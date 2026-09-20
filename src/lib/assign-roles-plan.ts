/**
 * What an `assign_roles` call SAYS it is doing (#809).
 *
 * Pure: no `#/db` import, no server module, nothing async. That is the point
 * rather than a nicety — `src/server/mcp/tools/assign-roles.ts` imports `#/db`
 * at load, so a vitest file cannot import the tool at all without a database,
 * and every sentence a human reads before approving a batch would be
 * unassertable if it were written there. `CODING_STANDARDS.md` ("Test
 * coverage") names that shape; `src/lib/mcp-limits.ts` was moved out of the
 * tool modules for the same reason.
 *
 * The tool returns the plan and applies it in the SAME call (no confirm page —
 * see the tool's header for why this write and `record_guest_book`'s are
 * judged differently). So the plan is not a thing a human approves before the
 * write; it is the account of what the write did, and the only place an
 * officer can see that Alex came off a role they did not mention.
 */

/** How a slot with no assignee reads on both sides of the arrow. */
export const OPEN_LABEL = "open";

/**
 * `assign_roles`' up-front lock refusal, RE-EXPORTED from
 * `#/lib/meeting-lifecycle` since #808.
 *
 * It was declared here when `assign_roles` was the only tool that raised it.
 * `upsert_agendas` raises the same item about the same fact, and importing it
 * out of THIS module made #808's planner depend on #809's for a sentence about
 * neither — so it moved to the module that owns the lock, beside
 * `isMeetingLocked` and the banner copy it is deliberately distinct from. The
 * re-export is what let that move edit no importer; `export … from` is the same
 * symbol, so the two spellings cannot drift into two sentences.
 *
 * `reassignSlotCore` and `releaseSlotCore` each assert the lock again under the
 * slot's row lock, raising `MEETING_LOCKED_MESSAGE` — for those two arms that
 * assertion is the ENFORCEMENT and this blocking item is the explanation.
 *
 * All THREE apply arms assert it, but only since #809: `applyAssignGuestToSlot`
 * named `assertMeetingNotLocked` nowhere and did not read `meetings.status` at
 * all — nor did `assignGuestSlot`, its browser caller — so an admin could put a
 * visitor on a completed meeting's agenda, and this blocking item was the whole
 * of the lock gate on that arm. The review of #809 found it while trying to
 * state where each arm enforces the lock; the gate now lives in the seam beside
 * its siblings, and `guests.integration.test.ts` executes it.
 */
export { MEETING_LOCKED_BLOCKING_MESSAGE } from "./meeting-lifecycle";

/** One planned change, in the order the caller sent it. */
export interface AssignmentPlanLine {
	/** Index into the call's `assignments` array. */
	index: number;
	slotId: string;
	/** The role's display name, e.g. `Timer`. */
	role: string;
	/** 0-based position within that role, for a role with several slots. */
	slotIndex: number;
	/** Prior holder's name, or `open`. */
	from: string;
	/** New holder's name, or `open`. */
	to: string;
	/** `Alex → Sam`. The line an officer reads. */
	change: string;
	/**
	 * Where the slot's linked speech goes, when this change unlinks one.
	 *
	 * ABSENT when nothing happens to a speech, which is the overwhelmingly
	 * common case. A release unlinks a speech and never deletes it (ADR-0009):
	 * it persists Person-owned and unscheduled. Saying nothing would let the
	 * plan read like data loss to the one person in a position to notice.
	 */
	speech?: string;
}

/** `Alex → Sam`. */
export function changeLabel(from: string, to: string): string {
	return `${from} → ${to}`;
}

/**
 * Where an unlinked speech ends up, in one sentence.
 *
 * Only a MEMBER can hold a speech — speeches are Person-owned (ADR-0009) and
 * assigning a guest clears the link — so the holder named here is always the
 * member coming off the slot.
 */
export function speechSentence(holder: string, title: string): string {
	return `${holder}'s speech "${title}" returns to ${holder}'s unscheduled speeches.`;
}

/** Build one plan line. `speechTitle` is the title of a speech this change unlinks. */
export function planLine(input: {
	index: number;
	slotId: string;
	role: string;
	slotIndex: number;
	from: string;
	to: string;
	/** Title of the linked speech this change unlinks, or null for neither. */
	unlinksSpeechTitled?: string | null;
}): AssignmentPlanLine {
	const line: AssignmentPlanLine = {
		index: input.index,
		slotId: input.slotId,
		role: input.role,
		slotIndex: input.slotIndex,
		from: input.from,
		to: input.to,
		change: changeLabel(input.from, input.to),
	};
	// A speech can only come off a member, so `from` is that member's name.
	if (input.unlinksSpeechTitled) {
		line.speech = speechSentence(input.from, input.unlinksSpeechTitled);
	}
	return line;
}

/** One slot named more than once in a single call. */
export interface DuplicateSlot {
	slotId: string;
	/** Every index that named it, ascending. The first is the one that would lose. */
	indexes: number[];
}

/**
 * Slots named more than once in one call.
 *
 * Last-write-wins on a batch nobody can see is a surprise: two instructions
 * about one slot means one of them was a mistake, and applying the later one
 * silently picks which. The caller can send one instead, so this blocks.
 *
 * Returns a group per duplicated slot rather than one item per extra line, so
 * a caller is told which lines disagree rather than only which one lost.
 */
export function findDuplicateSlots(slotIds: string[]): DuplicateSlot[] {
	const seen = new Map<string, number[]>();
	for (const [index, slotId] of slotIds.entries()) {
		const at = seen.get(slotId);
		if (at) at.push(index);
		else seen.set(slotId, [index]);
	}
	return [...seen.entries()]
		.filter(([, indexes]) => indexes.length > 1)
		.map(([slotId, indexes]) => ({ slotId, indexes }));
}
