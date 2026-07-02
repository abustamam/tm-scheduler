// Speaker-slot management DB logic, split out from `slots.ts` (a createServerFn
// module the guard test forbids from exporting db-touching functions).
// Integration-testable by mocking `#/db`.
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { meetings, roleDefinitions, roleSlots } from "#/db/schema";
import { pickSpeakerAndEvaluatorRoles } from "#/lib/meeting-roles";
import { logActivity } from "./activity";

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

export type SpeakerDetailsInput = {
	speechTitle?: string;
	pathwayPath?: string;
	projectName?: string;
	projectLevel?: string;
	minMinutes?: number;
	maxMinutes?: number;
};

export type NormalizedSpeakerDetails = {
	speechTitle: string;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
};

/** Normalize speaker details for persistence: blank/missing title → "TBA",
 *  blank optional strings → null, missing numbers → null. */
export function normalizeSpeakerDetails(
	input?: SpeakerDetailsInput,
): NormalizedSpeakerDetails {
	const title = input?.speechTitle?.trim();
	return {
		speechTitle: title && title.length > 0 ? title : "TBA",
		pathwayPath: input?.pathwayPath?.trim() || null,
		projectName: input?.projectName?.trim() || null,
		projectLevel: input?.projectLevel?.trim() || null,
		minMinutes: input?.minMinutes ?? null,
		maxMinutes: input?.maxMinutes ?? null,
	};
}
