import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import {
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import { logActivity } from "./activity";
import {
	assertClubNotArchived,
	getSessionUser,
	requireClubRole,
	requireMeetingAgendaEditor,
	requireMemberInClub,
	requireUser,
} from "./guards";
import { PLAN_ACCEPTING_CANCELLED } from "./meeting-write-options";
import {
	applyAddRoleSlot,
	applyAddSpeakerSlot,
	applyMoveEvaluatorSlot,
	applyMoveSpeakerSlot,
	applyRemoveRoleSlot,
	applyRemoveSpeakerSlot,
	claimSlotCore,
	confirmSlotCore,
	editSlotSpeech,
	reassignSlotCore,
	releaseSlotCore,
} from "./slots-logic";
import {
	speakerDetailsSchema,
	speakerDetailsUpdateSchema,
} from "./speaker-details-schema";
import {
	requestWriteActorWithProof,
	requireSessionActor,
} from "./write-actor-logic";

const claimSchema = z.object({
	slotId: z.string().uuid(),
	memberId: z.string().uuid(),
	actorMemberId: z.string().uuid(),
	speakerDetails: speakerDetailsSchema.optional(),
});

/** Claim an open slot for the given member. Speaker details are optional; a
 *  blank/missing speech title defaults to "TBA".
 *  FILL-BLANK (#763, ADR-0026) — no session required to claim an OPEN role for
 *  yourself. Without one the claim may not be for someone else (bar the
 *  meeting's TMOD, Phase 2) or over the member's own `not_coming`; with one it
 *  is the sheet rule, any member for any member.
 *
 *  The write, the archive gate, the lock check and that fill-blank gate all
 *  live in `claimSlotCore` (#825), where vitest can execute them. Returns the
 *  proof so the season grid offers "Undo" (a session-gated release) only to a
 *  caller who can use it. */
export const claimSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => claimSchema.parse(input))
	.handler(async ({ data }) => {
		// Cheap pre-read solely to resolve clubId for the trust guard; the
		// authoritative read-and-write happens in `claimSlotCore`.
		const [slot] = await db
			.select({ clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}
		// Trust guard: memberId must be a roster member of this club.
		await requireMemberInClub(data.memberId, slot.clubId);
		// Actor provenance (#396): a signed-in caller is credited as themselves; an
		// anonymous one keeps the name-pick, club-scoped to THIS slot's club. The
		// proof says which (#763) and is what `claimSlotCore` gates on.
		//
		// Null only for an impersonating superadmin (the asserted id is required
		// and club-scoped, so "nobody to credit" cannot arise here), and a null
		// carries no proof — which the core would read as ungated. So that caller
		// goes through the session gate instead: `read_write` is admitted and
		// credited as themselves, `read_only` is refused (ADR-0020: write-blind).
		const actor = (await requestWriteActorWithProof({
			clubId: slot.clubId,
			claimedActorMemberId: data.actorMemberId,
		})) ?? {
			memberId: (await requireSessionActor({ clubId: slot.clubId })).memberId,
			proof: "session" as const,
		};

		await db.transaction((tx) =>
			claimSlotCore(tx, {
				slotId: data.slotId,
				memberId: data.memberId,
				actorMemberId: actor.memberId,
				speakerDetails: data.speakerDetails,
				proof: actor.proof,
			}),
		);

		return { ok: true as const, proof: actor.proof };
	});

// No `actorMemberId` on the wire (#763): the actor is the caller's session.
// An older client still sends one; zod drops it.
const releaseSchema = z.object({
	slotId: z.string().uuid(),
});

/** Release a slot back to open. Any SIGNED-IN member of the club may release any
 *  slot (the sheet rule); the activity log records who did.
 *  AUTHED (#763, ADR-0026) — releasing takes a role away from someone, so an
 *  unverified name-pick may not do it.
 *
 *  The write, the archive gate and the lock check all live in
 *  `releaseSlotCore` since #809, so vitest can execute them; what stays here is
 *  the one thing that cannot move, `requireSessionActor`. It is a REQUEST-scoped
 *  read, and `assign_roles` calls the same core with an actor it resolved from a
 *  bearer token instead.
 *
 *  The gate refuses, in order of what the caller can fix: no session
 *  (`SIGN_IN_REQUIRED_MESSAGE`), a session with no active membership here, and
 *  an archived club — before any transaction. The core re-asserts the archive
 *  under its row lock. */
export const releaseSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => releaseSchema.parse(input))
	.handler(async ({ data }) => {
		// Cheap pre-read solely to resolve clubId for the actor guard; the
		// authoritative read-and-write happens under a row lock in
		// `releaseSlotCore`. Same shape as `reassignSlot` below.
		const [slot] = await db
			.select({ clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}

		// The session gate (#763), against THIS slot's club. Sheet-parity model —
		// any signed-in club member may release/clear any slot; the activity log
		// records who did it (mirrors reassignSlot). Null only for a `read_write`
		// impersonating superadmin, whom `logActivity` records as themselves.
		const { memberId: actorMemberId } = await requireSessionActor({
			clubId: slot.clubId,
		});

		await db.transaction((tx) =>
			releaseSlotCore(tx, {
				slotId: data.slotId,
				actorMemberId,
				proof: "session",
			}),
		);

		return { ok: true as const };
	});

const confirmSchema = z.object({
	slotId: z.string().uuid(),
	/** The holder confirming for THEMSELVES (#661) — the public arm, verified
	 *  against `role_slots.assigned_member_id`. Omitted by the officer surface,
	 *  which vouches for someone else and stays session-gated. Its presence is
	 *  what selects the arm; see `confirmSlotCore`. */
	memberId: z.string().uuid().optional(),
});

/** Confirm a claimed slot — either the slot's own holder saying yes, or a club
 *  admin/VPE vouching for them (#661).
 *  MIXED: the officer arm requires a VPE/admin session; the holder arm is
 *  FILL-BLANK (#763, ADR-0026) — session-less, unless the holder's answer is
 *  `not_coming`, which only the holder's own session may contradict. The whole
 *  gate — that one and the archive check included — lives in `confirmSlotCore`
 *  where a test can reach it, and where `setPlannedAttendance`'s confirm meets
 *  it too. */
export const confirmSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => confirmSchema.parse(input))
	.handler(async ({ data }) => {
		// `getSessionUser`, not `requireUser`: an anonymous holder is a first-class
		// caller here, for a blank (#763: not over their own `not_coming`). The
		// officer arm still refuses a null session itself, and the holder arm
		// derives its proof from this same session inside `confirmSlotCore`.
		const currentUser = await getSessionUser();
		return confirmSlotCore({
			slotId: data.slotId,
			sessionUserId: currentUser?.id ?? null,
			selfMemberId: data.memberId ?? null,
		});
	});

const unconfirmSchema = z.object({
	slotId: z.string().uuid(),
});

/** Un-confirm a slot back to claimed. Only club admins/VPEs may do this.
 *  AUTHED — requires VPE/admin session. */
export const unconfirmSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => unconfirmSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();

		const [slot] = await db
			.select({
				id: roleSlots.id,
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
				clubId: meetings.clubId,
				meetingStatus: meetings.status,
			})
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}
		// By write class (#1135), in two steps that keep the order each status has
		// always had. The lock refuses HERE, before the role gate, so any caller of
		// a completed meeting hears that it is locked; this call accepts `cancelled`
		// (`PLAN_ACCEPTING_CANCELLED`) for the reason the second one runs later.
		assertMeetingAccepts(slot.meetingStatus, "plan", PLAN_ACCEPTING_CANCELLED);

		// The actor is the resolved admin membership — never the client (#396).
		const membership = await requireClubRole(currentUser.id, slot.clubId, [
			"admin",
		]);
		// #1085. The page hides this on a cancelled meeting, and a stale tab or a
		// direct call should not be able to edit a meeting nobody can see. AFTER
		// the role gate, unlike the lock above (which predates it): a cancelled
		// meeting is hidden from members, so a caller outside the club must be
		// refused for who they are, not told the meeting is cancelled. The plain
		// class call: it refuses a completed meeting too, which the call above has
		// already done.
		assertMeetingAccepts(slot.meetingStatus, "plan");

		return db.transaction(async (tx) => {
			// Conditional UPDATE: only flips 'confirmed' → 'claimed'.
			const updated = await tx
				.update(roleSlots)
				.set({ status: "claimed" })
				.where(
					and(eq(roleSlots.id, data.slotId), eq(roleSlots.status, "confirmed")),
				)
				.returning({ id: roleSlots.id });

			if (updated.length === 0) {
				throw new Error("Slot was not confirmed.");
			}

			await logActivity(tx, {
				clubId: slot.clubId,
				actorMemberId: membership.id,
				action: "release",
				targetType: "slot",
				targetId: data.slotId,
				detail: { unconfirmed: true },
			});

			return { ok: true as const };
		});
	});

// No `actorMemberId` on the wire (#763): the actor is the caller's session.
const reassignSchema = z.object({
	slotId: z.string().uuid(),
	memberId: z.string().uuid(),
});

/** Reassign a claimed slot to a different member. Any SIGNED-IN member of the
 *  club may (the sheet rule); the target must be on this club's roster.
 *  AUTHED (#763, ADR-0026) — reassigning takes a role away from its holder.
 *  The archive gate lives in `reassignSlotCore` (#825); `requireSessionActor`
 *  also refuses an archived club before any transaction. */
export const reassignSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => reassignSchema.parse(input))
	.handler(async ({ data }) => {
		// Cheap pre-read solely to resolve clubId for the trust guards; the
		// authoritative read-and-write happens under a row lock in
		// reassignSlotCore (ADR-0005 atomicity — this row may change before the tx).
		const [slot] = await db
			.select({ clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}

		// The session gate (#763), then the target: a member id off the wire, so
		// it is checked against THIS club's roster.
		const { memberId: actorMemberId } = await requireSessionActor({
			clubId: slot.clubId,
		});
		await requireMemberInClub(data.memberId, slot.clubId);

		await db.transaction((tx) =>
			reassignSlotCore(tx, {
				slotId: data.slotId,
				memberId: data.memberId,
				actorMemberId,
				proof: "session",
			}),
		);

		return { ok: true as const };
	});

// No `actorMemberId` on the wire (#763): the actor is the caller's session.
const updateSpeakerDetailsSchema = z.object({
	slotId: z.string().uuid(),
	// The TRUNCATING variant, not the rejecting one `claimSlot` uses. The edit
	// sheet prefills and resubmits every field, so a value stored before #522's
	// caps must not block edits to the others — see `#/lib/speaker-limits`.
	speakerDetails: speakerDetailsUpdateSchema,
});

/** Edit a speaker slot's speech details. Blank title → "TBA". Any SIGNED-IN
 *  member of the club may (the sheet rule), and it is logged as a
 *  `meeting_edit` with the before and after title and project.
 *  AUTHED (#763, ADR-0026) — it rewrites somebody's speech, and until #763 did
 *  so with no session and no trace. */
export const updateSpeakerDetails = createServerFn({ method: "POST" })
	.validator((input: unknown) => updateSpeakerDetailsSchema.parse(input))
	.handler(async ({ data }) => {
		const [slot] = await db
			.select({
				id: roleSlots.id,
				isSpeakerRole: roleDefinitions.isSpeakerRole,
				clubId: meetings.clubId,
				meetingId: roleSlots.meetingId,
				meetingStatus: meetings.status,
				speechId: roleSlots.speechId,
				assignedMemberId: roleSlots.assignedMemberId,
				personId: members.personId,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);

		if (!slot) {
			throw new Error("Role not found.");
		}
		// The session gate first (#763), before the slot's own checks (speaker
		// role, lock, assignee), so an anonymous caller hears "sign in" rather
		// than what is wrong with the slot. It also refuses an archived club.
		const { memberId: actorMemberId } = await requireSessionActor({
			clubId: slot.clubId,
		});
		// #555. Redundant with the gate above for every arm it admits, and kept
		// deliberately: it is the call `public-readers-archive-gate`'s WRITE_GATES
		// row pins in this file, and it outlives a change to that gate.
		await assertClubNotArchived(slot.clubId);
		// By write class (#1135): completed says locked, cancelled says cancelled.
		// #1057. A cancelled meeting keeps every assignment until restored, and a
		// blank input here UNLINKS the speech (`editSlotSpeech`), which a restore
		// cannot bring back — on a page that is read-only, so the holder could not
		// put it right either.
		assertMeetingAccepts(slot.meetingStatus, "plan");
		if (!slot.isSpeakerRole) {
			throw new Error("Only speaker roles have speech details.");
		}
		// A speech is Person-owned, so it needs an assignee to own it.
		if (!slot.assignedMemberId || !slot.personId) {
			throw new Error("Assign a member before adding speech details.");
		}
		await db.transaction(async (tx) => {
			const before = await speechDetails(tx, slot.speechId);
			await editSlotSpeech(tx, {
				slotId: data.slotId,
				personId: slot.personId as string,
				currentSpeechId: slot.speechId,
				input: data.speakerDetails,
			});
			// Re-read through the SLOT: an edit can create a speech (none before)
			// or unlink one (blank input), so the after-speech is not necessarily
			// the one we started with.
			const [after] = await tx
				.select({ speechId: roleSlots.speechId })
				.from(roleSlots)
				.where(eq(roleSlots.id, data.slotId))
				.limit(1);
			const afterSpeechId = after?.speechId ?? null;
			await logActivity(tx, {
				clubId: slot.clubId,
				actorMemberId,
				action: "meeting_edit",
				targetType: "meeting",
				targetId: slot.meetingId,
				detail: {
					change: "speaker_details",
					slotId: data.slotId,
					speechId: afterSpeechId ?? slot.speechId,
					before,
					after: await speechDetails(tx, afterSpeechId),
					proof: "session",
				},
			});
		});

		return { ok: true as const };
	});

/** The two speech fields `updateSpeakerDetails` logs before and after (#763).
 *  A slot with no speech reads as both null. */
async function speechDetails(
	conn: Pick<typeof db, "select">,
	speechId: string | null,
): Promise<{ title: string | null; projectId: string | null }> {
	if (!speechId) return { title: null, projectId: null };
	const [row] = await conn
		.select({ title: speeches.title, projectId: speeches.projectId })
		.from(speeches)
		.where(eq(speeches.id, speechId))
		.limit(1);
	return { title: row?.title ?? null, projectId: row?.projectId ?? null };
}

// No `actorMemberId` on the wire (#396): the agenda-editor guard already knows
// who the caller is — the session's admin membership, or the self-asserted TMOD
// it verified against the meeting's TMOD slot — and that is what gets credited.
const speakerSlotSchema = z.object({
	meetingId: z.string().uuid(),
	/** Self-asserted TMOD member id (public page). Null for authed admin. */
	selfMemberId: z.string().uuid().nullable().optional(),
});

/** Admin/VPE OR the meeting's self-asserted TMOD: add a speaker slot
 *  (+ paired evaluator). AUTHED or self-assert (ADR-0010). */
export const addSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => speakerSlotSchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireMeetingAgendaEditor({
			meetingId: data.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyAddSpeakerSlot({
			meetingId: data.meetingId,
			actorMemberId: authz.actorMemberId,
		});
	});

/** Admin/VPE OR the meeting's self-asserted TMOD: remove an unclaimed speaker
 *  slot (+ unclaimed evaluator). AUTHED or self-assert (ADR-0010). */
export const removeSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => speakerSlotSchema.parse(input))
	.handler(async ({ data }) => {
		const authz = await requireMeetingAgendaEditor({
			meetingId: data.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyRemoveSpeakerSlot({
			meetingId: data.meetingId,
			actorMemberId: authz.actorMemberId,
		});
	});

const moveSpeakerSchema = z.object({
	slotId: z.string().uuid(),
	direction: z.enum(["up", "down"]),
	/** Self-asserted TMOD member id (public page). Null for authed admin. */
	selfMemberId: z.string().uuid().nullable().optional(),
});

/** Admin/VPE OR the meeting's self-asserted TMOD: reorder a speaker slot up/down
 *  (swaps slotIndex, then re-points evaluator links positionally). AUTHED or
 *  self-assert (ADR-0010). */
export const moveSpeakerSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => moveSpeakerSchema.parse(input))
	.handler(async ({ data }) => {
		const [row] = await db
			.select({ meetingId: roleSlots.meetingId })
			.from(roleSlots)
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);
		if (!row) throw new Error("Speaker slot not found.");
		const authz = await requireMeetingAgendaEditor({
			meetingId: row.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyMoveSpeakerSlot({
			slotId: data.slotId,
			direction: data.direction,
			actorMemberId: authz.actorMemberId,
		});
	});

/** Admin/VPE OR the meeting's self-asserted TMOD: reorder a paired-evaluator
 *  slot up/down (swaps slotIndex, then re-points the links so Evaluator N
 *  evaluates Speaker N). AUTHED or self-assert (ADR-0010). */
export const moveEvaluatorSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => moveSpeakerSchema.parse(input))
	.handler(async ({ data }) => {
		const [row] = await db
			.select({ meetingId: roleSlots.meetingId })
			.from(roleSlots)
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);
		if (!row) throw new Error("Evaluator slot not found.");
		const authz = await requireMeetingAgendaEditor({
			meetingId: row.meetingId,
			selfMemberId: data.selfMemberId ?? null,
		});
		return applyMoveEvaluatorSlot({
			slotId: data.slotId,
			direction: data.direction,
			actorMemberId: authz.actorMemberId,
		});
	});

const addRoleSlotSchema = z.object({
	meetingId: z.string().uuid(),
	roleDefinitionId: z.string().uuid(),
});

/** Admin/VPE: add one arbitrary non-paired role slot to a meeting. AUTHED. */
export const addRoleSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => addRoleSlotSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const [row] = await db
			.select({ clubId: meetings.clubId })
			.from(meetings)
			.where(eq(meetings.id, data.meetingId))
			.limit(1);
		if (!row) throw new Error("Meeting not found.");
		const membership = await requireClubRole(currentUser.id, row.clubId, [
			"admin",
		]);
		return applyAddRoleSlot({
			meetingId: data.meetingId,
			roleDefinitionId: data.roleDefinitionId,
			actorMemberId: membership.id,
		});
	});

const removeRoleSlotSchema = z.object({
	slotId: z.string().uuid(),
});

/** Admin/VPE: remove one unclaimed non-paired role slot. AUTHED. */
export const removeRoleSlot = createServerFn({ method: "POST" })
	.validator((input: unknown) => removeRoleSlotSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const [row] = await db
			.select({ clubId: meetings.clubId })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(eq(roleSlots.id, data.slotId))
			.limit(1);
		if (!row) throw new Error("Role not found.");
		const membership = await requireClubRole(currentUser.id, row.clubId, [
			"admin",
		]);
		return applyRemoveRoleSlot({
			slotId: data.slotId,
			actorMemberId: membership.id,
		});
	});
