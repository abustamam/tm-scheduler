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
 *   says to print the bare role name anyway, or `fallback.owner` has
 *   relocated the lookup to a different role that DOES have a slot.
 * - `requiresAnyOf` is an ADDITIONAL gate for a beat that is about OTHER
 *   roles besides its owner: the functionary-intro and functionary-reports
 *   beats (nothing to introduce, nobody to call for a report), the three
 *   vote beats, and the awards beat, all of which belong to a segment — a
 *   club with no Table Topics Master must not print "vote Best Table Topics"
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
 * - `fallback` reassigns a beat to a different owner and/or detail when its
 *   `unless` role has no slots, instead of disappearing (#363). On the three
 *   vote beats the owner is ALREADY the segment leader — Toastmaster of the
 *   Day, Table Topics Master, General Evaluator — so `unless: TIMER_ROLE` only
 *   swaps `detail`, dropping the "Calls for the Timer's report" clause when
 *   there is no Timer; `owner` is for a beat whose usual owner isn't the one
 *   actually holding the room. See `BeatFallback`.
 * - `id` names a beat another surface has to quote (#356). See `BeatId`.
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
	fallback?: BeatFallback;
	flex?: true;
	/** A 0-minute transition — "X introduces Y". Marks the row so the print
	 *  layouts can render it as a compact band rather than a full segment
	 *  block (#363), so a hand-off never reads as a duplicate of the row it
	 *  precedes. Nothing reads the flag yet. */
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
 * (#356) — currently the three projected slides that print a "Time:" line.
 *
 * The deck used to carry its own timing constants, so the same beat could be
 * budgeted at one length on the printed agenda and announced as another on the
 * wall, and was: beat 9 booked 3 minutes while the deck said "2–3 minutes".
 * They agreed everywhere else only because someone had just set both by hand.
 *
 * An id is how a slide says WHICH beat it is speaking for, the way `roleKey`
 * is how a beat says which role it binds to — matching on `detail` would break
 * the first time a beat is reworded, and matching on position the first time
 * one is inserted (#352 inserts one). Only the beats something else quotes
 * carry an id; the rest are reached by iteration, in order.
 */
export type BeatId = "evaluation" | "evaluatorEvaluation" | "generalEvaluation";

/** A beat's budget as the deck states it: "3 minutes", "1 minute". */
export function formatBeatMinutes(minutes: number): string {
	return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * The duration `id`'s beat budgets, ready to project.
 *
 * Throws rather than falling back: every id is emitted by `buildRunOfShow`, so
 * a miss means the template and the ids have been edited out of step, and a
 * silent default would put a made-up number on a projector — the exact failure
 * this seam exists to prevent. The unit tests cover both variants.
 */
export function beatDuration(template: Beat[], id: BeatId): string {
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
 *  display names (#367). Beat 4 uses it so the printed row names only the
 *  functionaries this club has — the same list the deck's `functionaryIntro`
 *  slide enumerates — rather than a fixed "the functionaries". */
export const ROLES_TOKEN = "{roles}";

/** Token in a beat's `detail`, replaced at expansion time by the award
 *  categories the club actually scores (#372) — the same list, in the same
 *  order, that the deck's `awards` slide builds. Unlike `ROLES_TOKEN` these are
 *  FIXED labels, not the club's role names: a club that renames "Table Topics
 *  Master" still hands out Best Table Topic. */
export const AWARDS_TOKEN = "{awards}";

/**
 * THE definition of "this club's functionaries" (#371) — the one every surface
 * reads: the legend, the beat-4/12 gates, the deck's two functionary slides,
 * and the `ROLES_TOKEN` list in beat 4's printed detail.
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
 * beats 4 and 12 from both surfaces while the legend still listed its people.
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
 * The functionaries who actually give a report — beat 12's subject, and the
 * deck's `functionaryReports` team (#371).
 *
 * Widening "functionary" to the category makes the Vote-Counter-only club more
 * reachable, not less, so beat 12 is gated on "functionaries who REPORT" rather
 * than "functionaries": otherwise a club running a Vote Counter and nothing
 * else gets "General Evaluator · Calls for the functionary reports" naming only
 * the person with no report to give. They are still introduced at beat 4 and
 * still in the legend — being a functionary and having a report are different
 * questions, and only the second one gates beat 12.
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
 *  list beat 12's gate is computed from, so the slide never names someone the
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
 *  ABSENCE (not presence) drives the three vote beats' `fallback` (#363): the
 *  vote is already owned by the segment leader, so losing the Timer only
 *  drops the "Calls for the Timer's report" clause, never the row. */
const TIMER_ROLE: BeatRole = { roleKey: "timer", roleName: "Timer" };

/** The 4 standard functionary roles we ship (`ROLE_TEMPLATE`). Since #371 these
 *  DECLARE which standard roles beat 4 is nominally about; they are no longer
 *  the definition of a functionary, which is the category
 *  (`functionarySlots`), nor the beat's gate — see `requirementsMet`. */
const FUNCTIONARY_ROLES: BeatRole[] = [
	{ roleKey: "grammarian", roleName: "Grammarian" },
	{ roleKey: "ah_counter", roleName: "Ah-Counter" },
	TIMER_ROLE,
	NON_REPORTING_FUNCTIONARY,
];

/** What beat 12 is nominally about: the standard functionaries MINUS the Vote
 *  Counter, who gives no report. Same relationship to
 *  `reportingFunctionarySlots` as `FUNCTIONARY_ROLES` has to
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
 * `requiresAnyOf`, an event's `fallback`), so `expandRunSheet` can adapt the
 * printed beats to whichever roles a club actually runs without this
 * function or its caller special-casing any one role by name.
 *
 * The corrected default flow: the Toastmaster of the Day introduces the
 * functionaries at the top (beat 4, naming the ones this club runs) — each
 * explains their own role, which is when the Grammarian gives the Word of the
 * Day — and the General Evaluator's work happens at the end: evaluate the
 * evaluators, call for the functionary reports, then evaluate the meeting
 * overall. The three vote beats each belong to a segment and are gated on it,
 * so a club with no Table Topics Master never prints a vote for a segment it
 * does not run.
 *
 * The 0-minute `handoff` beats between segments say who introduces whom (#363),
 * so nobody has to guess whose cue it is mid-meeting.
 *
 * `geIntroducesFunctionaries: true` is MCF's variant: beat 4 changes owner to
 * the General Evaluator, and gains the hand-off that introduces them first,
 * which exists only because of that swap. Durations are tunable constants
 * approximating templates/meeting-agenda/MeetingAgenda.dc.html; per-beat
 * durations and arbitrary reordering are deliberately out of scope.
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
			// timer's-report clause is conditional — `fallback` drops it, and it
			// alone, when there is no Timer to report.
			kind: "role",
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: "Calls for the Timer's report · vote Best Speaker",
			minutes: 1,
			renderUnowned: true,
			fallback: {
				unless: TIMER_ROLE,
				detail: "Vote Best Speaker",
			},
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
			detail: "Calls for the Timer's report · vote Best Table Topics",
			minutes: 1,
			renderUnowned: true,
			fallback: {
				unless: TIMER_ROLE,
				detail: "Vote Best Table Topics",
			},
			requiresAnyOf: [TABLE_TOPICS_ROLE],
		},
		{
			// The Table Topics Master is holding the room when the segment ends, so
			// they hand to the GE. With no Table Topics segment the Toastmaster never
			// gave the room away, so the fallback puts the hand-off back on them
			// rather than dropping it (#363).
			kind: "role",
			...TABLE_TOPICS_ROLE,
			role: "plain",
			detail: "Introduces the General Evaluator",
			minutes: 0,
			handoff: true,
			requiresAnyOf: [GENERAL_EVALUATOR_ROLE],
			fallback: { unless: TABLE_TOPICS_ROLE, owner: TOASTMASTER_ROLE },
		},
		{
			kind: "role",
			...GENERAL_EVALUATOR_ROLE,
			role: "plain",
			detail: "Introduces the speech evaluators",
			minutes: 0,
			handoff: true,
			requiresAnyOf: [EVALUATOR_ROLE],
			fallback: { unless: GENERAL_EVALUATOR_ROLE, owner: TOASTMASTER_ROLE },
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
			// The General Evaluator, per the same club agenda. A club that runs
			// evaluators but no General Evaluator still gets this row: `renderUnowned`
			// prints "General Evaluator" unattributed rather than losing the vote —
			// deliberately, since the deck still projects the Best-Evaluator slide
			// and an unattributed cue beats no cue at all. The GE's other three
			// closing beats carry no such flag and vanish outright without a GE.
			kind: "role",
			...GENERAL_EVALUATOR_ROLE,
			role: "plain",
			detail: "Calls for the Timer's report · vote Best Evaluator",
			minutes: 1,
			renderUnowned: true,
			fallback: {
				unless: TIMER_ROLE,
				detail: "Vote Best Evaluator",
			},
			requiresAnyOf: [EVALUATOR_ROLE],
		},
		{
			kind: "role",
			...GENERAL_EVALUATOR_ROLE,
			id: "evaluatorEvaluation",
			role: "plain",
			detail: "Evaluates the evaluators",
			minutes: 2,
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
		},
		{
			kind: "role",
			...GENERAL_EVALUATOR_ROLE,
			id: "generalEvaluation",
			role: "plain",
			detail: "Overall meeting evaluation",
			minutes: 2,
		},
		{
			// Same move as the three vote beats (#363): name the Toastmaster who
			// hands out the ribbons instead of the bare, nonexistent "Toastmaster".
			// `renderUnowned` so a club with no Toastmaster of the Day still gets
			// the row — `buildSlideDeck` still projects the `awards` slide.
			kind: "role",
			...TOASTMASTER_ROLE,
			role: "plain",
			detail: `Awards · ${AWARDS_TOKEN}`,
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
			// welcomed those guests at beat 2.
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
			detail: "Club business · elections · adjourn",
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

/** True when the club runs at least one functionary role this meeting — beat
 *  4's gate (#367). Exported so the deck (`buildSlideDeck`) gates its
 *  functionary-intro slide on the SAME signal the run sheet does, rather than a
 *  second rule that could drift: there is nothing to introduce when a club runs
 *  no functionaries at all. */
export function hasAnyFunctionaryRole(slots: AgendaSlot[]): boolean {
	return functionarySlots(slots).length > 0;
}

/** True when at least one of those functionaries gives a report — beat 12's
 *  gate, and the deck's functionary-reports slide (#371). Narrower than
 *  `hasAnyFunctionaryRole` by exactly the Vote Counter. */
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
		return beat.detail.replace(AWARDS_TOKEN, joinRoleNames(labels));
	}
	if (!beat.detail.includes(ROLES_TOKEN)) return beat.detail;
	// A group beat names the group's members (#371) — beat 4 lists exactly the
	// functionaries `buildLegend` puts on the projected slide, including any the
	// club invented. The group also gates the beat (`requirementsMet`), so this
	// list is never empty. Without a group, resolve the beat's own key list.
	const required = beat.requiresAnyOf ?? [];
	const matched =
		beat.requiresGroup != null
			? GROUP_SLOTS[beat.requiresGroup](slots)
			: slots.filter((s) =>
					required.some((r) => matchesRole(s, r.roleKey, r.roleName)),
				);
	const names = matched.map((s) => s.roleName);
	return beat.detail.replace(ROLES_TOKEN, joinRoleNames([...new Set(names)]));
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
		const detail = resolveDetail(beat, slots);
		// The beat is about OTHER roles than its owner (the functionary beats) or
		// belongs to a segment (the vote beats), and the club runs none of them —
		// nothing to introduce, nobody to call for a report, no segment to vote on.
		const missingRequired = !requirementsMet(beat, slots);

		// `fallback` lives on the shared half of `Beat` (#363), so this is computed
		// once for both arms below — the event arm only needs `who`, the role arm
		// only needs `owner`, but "did the fallback fire, and what does it say"
		// must answer the same way in both or the two arms can silently drift.
		const fb = beat.fallback;
		const useFallback =
			fb != null && !hasRole(slots, fb.unless.roleKey, fb.unless.roleName);
		// A fallback's own detail can carry the same `ROLES_TOKEN`/`AWARDS_TOKEN`
		// the beat's detail can (nothing stops a later beat from writing one) —
		// `resolveDetail` only reads `detail`/`requiresAnyOf`/`requiresGroup`, all
		// of which the fallback inherits from its beat, so this borrows the same
		// resolution rather than substituting `fb.detail` verbatim and risking a
		// literal "{roles}" on the printed agenda.
		const beatDetail =
			useFallback && fb.detail != null
				? resolveDetail({ ...beat, detail: fb.detail }, slots)
				: detail;

		if (missingRequired) {
			// omitted
		} else if (beat.kind === "event") {
			rows.push({
				who: useFallback ? (fb.owner?.roleName ?? beat.who) : beat.who,
				detail: beatDetail,
				minutes: beat.minutes,
				marks: null,
			});
		} else {
			// A fallback may move the beat to a different owner (#363) — resolve the
			// owner BEFORE looking up slots, so the row binds to the right role.
			const owner =
				useFallback && fb.owner != null
					? fb.owner
					: { roleKey: beat.roleKey, roleName: beat.roleName };
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
