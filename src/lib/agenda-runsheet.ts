import { assigneeDisplayName } from "./agenda";

/** Green/yellow/red timer-card marks, in minutes (e.g. 5, 6, 7). */
export type TimingMarks = { green: number; yellow: number; red: number };

/**
 * The minimal slot shape the run-of-show needs. The real slots returned by
 * `loadMeetingDetail` (src/server/meetings.ts) structurally satisfy this.
 */
export type AgendaSlot = {
	id: string;
	roleName: string;
	category: string;
	isSpeakerRole: boolean;
	slotIndex: number;
	assigneeName: string | null;
	/** True when the assignee is a non-member guest (#151) — renders "· Guest". */
	assigneeIsGuest?: boolean;
	speechTitle: string | null;
	projectLevel: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
	/** Optional link to the speaker's own slides/deck (#175). */
	presentationUrl?: string | null;
	evaluatesSlotId: string | null;
	evaluates: { speakerName: string | null } | null;
};

/** A slot's rendered assignee name (with the "· Guest" marker for guests, #151),
 *  or the OPEN placeholder when unassigned. */
export function assigneeDisplay(slot: {
	assigneeName: string | null;
	assigneeIsGuest?: boolean;
}): string {
	return (
		assigneeDisplayName(slot.assigneeName, slot.assigneeIsGuest) ?? OPEN_LABEL
	);
}

/** One rendered agenda row (no clock time yet — buildTimeline adds it). */
export type AgendaRow = {
	who: string; // "Speaker 1 · Rehanna Khan", "Sergeant-at-Arms", "Timer"
	detail: string;
	minutes: number; // duration this row contributes to the running clock
	marks: TimingMarks | null;
};

/** A functionary/uncovered role shown in the header legend. */
export type LegendEntry = { role: string; name: string };

/** A beat in the standard run-of-show. */
export type Beat =
	| { kind: "event"; who: string; detail: string; minutes: number }
	| {
			kind: "role";
			roleName: string;
			role: "plain" | "speaker" | "evaluator";
			detail: string;
			minutes: number;
	  };

/** Fallback speaker duration when a speaker slot has no maxMinutes. */
export const DEFAULT_SPEAKER_MINUTES = 7;

/** Placeholder shown for an open (unassigned) slot. */
export const OPEN_LABEL = "— open —";

/** Functionary-category roles for the header legend (Timer, Ah-Counter, Grammarian…). */
export function buildLegend(slots: AgendaSlot[]): LegendEntry[] {
	return slots
		.filter((s) => s.category === "functionary")
		.map((s) => ({ role: s.roleName, name: assigneeDisplay(s) }));
}

/**
 * The single hardcoded standard Toastmasters run-of-show for v1. Durations are
 * tunable constants approximating templates/meeting-agenda/MeetingAgenda.dc.html.
 * Per-club configurable templates are a deferred issue.
 */
export const RUN_OF_SHOW: Beat[] = [
	{
		kind: "event",
		who: "Sergeant-at-Arms",
		detail: "Call to Order · phones silent, exits noted",
		minutes: 1,
	},
	{
		kind: "event",
		who: "President",
		detail: "Opening remarks; welcomes guests",
		minutes: 1,
	},
	{
		kind: "role",
		roleName: "Toastmaster of the Day",
		role: "plain",
		detail: "Opens meeting · introduces theme & GE",
		minutes: 3,
	},
	{
		kind: "role",
		roleName: "General Evaluator",
		role: "plain",
		detail: "Introduces evaluation team · Grammarian shares Word of the Day",
		minutes: 5,
	},
	{
		kind: "role",
		roleName: "Speaker",
		role: "speaker",
		detail: "Prepared speech",
		minutes: DEFAULT_SPEAKER_MINUTES,
	},
	{
		kind: "event",
		who: "Timer",
		detail: "Timer's report · vote Best Speaker",
		minutes: 1,
	},
	{
		kind: "role",
		roleName: "Table Topics Master",
		role: "plain",
		detail: "Impromptu topics using the Word of the Day",
		minutes: 10,
	},
	{
		kind: "event",
		who: "Timer",
		detail: "Timer's report · vote Best Table Topics",
		minutes: 1,
	},
	{
		kind: "role",
		roleName: "Evaluator",
		role: "evaluator",
		detail: "Evaluates a speaker",
		minutes: 3,
	},
	{
		kind: "event",
		who: "Timer",
		detail: "Timer's report · vote Best Evaluator",
		minutes: 1,
	},
	{
		kind: "role",
		roleName: "General Evaluator",
		role: "plain",
		detail: "Grammarian, Ah-Counter & Timer reports · overall feedback",
		minutes: 7,
	},
	{
		kind: "event",
		who: "Toastmaster",
		detail: "Awards · Best Table Topic, Evaluator & Speaker",
		minutes: 2,
	},
	{
		kind: "event",
		who: "President",
		detail: "Club business · elections, guest comments · adjourn",
		minutes: 3,
	},
];

/** "Speaker 1" when the role repeats this meeting, else "Speaker". */
export function numbered(
	roleName: string,
	index: number,
	multi: boolean,
): string {
	return multi ? `${roleName} ${index + 1}` : roleName;
}

/** Order evaluator slots by the position of the speaker each evaluates. */
export function orderEvaluators(
	evaluators: AgendaSlot[],
	allSlots: AgendaSlot[],
): AgendaSlot[] {
	const speakerPos = new Map<string, number>();
	allSlots
		.filter((s) => s.isSpeakerRole)
		.sort((a, b) => a.slotIndex - b.slotIndex)
		.forEach((s, i) => {
			speakerPos.set(s.id, i);
		});
	const rank = (s: AgendaSlot) =>
		s.evaluatesSlotId != null && speakerPos.has(s.evaluatesSlotId)
			? (speakerPos.get(s.evaluatesSlotId) as number)
			: 1000 + s.slotIndex; // unlinked evaluators sort after linked ones
	return [...evaluators].sort(
		(a, b) => rank(a) - rank(b) || a.slotIndex - b.slotIndex,
	);
}

export function expandRunSheet(
	slots: AgendaSlot[],
	template: Beat[] = RUN_OF_SHOW,
): AgendaRow[] {
	const rows: AgendaRow[] = [];
	const byRole = (name: string) =>
		slots.filter((s) => s.roleName.toLowerCase() === name.toLowerCase());

	for (const beat of template) {
		if (beat.kind === "event") {
			rows.push({
				who: beat.who,
				detail: beat.detail,
				minutes: beat.minutes,
				marks: null,
			});
			continue;
		}

		const matching = byRole(beat.roleName);

		if (beat.role === "speaker") {
			const ordered = [...matching].sort((a, b) => a.slotIndex - b.slotIndex);
			const multi = ordered.length > 1;
			ordered.forEach((s, i) => {
				const marks =
					s.minMinutes != null && s.maxMinutes != null
						? {
								green: s.minMinutes,
								yellow: (s.minMinutes + s.maxMinutes) / 2,
								red: s.maxMinutes,
							}
						: null;
				const detail = s.speechTitle
					? `"${s.speechTitle}"${s.projectLevel ? ` · ${s.projectLevel}` : ""}`
					: beat.detail;
				rows.push({
					who: `${numbered(beat.roleName, i, multi)} · ${assigneeDisplay(s)}`,
					detail,
					minutes: s.maxMinutes ?? DEFAULT_SPEAKER_MINUTES,
					marks,
				});
			});
		} else if (beat.role === "evaluator") {
			const ordered = orderEvaluators(matching, slots);
			const multi = ordered.length > 1;
			ordered.forEach((s, i) => {
				rows.push({
					who: `${numbered(beat.roleName, i, multi)} · ${assigneeDisplay(s)}`,
					detail: s.evaluates?.speakerName
						? `Evaluates ${s.evaluates.speakerName}`
						: beat.detail,
					minutes: beat.minutes,
					marks: null,
				});
			});
		} else {
			// plain role: usually one slot; a missing role degrades to a label-only row.
			if (matching.length === 0) {
				rows.push({
					who: beat.roleName,
					detail: beat.detail,
					minutes: beat.minutes,
					marks: null,
				});
			} else {
				for (const s of matching) {
					rows.push({
						who: `${beat.roleName} · ${assigneeDisplay(s)}`,
						detail: beat.detail,
						minutes: beat.minutes,
						marks: null,
					});
				}
			}
		}
	}
	return rows;
}
