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
	numbered,
	OPEN_LABEL,
	resolveDetailTokens,
	type TimingMarks,
} from "./agenda-runsheet";
import {
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "./meeting-template-limits";

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
	row: AgendaRow;
	beatId: string;
	/** 0 for a non-repeating beat; the slot index within the block otherwise. */
	iteration: number;
	/** 1 for a non-repeating beat; the block's slot count otherwise. */
	iterationCount: number;
};

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
): AgendaRow | null {
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
	);
	const base = {
		detail,
		minutes: row.minutes,
		marks: resolveMarks(row),
		...(row.flex ? { flex: true as const } : {}),
		...(row.handoff ? { handoff: true as const } : {}),
	};

	if (row.kind === "section") {
		// A band, never a presenter. `section` is a real field rather than a reuse
		// of `handoff`, whose renderer is an indented italic elbow meaning
		// "X introduces Y" — the wrong visual language for a segment header.
		return { who: label, roleKey: null, section: true, ...base, marks: null };
	}

	if (row.kind === "event") {
		return { who: label, ...base };
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
	if (row.roleKey == null) return { who: label, ...base };
	const role = rolesByKey.get(row.roleKey);
	// A beat naming a role the template does not declare is dropped rather than
	// rendered against an invented name. The seed is the only writer in Phase 1,
	// so this is a corruption guard; Phase 2's editor needs a validation error.
	if (!role) return null;

	// Number by the SLOT when the role really repeats, and label the assignee
	// from the slot so a club that renamed the role sees its own word (#445).
	const numberedLabel = numbered(label, index, total > 1);
	const names = collapseOpen(
		bound
			.map((s) => assigneeDisplay(s))
			.filter((n): n is string => n != null && n !== ""),
	);
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
		...base,
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
				const bound = blockRow.roleKey === repeatKey ? [s] : [];
				const emitted = toRow(
					blockRow,
					rolesByKey,
					bound,
					n,
					repeated.length,
					slots,
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
): AgendaRow[] {
	return buildTemplateRowsWithSource(beats, roles, slots).map((e) => e.row);
}
