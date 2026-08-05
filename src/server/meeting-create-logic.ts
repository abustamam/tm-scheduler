// Shared per-meeting insert used by batch create (#184) and the #190 schedule
// top-up. Kept in a *-logic.ts module (no createServerFn) so it's directly
// testable and never dragged into the client bundle.
import { eq } from "drizzle-orm";
import type { db } from "#/db";
import { meetings, roleSlots } from "#/db/schema";
import { generateSlotRows, type SlotGenInput } from "#/lib/agenda";
import {
	pickSpeakerAndEvaluatorRoles,
	type RoleDefLite,
} from "#/lib/meeting-roles";

/**
 * What this module needs from a role definition: enough to generate the slots
 * (`SlotGenInput`) AND enough to work out which role is the Speaker and which
 * its paired Evaluator, so the slots can be linked at creation (#512).
 *
 * Deliberately NOT folded into `SlotGenInput`: `generateSlotRows` needs only the
 * narrow three fields, and widening it would force every fixture that calls it
 * to invent a category and sort order it does not use. Both production callers
 * here already `select()` the whole `role_definitions` row, so requiring the
 * richer shape at this boundary costs them nothing.
 */
export type MeetingSlotDefs = SlotGenInput & RoleDefLite;

type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export interface NewMeeting {
	clubId: string;
	scheduledAt: Date;
	/** Copied from the club default at insert (copy-at-insert). */
	lengthMinutes: number;
	location: string | null;
}

/**
 * Insert one meeting (plus role slots from the club template) idempotently:
 * `ON CONFLICT (club_id, scheduled_at) DO NOTHING`. Returns the new meeting id,
 * or `null` when a meeting already occupied that exact instant (or a concurrent
 * writer won the race) — the unique `(club_id, scheduled_at)` index is the
 * concurrency backstop for the read-triggered top-up. `theme`/`wordOfTheDay`/
 * `notes` are left blank; the caller passes an already-resolved `location`.
 */
export async function insertMeetingWithSlots(
	conn: DbOrTx,
	m: NewMeeting,
	defs: MeetingSlotDefs[],
): Promise<string | null> {
	const [row] = await conn
		.insert(meetings)
		.values({
			clubId: m.clubId,
			scheduledAt: m.scheduledAt,
			lengthMinutes: m.lengthMinutes,
			location: m.location,
			theme: null,
			wordOfTheDay: null,
			notes: null,
		})
		.onConflictDoNothing()
		.returning({ id: meetings.id });
	if (!row) return null;
	const slotRows = generateSlotRows(defs, row.id);
	if (slotRows.length > 0) {
		const inserted = await conn.insert(roleSlots).values(slotRows).returning({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
		});
		await linkEvaluatorsToSpeakers(conn, inserted, defs);
	}
	return row.id;
}

/**
 * Point each freshly-created Evaluator slot at the Speaker slot it evaluates
 * (#512).
 *
 * Pairing is positional here, and safely so: `generateSlotRows` has just emitted
 * `slotIndex` 0..n-1 contiguously per role, in one insert, so Speaker N and
 * Evaluator N genuinely correspond. That is NOT true of a meeting that has been
 * edited since — `applyRemoveSpeakerSlot` drops the highest UNCLAIMED slot of
 * each role independently, and `applyMoveSpeakerSlot` reorders speakers without
 * touching evaluators — which is exactly why the link is written down at birth
 * rather than inferred from indices later.
 *
 * Silent no-op when the club defines no evaluator-category role, or when the
 * speaker/evaluator roles cannot be identified: a meeting with unlinked slots is
 * the status quo, not a failure worth aborting a create over.
 */
export async function linkEvaluatorsToSpeakers(
	conn: DbOrTx,
	inserted: { id: string; roleDefinitionId: string; slotIndex: number }[],
	defs: MeetingSlotDefs[],
): Promise<void> {
	let speakerRoleId: string;
	let evaluatorRoleId: string | null;
	try {
		({ speakerRoleId, evaluatorRoleId } = pickSpeakerAndEvaluatorRoles(defs));
	} catch {
		return;
	}
	if (!evaluatorRoleId) return;

	const speakerByIndex = new Map(
		inserted
			.filter((s) => s.roleDefinitionId === speakerRoleId)
			.map((s) => [s.slotIndex, s.id]),
	);
	for (const evaluator of inserted) {
		if (evaluator.roleDefinitionId !== evaluatorRoleId) continue;
		const speakerId = speakerByIndex.get(evaluator.slotIndex);
		// An evaluator with no same-index speaker (the club's counts differ) is
		// left unlinked rather than pointed at an arbitrary speaker.
		if (!speakerId) continue;
		await conn
			.update(roleSlots)
			.set({ evaluatesSlotId: speakerId })
			.where(eq(roleSlots.id, evaluator.id));
	}
}
