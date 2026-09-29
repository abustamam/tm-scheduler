/**
 * New-member orientation (#940): the first-weeks checklist, derived.
 *
 * PURE and db-free on purpose. The loader (`src/server/orientation-logic.ts`)
 * reads raw FACTS about one membership and hands them here; every decision
 * about what counts as done lives in this file, where vitest can reach it
 * (a predicate inside a `createServerFn` handler or beside a `#/db` import is
 * unreachable from a unit test, the #519/#522 lesson `role-duties.ts` records).
 * Mentorship (#939) and the VPE stalled-members view (#942) build on this, so
 * `orientationItems` / `orientationView` are exported for them to reuse over
 * facts they load in bulk.
 *
 * ## The no-unverifiable-ticks rule (in the header of `role-duties.ts`)
 *
 * Three of the four items are DERIVED from rows the club already keeps: a path
 * enrollment, a speaker slot, a non-speaker slot. Only Base Camp is a
 * self-tick, and it may be one because nothing is suppressed by it: it reminds
 * nobody of anything and gates nothing, so a false tick costs only the member
 * who made it. Do not add a self-tick that hides a nudge someone else relies on.
 *
 * ## Cancelled meetings
 *
 * A slot in a CANCELLED meeting counts for nothing. The meeting did not happen
 * and will not, so signing up for one is not a first speech or a first role;
 * counting it would tick the item and then hide the checklist that was the
 * member's only prompt to sign up again. Past and future slots in scheduled or
 * completed meetings both count ("schedule your Ice Breaker" is done the moment
 * one is on the calendar).
 */

/** The meeting statuses a slot can sit in (`meeting_status` in schema.ts). */
export type OrientationMeetingStatus = "scheduled" | "cancelled" | "completed";

/** One slot the member holds: only what the derivation needs. */
export interface OrientationSlotFact {
	isSpeakerRole: boolean;
	meetingStatus: OrientationMeetingStatus;
}

/** Everything the checklist is derived from, for ONE membership. */
export interface OrientationFacts {
	/** `members.orientation_started_at`. Null ⇒ not in orientation at all. */
	startedAt: Date | null;
	/** `members.orientation_dismissed_at`: "I'm all set". */
	dismissedAt: Date | null;
	/** `members.basecamp_setup_at`: the one self-tick. */
	basecampSetupAt: Date | null;
	/** Live (non-archived) `path_enrollments` rows for the member's Person. */
	activePathCount: number;
	/** Slots assigned to this membership, in any meeting of the club. */
	slots: readonly OrientationSlotFact[];
}

export type OrientationItemKey =
	| "choose-path"
	| "ice-breaker"
	| "supporting-role"
	| "base-camp";

export interface OrientationItem {
	key: OrientationItemKey;
	label: string;
	/** One line under the label saying what "done" means. */
	hint: string;
	done: boolean;
	/** True only for the item the member ticks themselves (Base Camp). */
	selfTick: boolean;
}

/** Where the explainer (#941) lives, and its Base Camp section. */
export const PATHWAYS_EXPLAINER_HREF = "/resources/what-is-pathways";
export const PATHWAYS_EXPLAINER_SLUG = "what-is-pathways";
export const BASE_CAMP_SECTION_HASH = "base-camp";

/** A slot counts only when its meeting is not cancelled. */
export function slotCounts(slot: OrientationSlotFact): boolean {
	return slot.meetingStatus !== "cancelled";
}

export function hasChosenPath(facts: OrientationFacts): boolean {
	return facts.activePathCount > 0;
}

/** Any speaker slot in a non-cancelled meeting, past or future. */
export function hasSpeakerSlot(facts: OrientationFacts): boolean {
	return facts.slots.some((s) => s.isSpeakerRole && slotCounts(s));
}

/** Any NON-speaker slot (evaluator, functionary, leadership) likewise. */
export function hasSupportingSlot(facts: OrientationFacts): boolean {
	return facts.slots.some((s) => !s.isSpeakerRole && slotCounts(s));
}

export function hasSetUpBaseCamp(facts: OrientationFacts): boolean {
	return facts.basecampSetupAt !== null;
}

/** The four items, in the order the checklist shows them. */
export function orientationItems(facts: OrientationFacts): OrientationItem[] {
	return [
		{
			key: "choose-path",
			label: "Choose a path",
			hint: "Pick the Pathways path you'll work through.",
			done: hasChosenPath(facts),
			selfTick: false,
		},
		{
			key: "ice-breaker",
			label: "Schedule your Ice Breaker",
			hint: "Sign up for a speaking slot at a meeting.",
			done: hasSpeakerSlot(facts),
			selfTick: false,
		},
		{
			key: "supporting-role",
			label: "Take a supporting role",
			hint: "Timer, Ah-Counter, Grammarian or any other role.",
			done: hasSupportingSlot(facts),
			selfTick: false,
		},
		{
			key: "base-camp",
			label: "Set up Base Camp",
			hint: "Sign in to Base Camp and open your path. Tick it when done.",
			done: hasSetUpBaseCamp(facts),
			selfTick: true,
		},
	];
}

export interface OrientationView {
	/** `startedAt` is set. */
	inOrientation: boolean;
	dismissed: boolean;
	items: OrientationItem[];
	doneCount: number;
	total: number;
	/** Every item is done. */
	complete: boolean;
	/** Show the checklist: in orientation, not dismissed, not complete. */
	visible: boolean;
}

export function orientationView(facts: OrientationFacts): OrientationView {
	const items = orientationItems(facts);
	const doneCount = items.filter((i) => i.done).length;
	const complete = doneCount === items.length;
	const inOrientation = facts.startedAt !== null;
	const dismissed = facts.dismissedAt !== null;
	return {
		inOrientation,
		dismissed,
		items,
		doneCount,
		total: items.length,
		complete,
		visible: inOrientation && !dismissed && !complete,
	};
}
