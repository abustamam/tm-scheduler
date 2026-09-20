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
