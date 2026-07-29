import { assigneeDisplayName } from "./agenda";
import {
	DEFAULT_SPEAKER_MINUTES,
	speechBookedMinutes,
	speechWindow,
} from "./speech-window";

/** The default lives with the booked-duration rule it belongs to (#394); it is
 *  re-exported here because this is where every call site already reads it. */
export { DEFAULT_SPEAKER_MINUTES };

/** Green/yellow/red timer-card marks, in minutes (e.g. 5, 6, 7). */
export type TimingMarks = { green: number; yellow: number; red: number };

/**
 * The minimal slot shape the run-of-show needs. The real slots returned by
 * `loadMeetingDetail` (src/server/meetings.ts) structurally satisfy this.
 */
export type AgendaSlot = {
	id: string;
	roleName: string;
	/** Stable, rename-proof identity of the role this slot belongs to (#368) —
	 *  `role_definitions.key`, e.g. `"general_evaluator"`. `null`/absent for a
	 *  club-invented custom role, or a standard role predating the #368
	 *  backfill; beat matching (`expandRunSheet`) falls back to `roleName` in
	 *  that case. Renaming a role via `updateClubRole` never changes this, so
	 *  a beat keeps binding to the right slots even after a club renames
	 *  "General Evaluator" to something else. */
	roleKey?: string | null;
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
	/** True on the single squishy row (Table Topics). `applyFlex` resizes it. */
	flex?: boolean;
	/** Set from the beat's own `handoff` — see `Beat` for what it is for. */
	handoff?: boolean;
};

/** A functionary/uncovered role shown in the header legend. */
export type LegendEntry = { role: string; name: string };

/** A standard role a beat can bind to: the immutable `role_definitions.key`
 *  (#368) plus the canonical display name used as a fallback for slots that
 *  predate the backfill. */
export type BeatRole = { roleKey: string; roleName: string };

/**
 * A beat in the standard run-of-show. `flex` marks the single squishy beat.
 *
 * Beats declare their dependency on roles AS DATA, so `expandRunSheet` can
 * adapt to whichever roles a club actually runs without hardcoding "if who
 * === Timer" style special cases (#367):
 *
 * - A `role` beat's own `roleKey`/`roleName` gate it directly: no slots for
 *   that role this meeting ⇒ the beat is omitted — unless `renderUnowned`
 *   says to print the bare role name anyway, or a `fallbacks` entry's `owner`
 *   has relocated the lookup to a different role that DOES have a slot.
 * - `requiresAnyOf` is an ADDITIONAL gate for a beat that is about OTHER
 *   roles besides its owner: the functionary-intro and functionary-reports
 *   beats (nothing to introduce, nobody to call for a report), the three
 *   vote beats, and the awards beat, all of which belong to a segment — a
 *   club with no Table Topics Master must not print "Best Table Topics" voting
 *   for a segment not on its agenda. A beat is omitted unless at least one of
 *   these roles has a slot.
 * - `requiresGroup` gates on a role GROUP the club defines rather than a fixed
 *   key list (#371) — "this club's functionaries", which is a category, not a
 *   set of keys we shipped. It SUPERSEDES `requiresAnyOf` on the beats that
 *   declare it (see `requirementsMet` for why they can't be ORed); the keys
 *   stay on those beats as the standard roles the beat is nominally about,
 *   which is what `docs/superpowers/specs` and the deck's `ROLE` map mirror.
 * - `detail` may contain `ROLES_TOKEN`, replaced at expansion time by the roles
 *   the club actually runs, under their own names — the beat's `requiresGroup`
 *   members when it has one, else its `requiresAnyOf` matches.
 * - `fallbacks` reassign a beat to a different owner and/or detail when their
 *   `unless` role has no slots, instead of the beat disappearing (#363). On the
 *   three vote beats the owner is ALREADY the segment leader — Toastmaster of
 *   the Day, Table Topics Master, General Evaluator — so `unless: TIMER_ROLE`
 *   only swaps `detail`, dropping the "Calls for the Timer's report" clause
 *   when there is no Timer; `owner` is for a beat whose usual owner isn't the
 *   one actually holding the room. See `BeatFallback`.
 * - `id` names a beat another surface has to point at — because it quotes the
 *   beat's duration (#356) or because its `detail` is shared with another beat
 *   (#363). See `BeatId`.
 */
export type Beat = (
	| {
			kind: "event";
			who: string;
			detail: string;
			minutes: number;
	  }
	| {
			kind: "role";
			roleKey: string;
			roleName: string;
			role: "plain" | "speaker" | "evaluator";
			detail: string;
			minutes: number;
			/** Render this beat even when the owning role has no slot this meeting,
			 *  as the bare role name with no assignee (#363). For beats that are
			 *  ABOUT a segment rather than about their owner — the three votes and
			 *  the awards. Without it a club that disabled Toastmaster of the Day
			 *  would lose the Best-Speaker vote from the printed agenda while
			 *  `buildSlideDeck` still projected the slide. */
			renderUnowned?: true;
	  }
) & {
	id?: BeatId;
	requiresAnyOf?: BeatRole[];
	requiresGroup?: RoleGroup;
	/** Alternative owners/details, each used when its `unless` role has no slots
	 *  this meeting (#363). PLURAL because one beat can need two independent
	 *  answers: a vote beat drops its timer's-report clause when the club runs no
	 *  Timer AND moves to the Toastmaster when it runs no General Evaluator, and
	 *  those are different questions with different triggers.
	 *
	 *  Applied in array order; a later entry that sets the same field wins. */
	fallbacks?: BeatFallback[];
	flex?: true;
	/** A 0-minute transition — "X introduces Y". Marks the row so the print
	 *  layouts can render it as a compact band rather than a full segment
	 *  block (#363), so a hand-off never reads as a duplicate of the row it
	 *  precedes. The deck projects a slide per hand-off beat; it reads the beats
	 *  by position rather than this flag, and `agenda-parity.test.ts` compares
	 *  the two resolutions row-for-slide. */
	handoff?: true;
};

/**
 * An alternative owner and/or detail, used when `unless` has no slots this
 * meeting (#363). Generalises the old event-only `fallback`, which could only
 * name a replacement `who` as a bare string — a string that named a role which
 * does not exist ("Toastmaster", when the role is "Toastmaster of the Day") and
 * did not follow a club rename.
 *
 * Two jobs, one mechanism:
 * - `{ unless: TIMER_ROLE, detail: … }` drops a vote beat's timer's-report clause at
 *   a club with no Timer — exactly the old behaviour.
 * - `{ unless: TABLE_TOPICS_ROLE, owner: TOASTMASTER_ROLE }` moves a hand-off to
 *   whoever is actually holding the room: with no Table Topics segment, the
 *   Toastmaster never gave the room away, so the Toastmaster introduces the
 *   General Evaluator rather than the row vanishing.
 *
 * A beat carries a LIST of these (`Beat.fallbacks`), because the two jobs are
 * two questions and one beat can need both answered: the Best-Evaluator vote
 * asks "is there a Timer to call on?" and "is there a General Evaluator to run
 * this?" independently, and a single fallback could only answer one of them.
 */
export type BeatFallback = {
	/** The role whose ABSENCE triggers the fallback. */
	unless: BeatRole;
	/** Owning role for the fallback row; omitted ⇒ keep the beat's own owner. */
	owner?: BeatRole;
	/** Detail for the fallback row; omitted ⇒ keep the beat's own detail. */
	detail?: string;
};

/**
 * Stable identity of a beat whose DURATION another surface states verbatim
 * (#356) — the three projected slides that print a "Time:" line.
 *
 * The deck used to carry its own timing constants, so the same beat could be
 * budgeted at one length on the printed agenda and announced as another on the
 * wall, and was: the speech-evaluation beat booked 3 minutes while the deck
 * said "2–3 minutes". They agreed everywhere else only because someone had just
 * set both by hand.
 *
 * Separate from the rest of `BeatId` so `beatDuration` cannot be handed the id
 * of a 0-minute hand-off and answer "0 minutes" for a slide that has no time to
 * state.
 */
export type TimedBeatId =
	| "evaluation"
	| "evaluatorEvaluation"
	| "generalEvaluation";

/**
 * Stable identity of a beat something else has to point at.
 *
 * An id is how another surface says WHICH beat it means, the way `roleKey` is
 * how a beat says which role it binds to — matching on `detail` breaks the
 * first time a beat is reworded, and matching on position the first time one is
 * inserted (#352 inserts one). Only the beats something else quotes carry an
 * id; the rest are reached by iteration, in order.
 *
 * Two reasons a beat needs one, and both are live:
 * - Its DURATION is restated elsewhere — see `TimedBeatId`.
 * - Its `detail` does not identify it, because another beat shares that text.
 *   TWO hand-off beats read "Introduces the General Evaluator" (#363): MCF's
 *   opening one, and the Table Topics Master's into the evaluation segment.
 *   Both are correct copy — the GE genuinely is introduced twice in that flow —
 *   so the ambiguity will not resolve itself by rewording, and a `find` on the
 *   detail silently takes whichever comes first.
 *
 * The consumer of the two hand-off ids is `agenda-parity.test.ts`, whose beat
 * table pins each entry to the beat it claims to be. `buildSlideDeck` does NOT
 * read them: it emits its hand-off slides positionally (see `Beat.handoff`).
 * So renaming one is a change to that harness, not to the deck — and the ids
 * are not load-bearing in production.
 */
export type BeatId = TimedBeatId | "geOpeningHandoff" | "geEvaluationHandoff";

/** A beat's budget as the deck states it: "3 minutes", "1 minute". */
export function formatBeatMinutes(minutes: number): string {
	return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * The duration `id`'s beat budgets, ready to project.
 *
 * Throws rather than falling back: every `TimedBeatId` is emitted by
 * `buildRunOfShow` in both variants, so a miss means the template and the ids
 * have been edited out of step, and a silent default would put a made-up number
 * on a projector — the exact failure this seam exists to prevent. The unit tests
 * cover both variants.
 */
export function beatDuration(template: Beat[], id: TimedBeatId): string {
	const beat = template.find((b) => b.id === id);
	if (beat == null) throw new Error(`run-of-show has no "${id}" beat`);
	return formatBeatMinutes(beat.minutes);
}

/** A group of roles the CLUB defines, not a list of keys we shipped (#371).
 *  `"functionaries"` is every `category: "functionary"` role;
 *  `"reportingFunctionaries"` drops the Vote Counter, who gives no report. */
export type RoleGroup = "functionaries" | "reportingFunctionaries";

/** Squishy Table Topics bounds (minutes) and the on-time banner deadband. */
export const TABLE_TOPICS_MIN = 5;
export const TABLE_TOPICS_MAX = 25;
export const FLEX_TOLERANCE_MINUTES = 2;

/** Placeholder shown for an open (unassigned) slot. */
export const OPEN_LABEL = "— open —";

/** Token in a beat's `detail`, replaced at expansion time by the roles from
 *  the beat's `requiresAnyOf` that the club actually runs, under the club's OWN
 *  display names (#367). The functionary-intro beat uses it so the row names
 *  only the functionaries this club has — the same list the deck's
 *  `functionaryIntro` slide enumerates — rather than a fixed
 *  "the functionaries". */
export const ROLES_TOKEN = "{roles}";

/** Token in a beat's `detail`, replaced at expansion time by the award
 *  categories the club actually scores (#372) — the same list, in the same
 *  order, that the deck's `awards` slide builds. Unlike `ROLES_TOKEN` these are
 *  FIXED labels, not the club's role names: a club that renames "Table Topics
 *  Master" still hands out Best Table Topic. */
export const AWARDS_TOKEN = "{awards}";

/**
 * THE definition of "this club's functionaries" (#371) — the one every surface
 * reads: the legend, the functionary-intro and functionary-reports gates, the
 * deck's two functionary slides, and the `ROLES_TOKEN` list in the
 * functionary-intro beat's printed detail.
 *
 * Membership is the **category**. Keys are for IDENTITY — they make a beat
 * rename-proof (#368) and let us say which specific role something is — never
 * for membership. A club that marks a role `category: "functionary"` is telling
 * us it is one, and a tool whose premise (#367) is that clubs differ has no
 * business overruling that because we didn't ship the role.
 *
 * Before this, `buildLegend` filtered on the category while `hasAnyFunctionaryRole`
 * and `ROLES_TOKEN` resolved against the four standard keys, so a club's own
 * "Joke Master" was projected on the functionary slide but missing from the
 * printed row, and a club that disabled all four standard functionaries lost
 * the functionary-intro and functionary-reports beats from both surfaces while
 * the legend still listed its people.
 */
export function functionarySlots(slots: AgendaSlot[]): AgendaSlot[] {
	return slots.filter((s) => s.category === "functionary");
}

/** The one standard functionary who does not give a report: a Vote Counter
 *  tallies ballots. Excluded by IDENTITY (its key, so a rename does not smuggle
 *  it back in) — exactly what keys are for. */
const NON_REPORTING_FUNCTIONARY: BeatRole = {
	roleKey: "vote_counter",
	roleName: "Vote Counter",
};

/**
 * The functionaries who actually give a report — the functionary-reports beat's
 * subject, and the deck's `functionaryReports` team (#371).
 *
 * Widening "functionary" to the category makes the Vote-Counter-only club more
 * reachable, not less, so that beat is gated on "functionaries who REPORT"
 * rather than "functionaries": otherwise a club running a Vote Counter and
 * nothing else gets "General Evaluator · Calls for the functionary reports"
 * naming only the person with no report to give. They are still introduced at
 * the functionary-intro beat and still in the legend — being a functionary and
 * having a report are different questions, and only the second one gates the
 * reports beat.
 *
 * A club-invented functionary is presumed TO report. We cannot know, and an
 * extra name in a list the General Evaluator reads out is a smaller error than
 * silently deleting the beat from a club that runs only custom functionaries.
 */
export function reportingFunctionarySlots(slots: AgendaSlot[]): AgendaSlot[] {
	return functionarySlots(slots).filter(
		(s) =>
			!matchesRole(
				s,
				NON_REPORTING_FUNCTIONARY.roleKey,
				NON_REPORTING_FUNCTIONARY.roleName,
			),
	);
}

const toLegendEntry = (s: AgendaSlot): LegendEntry => ({
	role: s.roleName,
	name: assigneeDisplay(s),
});

/** Every functionary this club runs, for the header legend and the deck's
 *  functionary-intro slide (Timer, Ah-Counter, Grammarian… and whatever else
 *  the club invented). */
export function buildLegend(slots: AgendaSlot[]): LegendEntry[] {
	return functionarySlots(slots).map(toLegendEntry);
}

/** The subset that reports, for the deck's functionary-reports slide — the same
 *  list that beat's gate is computed from, so the slide never names someone the
 *  printed beat implies has a report when they do not (#371). */
export function buildReportingLegend(slots: AgendaSlot[]): LegendEntry[] {
	return reportingFunctionarySlots(slots).map(toLegendEntry);
}

/** Config for `buildRunOfShow`: the one axis of per-club variance (#367). At
 *  MCF the General Evaluator introduces the functionaries; almost everywhere
 *  else the Toastmaster of the Day does, at the top of the meeting. It decides
 *  the functionary-intro beat's owner and, because of that, whether the run
 *  sheet needs the hand-off that introduces the GE first — nothing else about
 *  the run-of-show, including the GE's closing sequence (evaluate the
 *  evaluators → call for functionary reports → overall evaluation), depends on
 *  this flag. */
export type RunOfShowConfig = { geIntroducesFunctionaries: boolean };

/** The Timer — one of the four standard functionaries, and the role whose
 *  ABSENCE (not presence) drives one of the three vote beats' `fallbacks`
 *  (#363): the vote is already owned by the segment leader, so losing the Timer
 *  only drops the "Calls for the Timer's report" clause, never the row. */
const TIMER_ROLE: BeatRole = { roleKey: "timer", roleName: "Timer" };

/** The 4 standard functionary roles we ship (`ROLE_TEMPLATE`). Since #371 these
 *  DECLARE which standard roles the functionary-intro beat is nominally about;
 *  they are no longer the definition of a functionary, which is the category
 *  (`functionarySlots`), nor the beat's gate — see `requirementsMet`. */
const FUNCTIONARY_ROLES: BeatRole[] = [
	{ roleKey: "grammarian", roleName: "Grammarian" },
	{ roleKey: "ah_counter", roleName: "Ah-Counter" },
	TIMER_ROLE,
	NON_REPORTING_FUNCTIONARY,
];

/** What the functionary-reports beat is nominally about: the standard
 *  functionaries MINUS the Vote Counter, who gives no report. Same relationship
 *  to `reportingFunctionarySlots` as `FUNCTIONARY_ROLES` has to
 *  `functionarySlots`. */
const REPORTING_FUNCTIONARY_ROLES: BeatRole[] = FUNCTIONARY_ROLES.filter(
	(r) => r.roleKey !== NON_REPORTING_FUNCTIONARY.roleKey,
);

/** The Toastmaster of the Day — the meeting's host. Named once because several
 *  beats bind to it as the same role: the opening, the hand-offs, the awards. */
const TOASTMASTER_ROLE: BeatRole = {
	roleKey: "toastmaster_of_the_day",
	roleName: "Toastmaster of the Day",
};

/** The General Evaluator, named once because several beats bind to it. */
const GENERAL_EVALUATOR_ROLE: BeatRole = {
	roleKey: "general_evaluator",
	roleName: "General Evaluator",
};

/**
 * The product decision for a club that runs no General Evaluator (#363): the
 * Toastmaster of the Day covers the WHOLE role, not a piece of it.
 *
 * Written once and shared by all five GE-owned beats, because the alternative
 * is what shipped before: the Best-Evaluator vote printed the bare string
 * "General Evaluator" (via `renderUnowned`) while the hand-off one row above it
 * relocated to the Toastmaster, and the GE's other three beats — including
 * "Calls for the functionary reports" — vanished outright, so a club with a
 * Timer, an Ah-Counter and a Grammarian but no GE never cued a single
 * functionary report. Same absent role, adjacent beats, three different
 * answers. One constant makes that unrepresentable.
 */
const GE_COVERED_BY_TOASTMASTER: BeatFallback = {
	unless: GENERAL_EVALUATOR_ROLE,
	owner: TOASTMASTER_ROLE,
};

/** The three segments that each end in a vote. Single-sourced so a vote beat's
 *  `requiresAnyOf` gate can never drift from the segment beat it follows. */
const SPEAKER_ROLE: BeatRole = { roleKey: "speaker", roleName: "Speaker" };
const TABLE_TOPICS_ROLE: BeatRole = {
	roleKey: "table_topics_master",
	roleName: "Table Topics Master",
};
const EVALUATOR_ROLE: BeatRole = {
	roleKey: "evaluator",
	roleName: "Evaluator",
};

/** The award handed out for each scored segment, in the order the awards beat
 *  reads them out — which is the order `buildSlideDeck` pushes them onto the
 *  `awards` slide, so print and deck can't disagree (#372). A club only hands
 *  out the awards for segments it actually runs; with no scored segment at all
 *  the beat's `requiresAnyOf` gate drops it, exactly as the deck omits the
 *  slide. */
const AWARD_CATEGORIES: { role: BeatRole; label: string }[] = [
	{ role: TABLE_TOPICS_ROLE, label: "Best Table Topic" },
	{ role: EVALUATOR_ROLE, label: "Best Evaluator" },
	{ role: SPEAKER_ROLE, label: "Best Speaker" },
];

/**
 * Build the standard Toastmasters run-of-show (#367). Pure, no db — every
 * beat declares which role(s) it depends on as data (`roleKey`,
 * `requiresAnyOf`, `fallbacks`), so `expandRunSheet` can adapt the
 * printed beats to whichever roles a club actually runs without this
 * function or its caller special-casing any one role by name.
 *
 * The corrected default flow: the Toastmaster of the Day introduces the
 * functionaries at the top (naming the ones this club runs) — each explains
 * their own role, which is when the Grammarian gives the Word of the Day — and
 * the General Evaluator's work happens at the end: evaluate the evaluators,
 * call for the functionary reports, then evaluate the meeting overall. The
 * three vote beats each belong to a segment and are gated on it, so a club with
 * no Table Topics Master never prints a vote for a segment it does not run.
 *
 * The 0-minute `handoff` beats between segments say who introduces whom (#363),
 * so nobody has to guess whose cue it is mid-meeting.
 *
 * `geIntroducesFunctionaries: true` is MCF's variant: the functionary-intro
 * beat changes owner to the General Evaluator, and gains the hand-off that
 * introduces them first, which exists only because of that swap. Durations are
 * tunable constants approximating
 * templates/meeting-agenda/MeetingAgenda.dc.html; per-beat durations and
 * arbitrary reordering are deliberately out of scope.
 */
export function buildRunOfShow({
	geIntroducesFunctionaries,
}: RunOfShowConfig): Beat[] {
	const functionaryIntroOwner = geIntroducesFunctionaries
		? GENERAL_EVALUATOR_ROLE
		: TOASTMASTER_ROLE;

	/**
	 * MCF's variant only: the Toastmaster introduces the General Evaluator before
	 * handing them the room for the functionary introductions (#363). The
	 * standard flow has no early GE appearance, so there is nothing to introduce
	 * and this beat does not exist there.
	 *
	 * Gated on the GE, not on the functionaries: the row introduces a person, and
	 * a club with no General Evaluator has nobody to introduce.
	 */
	const geOpeningIntro: Beat[] = geIntroducesFunctionaries
		? [
				{
					kind: "role",
					...TOASTMASTER_ROLE,
					// One of two beats whose detail is "Introduces the General
					// Evaluator" — the id is what tells them apart (#363).
					id: "geOpeningHandoff",
					role: "plain",
					detail: "Introduces the General Evaluator",
					minutes: 0,
					handoff: true,
					requiresAnyOf: [GENERAL_EVALUATOR_ROLE],
				},
			]
		: [];

	return [
		{
			// The club states this hand-off as a trailing clause, not a row of its
			// own (#363).
			kind: "event",
			who: "Sergeant-at-Arms",
			detail: "Call to Order · phones silent · introduces the President",
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
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: "Opens meeting · introduces the theme",
			minutes: 3,
		},
		...geOpeningIntro,
		{
			kind: "role",
			roleKey: functionaryIntroOwner.roleKey,
			roleName: functionaryIntroOwner.roleName,
			role: "plain",
			detail: `Introduces the ${ROLES_TOKEN}; each explains their role`,
			minutes: 3,
			requiresAnyOf: FUNCTIONARY_ROLES,
			requiresGroup: "functionaries",
		},
		{
			// Universal since #363. #438 added this for MCF only, reasoning that in
			// the standard flow the Toastmaster is already holding the room — but the
			// Table Topics hand-off below is added even though that is equally true
			// there, so being explicit in both flows is the consistent choice. Gated
			// on the SPEAKERS: a row must never promise speakers a club is not
			// running.
			kind: "role",
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: "Introduces the speakers",
			minutes: 0,
			handoff: true,
			requiresAnyOf: [SPEAKER_ROLE],
		},
		{
			kind: "role",
			...SPEAKER_ROLE,
			role: "speaker",
			detail: "Prepared speech",
			minutes: DEFAULT_SPEAKER_MINUTES,
		},
		{
			// The vote belongs to whoever is running the segment that just scored,
			// not to the Timer (#363) — the club's own printed agenda has this line
			// inside the leader's block every time, because the Timer gives a report
			// but never holds the room. Owner and gate are DELIBERATELY different
			// roles: this beat is owned by the Toastmaster of the Day (the segment
			// leader) but gated on the Speaker (the segment itself), so a club that
			// disables Toastmaster of the Day still runs the vote — `renderUnowned`
			// prints the bare role name rather than losing the row. Only the
			// timer's-report clause is conditional — a `fallbacks` entry drops it,
			// and it alone, when there is no Timer to report.
			kind: "role",
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: "Calls for the Timer's report · opens voting for Best Speaker",
			minutes: 1,
			renderUnowned: true,
			fallbacks: [
				{ unless: TIMER_ROLE, detail: "Opens voting for Best Speaker" },
			],
			requiresAnyOf: [SPEAKER_ROLE],
		},
		{
			kind: "role",
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: "Introduces the Table Topics Master",
			minutes: 0,
			handoff: true,
			requiresAnyOf: [TABLE_TOPICS_ROLE],
		},
		{
			kind: "role",
			...TABLE_TOPICS_ROLE,
			role: "plain",
			detail: "Impromptu topics using the Word of the Day",
			minutes: 10,
			flex: true,
		},
		{
			// Owner and gate are the same role here, so `renderUnowned` can never
			// fire; kept because all three votes are about segments, not their
			// owners.
			kind: "role",
			...TABLE_TOPICS_ROLE,
			role: "plain",
			detail:
				"Calls for the Timer's report · opens voting for Best Table Topics",
			minutes: 1,
			renderUnowned: true,
			fallbacks: [
				{ unless: TIMER_ROLE, detail: "Opens voting for Best Table Topics" },
			],
			requiresAnyOf: [TABLE_TOPICS_ROLE],
		},
		{
			// The Table Topics Master is holding the room when the segment ends, so
			// they hand to the GE. With no Table Topics segment the Toastmaster never
			// gave the room away, so the fallback puts the hand-off back on them
			// rather than dropping it (#363).
			kind: "role",
			...TABLE_TOPICS_ROLE,
			// The other beat reading "Introduces the General Evaluator" (#363).
			id: "geEvaluationHandoff",
			role: "plain",
			detail: "Introduces the General Evaluator",
			minutes: 0,
			handoff: true,
			requiresAnyOf: [GENERAL_EVALUATOR_ROLE],
			fallbacks: [{ unless: TABLE_TOPICS_ROLE, owner: TOASTMASTER_ROLE }],
		},
		{
			kind: "role",
			...GENERAL_EVALUATOR_ROLE,
			role: "plain",
			detail: "Introduces the speech evaluators",
			minutes: 0,
			handoff: true,
			requiresAnyOf: [EVALUATOR_ROLE],
			fallbacks: [GE_COVERED_BY_TOASTMASTER],
		},
		{
			kind: "role",
			...EVALUATOR_ROLE,
			id: "evaluation",
			role: "evaluator",
			detail: "Evaluates a speaker",
			minutes: 3,
		},
		{
			// The General Evaluator, per the same club agenda. THE beat that proves
			// `fallbacks` has to be plural (#363): it asks two independent questions
			// of the club's roster. Is there a Timer to call on? — if not, the
			// timer's-report clause goes. Is there a General Evaluator to run this? —
			// if not, the Toastmaster covers, exactly as they do for the GE's other
			// four beats. One fallback could only ever answer one of them, and the
			// one it answered was the Timer's, which is why this row used to print
			// the bare, unheld "General Evaluator" while the hand-off directly above
			// it relocated to the Toastmaster.
			//
			// `renderUnowned` still backstops the case where the fallback has nowhere
			// to fall back TO (no GE and no Toastmaster of the Day): the vote belongs
			// to the segment, so an unattributed cue beats no cue at all, and the deck
			// still projects the Best-Evaluator slide.
			kind: "role",
			...GENERAL_EVALUATOR_ROLE,
			role: "plain",
			detail: "Calls for the Timer's report · opens voting for Best Evaluator",
			minutes: 1,
			renderUnowned: true,
			fallbacks: [
				{ unless: TIMER_ROLE, detail: "Opens voting for Best Evaluator" },
				GE_COVERED_BY_TOASTMASTER,
			],
			requiresAnyOf: [EVALUATOR_ROLE],
		},
		{
			// Gated on the EVALUATORS, which deliberately reverses #367's call that
			// this beat follows the General Evaluator alone (#363). Do not "restore"
			// it: #367's symmetry argument — a GE with no evaluators still gets the
			// beat — was defending the wrong thing. "Evaluates the evaluators" is
			// wrong copy at a club that runs none no matter WHO owns the row, and
			// having the Toastmaster cover the role only made that reachable by a
			// second route. Every other beat about a segment is gated on that
			// segment; this one now is too.
			kind: "role",
			...GENERAL_EVALUATOR_ROLE,
			id: "evaluatorEvaluation",
			role: "plain",
			detail: "Evaluates the evaluators",
			minutes: 2,
			requiresAnyOf: [EVALUATOR_ROLE],
			fallbacks: [GE_COVERED_BY_TOASTMASTER],
		},
		{
			kind: "role",
			...GENERAL_EVALUATOR_ROLE,
			role: "plain",
			detail: "Calls for the functionary reports",
			minutes: 3,
			// Gated on functionaries who REPORT, not on functionaries (#371) — a
			// club whose only functionary is a Vote Counter has nobody to call on.
			requiresAnyOf: REPORTING_FUNCTIONARY_ROLES,
			requiresGroup: "reportingFunctionaries",
			// The most consequential of the five relocations (#363): without it a
			// club that runs functionaries but no General Evaluator never calls for
			// the functionary reports at all — the Timer, Ah-Counter and Grammarian
			// are introduced at the top of the meeting and then never cued to speak.
			fallbacks: [GE_COVERED_BY_TOASTMASTER],
		},
		{
			kind: "role",
			...GENERAL_EVALUATOR_ROLE,
			id: "generalEvaluation",
			role: "plain",
			// Trailing clause, per the club's agenda (#363): the GE's last act is
			// giving the room back. `beatDuration` matches on `id`, not `detail`.
			detail: "Overall meeting evaluation · returns control to the Toastmaster",
			minutes: 2,
			// ONE entry setting BOTH fields, not two entries — the plural mechanism
			// is for independent triggers, and here there is only one: with no
			// General Evaluator the Toastmaster gives the overall evaluation AND has
			// nobody to return control to, having never given it away. Splitting it
			// in two would let a future edit fire the owner swap without the clause
			// drop and print "Toastmaster of the Day · Alice | Overall meeting
			// evaluation · returns control to the Toastmaster".
			fallbacks: [
				{ ...GE_COVERED_BY_TOASTMASTER, detail: "Overall meeting evaluation" },
			],
		},
		{
			// Same move as the three vote beats (#363): name the Toastmaster who
			// hands out the ribbons instead of the bare, nonexistent "Toastmaster".
			// `renderUnowned` so a club with no Toastmaster of the Day still gets
			// the row — `buildSlideDeck` still projects the `awards` slide.
			kind: "role",
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: `Awards · ${AWARDS_TOKEN} · hands over to the President`,
			minutes: 2,
			renderUnowned: true,
			requiresAnyOf: AWARD_CATEGORIES.map((a) => a.role),
		},
		{
			// Guest comments (#352). They happen every meeting, right after the
			// awards, and until now were a clause inside the President's closing —
			// no row the Toastmaster could point at and no minutes on the clock, so
			// the agenda ran late by however long they took.
			//
			// Ungated on purpose. Every meeting can have guests, the club cannot
			// know in advance, and a segment that is skipped when the room is empty
			// costs nothing; the spec explicitly rules out a per-club toggle.
			// The President owns it because the beat is carved out of the
			// President's closing — this gives the responsibility its own row, it
			// does not move it to somebody else — and because the President is who
			// welcomed those guests in the opening remarks.
			kind: "event",
			who: "President",
			detail: "Guest Comments · invites our guests to share their thoughts",
			minutes: 2,
		},
		{
			kind: "event",
			who: "President",
			// The ", guest comments" clause that used to live here is gone: it was
			// kept only because the dedicated beat above was deferred, and leaving
			// both would have the agenda invite the same guests to speak twice.
			// "elections" is gone too (#363): the club holds none at a regular
			// meeting — announcements are what actually happens here.
			detail: "Club business · announcements · adjourns",
			minutes: 3,
		},
	];
}

/** The corrected default run-of-show (`geIntroducesFunctionaries: false`) —
 *  the standard flow almost every club runs. Existing callers that don't
 *  pass a template (`expandRunSheet(slots)`) keep getting this. */
export const RUN_OF_SHOW: Beat[] = buildRunOfShow({
	geIntroducesFunctionaries: false,
});

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

/** True when `slot` is an instance of the role identified by `roleKey`/
 *  `roleName` (#367/#368). Prefers the immutable `roleKey` — a rename via
 *  `updateClubRole` never changes it, so a beat keeps binding to the right
 *  slots even after a club renames "General Evaluator" to something else.
 *  Falls back to matching the free-text name only when the slot itself
 *  carries no key (a genuinely custom club role, or data predating #368). */
export function matchesRole(
	slot: AgendaSlot,
	roleKey: string,
	roleName: string,
): boolean {
	return slot.roleKey != null
		? slot.roleKey === roleKey
		: slot.roleName.toLowerCase() === roleName.toLowerCase();
}

function slotsForRole(
	slots: AgendaSlot[],
	roleKey: string,
	roleName: string,
): AgendaSlot[] {
	return slots.filter((s) => matchesRole(s, roleKey, roleName));
}

function hasRole(
	slots: AgendaSlot[],
	roleKey: string,
	roleName: string,
): boolean {
	return slots.some((s) => matchesRole(s, roleKey, roleName));
}

/** The slots behind each role group (#371) — the single lookup `expandRunSheet`
 *  and the two exported predicates below all go through, so a beat's gate, its
 *  `ROLES_TOKEN` list and the deck's slide can't answer "which functionaries?"
 *  three different ways. */
const GROUP_SLOTS: Record<RoleGroup, (slots: AgendaSlot[]) => AgendaSlot[]> = {
	functionaries: functionarySlots,
	reportingFunctionaries: reportingFunctionarySlots,
};

/** True when the club runs at least one functionary role this meeting — the
 *  functionary-intro beat's gate (#367). Exported so the deck's
 *  `buildSlideDeck` gates its functionary-intro slide on the SAME signal the
 *  run sheet does, rather than a second rule that could drift: there is nothing
 *  to introduce when a club runs no functionaries at all. */
export function hasAnyFunctionaryRole(slots: AgendaSlot[]): boolean {
	return functionarySlots(slots).length > 0;
}

/** True when at least one of those functionaries gives a report — the
 *  functionary-reports beat's gate, and the deck's matching slide (#371).
 *  Narrower than `hasAnyFunctionaryRole` by exactly the Vote Counter. */
export function hasAnyReportingFunctionaryRole(slots: AgendaSlot[]): boolean {
	return reportingFunctionarySlots(slots).length > 0;
}

/** "Timer", "Timer & Grammarian", "Timer, Grammarian & Ah-Counter". */
function joinRoleNames(names: string[]): string {
	if (names.length < 2) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/** Resolve `ROLES_TOKEN` in a beat's detail against the roles the club runs
 *  (#367), in slot order and under the club's own display names — the same
 *  order and names the deck's functionary slides list. */
function resolveDetail(beat: Beat, slots: AgendaSlot[]): string {
	if (beat.detail.includes(AWARDS_TOKEN)) {
		// Fixed labels in a fixed order (not the club's role names, and not slot
		// order) — the awards are the club's, the role names only decide WHICH
		// are handed out.
		const labels = AWARD_CATEGORIES.filter((a) =>
			hasRole(slots, a.role.roleKey, a.role.roleName),
		).map((a) => a.label);
		// Replacer FUNCTION, not a string: `String.replace` reads `$&`, "$`", `$'`
		// and `$n` in a replacement string as back-references, so a club role
		// literally named "Timer $`" would splice the copy before the token back
		// into the row. The awards labels are hardcoded, so this site is safe today
		// — but it is the same call as the `ROLES_TOKEN` one below, which is not.
		return beat.detail.replace(AWARDS_TOKEN, () => joinRoleNames(labels));
	}
	if (!beat.detail.includes(ROLES_TOKEN)) return beat.detail;
	// A group beat names the group's members (#371) — the functionary-intro beat
	// lists exactly the functionaries `buildLegend` puts on the projected slide,
	// including any the club invented. The group also gates the beat
	// (`requirementsMet`), so this list is never empty. Without a group, resolve
	// the beat's own key list.
	const required = beat.requiresAnyOf ?? [];
	const matched =
		beat.requiresGroup != null
			? GROUP_SLOTS[beat.requiresGroup](slots)
			: slots.filter((s) =>
					required.some((r) => matchesRole(s, r.roleKey, r.roleName)),
				);
	const names = matched.map((s) => s.roleName);
	// Replacer function ⇒ the club's role names are substituted LITERALLY. An
	// admin types `roleName` verbatim (admin/roles.tsx applies no character
	// validation to it),
	// so a role named "Timer $`" would otherwise corrupt the printed row, the
	// projected slide and the .pptx alike.
	return beat.detail.replace(ROLES_TOKEN, () =>
		joinRoleNames([...new Set(names)]),
	);
}

/**
 * Whether a beat's role dependencies are met.
 *
 * A declared `requiresGroup` is AUTHORITATIVE — it is not ORed with the beat's
 * `requiresAnyOf` key list (#371). The triage that set the direction here
 * suggested keeping the standard keys as a "gating fallback", but the two
 * cannot coexist: a group beat RENDERS its group as a list (`ROLES_TOKEN`, and
 * the matching deck slide's `team`), so a gate that admits a slot the group
 * excludes prints "Introduces the ; each explains their role" — and the deck,
 * which reads the group directly, drops the slide, so print and deck disagree.
 * That case is reachable: `applyRoleDefinitionUpdate` lets an admin change a
 * role's category, so a `timer`-keyed slot filed under "leadership" exists. The
 * category is the definition, so such a club simply runs no functionaries, and
 * both surfaces drop the beat together. `agenda-parity.test.ts` covers it.
 *
 * `requiresAnyOf` still gates every beat with no group: the three vote beats and
 * the awards beat, which are about fixed standard roles rather than a group the
 * club composes. An ungated beat always renders.
 */
function requirementsMet(beat: Beat, slots: AgendaSlot[]): boolean {
	if (beat.requiresGroup != null)
		return GROUP_SLOTS[beat.requiresGroup](slots).length > 0;
	if (beat.requiresAnyOf == null) return true;
	return beat.requiresAnyOf.some((r) => hasRole(slots, r.roleKey, r.roleName));
}

export function expandRunSheet(
	slots: AgendaSlot[],
	template: Beat[] = RUN_OF_SHOW,
): AgendaRow[] {
	const rows: AgendaRow[] = [];

	for (const beat of template) {
		const startLen = rows.length;
		// The beat is about OTHER roles than its owner (the functionary beats) or
		// belongs to a segment (the vote beats), and the club runs none of them —
		// nothing to introduce, nobody to call for a report, no segment to vote on.
		// Early-out rather than an empty first arm, so nothing below is resolved
		// for a beat that emits no rows (the two post-loop markers are already
		// no-ops on an empty range).
		if (!requirementsMet(beat, slots)) continue;

		// `fallbacks` live on the shared half of `Beat` (#363), so this is computed
		// once for both arms below — the event arm only needs `who`, the role arm
		// only needs `owner`, but "did a fallback fire, and what does it say"
		// must answer the same way in both or the two arms can silently drift.
		//
		// Resolved PER FIELD rather than per entry: the entries answer independent
		// questions (see `Beat.fallbacks`), so an entry that names only a `detail`
		// must not shadow an earlier entry's `owner`. Later wins within a field,
		// which is what makes the array order documented rather than incidental.
		const fired = (beat.fallbacks ?? []).filter(
			(fb) => !hasRole(slots, fb.unless.roleKey, fb.unless.roleName),
		);
		const fallbackOwner = fired.reduce<BeatRole | undefined>(
			(owner, fb) => fb.owner ?? owner,
			undefined,
		);
		const fallbackDetail = fired.reduce<string | undefined>(
			(text, fb) => fb.detail ?? text,
			undefined,
		);
		// A fallback's own detail can carry the same `ROLES_TOKEN`/`AWARDS_TOKEN`
		// the beat's detail can (nothing stops a later beat from writing one) —
		// `resolveDetail` only reads `detail`/`requiresAnyOf`/`requiresGroup`, all
		// of which the fallback inherits from its beat, so this borrows the same
		// resolution rather than substituting the fallback's `detail` verbatim and
		// risking a literal "{roles}" on the printed agenda. Either way the beat's
		// own `detail` is resolved at most once — a fired fallback replaces it
		// outright, so resolving both would throw one of the two away.
		const beatDetail =
			fallbackDetail != null
				? resolveDetail({ ...beat, detail: fallbackDetail }, slots)
				: resolveDetail(beat, slots);

		if (beat.kind === "event") {
			rows.push({
				who: fallbackOwner?.roleName ?? beat.who,
				detail: beatDetail,
				minutes: beat.minutes,
				marks: null,
			});
		} else {
			// A fallback may move the beat to a different owner (#363) — resolve the
			// owner BEFORE looking up slots, so the row binds to the right role.
			const owner = fallbackOwner ?? {
				roleKey: beat.roleKey,
				roleName: beat.roleName,
			};
			const matching = slotsForRole(slots, owner.roleKey, owner.roleName);

			if (beat.role === "speaker") {
				const ordered = [...matching].sort((a, b) => a.slotIndex - b.slotIndex);
				const multi = ordered.length > 1;
				ordered.forEach((s, i) => {
					// The row's two numbers answer two different questions (#394), so
					// they read two different helpers: the marks need an assigned
					// RANGE (both ends, or none at all), while the clock needs an
					// ALLOWANCE, which a max alone states perfectly well. Same
					// `speechBookedMinutes` the deck projects, so the printed clock and
					// the projector cannot drift.
					const w = speechWindow(s);
					const marks = w
						? { green: w.min, yellow: (w.min + w.max) / 2, red: w.max }
						: null;
					rows.push({
						who: `${numbered(owner.roleName, i, multi)} · ${assigneeDisplay(s)}`,
						detail: s.speechTitle
							? `"${s.speechTitle}"${s.projectLevel ? ` · ${s.projectLevel}` : ""}`
							: beatDetail,
						minutes: speechBookedMinutes(s),
						marks,
					});
				});
			} else if (beat.role === "evaluator") {
				const ordered = orderEvaluators(matching, slots);
				const multi = ordered.length > 1;
				ordered.forEach((s, i) => {
					rows.push({
						who: `${numbered(owner.roleName, i, multi)} · ${assigneeDisplay(s)}`,
						detail: s.evaluates?.speakerName
							? `Evaluates ${s.evaluates.speakerName}`
							: beatDetail,
						minutes: beat.minutes,
						marks: null,
					});
				});
			} else if (matching.length === 0) {
				// Role not run by this club this meeting (#367/#368: disabled ⇒ no
				// slots generated). Normally omit rather than printing a ghost row —
				// unless the beat is about a SEGMENT rather than its owner (#363), in
				// which case the bare role name still carries the instruction.
				if (beat.renderUnowned) {
					rows.push({
						who: owner.roleName,
						detail: beatDetail,
						minutes: beat.minutes,
						marks: null,
					});
				}
			} else {
				for (const s of matching) {
					rows.push({
						who: `${owner.roleName} · ${assigneeDisplay(s)}`,
						detail: beatDetail,
						minutes: beat.minutes,
						marks: null,
					});
				}
			}
		}

		// A hand-off beat marks every row it produced.
		if (beat.handoff) {
			for (let i = startLen; i < rows.length; i++) {
				rows[i] = { ...rows[i], handoff: true };
			}
		}

		// Mark the FIRST row this beat produced as the squishy one — unlike
		// `handoff` above, which is a rendering hint any number of rows may carry,
		// `flex` is singular by contract: `applyFlex` finds it with `findIndex` and
		// resizes exactly that one row.
		if (beat.flex && rows.length > startLen) {
			rows[startLen] = { ...rows[startLen], flex: true };
		}
	}
	return rows;
}

export type FlexStatus = "exact" | "over" | "under";

export type FlexResult = {
	/** Rows with the flex row's `minutes` replaced by the clamped value. */
	rows: AgendaRow[];
	/** Actual total after clamping (= start-to-end meeting length). */
	projectedMinutes: number;
	/** Banner status, AFTER the deadband. */
	status: FlexStatus;
	/** True signed delta: +5 = runs 5 min long, −5 = ends 5 min early. */
	deltaMinutes: number;
};

/**
 * Resize the single `flex`-marked row (Table Topics) so the run-of-show totals
 * `targetMinutes`, clamped to [TABLE_TOPICS_MIN, TABLE_TOPICS_MAX]. The flex row
 * absorbs the exact remainder, so `deltaMinutes` is nonzero only when clamping
 * makes the target unreachable. `status` applies the ±FLEX_TOLERANCE_MINUTES
 * deadband to gate the banner; the computed duration is never deadbanded.
 */
export function applyFlex(
	rows: AgendaRow[],
	targetMinutes: number,
): FlexResult {
	const total = rows.reduce((sum, r) => sum + r.minutes, 0);
	const flexIndex = rows.findIndex((r) => r.flex === true);

	let out = rows;
	let projectedMinutes = total;

	if (flexIndex !== -1) {
		const fixed = total - rows[flexIndex].minutes;
		const flexMinutes = Math.min(
			TABLE_TOPICS_MAX,
			Math.max(TABLE_TOPICS_MIN, targetMinutes - fixed),
		);
		out = rows.map((r, i) =>
			i === flexIndex ? { ...r, minutes: flexMinutes } : r,
		);
		projectedMinutes = fixed + flexMinutes;
	}

	const deltaMinutes = projectedMinutes - targetMinutes;
	const status: FlexStatus =
		Math.abs(deltaMinutes) <= FLEX_TOLERANCE_MINUTES
			? "exact"
			: deltaMinutes > 0
				? "over"
				: "under";

	return { rows: out, projectedMinutes, status, deltaMinutes };
}

/**
 * The over/under banner's text, or `null` when the agenda fits (`"exact"`) and
 * there is nothing to say.
 *
 * The explanatory half is conditional on a flex row actually EXISTING (#395).
 * `applyFlex` only resizes the single `flex: true` beat — Table Topics — and
 * since #367 a club that runs no Table Topics Master has no such beat at all.
 * `applyFlex` then finds nothing to squeeze and leaves the total alone, but the
 * copy used to explain the shortfall in terms of a segment that is not on the
 * agenda: a skeleton crew printed "Table Topics is at its 25-min cap" with no
 * Table Topics row anywhere. With no flex row the shortfall is entirely the
 * booked meeting length, so that is what the message names.
 *
 * The banner is never suppressed. It is accurate about the mismatch, and it is
 * the prompt that gets `lengthMinutes` corrected — hiding it would conceal a
 * real discrepancy between the agenda and the time booked for it.
 *
 * Lives here, next to `applyFlex`, rather than inline in the print route: the
 * decision is entirely a function of the `FlexResult`, and out here it is
 * unit-testable without mounting a route.
 */
export function flexBannerMessage(flex: FlexResult): string | null {
	if (flex.status === "exact") return null;
	const hasFlexRow = flex.rows.some((r) => r.flex === true);

	if (flex.status === "over") {
		return hasFlexRow
			? `Agenda runs ${flex.deltaMinutes} min long — Table Topics is at its ${TABLE_TOPICS_MIN}-min floor. Trim a speech or shorten the agenda.`
			: `Agenda runs ${flex.deltaMinutes} min long — trim a speech, or increase the meeting length.`;
	}
	return hasFlexRow
		? `Agenda ends ${-flex.deltaMinutes} min early — Table Topics is at its ${TABLE_TOPICS_MAX}-min cap.`
		: `Agenda ends ${-flex.deltaMinutes} min early — consider shortening the meeting length.`;
}
