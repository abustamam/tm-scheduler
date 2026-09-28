/**
 * Anonymous role feedback, "love notes" (#981 / #984): the targets a meeting
 * offers, the anonymous capped write, and the recipient's read.
 *
 * Db-touching, so it lives here rather than in `role-feedback.ts`, which exports
 * only server fns and types (`server-modules.guard.test.ts`).
 *
 * THE RULE THIS MODULE EXISTS TO KEEP: no writer identity is ever stored,
 * accepted or returned. `leaveFeedbackLogic` takes no user, member, device or
 * guest id, the table has no column for one, and the write returns `{ ok }` and
 * nothing else — not even the new row's id, which a writer could otherwise hold
 * and later point at. The recipient and the role label are derived here, from
 * the meeting's own rows, and never taken from the caller.
 */
import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleFeedbackNotes,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	FEEDBACK_CLOSED_MESSAGE,
	FEEDBACK_NOT_OPEN_MESSAGE,
	FEEDBACK_PER_MEETING_CAP,
	FEEDBACK_PER_RECIPIENT_CAP,
	FEEDBACK_TEXT_MAX,
	type FeedbackWindow,
	type FeedbackWindowState,
	feedbackWindow,
	feedbackWindowState,
} from "#/lib/feedback-window";
import { CLUB_BUSY_MESSAGE, lockClubForWrite } from "./club-write-lock";
import { feedbackIpLimiter } from "./feedback-rate-limit";
import { assertClubNotArchived } from "./guards";
import { resolvePublicMeetingKey } from "./meeting-resolve-logic";
import type { DbOrTx } from "./meeting-templates-logic";
import { userMemberIds } from "./person-identity-logic";
import { isDeadlock } from "./pg-errors";

/** The role label every Table Topics speaker's note carries. */
export const TABLE_TOPICS_SPEAKER_LABEL = "Table Topics speaker";

export type FeedbackTargetKind = "slot" | "tableTopics";

export interface FeedbackTarget {
	kind: FeedbackTargetKind;
	/** `role_slots.id` or `table_topics_speakers.id`. */
	id: string;
	memberName: string;
	roleLabel: string;
}

/** A target with the recipient resolved — server-side only, never returned. */
interface ResolvedTarget extends FeedbackTarget {
	memberId: string;
}

/**
 * Every member a note may be left for at this meeting, in agenda order: the
 * member-held role slots, labelled with `slotLabel` over ALL the meeting's slots
 * (so "Speaker 2" stays "Speaker 2" when Speaker 1 is a guest or open), then the
 * member Table Topics speakers, placed after the Table Topics Master's slot when
 * there is one.
 *
 * ONE loader for the page's list and the write's resolution, so the label a
 * writer tapped is the label stored. It deliberately does not call
 * `loadMeetingSlots`, which reads through the pooled `db`: the write runs this
 * INSIDE a transaction holding the club write lock, and a second pooled
 * connection taken while holding it is how a burst of writers queued on that
 * lock starves the 10-connection pool. The ordering (`sort_order`, then
 * `slot_index`) and the numbering helpers are the same ones that loader's
 * callers use; `role-feedback.integration.test.ts` pins the labels against it.
 */
async function loadResolvedTargets(
	conn: DbOrTx,
	meetingId: string,
): Promise<ResolvedTarget[]> {
	const [slots, speakers] = await Promise.all([
		conn
			.select({
				id: roleSlots.id,
				slotIndex: roleSlots.slotIndex,
				roleName: roleDefinitions.name,
				roleKey: roleDefinitions.key,
				slotsUnordered: roleDefinitions.slotsUnordered,
				memberId: members.id,
				memberName: members.name,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
			.where(eq(roleSlots.meetingId, meetingId))
			.orderBy(asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex)),
		conn
			.select({
				id: tableTopicsSpeakers.id,
				memberId: members.id,
				memberName: members.name,
			})
			.from(tableTopicsSpeakers)
			.innerJoin(members, eq(members.id, tableTopicsSpeakers.memberId))
			.where(eq(tableTopicsSpeakers.meetingId, meetingId))
			.orderBy(
				asc(tableTopicsSpeakers.sortOrder),
				asc(tableTopicsSpeakers.createdAt),
			),
	]);

	// Counted over EVERY slot, open and guest-held included.
	const roleCounts = buildRoleCounts(slots);
	const slotTargets: (ResolvedTarget & { roleKey: string | null })[] = [];
	for (const s of slots) {
		if (!s.memberId || !s.memberName) continue;
		slotTargets.push({
			kind: "slot",
			id: s.id,
			memberId: s.memberId,
			memberName: s.memberName,
			roleLabel: slotLabel(s, roleCounts),
			roleKey: s.roleKey,
		});
	}
	const ttTargets: ResolvedTarget[] = speakers.map((s) => ({
		kind: "tableTopics",
		id: s.id,
		memberId: s.memberId,
		memberName: s.memberName,
		roleLabel: TABLE_TOPICS_SPEAKER_LABEL,
	}));

	let ttmAt = -1;
	slotTargets.forEach((t, i) => {
		if (t.roleKey === "table_topics_master") ttmAt = i;
	});
	const strip = ({ roleKey: _k, ...t }: (typeof slotTargets)[number]) => t;
	const ordered = slotTargets.map(strip);
	if (ttmAt === -1) return [...ordered, ...ttTargets];
	return [
		...ordered.slice(0, ttmAt + 1),
		...ttTargets,
		...ordered.slice(ttmAt + 1),
	];
}

// ---------------------------------------------------------------------------
// The public page's read
// ---------------------------------------------------------------------------

export interface FeedbackTargetsPublic {
	meeting: {
		id: string;
		/** `scheduledAt`, ISO. */
		date: string;
		/** The meeting's theme, when it has one. */
		title: string | null;
		/** The club's timezone, to format `date` for the page. */
		timezone: string;
	};
	window: {
		opensAt: string;
		endsAt: string;
		closesAt: string;
		canWrite: boolean;
		recipientsCanRead: boolean;
		/** Decided HERE, on the server's clock, so the page never picks
		 *  "not yet" vs "closed" from the visitor's (possibly wrong) clock. */
		state: FeedbackWindowState;
	};
	targets: FeedbackTarget[];
}

const serializeWindow = (
	w: FeedbackWindow,
	now: Date,
): FeedbackTargetsPublic["window"] => ({
	opensAt: w.opensAt.toISOString(),
	endsAt: w.endsAt.toISOString(),
	closesAt: w.closesAt.toISOString(),
	canWrite: w.canWrite,
	recipientsCanRead: w.recipientsCanRead,
	state: feedbackWindowState(w, now),
});

/**
 * What the public feedback page shows: the meeting, its window, and who a note
 * can be left for. Archive-gated through `resolvePublicMeetingKey`, so an
 * archived club answers exactly like a key that never existed: `null`. A
 * cancelled meeting is `null` too — it has no feedback page.
 *
 * Exposes each target's display name and role label and NOTHING else: no member
 * id, no contact, no attendance. The target id is the slot's or the speaker's,
 * which the public agenda already carries.
 */
export async function loadFeedbackTargetsPublic(
	clubId: string,
	meetingKey: string,
	now: Date = new Date(),
): Promise<FeedbackTargetsPublic | null> {
	const meetingId = await resolvePublicMeetingKey(clubId, meetingKey);
	if (!meetingId) return null;
	const [row] = await db
		.select({
			id: meetings.id,
			scheduledAt: meetings.scheduledAt,
			lengthMinutes: meetings.lengthMinutes,
			status: meetings.status,
			theme: meetings.theme,
			timezone: clubs.timezone,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row || row.status === "cancelled") return null;
	const targets = await loadResolvedTargets(db, meetingId);
	return {
		meeting: {
			id: row.id,
			date: row.scheduledAt.toISOString(),
			title: row.theme,
			timezone: row.timezone,
		},
		window: serializeWindow(feedbackWindow(row, now), now),
		targets: targets.map(({ memberId: _m, ...t }) => t),
	};
}

// ---------------------------------------------------------------------------
// The anonymous write
// ---------------------------------------------------------------------------

export interface LeaveFeedbackInput {
	meetingId: string;
	target: { kind: FeedbackTargetKind; id: string };
	wentWell?: string | null;
	tryNext?: string | null;
}

export const FEEDBACK_EMPTY_MESSAGE =
	"Write something in at least one of the two boxes.";
export const FEEDBACK_TOO_LONG_MESSAGE = `Each box holds at most ${FEEDBACK_TEXT_MAX} characters.`;
export const FEEDBACK_BAD_TEXT_MESSAGE =
	"That note has a character we can't store. Remove it and try again.";
export const FEEDBACK_CANCELLED_MESSAGE = "This meeting was cancelled.";
export const FEEDBACK_MEETING_NOT_FOUND_MESSAGE = "Meeting not found.";
export const FEEDBACK_TARGET_MESSAGE =
	"That role can't take feedback. Reload the page and try again.";
export const FEEDBACK_RECIPIENT_CAP_MESSAGE =
	"This person has received all the notes they can for this meeting. Thank you for wanting to add one!";
export const FEEDBACK_MEETING_CAP_MESSAGE =
	"This meeting has received all the notes it can. Thank you for wanting to add one!";
export const FEEDBACK_RATE_LIMIT_MESSAGE =
	"You're sending notes quickly. Wait a minute and try again.";
/** What a session-less caller sees for ANY failure that is not one of the
 *  refusals above: never a driver message, which names columns and values. */
export const FEEDBACK_GENERIC_ERROR_MESSAGE =
	"Couldn't send your note. Please try again in a moment.";
export { FEEDBACK_CLOSED_MESSAGE, FEEDBACK_NOT_OPEN_MESSAGE };

/**
 * Every message `leaveFeedbackLogic` may hand its anonymous caller verbatim.
 * Anything else — a `DrizzleQueryError` ("Failed query: insert … params: …",
 * which carries ids), a pool error, a bug — becomes
 * `FEEDBACK_GENERIC_ERROR_MESSAGE`.
 */
const PUBLIC_FEEDBACK_MESSAGES: ReadonlySet<string> = new Set([
	FEEDBACK_EMPTY_MESSAGE,
	FEEDBACK_TOO_LONG_MESSAGE,
	FEEDBACK_BAD_TEXT_MESSAGE,
	FEEDBACK_NOT_OPEN_MESSAGE,
	FEEDBACK_CLOSED_MESSAGE,
	FEEDBACK_CANCELLED_MESSAGE,
	FEEDBACK_MEETING_NOT_FOUND_MESSAGE,
	FEEDBACK_TARGET_MESSAGE,
	FEEDBACK_RECIPIENT_CAP_MESSAGE,
	FEEDBACK_MEETING_CAP_MESSAGE,
	FEEDBACK_RATE_LIMIT_MESSAGE,
	CLUB_ARCHIVED_MESSAGE,
	CLUB_BUSY_MESSAGE,
	"Club not found.",
]);

/** The error a session-less caller may see for `err`: one of the refusals
 *  above unchanged, or the generic message with the original on `cause`
 *  (server-side only; `cause` is not what the client renders). */
export function publicFeedbackError(err: unknown): Error {
	if (err instanceof Error && PUBLIC_FEEDBACK_MESSAGES.has(err.message)) {
		return err;
	}
	return new Error(FEEDBACK_GENERIC_ERROR_MESSAGE, { cause: err });
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trim; blank → null. Throws when over the cap, or when the text carries a
 *  NUL, which Postgres refuses in `text` (22021) — refused here so the insert
 *  is never attempted with it. */
function cleanText(v: string | null | undefined): string | null {
	const t = (v ?? "").trim();
	if (t.includes("\u0000")) throw new Error(FEEDBACK_BAD_TEXT_MESSAGE);
	if (t.length > FEEDBACK_TEXT_MAX) throw new Error(FEEDBACK_TOO_LONG_MESSAGE);
	return t.length > 0 ? t : null;
}

/**
 * Every refusal that depends on the meeting's own rows: cancelled, the window
 * (server clock), the target, and the two caps. Run TWICE per write: once on a
 * pooled read before any lock, so a closed window or a full cap is refused
 * without queueing on the club write lock or holding a connection there; and
 * again, authoritatively, on the transaction under that lock, which is what
 * makes the caps hold under concurrency. Returns the resolved target.
 */
async function admitNote(
	conn: DbOrTx,
	input: LeaveFeedbackInput,
	at: Date,
): Promise<ResolvedTarget> {
	const [meeting] = await conn
		.select({
			scheduledAt: meetings.scheduledAt,
			lengthMinutes: meetings.lengthMinutes,
			status: meetings.status,
		})
		.from(meetings)
		.where(eq(meetings.id, input.meetingId))
		.limit(1);
	if (!meeting) throw new Error(FEEDBACK_MEETING_NOT_FOUND_MESSAGE);
	if (meeting.status === "cancelled") {
		throw new Error(FEEDBACK_CANCELLED_MESSAGE);
	}
	const state = feedbackWindowState(feedbackWindow(meeting, at), at);
	if (state === "notYet") throw new Error(FEEDBACK_NOT_OPEN_MESSAGE);
	if (state === "closed") throw new Error(FEEDBACK_CLOSED_MESSAGE);

	const targets = await loadResolvedTargets(conn, input.meetingId);
	const target = targets.find(
		(t) => t.kind === input.target.kind && t.id === input.target.id,
	);
	if (!target) throw new Error(FEEDBACK_TARGET_MESSAGE);

	const [counts] = await conn
		.select({
			meeting: sql<number>`count(*)::int`,
			recipient: sql<number>`count(*) filter (where ${roleFeedbackNotes.recipientMemberId} = ${target.memberId})::int`,
		})
		.from(roleFeedbackNotes)
		.where(eq(roleFeedbackNotes.meetingId, input.meetingId));
	if ((counts?.recipient ?? 0) >= FEEDBACK_PER_RECIPIENT_CAP) {
		throw new Error(FEEDBACK_RECIPIENT_CAP_MESSAGE);
	}
	if ((counts?.meeting ?? 0) >= FEEDBACK_PER_MEETING_CAP) {
		throw new Error(FEEDBACK_MEETING_CAP_MESSAGE);
	}
	return target;
}

/**
 * Leave an anonymous note. No session, no identity — see the module header.
 *
 * Order, and why:
 *  1. The text is validated before any database work: it needs nothing else.
 *  2. The club comes from the MEETING's own row, never from the caller.
 *  3. A cheap pooled PRE-CHECK: the (unlocked) archive gate, then `admitNote`.
 *     Most refusals — a closed window, a full cap, a stale card — end here,
 *     without taking the club write lock or holding a connection behind it.
 *     Then the per-address speed bump (`feedbackIpLimiter`, in memory, a
 *     salted hash, never stored or logged), counted only for an attempt that
 *     would otherwise go on to take the lock. No address → not limited: one
 *     shared bucket for every header-less request would throttle the room.
 *  4. In ONE transaction: the club write lock (`lockClubForWrite`, #925), then
 *     the club row (`FOR NO KEY UPDATE`, which the archiving `UPDATE` conflicts
 *     with), then the archive gate read UNDER that lock — so a club archived
 *     mid-request cannot take the row (CODING_STANDARDS "Where a write already
 *     holds a club lock"). Takedown is checked before the meeting's own state,
 *     so an archived club answers the same whatever its meetings look like.
 *  5. `admitNote` again on the transaction: the authoritative re-check. The
 *     caps are counted under the club lock, so concurrent writers serialise and
 *     cannot overshoot either.
 *
 * Every failure leaves through `publicFeedbackError`: a caller with no session
 * sees one of the refusals above or a generic message, never a driver error.
 */
export async function leaveFeedbackLogic(
	input: LeaveFeedbackInput,
	now: () => Date = () => new Date(),
	/** The caller's address, for the in-memory limiter only. Never stored. */
	clientIp: string | null = null,
): Promise<{ ok: true }> {
	try {
		return await leaveFeedbackUnmapped(input, now, clientIp);
	} catch (err) {
		throw publicFeedbackError(err);
	}
}

async function leaveFeedbackUnmapped(
	input: LeaveFeedbackInput,
	now: () => Date,
	clientIp: string | null,
): Promise<{ ok: true }> {
	const wentWell = cleanText(input.wentWell);
	const tryNext = cleanText(input.tryNext);
	if (!wentWell && !tryNext) throw new Error(FEEDBACK_EMPTY_MESSAGE);
	if (!UUID_RE.test(input.meetingId) || !UUID_RE.test(input.target.id)) {
		throw new Error(FEEDBACK_MEETING_NOT_FOUND_MESSAGE);
	}

	const [owner] = await db
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, input.meetingId))
		.limit(1);
	if (!owner) throw new Error(FEEDBACK_MEETING_NOT_FOUND_MESSAGE);
	const clubId = owner.clubId;

	// The pre-check (step 3). Not the gate — step 4 is.
	await assertClubNotArchived(clubId);
	await admitNote(db, input, now());
	if (clientIp && !feedbackIpLimiter.take(clientIp)) {
		throw new Error(FEEDBACK_RATE_LIMIT_MESSAGE);
	}

	try {
		return await db.transaction(async (tx) => {
			await lockClubForWrite(tx, clubId);
			await tx
				.select({ id: clubs.id })
				.from(clubs)
				.where(eq(clubs.id, clubId))
				.for("no key update");
			// The gate, read under the row lock just taken.
			await assertClubNotArchived(clubId, tx);

			const target = await admitNote(tx, input, now());

			await tx.insert(roleFeedbackNotes).values({
				clubId,
				meetingId: input.meetingId,
				recipientMemberId: target.memberId,
				roleSlotId: target.kind === "slot" ? target.id : null,
				tableTopicsSpeakerId: target.kind === "tableTopics" ? target.id : null,
				roleLabel: target.roleLabel,
				wentWell,
				tryNext,
			});
			return { ok: true as const };
		});
	} catch (err) {
		// Nothing was written (the transaction rolled back), so "try again" is
		// the whole remedy; the original rides on `cause` for a SQLSTATE check.
		if (isDeadlock(err)) throw new Error(CLUB_BUSY_MESSAGE, { cause: err });
		throw err;
	}
}

// ---------------------------------------------------------------------------
// The recipient's read (parts 2 and 3 call this; no server fn here)
// ---------------------------------------------------------------------------

export interface FeedbackNote {
	id: string;
	wentWell: string | null;
	tryNext: string | null;
	createdAt: string;
	seen: boolean;
}

export interface FeedbackMeetingGroup {
	meetingId: string;
	clubName: string;
	/** `scheduledAt`, ISO. */
	meetingDate: string;
	roles: { roleLabel: string; notes: FeedbackNote[] }[];
}

export interface FeedbackForUser {
	meetings: FeedbackMeetingGroup[];
	unseenCount: number;
}

/**
 * The notes left for `userId`, across ALL their memberships — archived clubs
 * included: a takedown stops new notes, not a person reading what they were
 * given. Only meetings whose scheduled end has passed (`recipientsCanRead`),
 * newest meeting first, then grouped by role label.
 *
 * Takes the SESSION user's id from its caller and nothing else, so there is no
 * path by which it returns another member's notes, and no field in the result
 * that could say who wrote one.
 */
export async function loadFeedbackForUser(
	userId: string,
	opts: { meetingId?: string; from?: Date; to?: Date } = {},
	now: Date = new Date(),
): Promise<FeedbackForUser> {
	const memberIds = await userMemberIds(userId);
	if (memberIds.length === 0) return { meetings: [], unseenCount: 0 };

	const conds = [
		inArray(roleFeedbackNotes.recipientMemberId, memberIds),
		// The scheduled end has passed, on the server's clock.
		sql`${meetings.scheduledAt} + (${meetings.lengthMinutes} * interval '1 minute') <= ${now.toISOString()}::timestamptz`,
	];
	if (opts.meetingId) {
		if (!UUID_RE.test(opts.meetingId)) return { meetings: [], unseenCount: 0 };
		conds.push(eq(roleFeedbackNotes.meetingId, opts.meetingId));
	}
	if (opts.from) conds.push(gte(meetings.scheduledAt, opts.from));
	if (opts.to) conds.push(lt(meetings.scheduledAt, opts.to));

	const rows = await db
		.select({
			id: roleFeedbackNotes.id,
			meetingId: roleFeedbackNotes.meetingId,
			roleLabel: roleFeedbackNotes.roleLabel,
			wentWell: roleFeedbackNotes.wentWell,
			tryNext: roleFeedbackNotes.tryNext,
			seenAt: roleFeedbackNotes.seenAt,
			createdAt: roleFeedbackNotes.createdAt,
			scheduledAt: meetings.scheduledAt,
			clubName: clubs.name,
		})
		.from(roleFeedbackNotes)
		.innerJoin(meetings, eq(meetings.id, roleFeedbackNotes.meetingId))
		.innerJoin(clubs, eq(clubs.id, roleFeedbackNotes.clubId))
		.where(and(...conds))
		.orderBy(
			desc(meetings.scheduledAt),
			asc(roleFeedbackNotes.roleLabel),
			// `created_at` is a DAY (schema.ts says why); `id` is random, so the
			// order within a day says nothing about who wrote first.
			asc(roleFeedbackNotes.createdAt),
			asc(roleFeedbackNotes.id),
		);

	const groups: FeedbackMeetingGroup[] = [];
	const byMeeting = new Map<string, FeedbackMeetingGroup>();
	let unseenCount = 0;
	for (const r of rows) {
		let g = byMeeting.get(r.meetingId);
		if (!g) {
			g = {
				meetingId: r.meetingId,
				clubName: r.clubName,
				meetingDate: r.scheduledAt.toISOString(),
				roles: [],
			};
			byMeeting.set(r.meetingId, g);
			groups.push(g);
		}
		let role = g.roles.find((x) => x.roleLabel === r.roleLabel);
		if (!role) {
			role = { roleLabel: r.roleLabel, notes: [] };
			g.roles.push(role);
		}
		const seen = r.seenAt !== null;
		if (!seen) unseenCount++;
		role.notes.push({
			id: r.id,
			wentWell: r.wentWell,
			tryNext: r.tryNext,
			createdAt: r.createdAt.toISOString(),
			seen,
		});
	}
	return { meetings: groups, unseenCount };
}
