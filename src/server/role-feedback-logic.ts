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
 * and later point at. The role label is derived here, from the meeting's and
 * the club's own rows, and never taken from the caller as text. Since #1021 the
 * caller may NAME the recipient (a member id), but only a member this module
 * admits: one of the meeting's club, active unless the agenda itself vouches
 * for them (see `resolvePersonNote`).
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
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
import {
	type FeedbackRoleChoice,
	GENERAL_FEEDBACK_LABEL,
	type LegacyLeaveFeedbackInput,
	type PersonLeaveFeedbackInput,
	TABLE_TOPICS_SPEAKER_LABEL,
} from "#/lib/role-feedback-input";
import { CLUB_BUSY_MESSAGE, lockClubForWrite } from "./club-write-lock";
import {
	feedbackIpLimiter,
	feedbackSenderMeetingCap,
} from "./feedback-rate-limit";
import { assertClubNotArchived } from "./guards";
import { resolvePublicMeetingKey } from "./meeting-resolve-logic";
import type { DbOrTx } from "./meeting-templates-logic";
import { userMemberIds } from "./person-identity-logic";
import { isDeadlock } from "./pg-errors";

export { GENERAL_FEEDBACK_LABEL, TABLE_TOPICS_SPEAKER_LABEL };
export type {
	FeedbackRoleChoice,
	LegacyLeaveFeedbackInput,
	PersonLeaveFeedbackInput,
};

export type FeedbackTargetKind = "slot" | "tableTopics";

export interface FeedbackTarget {
	kind: FeedbackTargetKind;
	/** `role_slots.id` or `table_topics_speakers.id`. */
	id: string;
	memberName: string;
	roleLabel: string;
}

/** A target with the recipient resolved. `loadFeedbackTargetsPublic` returns
 *  these fields renamed (`PublicFeedbackTarget`); the write reads them to
 *  check a named recipient against the agenda. */
interface ResolvedTarget extends FeedbackTarget {
	memberId: string;
	/** The slot's role definition; null for a Table Topics speaker row. */
	roleDefinitionId: string | null;
	/** `members.status = 'active'`. */
	memberActive: boolean;
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
				roleDefinitionId: roleSlots.roleDefinitionId,
				memberId: members.id,
				memberName: members.name,
				memberStatus: members.status,
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
				memberStatus: members.status,
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
			roleDefinitionId: s.roleDefinitionId,
			memberActive: s.memberStatus === "active",
			roleKey: s.roleKey,
		});
	}
	const ttTargets: ResolvedTarget[] = speakers.map((s) => ({
		kind: "tableTopics",
		id: s.id,
		memberId: s.memberId,
		memberName: s.memberName,
		roleLabel: TABLE_TOPICS_SPEAKER_LABEL,
		roleDefinitionId: null,
		memberActive: s.memberStatus === "active",
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
	/** "At this meeting": the agenda's member-held roles, in agenda order. */
	targets: PublicFeedbackTarget[];
	/** "Someone else": every ACTIVE member of the club not in `targets`, by
	 *  name (#1021). */
	others: { memberId: string; name: string; preferredName: string | null }[];
	/** The club's enabled role definitions, by `sort_order`: what the role
	 *  picker offers as an unnumbered role (#1021). */
	roleOptions: { roleDefinitionId: string; name: string }[];
}

/**
 * What the public feedback reader answers for a CANCELLED meeting (#1057): the
 * meeting's id and status and nothing else. A cancelled meeting is visible and
 * says so (the maintainer's decision on #1084), so the page must tell it apart
 * from a key that names nothing — from this one answer, off the same row, with
 * no second lookup. No names, no window, no roles: a cancelled meeting takes no
 * notes, so the page has nothing to offer.
 */
export interface FeedbackMeetingCancelled {
	meetingId: string;
	status: "cancelled";
}

/** One "At this meeting" row, with what the role picker needs (#1021). */
export interface PublicFeedbackTarget extends FeedbackTarget {
	recipientMemberId: string;
	/** The slot's role definition; null for a Table Topics speaker row. */
	roleDefinitionId: string | null;
	/** `members.status = 'active'`. An inactive member on the agenda can be
	 *  sent a note only under a role they hold, so the picker offers no other. */
	recipientActive: boolean;
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
 * cancelled meeting answers `FeedbackMeetingCancelled` — its id and status
 * only — so the page can say it is cancelled instead of "not found" (#1057).
 *
 * Exposes display names, role labels, member ids, an active flag and the
 * club's enabled role names, and NOTHING else: no contact, no attendance.
 * Member ids are exposed since #1021 so a note can name its recipient.
 *
 * What that exposure is, exactly, measured against `loadPublicClubRoster`
 * (`members-logic.ts`, session-less, every NON-inactive member's id, name and
 * preferred name):
 *  - `others` is a subset of that roster (active members only);
 *  - `targets` is NOT: it also carries the member id and `recipientActive:
 *    false` of an INACTIVE member who holds a slot or Table Topics row at this
 *    meeting, which the roster omits. The public agenda already shows that
 *    person's name beside the role; the id and the inactive status are new.
 * The target id is the slot's or the speaker's, which the public agenda
 * already carries.
 */
export async function loadFeedbackTargetsPublic(
	clubId: string,
	meetingKey: string,
	now: Date = new Date(),
): Promise<FeedbackTargetsPublic | FeedbackMeetingCancelled | null> {
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
			clubId: meetings.clubId,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) return null;
	if (row.status === "cancelled") {
		return { meetingId: row.id, status: "cancelled" };
	}
	const [targets, active, roleOptions] = await Promise.all([
		loadResolvedTargets(db, meetingId),
		db
			.select({
				memberId: members.id,
				name: members.name,
				preferredName: members.preferredName,
			})
			.from(members)
			.where(and(eq(members.clubId, row.clubId), eq(members.status, "active")))
			.orderBy(asc(members.name), asc(members.id)),
		db
			.select({
				roleDefinitionId: roleDefinitions.id,
				name: roleDefinitions.name,
			})
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.clubId, row.clubId),
					eq(roleDefinitions.enabled, true),
				),
			)
			.orderBy(asc(roleDefinitions.sortOrder), asc(roleDefinitions.name)),
	]);
	const onAgenda = new Set(targets.map((t) => t.memberId));
	return {
		meeting: {
			id: row.id,
			date: row.scheduledAt.toISOString(),
			title: row.theme,
			timezone: row.timezone,
		},
		window: serializeWindow(feedbackWindow(row, now), now),
		targets: targets.map(
			({ memberId, memberActive, ...t }): PublicFeedbackTarget => ({
				...t,
				recipientMemberId: memberId,
				recipientActive: memberActive,
			}),
		),
		others: active.filter((m) => !onAgenda.has(m.memberId)),
		roleOptions,
	};
}

// ---------------------------------------------------------------------------
// The anonymous write
// ---------------------------------------------------------------------------

export type LeaveFeedbackInput =
	| LegacyLeaveFeedbackInput
	| PersonLeaveFeedbackInput;

const isLegacy = (i: LeaveFeedbackInput): i is LegacyLeaveFeedbackInput =>
	"target" in i && i.target !== undefined;

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
/** One address has sent its share of this meeting's notes (#1038). Worded for
 *  a shared connection: on a venue's Wi-Fi it is the room, not one person. */
export const FEEDBACK_SENDER_CAP_MESSAGE =
	"This connection has sent all the notes it can for this meeting. Thank you for wanting to add one!";
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
	FEEDBACK_SENDER_CAP_MESSAGE,
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

/** What the insert takes: who receives the note, under which label, linked
 *  to which agenda row (at most one). */
interface AdmittedNote {
	memberId: string;
	roleLabel: string;
	roleSlotId: string | null;
	tableTopicsSpeakerId: string | null;
}

/**
 * Resolve a note for a NAMED recipient (#1021), per the table in the issue:
 *
 *  - the recipient must be a `members` row of the MEETING's club — a wrong
 *    club and an unknown id are the same refusal;
 *  - `slot` / `tableTopics`: the row must be on this meeting's agenda AND held
 *    by this recipient. The agenda vouches for them, so an inactive member who
 *    holds a slot can still receive a note, exactly as through the legacy path;
 *  - `definition` / `tableTopicsSpeaker` / `general`: nothing on the agenda
 *    vouches, so the recipient must be `active`; a definition must be the
 *    club's own and enabled.
 *
 * Every refusal is `FEEDBACK_TARGET_MESSAGE`, one indistinguishable answer, so
 * a caller probing ids learns nothing about which check failed.
 */
async function resolvePersonNote(
	conn: DbOrTx,
	input: PersonLeaveFeedbackInput,
	clubId: string,
): Promise<AdmittedNote> {
	const refuse = () => new Error(FEEDBACK_TARGET_MESSAGE);
	const [recipient] = await conn
		.select({ id: members.id, status: members.status })
		.from(members)
		.where(
			and(eq(members.id, input.recipientMemberId), eq(members.clubId, clubId)),
		)
		.limit(1);
	if (!recipient) throw refuse();
	const role = input.role;

	if (role.kind === "slot" || role.kind === "tableTopics") {
		const id = role.kind === "slot" ? role.slotId : role.speakerId;
		const held = (await loadResolvedTargets(conn, input.meetingId)).find(
			(t) => t.kind === role.kind && t.id === id && t.memberId === recipient.id,
		);
		if (!held) throw refuse();
		return {
			memberId: recipient.id,
			roleLabel: held.roleLabel,
			roleSlotId: held.kind === "slot" ? held.id : null,
			tableTopicsSpeakerId: held.kind === "tableTopics" ? held.id : null,
		};
	}

	if (recipient.status !== "active") throw refuse();
	const unlinked = {
		memberId: recipient.id,
		roleSlotId: null,
		tableTopicsSpeakerId: null,
	};
	if (role.kind === "general") {
		return { ...unlinked, roleLabel: GENERAL_FEEDBACK_LABEL };
	}
	if (role.kind === "tableTopicsSpeaker") {
		return { ...unlinked, roleLabel: TABLE_TOPICS_SPEAKER_LABEL };
	}
	if (role.kind === "definition") {
		const [def] = await conn
			.select({ name: roleDefinitions.name })
			.from(roleDefinitions)
			.where(
				and(
					eq(roleDefinitions.id, role.roleDefinitionId),
					eq(roleDefinitions.clubId, clubId),
					eq(roleDefinitions.enabled, true),
				),
			)
			.limit(1);
		if (!def) throw refuse();
		return { ...unlinked, roleLabel: def.name };
	}
	// An unknown kind from a caller that skipped the wire schema.
	throw refuse();
}

/**
 * Every refusal that depends on the meeting's own rows: cancelled, the window
 * (server clock), the recipient and role, and the two caps. Run TWICE per
 * write: once on a pooled read before any lock, so a closed window or a full
 * cap is refused without queueing on the club write lock or holding a
 * connection there; and again, authoritatively, on the transaction under that
 * lock, which is what makes the caps hold under concurrency. Returns what the
 * insert takes.
 */
async function admitNote(
	conn: DbOrTx,
	input: LeaveFeedbackInput,
	at: Date,
): Promise<AdmittedNote & { closesAt: Date }> {
	const [meeting] = await conn
		.select({
			clubId: meetings.clubId,
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
	const window = feedbackWindow(meeting, at);
	const state = feedbackWindowState(window, at);
	if (state === "notYet") throw new Error(FEEDBACK_NOT_OPEN_MESSAGE);
	if (state === "closed") throw new Error(FEEDBACK_CLOSED_MESSAGE);

	let note: AdmittedNote;
	if (isLegacy(input)) {
		const targets = await loadResolvedTargets(conn, input.meetingId);
		const target = targets.find(
			(t) => t.kind === input.target.kind && t.id === input.target.id,
		);
		if (!target) throw new Error(FEEDBACK_TARGET_MESSAGE);
		note = {
			memberId: target.memberId,
			roleLabel: target.roleLabel,
			roleSlotId: target.kind === "slot" ? target.id : null,
			tableTopicsSpeakerId: target.kind === "tableTopics" ? target.id : null,
		};
	} else {
		note = await resolvePersonNote(conn, input, meeting.clubId);
	}

	const [counts] = await conn
		.select({
			meeting: sql<number>`count(*)::int`,
			recipient: sql<number>`count(*) filter (where ${roleFeedbackNotes.recipientMemberId} = ${note.memberId})::int`,
		})
		.from(roleFeedbackNotes)
		.where(eq(roleFeedbackNotes.meetingId, input.meetingId));
	if ((counts?.recipient ?? 0) >= FEEDBACK_PER_RECIPIENT_CAP) {
		throw new Error(FEEDBACK_RECIPIENT_CAP_MESSAGE);
	}
	if ((counts?.meeting ?? 0) >= FEEDBACK_PER_MEETING_CAP) {
		throw new Error(FEEDBACK_MEETING_CAP_MESSAGE);
	}
	return { ...note, closesAt: window.closesAt };
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
 *     Before it, the per-address PER-MEETING budget
 *     (`feedbackSenderMeetingCap`, #1038, kept the same way): a slot is
 *     reserved here, held until the meeting's window closes, and given back
 *     if the attempt stores nothing — refused by the per-minute limiter, or
 *     by anything in steps 4-5 — so only written notes spend it.
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
	if (isLegacy(input)) {
		if (!UUID_RE.test(input.meetingId) || !UUID_RE.test(input.target.id)) {
			throw new Error(FEEDBACK_MEETING_NOT_FOUND_MESSAGE);
		}
	} else {
		if (!UUID_RE.test(input.meetingId)) {
			throw new Error(FEEDBACK_MEETING_NOT_FOUND_MESSAGE);
		}
		// Every id the person shape carries is checked before it reaches a
		// query: a malformed one is the target refusal, never a driver error.
		const r = input.role as Partial<Record<string, unknown>>;
		const roleIds = [r.slotId, r.speakerId, r.roleDefinitionId].filter(
			(v) => v !== undefined,
		);
		if (
			!UUID_RE.test(input.recipientMemberId) ||
			roleIds.some((v) => typeof v !== "string" || !UUID_RE.test(v))
		) {
			throw new Error(FEEDBACK_TARGET_MESSAGE);
		}
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
	const at = now();
	const { closesAt } = await admitNote(db, input, at);
	if (
		clientIp &&
		!feedbackSenderMeetingCap.take(
			clientIp,
			input.meetingId,
			closesAt.getTime(),
			at.getTime(),
		)
	) {
		throw new Error(FEEDBACK_SENDER_CAP_MESSAGE);
	}
	// Give the reserved slot back: this attempt stored no note.
	const release = () => {
		if (clientIp) feedbackSenderMeetingCap.release(clientIp, input.meetingId);
	};
	if (clientIp && !feedbackIpLimiter.take(clientIp, at.getTime())) {
		release();
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

			const note = await admitNote(tx, input, now());

			await tx.insert(roleFeedbackNotes).values({
				clubId,
				meetingId: input.meetingId,
				recipientMemberId: note.memberId,
				roleSlotId: note.roleSlotId,
				tableTopicsSpeakerId: note.tableTopicsSpeakerId,
				roleLabel: note.roleLabel,
				wentWell,
				tryNext,
			});
			return { ok: true as const };
		});
	} catch (err) {
		release();
		// Nothing was written (the transaction rolled back), so "try again" is
		// the whole remedy; the original rides on `cause` for a SQLSTATE check.
		if (isDeadlock(err)) throw new Error(CLUB_BUSY_MESSAGE, { cause: err });
		throw err;
	}
}

// ---------------------------------------------------------------------------
// The recipient's read, delete and mark-seen (#986)
// ---------------------------------------------------------------------------

/**
 * THE statement of which notes a recipient may touch, shared by the read, the
 * delete and the mark-seen so the three cannot drift: left for one of the
 * caller's own memberships (`memberIds`, from the SESSION user), on a meeting
 * whose scheduled end has passed on the server's clock. A note the recipient
 * cannot read, they can neither delete nor mark seen — so no id a caller holds
 * reaches a note before its meeting has ended.
 *
 * An `EXISTS` rather than a join so it reads the same inside a `DELETE` and an
 * `UPDATE`, which have no join of their own.
 */
const recipientMayTouch = (memberIds: string[], now: Date) =>
	and(
		inArray(roleFeedbackNotes.recipientMemberId, memberIds),
		sql`exists (select 1 from ${meetings} where ${meetings.id} = ${roleFeedbackNotes.meetingId} and ${meetings.scheduledAt} + (${meetings.lengthMinutes} * interval '1 minute') <= ${now.toISOString()}::timestamptz)`,
	);

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
	/** The club's timezone, so the date is formatted the same on the server's
	 *  render and the browser's hydration (#608's hazard, not repeated). */
	timezone: string;
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

	const conds = [recipientMayTouch(memberIds, now)];
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
			timezone: clubs.timezone,
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
				timezone: r.timezone,
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

/** What `deleteMyFeedbackNote` answers. `deleted: false` is ONE result for a
 *  note that does not exist, one already deleted, one that belongs to someone
 *  else, and one whose meeting has not ended: the caller cannot tell them apart, so a guessed id says
 *  nothing about whether a note exists. */
export interface DeleteFeedbackResult {
	deleted: boolean;
}

/**
 * Hard-delete one note, only when `recipientMayTouch` admits it: one of
 * `userId`'s own memberships, on a meeting that has ended (any club, archived included: a takedown stops new notes, not a
 * person throwing away one they were given). Anything else deletes nothing and
 * answers exactly like a note that never existed.
 *
 * The ownership check and the delete are ONE statement, so there is no
 * check-then-act window, and the recipient set comes from the SESSION user,
 * never from the caller.
 */
export async function deleteMyFeedbackNote(
	userId: string,
	noteId: string,
	now: Date = new Date(),
): Promise<DeleteFeedbackResult> {
	if (!UUID_RE.test(noteId)) return { deleted: false };
	const memberIds = await userMemberIds(userId);
	if (memberIds.length === 0) return { deleted: false };
	const gone = await db
		.delete(roleFeedbackNotes)
		.where(
			and(eq(roleFeedbackNotes.id, noteId), recipientMayTouch(memberIds, now)),
		)
		.returning({ id: roleFeedbackNotes.id });
	return { deleted: gone.length > 0 };
}

/**
 * Mark the caller's readable, unseen notes seen. Narrowed to `noteIds`, the
 * notes the dashboard actually rendered, so a note that arrives between the
 * page's read and this call keeps its "new" badge for the next visit instead of
 * being marked seen unshown. Ids that are not the caller's are ignored: the
 * recipient filter comes from the session, and the result is only a count.
 */
export async function markMyFeedbackSeen(
	userId: string,
	noteIds: readonly string[],
	now: Date = new Date(),
): Promise<{ marked: number }> {
	const ids = noteIds.filter((id) => UUID_RE.test(id));
	if (ids.length === 0) return { marked: 0 };
	const memberIds = await userMemberIds(userId);
	if (memberIds.length === 0) return { marked: 0 };
	const marked = await db
		.update(roleFeedbackNotes)
		.set({ seenAt: now })
		.where(
			and(
				inArray(roleFeedbackNotes.id, ids),
				isNull(roleFeedbackNotes.seenAt),
				recipientMayTouch(memberIds, now),
			),
		)
		.returning({ id: roleFeedbackNotes.id });
	return { marked: marked.length };
}
