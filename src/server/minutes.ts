import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { z } from "zod";
import { db } from "#/db";
import { ATTENDANCE_MODES } from "#/lib/attendance-mode";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import { MEETING_UPDATE_FIELDS } from "#/lib/meeting-limits";
import { parseViewAs, VIEW_AS_COOKIE } from "#/lib/view-as";
import type { ReleasedSlot } from "./availability-logic";
import { isReadableClub } from "./club-readable-logic";
import {
	getMembership,
	getSessionUser,
	requireClubRole,
	requireUser,
	requireVoteCounterCapability,
} from "./guards";
import { getActiveImpersonation } from "./impersonation-logic";
import {
	addGuestPresent,
	addTableTopicsSpeaker,
	assertAttendanceRecordable,
	clearAward,
	getMeetingClubId,
	getMeetingStatus,
	loadMinutes,
	loadMinutesProgram,
	moveTableTopicsSpeaker,
	removeGuestPresent,
	removeTableTopicsSpeaker,
	setAward,
	setMemberAbsentReleasingRoles,
	setMemberPresence,
} from "./minutes-logic";
import { isEffectiveAdmin } from "./officers-logic";
import { minutesAccess } from "./view-as-logic";

const uuid = z.string().uuid();

// A guest added from the minutes/attendance flow. `email` is validated as an
// EMAIL, not free text, so every writer of a guest's address (now
// `people.email`, #1125) agrees with `guestBookSchema` and `updateGuestSchema` —
// this was the one path through which "a@b.com?bcc=x&subject=y" could reach the
// column, and the VP-Membership card renders it into a `mailto:` href. The href is encoded there too;
// this is the other half, so the value never gets stored in the first place.
// `.max(200)` matches `guestBookSchema`'s cap on the same column.
const newGuestSchema = z.object({
	name: z.string().trim().min(1),
	email: z.string().trim().email().max(200).optional(),
	phone: z.string().trim().optional(),
});

const attendanceStatus = z.enum(["present", "absent", "excused"]);
// Mirrors the `attendance_mode` enum (#1046). Optional everywhere it appears: a
// client (or a queued offline op) from before #1049 sends none, and none means
// "leave the stored mode alone", never a default (see `setMemberPresence`).
const attendanceMode = z.enum(ATTENDANCE_MODES);
const awardCategory = z.enum([
	"best_speaker",
	"best_evaluator",
	"best_table_topics",
]);

/** The minutes payload returned to the meeting view, with visibility flags. */
export type MinutesResult = {
	visible: boolean;
	canEdit: boolean;
	data: Awaited<ReturnType<typeof loadMinutes>> | null;
	program: Awaited<ReturnType<typeof loadMinutesProgram>>;
};

/**
 * Load a meeting's minutes for the meeting view. AUTHED — club admins always
 * see it (to fill it in); members see it read-only, and ONLY once the meeting is
 * `completed` (ADR-0012 / ADR-0014). Non-members and members of an unfinished
 * meeting get `{ visible: false, data: null }` so the loader degrades instead of
 * throwing.
 */
export const getMinutes = createServerFn({ method: "GET" })
	.validator((meetingId: unknown) => uuid.parse(meetingId))
	.handler(async ({ data: meetingId }): Promise<MinutesResult> => {
		const sessionUser = await getSessionUser();
		const empty: MinutesResult = {
			visible: false,
			canEdit: false,
			data: null,
			program: [],
		};
		if (!sessionUser) return empty;
		const clubId = await getMeetingClubId(meetingId);
		// Archive takedown (#560). This fn resolves membership itself rather than
		// through a `require*` gate, so it never reaches the gates'
		// `assertClubNotArchived` — and a `createServerFn` is addressable directly with
		// no router, so the meeting page 404ing does not gate this. Returns the
		// module's existing not-visible shape rather than throwing, matching how the
		// public readers collapse archived into never-existed.
		if (!(await isReadableClub(clubId))) return empty;
		// A membership that is not active counts as no membership: it is neither a
		// member's read of the minutes nor an admin's.
		const found = await getMembership(sessionUser.id, clubId);
		const membership = found?.status === "active" ? found : null;
		// Read-write impersonation (#246): a superadmin acting as admin has no
		// membership but may still edit minutes. Only checked when there's no real
		// membership (zero cost for real members).
		const impersonatingRW =
			!membership &&
			(await getActiveImpersonation(sessionUser.id, clubId))?.mode ===
				"read_write";
		if (!membership && !impersonatingRW) return empty;
		// "Preview as member" (#1113) drops `canEdit`, and with it the admin's look at
		// the minutes of a meeting that is not completed. Read for ANY caller: it can
		// only remove access, which a plain member never had.
		// getCookie can throw off a request context (tests): no cookie, no preview.
		let asMember = false;
		try {
			asMember = parseViewAs(getCookie(VIEW_AS_COOKIE)) === "member";
		} catch {
			asMember = false;
		}
		const status = await getMeetingStatus(meetingId);
		const { canEdit, visible } = minutesAccess({
			// Effective-admin (#202): stored admin OR an open officer term, the same
			// two arms as the minutes writes' `requireClubRole` gate.
			isAdmin: membership ? await isEffectiveAdmin(db, membership) : false,
			impersonatingReadWrite: impersonatingRW,
			asMember,
			status,
		});
		if (!visible) return empty;
		const [data, program] = await Promise.all([
			loadMinutes(meetingId),
			loadMinutesProgram(meetingId),
		]);
		return { visible: true, canEdit, data, program };
	});

/**
 * Refuse a minutes or roll write the meeting's status refuses, by write class
 * (#1137): every writer below WRITES THE MEETING UP, so each is the `record`
 * class, which refuses a cancelled meeting and accepts a completed one (that is
 * when it is written up). Only `MEETING_WRITE_POLICY` says which statuses those
 * are, so a new status is one edit there and not an audit of these eight.
 *
 * The cancelled case is #1085. A cancelled meeting is hidden from every member
 * and never happened, so it must not quietly gain a roll, guests, Table Topics
 * speakers or awards from a stale tab, an offline replay or a direct call.
 * AFTER each handler's caller gate, so an outsider is refused for who they are
 * before learning the meeting's state, and BEFORE the date rule, so an officer
 * is told the reason that will not go away by waiting. A read, not a lock: the
 * window a cancel can commit inside is the one #1057 accepted for planned
 * attendance.
 */
async function assertMinutesMeetingRecordable(
	meetingId: string,
): Promise<void> {
	assertMeetingAccepts(await getMeetingStatus(meetingId), "record");
}

/** Resolve the meeting's club and gate the caller to the club admin role. */
async function gateAdmin(meetingId: string): Promise<string | null> {
	const currentUser = await requireUser();
	const clubId = await getMeetingClubId(meetingId);
	const membership = await requireClubRole(currentUser.id, clubId, ["admin"]);
	// The acting officer's member id, for the activity log. Null for an
	// impersonating superadmin, whom `logActivity` stamps itself (#246).
	return membership.impersonatedBy ? null : membership.id;
}

const setPresenceSchema = z
	.object({
		meetingId: uuid,
		memberId: uuid,
		status: attendanceStatus,
		mode: attendanceMode.optional(),
		// Free every role the member holds, in the same transaction as the Absent
		// write (#1256). DEFAULT FALSE: a tab from before the deploy cannot send it,
		// so it records Absent and frees nothing, the stale-tab rule of #663.
		releaseHeldRoles: z.boolean().default(false),
		// The slot ids the dialog LISTED, which is what the officer confirmed
		// (#1256). Required and non-empty with `releaseHeldRoles`, refused without
		// it: a replayed or stale release then frees only what was confirmed, never
		// a role the member was given since.
		releaseSlotIds: z.array(uuid).max(200).optional(),
	})
	// A mode on an absent/excused write is a contradiction — they were neither
	// in the room nor on the call. Refused rather than silently dropped, so a
	// client that sends one finds out (#1049). The logic clears it regardless.
	.refine((d) => d.mode === undefined || d.status === "present", {
		message: "Only a present attendee has an attendance mode.",
	})
	// Only Absent frees roles: Excused is being retired (#1255) and Present
	// frees nothing. `false` is valid with every status.
	.refine((d) => !d.releaseHeldRoles || d.status === "absent", {
		message: "Only an absent attendee's roles can be released.",
	})
	.refine(
		(d) =>
			d.releaseHeldRoles
				? d.releaseSlotIds !== undefined && d.releaseSlotIds.length > 0
				: d.releaseSlotIds === undefined,
		{
			message:
				"releaseSlotIds is required with releaseHeldRoles, and refused without it.",
		},
	);

/** Set a member's presence status. ADMIN-ONLY — stays this way after #510: a
 *  Ballot Counter has no business editing the roster's attendance. Capability
 *  grants get enumerated, not widened (#464). */
export const setAttendance = createServerFn({ method: "POST" })
	.validator((input: unknown) => setPresenceSchema.parse(input))
	.handler(async ({ data }) => {
		const actorMemberId = await gateAdmin(data.meetingId);
		await assertMinutesMeetingRecordable(data.meetingId);
		await assertAttendanceRecordable(data.meetingId);
		if (data.releaseHeldRoles) {
			const released = await setMemberAbsentReleasingRoles(
				{
					meetingId: data.meetingId,
					memberId: data.memberId,
					releaseSlotIds: data.releaseSlotIds ?? [],
				},
				actorMemberId,
			);
			return { ok: true as const, released };
		}
		await setMemberPresence(data);
		return { ok: true as const, released: [] as ReleasedSlot[] };
	});

const addGuestSchema = z
	.object({
		meetingId: uuid,
		// Optional client-supplied id for the NEW guest row (#176 slice 2) — lets an
		// offline create replay idempotently. Ignored on the existing-guest path.
		id: uuid.optional(),
		guestId: uuid.optional(),
		newGuest: newGuestSchema.optional(),
		// #1049. `mode` alone is written only if this add INSERTS the row (a guest
		// already present keeps theirs); `replaceMode: true` is roll mode's guest
		// toggle, the one path that changes an existing row's mode.
		mode: attendanceMode.optional(),
		replaceMode: z.boolean().optional(),
	})
	.refine((d) => Boolean(d.guestId) || Boolean(d.newGuest), {
		message: "Provide an existing guest or a new guest.",
	});

/** Add a present guest (existing or new). ADMIN-ONLY — stays this way after
 *  #510: a Ballot Counter has no business editing the club's guest records. */
export const addMinutesGuest = createServerFn({ method: "POST" })
	.validator((input: unknown) => addGuestSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		await assertMinutesMeetingRecordable(data.meetingId);
		await assertAttendanceRecordable(data.meetingId);
		return addGuestPresent(data);
	});

const removeGuestSchema = z.object({ meetingId: uuid, guestId: uuid });

/** Remove a present guest. ADMIN-ONLY — stays this way after #510, same reason
 *  as `addMinutesGuest`. */
export const removeMinutesGuest = createServerFn({ method: "POST" })
	.validator((input: unknown) => removeGuestSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		await assertMinutesMeetingRecordable(data.meetingId);
		await assertAttendanceRecordable(data.meetingId);
		await removeGuestPresent(data);
		return { ok: true as const };
	});

const addSpeakerSchema = z
	.object({
		meetingId: uuid,
		// Optional client-supplied id for the new Table Topics speaker row (#176
		// slice 2) — the stable target for later remove/move ops; replays no-op.
		id: uuid.optional(),
		// Optional client-supplied id for an INLINE new guest (#176 slice 5) —
		// distinct from `id` (the speaker-row id). Threads the guest PK so an
		// offline new-guest speaker replays idempotently (no orphan guest).
		newGuestId: uuid.optional(),
		memberId: uuid.optional(),
		guestId: uuid.optional(),
		// Name only (#1157): the Table Topics capture sends a name and nothing else,
		// and an address is written to a Person only under an officer's session.
		// Zod strips an extra key, so one a stale tab still sends is dropped rather
		// than stored. `addGuestSchema` (admin-only) keeps the wider
		// `newGuestSchema`.
		newGuest: z.object({ name: z.string().trim().min(1) }).optional(),
		topic: MEETING_UPDATE_FIELDS.topic.optional(),
		// Self-asserted Ballot Counter identity (#510) — see
		// `requireVoteCounterCapability`. Omitted (or ignored) on the admin path.
		selfMemberId: uuid.nullable().optional(),
	})
	.refine(
		(d) => Boolean(d.memberId) || Boolean(d.guestId) || Boolean(d.newGuest),
		{ message: "Provide a member or guest speaker." },
	)
	.refine((d) => !(d.memberId && (d.guestId || d.newGuest)), {
		message: "A speaker is a member OR a guest, not both.",
	});

/** Add a Table Topics speaker. ADMIN, or the meeting's self-asserted Ballot
 *  Counter (#510) — one of the five capabilities that role gets; see
 *  `requireVoteCounterCapability`. */
export const addTableTopics = createServerFn({ method: "POST" })
	.validator((input: unknown) => addSpeakerSchema.parse(input))
	.handler(async ({ data }) => {
		await requireVoteCounterCapability(data);
		await assertMinutesMeetingRecordable(data.meetingId);
		return addTableTopicsSpeaker(data);
	});

const removeSpeakerSchema = z.object({
	meetingId: uuid,
	id: uuid,
	selfMemberId: uuid.nullable().optional(),
});

/** Remove a Table Topics speaker. ADMIN, or the meeting's self-asserted Ballot
 *  Counter (#510). */
export const removeTableTopics = createServerFn({ method: "POST" })
	.validator((input: unknown) => removeSpeakerSchema.parse(input))
	.handler(async ({ data }) => {
		await requireVoteCounterCapability(data);
		await assertMinutesMeetingRecordable(data.meetingId);
		await removeTableTopicsSpeaker(data);
		return { ok: true as const };
	});

const moveSpeakerSchema = z.object({
	meetingId: uuid,
	id: uuid,
	direction: z.enum(["up", "down"]),
	// ABSOLUTE 0-based destination, and the reason a queued move can be replayed
	// safely: `direction` alone is a relative step, so a write abandoned at its
	// deadline that still landed gets stepped a SECOND position when the drain
	// replays it. Optional for the two callers that have no queue behind them —
	// the Ballot Counter console — and for ops persisted before it existed.
	// Unbounded on purpose: `moveTableTopicsSpeaker` no-ops on any target outside
	// the list, so a large value costs one SELECT, not a renumber.
	toIndex: z.number().int().nonnegative().optional(),
	selfMemberId: uuid.nullable().optional(),
});

/** Reorder a Table Topics speaker. ADMIN, or the meeting's self-asserted
 *  Ballot Counter (#510). */
export const moveTableTopics = createServerFn({ method: "POST" })
	.validator((input: unknown) => moveSpeakerSchema.parse(input))
	.handler(async ({ data }) => {
		await requireVoteCounterCapability(data);
		await assertMinutesMeetingRecordable(data.meetingId);
		await moveTableTopicsSpeaker(data);
		return { ok: true as const };
	});

const setAwardSchema = z
	.object({
		meetingId: uuid,
		category: awardCategory,
		// Optional client-supplied id for an INLINE new guest (#176 slice 5) — makes
		// an offline new-guest award replay idempotently (no orphan guest).
		newGuestId: uuid.optional(),
		memberId: uuid.optional(),
		guestId: uuid.optional(),
		// Name only (#1157), matching the award picker's UI and `addSpeakerSchema`:
		// an address is written to a Person only under an officer's session.
		newGuest: z.object({ name: z.string().trim().min(1) }).optional(),
		/** A write-in winner (#582) — no row, just the name a voter typed. Bounded
		 *  by `writeInNameSchema` inside `setAward`, which is the one definition of
		 *  that cap. */
		writeInName: z.string().optional(),
		selfMemberId: uuid.nullable().optional(),
	})
	.refine(
		(d) =>
			Boolean(d.memberId) ||
			Boolean(d.guestId) ||
			Boolean(d.newGuest) ||
			Boolean(d.writeInName),
		{ message: "Provide a member or guest for the award." },
	)
	.refine((d) => !(d.memberId && (d.guestId || d.newGuest)), {
		message: "An award winner is a member OR a guest, not both.",
	});

/** Set an award winner. ADMIN, or the meeting's self-asserted Ballot Counter
 *  (#510) confirming the tally they alone can see — the whole point of the
 *  feature (`docs/superpowers/specs/2026-08-08-digital-voting-design.md`). */
export const setMinutesAward = createServerFn({ method: "POST" })
	.validator((input: unknown) => setAwardSchema.parse(input))
	.handler(async ({ data }) => {
		await requireVoteCounterCapability(data);
		await assertMinutesMeetingRecordable(data.meetingId);
		await setAward(data);
		return { ok: true as const };
	});

const clearAwardSchema = z.object({
	meetingId: uuid,
	category: awardCategory,
	selfMemberId: uuid.nullable().optional(),
});

/** Clear an award — the undo for a mis-tapped winner. ADMIN, or the meeting's
 *  self-asserted Ballot Counter (#510): whoever may set a winner must also be
 *  able to take one back. */
export const clearMinutesAward = createServerFn({ method: "POST" })
	.validator((input: unknown) => clearAwardSchema.parse(input))
	.handler(async ({ data }) => {
		await requireVoteCounterCapability(data);
		await assertMinutesMeetingRecordable(data.meetingId);
		await clearAward(data);
		return { ok: true as const };
	});
