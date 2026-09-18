/**
 * Builds a TEMPLATED meeting's agenda rows directly, without going through
 * `Beat` / `expandRunSheet`.
 *
 * `Beat` exists to do two jobs: GATE (does this club's role set justify this
 * beat?) and FAN OUT (one beat becomes one row per slot of its role). A
 * template needs neither — its shape is fixed by the contest rules, and a
 * repeat block binds one slot at a time. Routing templates through `Beat`
 * anyway produced three defects, which is why this module exists (spec D8):
 *
 *   1. N² rows. `expandRunSheet` already fans one beat across every matching
 *      slot (`slotsForRole`, agenda-runsheet.ts:1269, filters the whole array),
 *      so emitting one beat per slot multiplied the count — four contestants
 *      printed sixteen rows on a clock wrong by the same factor.
 *   2. Dropped marks and minutes. `expandRunSheet`'s speaker arm reads
 *      `speechWindow(slot)` and `speechBookedMinutes(slot)`, overriding
 *      whatever the beat declared — so a contestant's 1/1.5/2 window vanished
 *      and every contestant rendered at the 7-minute default.
 *   3. Section bands smuggled through as `handoff`, which renders as an
 *      indented italic elbow meaning "X introduces Y".
 *
 * Pure: no database access, so every branch here is reachable from a unit test.
 */
import {
	type AgendaRow,
	type AgendaSlot,
	assigneeDisplay,
	evaluatedSpeakerLabel,
	introducedSuffix,
	numbered,
	OPEN_LABEL,
	pairedEvaluatorNames,
	resolveDetailTokens,
	type TimingMarks,
} from "./agenda-runsheet";
import {
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "./meeting-template-limits";
import { speechBookedMinutes, speechWindow } from "./speech-window";
import {
	resolveTableTopicsMarks,
	TABLE_TOPICS_ROLE_KEY,
	type TableTopicsLimits,
} from "./table-topics-limits";

/**
 * A beat's CONTENT, with no identity — what a seed authors and what gets
 * inserted.
 *
 * Split from `TemplateBeatRow` because the two are genuinely different things
 * and conflating them is a live hazard, not a tidiness point:
 * `seed-global-templates.ts` inserts with `.values(seed.beats.map((b) => ({
 * ...b, templateId: id })))`, spreading the whole object. Give a seed an `id`
 * and it is written as the PRIMARY KEY — a uuid column, so a readable
 * placeholder throws outright and a real uuid would collide across templates.
 */
export type TemplateBeatSeed = {
	sortOrder: number;
	kind: "section" | "role" | "event";
	label: string;
	detail: string | null;
	minutes: number;
	roleKey: string | null;
	repeatsRoleKey: string | null;
	flex: boolean;
	handoff: boolean;
	markGreen: number | null;
	markYellow: number | null;
	markRed: number | null;
	/**
	 * Whether the CLUB owns this row's marks (#683) — see the column's own
	 * docblock in `schema.ts`.
	 *
	 * REQUIRED rather than optional, for the reason `AgendaDraftRow.flex` is:
	 * every reader that forgets it fails in the direction that LOOKS fine.
	 * `undefined` reads as "not governed", so a loader that omitted the column
	 * would leave every club's Table Topics window frozen at its materialisation
	 * snapshot again, on every surface at once, with nothing throwing. Required
	 * means typecheck names each select and each seed.
	 */
	clubGoverned: boolean;
};

/**
 * One STORED row of `meeting_template_beats` — a seed that has been inserted
 * and read back, so it has an identity.
 *
 * The id is what lets `buildTemplateRowsWithSource` tell the editor which
 * stored beat each emitted row came from. `AgendaRow` has no id of its own,
 * and a repeat block emits several rows from one beat, so without this a table
 * row has no way to address the beat an edit should write to.
 */
export type TemplateBeatRow = TemplateBeatSeed & { id: string };

/** What this module needs from `meeting_template_roles`. */
export type TemplateRoleRow = {
	key: string;
	name: string;
	isSpeakerRole: boolean;
};

/**
 * One emitted row plus the stored beat and repeat iteration it came from.
 *
 * The agenda editor needs this and cannot re-derive it. `AgendaRow` carries no
 * id, so a table row has no way to address the beat an edit should write to;
 * and re-running the block grouping inside a component would duplicate the
 * very logic this module owns — the same second-derivation the editor's clock
 * deliberately avoids by calling `resolveAgendaRows` rather than reimplementing
 * it.
 *
 * `iteration` / `iterationCount` are what let the editor band a repeat block by
 * ITERATION. Banding by beat is not possible: the expander emits a whole block
 * per iteration, so a two-beat block over four contestants interleaves as
 * speech, silence, speech, silence… and neither beat owns a contiguous run.
 */
export type SourcedAgendaRow = {
	row: GovernedAgendaRow;
	beatId: string;
	/** 0 for a non-repeating beat; the slot index within the block otherwise. */
	iteration: number;
	/** 1 for a non-repeating beat; the block's slot count otherwise. */
	iterationCount: number;
};

/**
 * An emitted row that also says whether the CLUB owns its marks (#683).
 *
 * The flag has to reach the projected deck: `beatTimingText` labels a row's span
 * as the club's Table Topics rule rather than as the ±30s speech grace, and it
 * used to decide that from the row's `roleKey` plus the presence of marks — the
 * same inference {@link isTableTopicsSegment} stopped making, so a vote row an
 * officer had timed got the club's labelling on the wall.
 *
 * An intersection carried on the TEMPLATE path's own rows rather than a field on
 * `AgendaRow` itself, because only this path has a stored beat to read it from.
 * `expandRunSheet` builds the standard flow from code-derived beats with no
 * template row behind them, and a plain `AgendaRow` is a perfectly good
 * `GovernedAgendaRow`: the flag absent means the club owns nothing, which is the
 * honest answer there. The deck only ever runs on this path — the routes call
 * `buildTemplateSlideDeck` exactly when the meeting has a template — but the
 * wider parameter type means a caller that hands it standard rows still
 * compiles, and still gets the truthful answer.
 */
export type GovernedAgendaRow = AgendaRow & { clubGoverned?: true };

/**
 * Cap by CODE POINTS, not UTF-16 units. Slicing a surrogate pair in half yields
 * a lone surrogate that renders as a replacement glyph and makes
 * `encodeURIComponent` throw for any consumer building a URL from it (#522).
 */
function capChars(value: string, max: number): string {
	const points = [...value];
	return points.length <= max ? value : points.slice(0, max).join("");
}

/** All three marks or none — a timer card with a hole in it is worse than no
 *  card, and a beat carrying green and red but no yellow is a data error. */
function resolveMarks(row: TemplateBeatRow): TimingMarks | null {
	const { markGreen, markYellow, markRed } = row;
	if (markGreen == null || markYellow == null || markRed == null) return null;
	return { green: markGreen, yellow: markYellow, red: markRed };
}

/** The minimum a row has to carry for {@link isTableTopicsSegment} to decide
 *  about it. Structural rather than `TemplateBeatRow`, and EXPORTED, because the
 *  agenda editor's `AgendaDraftRow` is the same fields under a different name
 *  and both sides call the same predicate — a caller that cannot name the
 *  constraint writes its own copy, which is how the two drifted apart in the
 *  first cut of #679. */
export type MarkedBeat = {
	kind: "section" | "role" | "event";
	roleKey: string | null;
	markGreen: number | null;
	markYellow: number | null;
	markRed: number | null;
	/** The stored answer to "does the club own this row's marks" (#683). */
	clubGoverned: boolean;
};

/** The three mark columns, narrowed to present. {@link isTableTopicsSegment} is a
 *  TYPE PREDICATE so a caller that has checked it does not then need a `?? 0`
 *  fallback the check already made unreachable — dead defence reads as care and
 *  is untestable by construction. */
type ClubOwnedMarks = {
	markGreen: number;
	markYellow: number;
	markRed: number;
};

/**
 * Whether a stored beat is a Table Topics row whose timer marks the CLUB owns.
 *
 * Exported because three places have to agree about it and disagreeing is
 * silent: {@link refreshTableTopicsMarks} decides which row to re-derive, the
 * agenda editor decides which row's three mark inputs to stop offering, and
 * `beatTimingText` decides which row's span the projected deck labels as the
 * club's rule rather than as the ±30s speech grace. The first cut of #679
 * hand-wrote the editor's copy with one condition missing, which disabled the
 * inputs on a row the server would not refresh — three permanently blank,
 * permanently disabled fields and no way back. Five review passes found it
 * independently. One function, every call site.
 *
 * **ONE condition, and it is a STORED column** (#683). Every earlier cut asked
 * the row about its own contents, and every one of those properties is
 * something the officer edits:
 *
 * - `flex` went first (#682). It is a length property behind a one-click "Pin"
 *   button about DURATION, so pinning the segment silently detached its timing
 *   from club settings — and it was a mutation SURVIVOR besides (deleting the
 *   clause left 2,434 tests green, because every fixture that excluded the vote
 *   row on `flex` excluded it on marks too).
 * - `roleKey` alone was never enough: the run of show gives THREE beats
 *   `table_topics_master` (the segment, the "Best Table Topics" vote, and the GE
 *   hand-off) and `beatSeed` labels all three `"Table Topics Master"`, so
 *   neither the key nor the label identifies the row.
 * - **All three marks present** was what told those three apart, and it is what
 *   #683 removed. Only the segment declares marks *when materialised* — but the
 *   marks are the officer's own field. Set timer marks on the Best Table Topics
 *   vote row and it began to match: the refresh pass overwrote them with the
 *   club's speaking window, the editor replaced its inputs with read-only text,
 *   and the only way out was delete-and-re-add. The officer was editing a
 *   different row than the one that broke.
 *
 * So the question is answered once, at materialisation, and stored. Nothing an
 * officer can type changes the answer, and the editor's own un-govern control is
 * the one way it moves.
 *
 * **Still a TYPE PREDICATE, and the marks it narrows are an invariant
 * {@link refreshTableTopicsMarks} establishes** rather than one this reads.
 * `resolveTableTopicsMarks` always answers with a full trio (the standard window
 * when the club has stated nothing), so a governed beat that has been through
 * the refresh carries all three. Every consumer that READS the narrowed marks is
 * downstream of it: `resolveAgendaRows` refreshes before building rows, and
 * `loadAgendaDraft` refreshes before the editor sees a draft. The one caller
 * upstream of the refresh is the refresh itself, which overwrites all three and
 * reads none of them.
 *
 * That ordering is also the point of dropping the marks clause rather than
 * keeping it alongside the column. A governed row whose marks are null — which
 * `assertMarks` permits, and which the Undo path could mint before the
 * placeholder was patched — must still be refreshed back onto the club's window.
 * Under the old predicate it stopped matching instead: never refreshed again, no
 * timer window on the run sheet, the agenda or the deck, while the Timer's role
 * sheet kept printing the club's. The marker replaces the inference; it does not
 * sit beside it.
 */
export function isTableTopicsSegment<T extends MarkedBeat>(
	beat: T,
): beat is T & ClubOwnedMarks {
	return beat.clubGoverned;
}

/**
 * Whether the club's Table Topics window COULD govern this row — i.e. whether
 * the agenda editor may offer to hand it back (#683).
 *
 * The mirror of {@link isTableTopicsSegment}, and it has to be inferred because
 * there is nothing else to ask: a row the officer has un-governed carries
 * `clubGoverned = false` like every other row, so only its role says it was ever
 * a candidate. Inference is safe HERE and was not there, because this decides
 * what BUTTON to show rather than whose numbers win — a false positive offers a
 * control the officer can ignore, where the old predicate's false positive
 * rewrote their data.
 *
 * Lives beside the predicate rather than in the editor because the editor must
 * not restate the role key: that is how the two copies drifted in #679, and
 * `table-topics-limits-wiring.guard.test.ts` fails a file that does.
 */
export function isClubGovernable(beat: {
	kind: MarkedBeat["kind"];
	roleKey: string | null;
}): boolean {
	return beat.kind === "role" && beat.roleKey === TABLE_TOPICS_ROLE_KEY;
}

/**
 * Re-derive the Table Topics segment's timer marks from the club's CURRENT
 * window (#679).
 *
 * `materialiseRunOfShow` snapshots the club's marks into the stored row, and
 * `resolveMarks` above makes that stored copy authoritative — deliberately, so
 * an officer's per-meeting edit survives. The cost was that a club editing its
 * window afterwards kept the frozen numbers on every meeting already
 * materialised, which in practice is every meeting whose agenda editor has ever
 * been opened (`loadAgendaDraft` materialises on READ).
 *
 * That was not a stale number in isolation, and the sharpest version is why
 * this re-derives rather than waiting for a button. The Timer's printed role
 * sheet has re-derived from the live columns since #443 — `standardTimingRows`
 * reads `clubs.table_topics_*_seconds` on every render — so the club that
 * edited its window was already being handed a PACKET whose run sheet said one
 * thing and whose Timer card said another, stapled together. A "refresh from
 * club settings" action would leave those two disagreeing until someone
 * noticed; this makes them the same derivation from the same source.
 *
 * **What it costs, stated plainly:** the Table Topics segment's marks stop
 * being per-meeting data. An officer can no longer give one meeting a different
 * Table Topics window through the agenda editor — which is why the editor shows
 * that row's window as read-only text rather than accepting an edit it would
 * discard, and why a meeting that already carries a hand-set override starts
 * printing the club's window instead on the next render. The capability was not
 * really there before: the deck labels this row's span as the club's
 * disqualification rule and the Timer's card ignores the row entirely, so a
 * per-meeting override already contradicted two surfaces the moment it was made.
 *
 * Applied at the two seams that hold a club: `resolveAgendaRows`, which every
 * render surface goes through, and `loadAgendaDraft`, so the editor shows what
 * will actually print. NOT applied inside `buildTemplateRows`, which takes no
 * club and has ~50 test call sites — threading an optional window through there
 * would mean a caller that omits it silently REPLACING a club's window with the
 * standard one, which is the #443 freeze bug relocated to render time.
 *
 * Note `null` here means "the club states nothing", NOT "leave the rows alone":
 * it resolves to the standard window and OVERWRITES. A third render seam that
 * forgets to join the club columns would therefore print our rule over the
 * club's, silently — which is why `table-topics-limits-wiring.guard.test.ts`
 * sweeps `src/` for every `buildTemplateRows` caller rather than pinning the two
 * known ones by name.
 */
export function refreshTableTopicsMarks<T extends MarkedBeat>(
	beats: T[],
	tableTopicsLimits: TableTopicsLimits | null,
): T[] {
	const marks = resolveTableTopicsMarks(tableTopicsLimits);
	return beats.map((beat) =>
		isTableTopicsSegment(beat)
			? {
					...beat,
					markGreen: marks.green,
					markYellow: marks.yellow,
					markRed: marks.red,
				}
			: beat,
	);
}

/** Slots belonging to a template role, in slot order. */
function slotsForRole(slots: AgendaSlot[], roleKey: string): AgendaSlot[] {
	return slots
		.filter((s) => s.roleKey === roleKey)
		.sort((a, b) => a.slotIndex - b.slotIndex);
}

/** "Ada", "Ada and Grace", "Ada, Grace and Alan" — one beat, several holders. */
function joinHolders(names: string[]): string {
	return new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	}).format(names);
}

/**
 * At most ONE open placeholder in a holder list.
 *
 * `assigneeDisplay` answers an unclaimed slot with `OPEN_LABEL`, so a beat
 * bound to two unclaimed Ballot Counters printed `Tallying · — open — and —
 * open —` on a real sheet — prose that says nothing the single placeholder
 * does not, in a list format built for distinct names.
 *
 * Collapsed rather than dropped, deliberately. A role nobody has signed up
 * for must still appear (v1.24.0.0 fixed the opposite bug: such a row was
 * vanishing from the printed agenda entirely, so nothing told the club the
 * job was open). On a partly-claimed row `Ada and — open —` is the honest
 * reading, and that is what this keeps.
 */
function collapseOpen(names: string[]): string[] {
	let seenOpen = false;
	return names.filter((n) => {
		if (n !== OPEN_LABEL) return true;
		if (seenOpen) return false;
		seenOpen = true;
		return true;
	});
}

/**
 * One row from one stored beat, bound to the slots it names.
 *
 * `bound` is the whole difference from the design this replaced: a repeated
 * block passes the one slot for that iteration, so the row names that person
 * and nobody else; a non-repeating role beat passes every slot the role owns,
 * so the row names all of them together.
 *
 * The row's `who` is the beat's LABEL — the activity ("Contest briefing",
 * "Results and certificates") — not the role name. A contest runs seven
 * different beats owned by the Contest Chair, and labelling them all
 * "Contest Chair" would collapse seven distinct activities into one repeated
 * string. The role identity travels in `roleKey`, which is what the print
 * layouts colour by (#445), and the assignee is appended so the sheet still
 * says who is doing it.
 */
function toRow(
	row: TemplateBeatRow,
	rolesByKey: Map<string, TemplateRoleRow>,
	bound: AgendaSlot[],
	index: number,
	total: number,
	/** EVERY slot on the meeting, not just this row's. A detail token names
	 *  other roles — "Introduces the {role:table_topics_master}" sits on a
	 *  Toastmaster row — so resolving against `bound` alone silently produces
	 *  "Introduces the " for every cross-role cue on the sheet. */
	allSlots: AgendaSlot[],
	/**
	 * The SPEAKER slot this row's repeat block is on, when it is on one (#719).
	 *
	 * Distinct from `bound`, which is the slots this row NAMES. The speech
	 * preamble is the Toastmaster's row sitting inside the speaker's block, so
	 * it names the Toastmaster and is ABOUT a speech that is not its own — the
	 * one thing `{evaluator:paired}` needs and `bound` cannot supply.
	 */
	blockSlot: AgendaSlot | null = null,
): GovernedAgendaRow | null {
	const label = capChars(row.label, MAX_TEMPLATE_LABEL_CHARS);
	// Cap BEFORE resolving: the cap bounds what an officer TYPED, and resolution
	// can legitimately expand a short token into a long list of holder names.
	// Capping afterwards would truncate people's names instead of the input.
	const detail = resolveDetailTokens(
		capChars(row.detail ?? "", MAX_TEMPLATE_DETAIL_CHARS),
		allSlots,
		// A materialized beat's `{roles}` always carries its own group, so there
		// is no Beat-side list to fall back to. An officer who types a bare
		// `{roles}` by hand gets nothing, which is honest.
		() => [],
		// The evaluator paired to this iteration's speech (#719), so an adopted
		// template names the same person the code-derived sheet does — which is
		// 622a's promise and what `agenda-adoption-parity.test.ts` holds. Outside
		// a repeat block there is no speech to pair with and the token correctly
		// resolves to nothing.
		blockSlot
			? () => introducedSuffix(pairedEvaluatorNames(blockSlot.id, allSlots))
			: undefined,
	);
	const base = {
		detail,
		minutes: row.minutes,
		marks: resolveMarks(row),
		...(row.flex ? { flex: true as const } : {}),
		...(row.handoff ? { handoff: true as const } : {}),
		// Carried only when TRUE, like `flex` and `handoff` above, so an ordinary
		// row is byte-identical to what it was before #683 and the agenda/deck
		// parity fixtures that compare whole rows keep comparing the same object.
		...(row.clubGoverned ? { clubGoverned: true as const } : {}),
	};

	if (row.kind === "section") {
		// A band, never a presenter. `section` is a real field rather than a reuse
		// of `handoff`, whose renderer is an indented italic elbow meaning
		// "X introduces Y" — the wrong visual language for a segment header.
		return {
			who: label,
			roleKey: null,
			// A band is not anybody's turn (#732) — see `AgendaRow.slotId`.
			slotId: null,
			section: true,
			...base,
			marks: null,
		};
	}

	if (row.kind === "event") {
		// No owner, so no slot (#732).
		return { who: label, slotId: null, ...base };
	}

	// A role beat bound to NOBODY renders as a plain labelled beat — the same
	// shape `event` gets — rather than vanishing. Dropping it was invisible
	// authoring: "Add row: Role" inserts exactly this row (`addAgendaRow` sets
	// only kind/label/minutes, so `role_key` is null), and the Role select's
	// "Nobody" option returns any existing role row to it. The officer typed a
	// label and minutes, saw the card in the editor, and printed an agenda
	// without it — and the same absence reached the meeting page, the projected
	// deck and the `.pptx`, since all four read `buildTemplateRows`.
	//
	// Rendering it is the honest reading of what is stored: the beat has a
	// label and a duration, which is everything an `event` beat has. What it
	// lacks is an owner, and an agenda item with no owner is a normal thing for
	// a club to schedule. The alternative — keep it hidden and badge the editor
	// card — leaves the officer able to author an invisible row anyway, one
	// select away, and asks them to learn a rule instead of removing it.
	// The beat names no role, so it is bound to no slot either (#732).
	if (row.roleKey == null) return { who: label, slotId: null, ...base };
	const role = rolesByKey.get(row.roleKey);
	// A beat naming a role the template does not declare is dropped rather than
	// rendered against an invented name. The seed is the only writer in Phase 1,
	// so this is a corruption guard; Phase 2's editor needs a validation error.
	if (!role) return null;

	// A SPEAKER or EVALUATOR row is about one person's speech, so three of its
	// fields come from the SLOT rather than the beat — exactly as `expandRunSheet`
	// builds them. Without this an adopted agenda prints "Prepared speech" where
	// the code path printed the speech's own title and level, drops the Timer's
	// green/yellow/red for every speech, and says "Evaluates a speaker" instead
	// of naming who. The marks are the sharp end: the Timer works from the
	// printed sheet, and a speech row with no window gives them nothing to time.
	const oneSlot = bound.length === 1 ? bound[0] : null;
	// A speaker row reads its own speech; an evaluator row reads the speech it
	// evaluates. `isSpeakerRole` is true for BOTH in this repo's role model, so
	// they are told apart by whether the slot points at a speaker.
	const isEvaluatorSlot = oneSlot?.evaluatesSlotId != null;
	// Only when the BEAT declares no window of its own. A beat carrying marks is
	// stating that the format fixes this segment — a contest's "Impromptu answer"
	// runs 1:00-2:00 whoever is speaking — and must keep them. A standard speech
	// beat declares none and defers to the speaker's own project, which is what
	// `expandRunSheet` has always done.
	const speechSlot =
		role.isSpeakerRole && oneSlot && !isEvaluatorSlot && base.marks == null
			? oneSlot
			: null;
	const evaluatedLabel =
		oneSlot && isEvaluatorSlot
			? evaluatedSpeakerLabel(oneSlot, allSlots)
			: null;
	const window = speechSlot ? speechWindow(speechSlot) : null;
	const speechMarks = window
		? {
				green: window.min,
				yellow: (window.min + window.max) / 2,
				red: window.max,
			}
		: null;

	// Number by the SLOT when the role really repeats, and label the assignee
	// from the slot so a club that renamed the role sees its own word (#445).
	const numberedLabel = numbered(label, index, total > 1);
	const displayed = bound
		.map((s) => assigneeDisplay(s))
		.filter((n): n is string => n != null && n !== "");
	// An UNORDERED role drops the placeholder entirely once anyone holds it
	// (#624): a contest is entered, not staffed, so an unclaimed contestant place
	// is one fewer entrant rather than a job to recruit into, and "and — open —"
	// trailing the speaking list says the opposite. Every ordered role keeps
	// `collapseOpen`'s single placeholder — see its docblock. Read off the SLOTS
	// rather than the template role, which does not carry the flag; the loaders
	// put it on every slot they return.
	const held = displayed.filter((n) => n !== OPEN_LABEL);
	const names =
		bound.some((s) => s.slotsUnordered) && held.length > 0
			? held
			: collapseOpen(displayed);
	const holder = names.length > 0 ? joinHolders(names) : null;
	const who = holder ? `${numberedLabel} · ${holder}` : numberedLabel;
	// The halves unjoined (#463), same as the standard path. `holder` is null on a
	// beat whose role has no slot, where `who` is the label alone.
	return {
		who,
		roleLabel: numberedLabel,
		holder,
		// And the halves of `holder` itself — see `AgendaRow.holders`. Omitted
		// rather than empty when nobody holds the row, so "one holder" and
		// "nobody" stay distinguishable at every consumer.
		...(names.length > 0 ? { holders: names } : {}),
		roleKey: role.key,
		// The row's one slot, when it has exactly one (#732). That is every
		// iteration of a `repeatsRoleKey` block, which binds one slot per row.
		// NULL on a non-repeating beat bound to two or more — two ballot counters
		// perform one tally together, and the row is about both of them, so there
		// is no single turn to name. Also null when the role has no slot at all.
		// Reuses `oneSlot`, which the speech/evaluator overrides below already
		// gate on, so "this row is about one person" is asked once.
		slotId: oneSlot?.id ?? null,
		...base,
		// Slot-derived overrides, applied AFTER `base` so they win. Only ever set
		// on a speaker or evaluator row bound to exactly one slot; every other row
		// keeps the beat's own detail, minutes and marks untouched.
		...(speechSlot
			? {
					detail: speechSlot.speechTitle
						? `"${speechSlot.speechTitle}"${
								speechSlot.projectLevel ? ` · ${speechSlot.projectLevel}` : ""
							}`
						: base.detail,
					minutes: speechBookedMinutes(speechSlot),
					marks: speechMarks,
				}
			: {}),
		...(evaluatedLabel ? { detail: `Evaluates ${evaluatedLabel}` } : {}),
	};
}

/**
 * Expand a template into finished agenda rows.
 *
 * Rows are taken in `sortOrder`. A run of CONSECUTIVE rows sharing the same
 * non-null `repeatsRoleKey` forms one block emitted once per slot of that role
 * (capped at `MAX_ROLE_REPEAT_SLOTS`), each iteration bound to exactly one
 * slot. A block whose role has no slots emits nothing.
 *
 * A NON-repeating role beat emits ONE row, naming every holder of its role.
 * It used to emit one row per slot, which was right for a roster and wrong for
 * a run of show: two ballot counters perform one tally together, and printing
 * it twice booked twice the minutes.
 *
 * That one row's holder list is capped at `MAX_ROLE_REPEAT_SLOTS` too
 * (#task-10 review), same as the repeat path a few lines below — this branch
 * had no analogue of that cap until now. It was never a live bug while
 * `defaultCount` was seed-fixed at small numbers, but Task 8's editor makes
 * a role's slot count officer-editable (`addAgendaRole` caps it at
 * `MAX_ROLE_REPEAT_SLOTS` at the writer), and a writer cap is not the only
 * way this number can grow: a `role_definitions` row materialized before a
 * cap existed, one inserted directly, or a template copied from a source
 * whose own count was never re-validated (`copyTemplateForMeeting` copies
 * `defaultCount` verbatim) can all still hand this branch more slots than the
 * writer would ever accept today. Capping at the RENDERER — the seam every
 * one of those paths funnels through — closes all of them at once, the same
 * defense-in-depth reasoning `MAX_TEMPLATE_BEATS`'s docblock states for
 * `loadTemplateBeats`. Measured cost of NOT capping: one non-repeating beat
 * bound to 50,000 slots rendered in ~90ms alone (`meeting-template-limits.bench.test.ts`);
 * negligible per beat, but multiplied by every such beat a corrupted or
 * pre-cap row could produce, an uncapped join is real, not theoretical, cost.
 */
export function buildTemplateRowsWithSource(
	beats: TemplateBeatRow[],
	roles: TemplateRoleRow[],
	slots: AgendaSlot[],
): SourcedAgendaRow[] {
	const rolesByKey = new Map(roles.map((r) => [r.key, r]));
	const ordered = [...beats].sort((a, b) => a.sortOrder - b.sortOrder);
	const out: SourcedAgendaRow[] = [];

	let i = 0;
	while (i < ordered.length) {
		const row = ordered[i];
		if (!row) break;

		if (row.repeatsRoleKey == null) {
			if (row.kind === "role" && row.roleKey != null) {
				// ONE row per beat. Every holder of the role is named on it; the
				// beat repeats per holder only when it says so via repeatsRoleKey.
				// Capped the same as the repeat path below — see this function's
				// docblock for why a writer-side cap on `defaultCount` is not
				// enough on its own.
				const owned = slotsForRole(slots, row.roleKey).slice(
					0,
					MAX_ROLE_REPEAT_SLOTS,
				);
				const emitted = toRow(row, rolesByKey, owned, 0, 0, slots);
				if (emitted) {
					out.push({
						row: emitted,
						beatId: row.id,
						iteration: 0,
						iterationCount: 1,
					});
				}
			} else {
				const emitted = toRow(row, rolesByKey, [], 0, 0, slots);
				if (emitted) {
					out.push({
						row: emitted,
						beatId: row.id,
						iteration: 0,
						iterationCount: 1,
					});
				}
			}
			i += 1;
			continue;
		}

		// Gather the consecutive run sharing this repeatsRoleKey.
		const repeatKey = row.repeatsRoleKey;
		const block: TemplateBeatRow[] = [];
		while (i < ordered.length) {
			const next = ordered[i];
			if (!next || next.repeatsRoleKey !== repeatKey) break;
			block.push(next);
			i += 1;
		}

		const repeated = slotsForRole(slots, repeatKey).slice(
			0,
			MAX_ROLE_REPEAT_SLOTS,
		);
		repeated.forEach((s, n) => {
			for (const blockRow of block) {
				// Bind the ROLE-owning row to this iteration's slot; the others in
				// the block (a minute of silence) own no slot and repeat as-is.
				//
				// The ONE exception is a HAND-OFF row inside a block it does not own
				// (#719's speech preamble, repeating alongside the speech it
				// introduces). A hand-off row says "X introduces Y": X has to be a
				// person, and X is never "the 2nd of anything" — so it binds to its
				// own role's holders and keeps its label unnumbered, where the
				// default would print "Toastmaster of the Day 1" holding nobody. The
				// exception is scoped to `handoff` rather than to every non-owning
				// role row so that no other template row's rendering moves: a plain
				// role beat an officer parks inside a repeat block is unchanged.
				const owns = blockRow.roleKey === repeatKey;
				const introducerKey =
					!owns && blockRow.handoff && blockRow.kind === "role"
						? blockRow.roleKey
						: null;
				const bound = owns
					? [s]
					: introducerKey != null
						? slotsForRole(slots, introducerKey).slice(0, MAX_ROLE_REPEAT_SLOTS)
						: [];
				const emitted = toRow(
					blockRow,
					rolesByKey,
					bound,
					// Only the hand-off exception moves; every other block row keeps
					// the iteration's index and count exactly as before. 0/0 is what
					// the non-repeating role path passes, and it leaves the label
					// unnumbered.
					introducerKey != null ? 0 : n,
					introducerKey != null ? 0 : repeated.length,
					slots,
					// The iteration's slot, passed to EVERY row in the block rather
					// than only the owning one: a block row that does not own the slot
					// is still about it (#719's speech preamble), and that is the only
					// thing distinguishing it from an unrelated row on the sheet.
					s,
				);
				if (emitted) {
					out.push({
						row: emitted,
						beatId: blockRow.id,
						iteration: n,
						iterationCount: repeated.length,
					});
				}
			}
		});
	}

	return out;
}

/** The rows alone — the name every renderer already imports. ONE
 *  implementation, two views of it: a renderer wants rows, and the editor
 *  wants to know which stored beat each row came from. */
export function buildTemplateRows(
	beats: TemplateBeatRow[],
	roles: TemplateRoleRow[],
	slots: AgendaSlot[],
): GovernedAgendaRow[] {
	return buildTemplateRowsWithSource(beats, roles, slots).map((e) => e.row);
}
