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
};

/** A functionary/uncovered role shown in the header legend. */
export type LegendEntry = { role: string; name: string };

/**
 * A beat in the standard run-of-show. `flex` marks the single squishy beat.
 *
 * Beats declare their dependency on roles AS DATA, so `expandRunSheet` can
 * adapt to whichever roles a club actually runs without hardcoding "if who
 * === Timer" style special cases (#367):
 *
 * - A `role` beat's own `roleKey`/`roleName` gate it directly: no slots for
 *   that role this meeting ⇒ the beat is omitted.
 * - `requiresAnyOf` is an ADDITIONAL gate for a beat that is about OTHER
 *   roles besides its owner (the functionary-intro and functionary-reports
 *   beats): omitted unless at least one of these roles has a slot.
 * - An `event` beat's `fallback` reassigns it to a different owner/detail
 *   when `fallback.roleKey` has no slots, instead of disappearing — the
 *   Timer's-report vote beats become Toastmaster-run plain votes.
 */
export type Beat = (
	| {
			kind: "event";
			who: string;
			detail: string;
			minutes: number;
			fallback?: { roleKey: string; who: string; detail: string };
	  }
	| {
			kind: "role";
			roleKey: string;
			roleName: string;
			role: "plain" | "speaker" | "evaluator";
			detail: string;
			minutes: number;
			requiresAnyOf?: { roleKey: string; roleName: string }[];
	  }
) & { flex?: true };

/** Fallback speaker duration when a speaker slot has no maxMinutes. */
export const DEFAULT_SPEAKER_MINUTES = 7;

/** Squishy Table Topics bounds (minutes) and the on-time banner deadband. */
export const TABLE_TOPICS_MIN = 5;
export const TABLE_TOPICS_MAX = 25;
export const FLEX_TOLERANCE_MINUTES = 2;

/** Placeholder shown for an open (unassigned) slot. */
export const OPEN_LABEL = "— open —";

/** Functionary-category roles for the header legend (Timer, Ah-Counter, Grammarian…). */
export function buildLegend(slots: AgendaSlot[]): LegendEntry[] {
	return slots
		.filter((s) => s.category === "functionary")
		.map((s) => ({ role: s.roleName, name: assigneeDisplay(s) }));
}

/** Config for `buildRunOfShow`: the one axis of per-club variance (#367). At
 *  MCF the General Evaluator introduces the functionaries; almost everywhere
 *  else the Toastmaster of the Day does, at the top of the meeting. Nothing
 *  else about the run-of-show — including the GE's closing sequence
 *  (evaluate the evaluators → call for functionary reports → overall
 *  evaluation) — depends on this flag. */
export type RunOfShowConfig = { geIntroducesFunctionaries: boolean };

/** The 4 functionary-category roles (`ROLE_TEMPLATE`) that the
 *  functionary-intro and functionary-reports beats depend on collectively —
 *  "introduce/call for the functionaries" only makes sense once a club runs
 *  at least one. */
const FUNCTIONARY_ROLES: { roleKey: string; roleName: string }[] = [
	{ roleKey: "grammarian", roleName: "Grammarian" },
	{ roleKey: "ah_counter", roleName: "Ah-Counter" },
	{ roleKey: "timer", roleName: "Timer" },
	{ roleKey: "vote_counter", roleName: "Vote Counter" },
];

/**
 * Build the standard Toastmasters run-of-show (#367). Pure, no db — every
 * beat declares which role(s) it depends on as data (`roleKey`,
 * `requiresAnyOf`, an event's `fallback`), so `expandRunSheet` can adapt the
 * printed beats to whichever roles a club actually runs without this
 * function or its caller special-casing any one role by name.
 *
 * The corrected default flow: the Toastmaster of the Day introduces the
 * functionaries at the top (beat 4) — each explains their own role, which is
 * when the Grammarian gives the Word of the Day — and the General Evaluator's
 * work happens at the end (beats 11–13): evaluate the evaluators, call for
 * the functionary reports, then evaluate the meeting overall.
 *
 * `geIntroducesFunctionaries: true` is MCF's variant: beat 4 ONLY changes
 * owner to the General Evaluator. Durations are tunable constants
 * approximating templates/meeting-agenda/MeetingAgenda.dc.html; per-beat
 * durations and arbitrary reordering are deliberately out of scope.
 */
export function buildRunOfShow({
	geIntroducesFunctionaries,
}: RunOfShowConfig): Beat[] {
	const functionaryIntroOwner = geIntroducesFunctionaries
		? { roleKey: "general_evaluator", roleName: "General Evaluator" }
		: {
				roleKey: "toastmaster_of_the_day",
				roleName: "Toastmaster of the Day",
			};

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
			roleKey: "toastmaster_of_the_day",
			roleName: "Toastmaster of the Day",
			role: "plain",
			detail: "Opens meeting · introduces the theme",
			minutes: 3,
		},
		{
			kind: "role",
			roleKey: functionaryIntroOwner.roleKey,
			roleName: functionaryIntroOwner.roleName,
			role: "plain",
			detail: "Introduces the functionaries; each explains their role",
			minutes: 3,
			requiresAnyOf: FUNCTIONARY_ROLES,
		},
		{
			kind: "role",
			roleKey: "speaker",
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
			fallback: {
				roleKey: "timer",
				who: "Toastmaster",
				detail: "Vote Best Speaker",
			},
		},
		{
			kind: "role",
			roleKey: "table_topics_master",
			roleName: "Table Topics Master",
			role: "plain",
			detail: "Impromptu topics using the Word of the Day",
			minutes: 10,
			flex: true,
		},
		{
			kind: "event",
			who: "Timer",
			detail: "Timer's report · vote Best Table Topics",
			minutes: 1,
			fallback: {
				roleKey: "timer",
				who: "Toastmaster",
				detail: "Vote Best Table Topics",
			},
		},
		{
			kind: "role",
			roleKey: "evaluator",
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
			fallback: {
				roleKey: "timer",
				who: "Toastmaster",
				detail: "Vote Best Evaluator",
			},
		},
		{
			kind: "role",
			roleKey: "general_evaluator",
			roleName: "General Evaluator",
			role: "plain",
			detail: "Evaluates the evaluators",
			minutes: 2,
		},
		{
			kind: "role",
			roleKey: "general_evaluator",
			roleName: "General Evaluator",
			role: "plain",
			detail: "Calls for the functionary reports",
			minutes: 3,
			requiresAnyOf: FUNCTIONARY_ROLES,
		},
		{
			kind: "role",
			roleKey: "general_evaluator",
			roleName: "General Evaluator",
			role: "plain",
			detail: "Overall meeting evaluation",
			minutes: 2,
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

/** True when the club runs at least one functionary role this meeting — the
 *  gate the functionary-intro and functionary-reports beats share (#367).
 *  Exported so the deck (`buildSlideDeck`) gates its matching slides on the
 *  SAME signal the run sheet does, rather than a second rule that could drift:
 *  there is nothing to introduce, and nobody to call for a report, when a club
 *  runs no functionaries at all. */
export function hasAnyFunctionaryRole(slots: AgendaSlot[]): boolean {
	return FUNCTIONARY_ROLES.some((r) => hasRole(slots, r.roleKey, r.roleName));
}

export function expandRunSheet(
	slots: AgendaSlot[],
	template: Beat[] = RUN_OF_SHOW,
): AgendaRow[] {
	const rows: AgendaRow[] = [];

	for (const beat of template) {
		const startLen = rows.length;

		if (beat.kind === "event") {
			const fb = beat.fallback;
			// An event beat's own display name doubles as the name to match
			// against when a slot carries no key (e.g. "Timer") — every event
			// beat with a fallback names the exact role it depends on.
			const useFallback = fb != null && !hasRole(slots, fb.roleKey, beat.who);
			rows.push({
				who: useFallback ? fb.who : beat.who,
				detail: useFallback ? fb.detail : beat.detail,
				minutes: beat.minutes,
				marks: null,
			});
		} else {
			const matching = slotsForRole(slots, beat.roleKey, beat.roleName);

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
			} else if (matching.length === 0) {
				// Role not run by this club this meeting (#367/#368: disabled ⇒
				// no slots generated) — omit the beat entirely rather than
				// printing a ghost row with no assignee.
			} else if (
				beat.requiresAnyOf &&
				!beat.requiresAnyOf.some((r) => hasRole(slots, r.roleKey, r.roleName))
			) {
				// The beat's own owner role exists, but none of the OTHER roles
				// it's actually about do (the functionaries) — nothing to
				// introduce or call for.
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

		// Mark the first row this beat produced as the squishy one.
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
