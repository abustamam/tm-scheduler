import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { MEETING_UPDATE_FIELDS } from "#/lib/meeting-limits";
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
	setMemberPresence,
} from "./minutes-logic";

const uuid = z.string().uuid();

// A guest added from the minutes/attendance flow. `email` is validated as an
// EMAIL, not free text, so every writer of `guests.email` agrees with
// `guestBookSchema` and `updateGuestSchema` — this was the one path through
// which "a@b.com?bcc=x&subject=y" could reach the column, and the VP-Membership
// card renders that column into a `mailto:` href. The href is encoded there too;
// this is the other half, so the value never gets stored in the first place.
// `.max(200)` matches `guestBookSchema`'s cap on the same column.
const newGuestSchema = z.object({
	name: z.string().trim().min(1),
	email: z.string().trim().email().max(200).optional(),
	phone: z.string().trim().optional(),
});

const attendanceStatus = z.enum(["present", "absent", "excused"]);
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
		const membership = await getMembership(sessionUser.id, clubId);
		// Read-write impersonation (#246): a superadmin acting as admin has no
		// membership but may still edit minutes. Only checked when there's no real
		// membership (zero cost for real members).
		const impersonatingRW =
			!membership &&
			(await getActiveImpersonation(sessionUser.id, clubId))?.mode ===
				"read_write";
		if (!membership && !impersonatingRW) return empty;
		const canEdit = membership?.clubRole === "admin" || impersonatingRW;
		const status = await getMeetingStatus(meetingId);
		const visible = canEdit || status === "completed";
		if (!visible) return empty;
		const [data, program] = await Promise.all([
			loadMinutes(meetingId),
			loadMinutesProgram(meetingId),
		]);
		return { visible: true, canEdit, data, program };
	});

/** Resolve the meeting's club and gate the caller to the club admin role. */
async function gateAdmin(meetingId: string): Promise<void> {
	const currentUser = await requireUser();
	const clubId = await getMeetingClubId(meetingId);
	await requireClubRole(currentUser.id, clubId, ["admin"]);
}

const setPresenceSchema = z.object({
	meetingId: uuid,
	memberId: uuid,
	status: attendanceStatus,
});

/** Set a member's presence status. ADMIN-ONLY — stays this way after #510: a
 *  Ballot Counter has no business editing the roster's attendance. Capability
 *  grants get enumerated, not widened (#464). */
export const setAttendance = createServerFn({ method: "POST" })
	.validator((input: unknown) => setPresenceSchema.parse(input))
	.handler(async ({ data }) => {
		await gateAdmin(data.meetingId);
		await assertAttendanceRecordable(data.meetingId);
		await setMemberPresence(data);
		return { ok: true as const };
	});

const addGuestSchema = z
	.object({
		meetingId: uuid,
		// Optional client-supplied id for the NEW guest row (#176 slice 2) — lets an
		// offline create replay idempotently. Ignored on the existing-guest path.
		id: uuid.optional(),
		guestId: uuid.optional(),
		newGuest: newGuestSchema.optional(),
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
		newGuest: newGuestSchema.optional(),
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
		newGuest: newGuestSchema.optional(),
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
		await clearAward(data);
		return { ok: true as const };
	});
