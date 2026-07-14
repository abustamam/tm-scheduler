// Speaker-slot management DB logic, split out from `slots.ts` (a createServerFn
// module the guard test forbids from exporting db-touching functions).
// Integration-testable by mocking `#/db`.
import { and, eq, gt } from "drizzle-orm";
import { db } from "#/db";
import {
	meetings,
	memberAvailability,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	pairedRoleIds,
	pickSpeakerAndEvaluatorRoles,
} from "#/lib/meeting-roles";
import { normalizePresentationUrl } from "#/lib/presentation-url";
import { logActivity } from "./activity";
import { assertMeetingNotLocked } from "./meeting-authz-logic";

// Either the main db client or a drizzle transaction — so speech helpers can run
// inside a caller's transaction and commit atomically with the slot change.
type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

async function clubRoles(clubId: string) {
	const defs = await db
		.select({
			id: roleDefinitions.id,
			category: roleDefinitions.category,
			defaultCount: roleDefinitions.defaultCount,
			sortOrder: roleDefinitions.sortOrder,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
		})
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId));
	return pickSpeakerAndEvaluatorRoles(defs);
}

/** Next 0-based slotIndex for a (meeting, role) pair. */
function nextIndex(indices: number[]): number {
	return indices.length === 0 ? 0 : Math.max(...indices) + 1;
}

/** Add one Speaker slot (+ a paired Evaluator slot, count-parity). */
export async function applyAddSpeakerSlot(input: {
	meetingId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const { speakerRoleId, evaluatorRoleId } = await clubRoles(meeting.clubId);

	const existing = await db
		.select({
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
		})
		.from(roleSlots)
		.where(eq(roleSlots.meetingId, input.meetingId));
	const idxFor = (roleId: string) =>
		nextIndex(
			existing
				.filter((s) => s.roleDefinitionId === roleId)
				.map((s) => s.slotIndex),
		);

	await db.transaction(async (tx) => {
		await tx.insert(roleSlots).values({
			meetingId: input.meetingId,
			roleDefinitionId: speakerRoleId,
			slotIndex: idxFor(speakerRoleId),
		});
		if (evaluatorRoleId) {
			await tx.insert(roleSlots).values({
				meetingId: input.meetingId,
				roleDefinitionId: evaluatorRoleId,
				slotIndex: idxFor(evaluatorRoleId),
			});
		}
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { change: "speaker_added" },
		});
	});
	return { clubId: meeting.clubId };
}

/** The club's role defs in the shape `pairedRoleIds` needs, plus name/id. */
async function clubRoleDefs(clubId: string) {
	return db
		.select({
			id: roleDefinitions.id,
			name: roleDefinitions.name,
			category: roleDefinitions.category,
			defaultCount: roleDefinitions.defaultCount,
			sortOrder: roleDefinitions.sortOrder,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
		})
		.from(roleDefinitions)
		.where(eq(roleDefinitions.clubId, clubId));
}

/** Add one open slot of an arbitrary non-paired role to a meeting. Duplicates
 *  allowed (next slotIndex). Rejects the speaker/paired-evaluator roles (those
 *  go through the +/- speaker buttons) and roles from another club. */
export async function applyAddRoleSlot(input: {
	meetingId: string;
	roleDefinitionId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	assertMeetingNotLocked(meeting.status);

	const defs = await clubRoleDefs(meeting.clubId);
	const role = defs.find((d) => d.id === input.roleDefinitionId);
	if (!role) throw new Error("Role not found for this club.");
	if (pairedRoleIds(defs).has(role.id)) {
		throw new Error("Add speakers with the speaker controls.");
	}

	const existing = await db
		.select({ slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, input.meetingId),
				eq(roleSlots.roleDefinitionId, input.roleDefinitionId),
			),
		);
	const slotIndex = nextIndex(existing.map((s) => s.slotIndex));

	await db.transaction(async (tx) => {
		await tx.insert(roleSlots).values({
			meetingId: input.meetingId,
			roleDefinitionId: input.roleDefinitionId,
			slotIndex,
		});
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: {
				change: "role_added",
				roleDefinitionId: input.roleDefinitionId,
			},
		});
	});
	return { clubId: meeting.clubId };
}

/** Remove one unclaimed, non-paired slot from a meeting. Rejects a claimed slot
 *  (never destroys an assignment) and the speaker/paired-evaluator roles. */
export async function applyRemoveRoleSlot(input: {
	slotId: string;
	actorMemberId: string | null;
}) {
	const [slot] = await db
		.select({
			id: roleSlots.id,
			meetingId: roleSlots.meetingId,
			roleDefinitionId: roleSlots.roleDefinitionId,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			clubId: meetings.clubId,
			meetingStatus: meetings.status,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, input.slotId))
		.limit(1);
	if (!slot) throw new Error("Role not found.");
	assertMeetingNotLocked(slot.meetingStatus);
	if (slot.assignedMemberId || slot.status !== "open") {
		throw new Error("Release the role before removing it.");
	}

	const defs = await clubRoleDefs(slot.clubId);
	if (pairedRoleIds(defs).has(slot.roleDefinitionId)) {
		throw new Error("Remove speakers with the speaker controls.");
	}

	await db.transaction(async (tx) => {
		await tx.delete(roleSlots).where(eq(roleSlots.id, input.slotId));
		await logActivity(tx, {
			clubId: slot.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: slot.meetingId,
			detail: {
				change: "role_removed",
				roleDefinitionId: slot.roleDefinitionId,
			},
		});
	});
	return { clubId: slot.clubId };
}

/** Presence-based template backfill: for every upcoming meeting (scheduledAt >
 *  now), add one open slot of each standard (defaultCount >= 1), non-paired role
 *  the meeting has zero of. Never tops up counts, never adds speakers/paired
 *  evaluators, never touches past meetings. Idempotent. Returns how many
 *  meetings changed and the distinct role names added. */
export async function applyTemplateSyncToUpcomingMeetings(input: {
	clubId: string;
	actorMemberId: string | null;
}) {
	const defs = await clubRoleDefs(input.clubId);
	const paired = pairedRoleIds(defs);
	const standard = defs.filter((d) => d.defaultCount >= 1 && !paired.has(d.id));

	const upcoming = await db
		.select({ id: meetings.id })
		.from(meetings)
		.where(
			and(
				eq(meetings.clubId, input.clubId),
				gt(meetings.scheduledAt, new Date()),
			),
		);

	const rolesAdded = new Set<string>();
	let meetingsChanged = 0;

	await db.transaction(async (tx) => {
		for (const m of upcoming) {
			const present = await tx
				.select({ roleDefinitionId: roleSlots.roleDefinitionId })
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, m.id));
			const presentIds = new Set(present.map((s) => s.roleDefinitionId));
			const missing = standard.filter((d) => !presentIds.has(d.id));
			if (missing.length === 0) continue;

			await tx.insert(roleSlots).values(
				missing.map((d) => ({
					meetingId: m.id,
					roleDefinitionId: d.id,
					slotIndex: 0,
				})),
			);
			for (const d of missing) rolesAdded.add(d.name);
			await logActivity(tx, {
				clubId: input.clubId,
				actorMemberId: input.actorMemberId,
				action: "meeting_edit",
				targetType: "meeting",
				targetId: m.id,
				detail: {
					change: "template_sync",
					roleDefinitionIds: missing.map((d) => d.id),
				},
			});
			meetingsChanged += 1;
		}
	});

	return { meetingsChanged, rolesAdded: [...rolesAdded] };
}

/** Highest-index unclaimed (open, unassigned) slot id for a role, or null. */
function topUnclaimed(
	slots: {
		id: string;
		slotIndex: number;
		status: string;
		assignedMemberId: string | null;
	}[],
	roleId: string,
	roleOf: (id: string) => string,
): string | null {
	const open = slots
		.filter(
			(s) =>
				roleOf(s.id) === roleId && s.status === "open" && !s.assignedMemberId,
		)
		.sort((a, b) => b.slotIndex - a.slotIndex);
	return open[0]?.id ?? null;
}

/** Remove one unclaimed Speaker slot (+ one unclaimed Evaluator, best-effort). */
export async function applyRemoveSpeakerSlot(input: {
	meetingId: string;
	actorMemberId: string | null;
}) {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const { speakerRoleId, evaluatorRoleId } = await clubRoles(meeting.clubId);

	const slots = await db
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
		})
		.from(roleSlots)
		.where(eq(roleSlots.meetingId, input.meetingId));
	const roleOf = (id: string) =>
		slots.find((s) => s.id === id)?.roleDefinitionId ?? "";

	const speakerId = topUnclaimed(slots, speakerRoleId, roleOf);
	if (!speakerId) throw new Error("Release a speaker before removing a slot.");
	const evaluatorId = evaluatorRoleId
		? topUnclaimed(slots, evaluatorRoleId, roleOf)
		: null;

	await db.transaction(async (tx) => {
		await tx.delete(roleSlots).where(eq(roleSlots.id, speakerId));
		if (evaluatorId) {
			await tx.delete(roleSlots).where(eq(roleSlots.id, evaluatorId));
		}
		await logActivity(tx, {
			clubId: meeting.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { change: "speaker_removed" },
		});
	});
	return { clubId: meeting.clubId };
}

/** Swap a speaker slot's position with its neighbor (up = lower index). */
export async function applyMoveSpeakerSlot(input: {
	slotId: string;
	direction: "up" | "down";
	actorMemberId: string | null;
}) {
	const [target] = await db
		.select({
			id: roleSlots.id,
			meetingId: roleSlots.meetingId,
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
			clubId: meetings.clubId,
		})
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, input.slotId))
		.limit(1);
	if (!target) throw new Error("Speaker slot not found.");

	const siblings = await db
		.select({ id: roleSlots.id, slotIndex: roleSlots.slotIndex })
		.from(roleSlots)
		.where(
			and(
				eq(roleSlots.meetingId, target.meetingId),
				eq(roleSlots.roleDefinitionId, target.roleDefinitionId),
			),
		);
	const ordered = siblings.sort((a, b) => a.slotIndex - b.slotIndex);
	const pos = ordered.findIndex((s) => s.id === target.id);
	const neighbor =
		input.direction === "up" ? ordered[pos - 1] : ordered[pos + 1];
	if (!neighbor) throw new Error("No slot to swap with.");

	await db.transaction(async (tx) => {
		await tx
			.update(roleSlots)
			.set({ slotIndex: neighbor.slotIndex })
			.where(eq(roleSlots.id, target.id));
		await tx
			.update(roleSlots)
			.set({ slotIndex: target.slotIndex })
			.where(eq(roleSlots.id, neighbor.id));
		await logActivity(tx, {
			clubId: target.clubId,
			actorMemberId: input.actorMemberId,
			action: "meeting_edit",
			targetType: "meeting",
			targetId: target.meetingId,
			detail: { change: "speaker_reordered" },
		});
	});
	return { clubId: target.clubId };
}

// ---------------------------------------------------------------------------
// Speeches — first-class, Person-owned content (ADR-0009 / #79). A speaker slot
// references a speech via `role_slots.speech_id`; these helpers create/edit/
// unlink that pointer without ever destroying the speech itself.
// ---------------------------------------------------------------------------

// Field names mirror the legacy speaker-details form input, so existing callers
// pass the same shape; `speechTitle` maps to `speeches.title`.
export type SpeechInput = {
	speechTitle?: string;
	introduction?: string;
	pathwayPath?: string;
	projectName?: string;
	projectLevel?: string;
	minMinutes?: number;
	maxMinutes?: number;
	presentationUrl?: string;
};

export type SpeechContent = {
	title: string;
	introduction: string | null;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
	presentationUrl: string | null;
};

/**
 * Normalize raw speech form input to persistable content plus a `hasContent`
 * flag. `hasContent` is false for a pure-TBA / empty input (blank or "TBA" title
 * and no other field set) — the caller then leaves the slot's `speech_id` NULL
 * instead of creating a blank speech (mirrors the migration's empty-placeholder
 * rule and keeps "TBA" a derived, unstored state).
 */
export function normalizeSpeech(input?: SpeechInput): {
	content: SpeechContent;
	hasContent: boolean;
} {
	const title = input?.speechTitle?.trim() ?? "";
	const introduction = input?.introduction?.trim() || null;
	const pathwayPath = input?.pathwayPath?.trim() || null;
	const projectName = input?.projectName?.trim() || null;
	const projectLevel = input?.projectLevel?.trim() || null;
	const minMinutes = input?.minMinutes ?? null;
	const maxMinutes = input?.maxMinutes ?? null;
	const presentationUrl = normalizePresentationUrl(input?.presentationUrl);
	const hasOtherContent =
		introduction !== null ||
		pathwayPath !== null ||
		projectName !== null ||
		projectLevel !== null ||
		minMinutes !== null ||
		maxMinutes !== null ||
		presentationUrl !== null;
	const hasRealTitle = title.length > 0 && title !== "TBA";
	return {
		content: {
			title: title.length > 0 ? title : "TBA",
			introduction,
			pathwayPath,
			projectName,
			projectLevel,
			minMinutes,
			maxMinutes,
			presentationUrl,
		},
		hasContent: hasRealTitle || hasOtherContent,
	};
}

/**
 * Attach a new Person-owned Speech to a freshly-claimed speaker slot and point
 * the slot at it. Pure-TBA / empty input creates nothing (slot stays TBA,
 * `speech_id` NULL). Returns the new speech id, or null when nothing was created.
 * Assumes the slot has no speech yet (a just-claimed slot).
 */
export async function attachSpeechToSlot(
	conn: DbOrTx,
	args: { slotId: string; personId: string; input?: SpeechInput },
): Promise<string | null> {
	const { content, hasContent } = normalizeSpeech(args.input);
	if (!hasContent) return null;
	const [row] = await conn
		.insert(speeches)
		.values({ personId: args.personId, ...content })
		.returning({ id: speeches.id });
	if (!row) throw new Error("Failed to create speech.");
	await conn
		.update(roleSlots)
		.set({ speechId: row.id })
		.where(eq(roleSlots.id, args.slotId));
	return row.id;
}

/**
 * Unlink a slot's speech (set `speech_id` NULL). The speech row is NOT deleted —
 * it persists Person-owned and unscheduled (ADR-0009 pointer lifecycle). Safe to
 * call when the slot has no speech.
 */
export async function unlinkSlotSpeech(
	conn: DbOrTx,
	slotId: string,
): Promise<void> {
	await conn
		.update(roleSlots)
		.set({ speechId: null })
		.where(eq(roleSlots.id, slotId));
}

/**
 * Apply the reassign pointer rule (ADR-0009): when a speaker slot moves to a
 * *different* Person, unlink the speech (it persists Person-owned and
 * unscheduled); moving within the same Person keeps the speech attached. Returns
 * whether the speech was unlinked. Call after repointing the slot's assignee.
 */
export async function reassignSlotSpeech(
	conn: DbOrTx,
	args: {
		slotId: string;
		fromPersonId: string | null;
		toPersonId: string | null;
	},
): Promise<boolean> {
	if (args.fromPersonId === args.toPersonId) return false;
	await unlinkSlotSpeech(conn, args.slotId);
	return true;
}

/**
 * Self-claiming a role is the strongest "I'm coming" statement, so it clears
 * the claimant's decline flag ("not going" row) for that meeting — spec
 * 2026-07-13. Admin assignments (actor ≠ member, or no actor) must NOT
 * silently erase the member's own absence statement, so they no-op.
 *
 * Logs an `availability_clear` activity (#211) when a row was actually
 * deleted, mirroring the explicit `clearAvailability` server fn — but only
 * then, so a claim by a member with no NA row doesn't spam the activity feed.
 */
export async function clearAvailabilityOnSelfClaim(
	tx: DbOrTx,
	args: {
		memberId: string;
		actorMemberId: string | null;
		meetingId: string;
		clubId: string;
	},
): Promise<void> {
	if (args.actorMemberId === null || args.memberId !== args.actorMemberId)
		return;
	const deleted = await tx
		.delete(memberAvailability)
		.where(
			and(
				eq(memberAvailability.memberId, args.memberId),
				eq(memberAvailability.meetingId, args.meetingId),
			),
		)
		.returning({ id: memberAvailability.id });
	if (deleted.length === 0) return;
	await logActivity(tx, {
		clubId: args.clubId,
		actorMemberId: args.memberId,
		action: "availability_clear",
		targetType: "meeting",
		targetId: args.meetingId,
		detail: { via: "claim" },
	});
}

/**
 * Reassign a slot to a different member, atomically (ADR-0005). MUST run inside
 * a caller-provided transaction: it re-reads the slot **with a FOR UPDATE row
 * lock** so the read that decides the speech keep-or-unlink and the write happen
 * as one serialized unit — a concurrent release/claim/reassign can no longer be
 * silently overwritten from a stale prior-assignee read.
 *
 * Deliberately allows assigning an *open* slot (admin/VPE assign-to-member
 * flows) — the guarantee here is atomicity, not a status precondition. Returns
 * the slot's club id so the caller can trust-guard/log against it.
 */
export async function reassignSlotCore(
	tx: DbOrTx,
	args: { slotId: string; memberId: string; actorMemberId: string | null },
): Promise<{ clubId: string }> {
	// Lock only the role_slots row; FOR UPDATE on the joined role_definitions /
	// meetings catalog rows is unnecessary (they don't change under us).
	const [slot] = await tx
		.select({
			id: roleSlots.id,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			clubId: meetings.clubId,
			meetingStatus: meetings.status,
			meetingId: roleSlots.meetingId,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, args.slotId))
		.limit(1)
		.for("update", { of: roleSlots });
	if (!slot) throw new Error("Role not found.");
	// Lock choke point (#150): reassign/claim-to-member on a completed meeting is
	// rejected here under the row lock.
	assertMeetingNotLocked(slot.meetingStatus);

	// Reassigning a speaker slot to a *different* Person unlinks the speech; the
	// old speech persists Person-owned and unscheduled (ADR-0009). Within the
	// same Person it keeps the speech. Both persons are read under the lock.
	const personOf = async (memberId: string | null) =>
		memberId
			? ((
					await tx
						.select({ personId: members.personId })
						.from(members)
						.where(eq(members.id, memberId))
						.limit(1)
				)[0]?.personId ?? null)
			: null;
	const fromPerson = slot.isSpeakerRole
		? await personOf(slot.assignedMemberId)
		: null;
	const toPerson = slot.isSpeakerRole ? await personOf(args.memberId) : null;

	// New holder hasn't been confirmed → back to "claimed".
	await tx
		.update(roleSlots)
		.set({
			assignedMemberId: args.memberId,
			assignedGuestId: null,
			status: "claimed",
		})
		.where(eq(roleSlots.id, args.slotId));

	await clearAvailabilityOnSelfClaim(tx, {
		memberId: args.memberId,
		actorMemberId: args.actorMemberId,
		meetingId: slot.meetingId,
		clubId: slot.clubId,
	});

	// Unlink the speech only when the Person actually changed.
	if (slot.isSpeakerRole) {
		await reassignSlotSpeech(tx, {
			slotId: args.slotId,
			fromPersonId: fromPerson,
			toPersonId: toPerson,
		});
	}

	await logActivity(tx, {
		clubId: slot.clubId,
		actorMemberId: args.actorMemberId,
		action: "reassign",
		targetType: "slot",
		targetId: args.slotId,
		detail: {
			fromMemberId: slot.assignedMemberId,
			memberId: args.memberId,
		},
	});

	return { clubId: slot.clubId };
}

/**
 * Edit the speech attached to a speaker slot (the "Edit speech" flow):
 *  - real content + slot already has a speech → update that speech in place.
 *  - real content + no speech yet → create one owned by `personId` and link it.
 *  - blank/TBA input + slot has a speech → unlink it (the speech persists).
 *  - blank/TBA input + no speech → no-op.
 * `personId` is the current assignee's Person (required to own a new speech).
 */
export async function editSlotSpeech(
	conn: DbOrTx,
	args: {
		slotId: string;
		personId: string;
		currentSpeechId: string | null;
		input?: SpeechInput;
	},
): Promise<void> {
	const { content, hasContent } = normalizeSpeech(args.input);
	if (!hasContent) {
		if (args.currentSpeechId) await unlinkSlotSpeech(conn, args.slotId);
		return;
	}
	if (args.currentSpeechId) {
		await conn
			.update(speeches)
			.set({ ...content, updatedAt: new Date() })
			.where(eq(speeches.id, args.currentSpeechId));
		return;
	}
	await attachSpeechToSlot(conn, {
		slotId: args.slotId,
		personId: args.personId,
		input: args.input,
	});
}
