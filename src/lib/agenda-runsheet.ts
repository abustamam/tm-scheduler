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
	speechTitle: string | null;
	projectLevel: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
	evaluatesSlotId: string | null;
	evaluates: { speakerName: string | null } | null;
};

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

/**
 * The single hardcoded standard Toastmasters run-of-show for v1. Durations are
 * tunable constants approximating templates/meeting-agenda/MeetingAgenda.dc.html.
 * Per-club configurable templates are a deferred issue.
 */
/** Functionary-category roles for the header legend (Timer, Ah-Counter, Grammarian…). */
export function buildLegend(slots: AgendaSlot[]): LegendEntry[] {
	return slots
		.filter((s) => s.category === "functionary")
		.map((s) => ({ role: s.roleName, name: s.assigneeName ?? OPEN_LABEL }));
}

export const RUN_OF_SHOW: Beat[] = [
	{ kind: "event", who: "Sergeant-at-Arms", detail: "Call to Order · phones silent, exits noted", minutes: 1 },
	{ kind: "event", who: "President", detail: "Opening remarks; welcomes guests", minutes: 1 },
	{ kind: "role", roleName: "Toastmaster of the Day", role: "plain", detail: "Opens meeting · introduces theme & GE", minutes: 3 },
	{ kind: "role", roleName: "General Evaluator", role: "plain", detail: "Introduces evaluation team · Grammarian shares Word of the Day", minutes: 5 },
	{ kind: "role", roleName: "Speaker", role: "speaker", detail: "Prepared speech", minutes: DEFAULT_SPEAKER_MINUTES },
	{ kind: "event", who: "Timer", detail: "Timer's report · vote Best Speaker", minutes: 1 },
	{ kind: "role", roleName: "Table Topics Master", role: "plain", detail: "Impromptu topics using the Word of the Day", minutes: 10 },
	{ kind: "event", who: "Timer", detail: "Timer's report · vote Best Table Topics", minutes: 1 },
	{ kind: "role", roleName: "Evaluator", role: "evaluator", detail: "Evaluates a speaker", minutes: 3 },
	{ kind: "event", who: "Timer", detail: "Timer's report · vote Best Evaluator", minutes: 1 },
	{ kind: "role", roleName: "General Evaluator", role: "plain", detail: "Grammarian, Ah-Counter & Timer reports · overall feedback", minutes: 7 },
	{ kind: "event", who: "Toastmaster", detail: "Awards · Best Table Topic, Evaluator & Speaker", minutes: 2 },
	{ kind: "event", who: "President", detail: "Club business · elections, guest comments · adjourn", minutes: 3 },
];
