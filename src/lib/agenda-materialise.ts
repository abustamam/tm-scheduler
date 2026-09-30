// src/lib/agenda-materialise.ts
import {
	type Beat,
	type BeatPreamble,
	buildRunOfShow,
	type RoleGroup,
} from "./agenda-runsheet";
import {
	isClubGovernable,
	type TemplateBeatSeed,
} from "./agenda-template-rows";
import type { TableTopicsLimits } from "./table-topics-limits";

/**
 * Turn the code-derived run of show into rows a club can edit.
 *
 * ```
 * buildRunOfShow({ geIntroducesFunctionaries, tableTopicsLimits })
 *         |  22 beats, or 23 on the GE variant (one of which seeds an extra
 *         |  row for its `preamble`, #719) — carrying the CLUB's variant
 *         |  AND its Table Topics marks, SNAPSHOTTED below as the row's initial
 *         |  value (#443) and re-derived at render since #679
 *         v
 *   drop the gating   <- D1: a row stays until deleted, so the gate is
 *         |               evaluated ONCE, here, and never again
 *         v
 *   open five bands (D2)
 *         |  + 5 section rows
 *         v
 *   Beat -> TemplateBeatSeed
 *         |  detail tokens VERBATIM (D7), handoff carried (D8)
 *         v
 *   TemplateBeatSeed[]
 * ```
 *
 * Pure and `#/db`-free on purpose: the golden band tables in
 * `agenda-materialise.test.ts` are the acceptance criteria for this module, and
 * a `createServerFn` handler body is unreachable from vitest.
 */

/** The five bands, in the order they open. Spec D2. */
export const BAND_LABELS = [
	"OPENING",
	"SPEECHES",
	"TABLE TOPICS",
	"EVALUATIONS",
	"CLOSING",
] as const;

/**
 * The index, in the original beat list, of the beat each band opens on.
 *
 * Derived structurally rather than hardcoded, because the two variants differ
 * by one beat and the GE opening pair shifts everything after it. Only five
 * beats carry a stable `id`, so the hand-off that introduces each segment is
 * the reliable marker for the rest.
 */
function bandOpensAt(beats: Beat[]): number[] {
	const geOpening = beats.findIndex((b) => b.id === "geOpeningHandoff");
	const handoffs = beats.flatMap((b, i) => (b.handoff === true ? [i] : []));
	// SPEECHES opens on the first hand-off AFTER the GE opening pair (which is
	// itself a hand-off on that variant, hence the skip).
	const speeches = handoffs.find((i) => i > geOpening) ?? 0;
	// TABLE TOPICS opens on the next hand-off, the one introducing the TTM.
	const tableTopics = handoffs.find((i) => i > speeches) ?? 0;
	// EVALUATIONS is the one boundary with a stable id.
	const evaluations = beats.findIndex((b) => b.id === "geEvaluationHandoff");
	// CLOSING opens on the awards beat, immediately after the general evaluation.
	const closing = beats.findIndex((b) => b.id === "generalEvaluation") + 1;
	return [0, speeches, tableTopics, evaluations, closing];
}

export function materialiseRunOfShow(
	geIntroducesFunctionaries: boolean,
	/**
	 * The club's Table Topics window (#443), or null for the standard one.
	 *
	 * REQUIRED, for the same reason the variant above is passed: `beatSeed`
	 * PERSISTS `beat.marks` into `mark_green/mark_yellow/mark_red` on the
	 * template row, and `resolveMarks` (`agenda-template-rows.ts`) makes that
	 * stored copy what renders. So a template materialised without this freezes
	 * OUR window into the club's own rows, permanently — a club that later sets
	 * its rule sees nothing change on any surface, deck included.
	 *
	 * The snapshot is now the row's INITIAL value only. #679 closed the stale
	 * half: `refreshTableTopicsMarks` (`agenda-template-rows.ts`) re-derives this
	 * one row's marks from the club's current window at every render, so a club
	 * that edits its window after materialising no longer keeps the frozen
	 * numbers. Passing the club's window here still matters — the stored row
	 * should be right on the day it is written, and it is what a template COPY
	 * (`copyTemplateForMeeting`) carries forward.
	 *
	 * WHICH row the refresh re-derives is decided here too, and stored: see
	 * {@link clubGovernedIndex} and `meeting_template_beats.club_governed` (#683).
	 */
	tableTopicsLimits: TableTopicsLimits | null,
): TemplateBeatSeed[] {
	// NOT the `RUN_OF_SHOW` const — that is this call with the variant frozen
	// `false`, so reading it gives every club the 22-beat sheet and silently
	// drops MCF's `geOpeningHandoff`. Spec R5.
	const beats = buildRunOfShow({
		geIntroducesFunctionaries,
		tableTopicsLimits,
	});
	const opensAt = bandOpensAt(beats);
	const governed = clubGovernedIndex(beats);

	const out: TemplateBeatSeed[] = [];
	let band = 0;
	beats.forEach((beat, i) => {
		while (band < opensAt.length && opensAt[band] === i) {
			out.push(sectionSeed(BAND_LABELS[band] as string, out.length));
			band += 1;
		}
		// A beat with a `preamble` seeds TWO rows (#719), or a club-owned template
		// silently loses the introduction the code-derived run of show has. It
		// comes first, matching the order `expandRunSheet` emits, and joins the
		// beat's own repeat block so the two interleave per speaker.
		if (beat.kind === "role" && beat.preamble != null) {
			out.push(preambleSeed(beat.preamble, repeatsRoleKeyOf(beat), out.length));
		}
		out.push(beatSeed(beat, out.length, i === governed));
	});
	return out;
}

/**
 * The index of the ONE beat the club's Table Topics window governs, or -1 (#683).
 *
 * This is the same shape of question `isTableTopicsSegment` used to ask at
 * render time, and it is safe HERE and was not there. The input is the
 * CODE-DERIVED run of show, authored two files away and identical for every
 * club: three beats carry `table_topics_master` and exactly one of them declares
 * `marks`, because `buildRunOfShow` writes them on the speaking segment and
 * nowhere else. Nobody can edit it between here and the answer. What broke was
 * asking the same question of a STORED row months later, where the marks are a
 * field on the agenda editor's own form.
 *
 * `findIndex`, so the answer is at most one beat no matter what the run of show
 * grows into — "at most one governed row per meeting" is then structural rather
 * than a property of today's beat list. A run of show that ever declares Table
 * Topics marks on a second beat governs the first and leaves the second alone,
 * which is wrong quietly rather than wrong loudly; the alternative, governing
 * both, is the multi-row overwrite #683 is about.
 */
function clubGovernedIndex(beats: Beat[]): number {
	return beats.findIndex(
		(b) =>
			b.kind === "role" &&
			b.marks != null &&
			// The SAME predicate the editor asks before offering the re-govern
			// control and `assertGovernable` asks before allowing it, imported
			// rather than restated. Three writers have to agree about which rows the
			// club's window may govern, and a fourth copy of the role key here is
			// the drift #679 already paid for once.
			isClubGovernable(b),
	);
}

/**
 * The speech preamble as a template row (#719).
 *
 * It carries the SPEAKER's `repeatsRoleKey` even though it is the Toastmaster's
 * row, and that is the whole of how the adopted sheet interleaves. A
 * `repeatsRoleKey` run is expanded as a BLOCK — `buildTemplateRowsWithSource`
 * gathers the consecutive beats sharing the key and emits the whole block once
 * per slot — so preamble+speech repeat together as preamble 1, speech 1,
 * preamble 2, speech 2. Left null it would render one introduction ahead of
 * every speech, which is the ordering #719 exists to avoid and which
 * `agenda-adoption-parity.test.ts` would (rightly) fail: adoption must not
 * change the printed sheet.
 *
 * Only the row whose `roleKey` EQUALS the repeat key is bound to the
 * iteration's slot, so this stays the Toastmaster's row and does not become the
 * speaker's — the same mechanism a contest's "minute of silence" beat uses to
 * sit inside a block it does not own.
 *
 * `detail` is carried VERBATIM (spec D7) including `PAIRED_EVALUATOR_TOKEN`,
 * which the template renderer resolves against the block's own speaker slot.
 *
 * A `handoff`, matching the row `expandRunSheet` emits: the flag is what makes
 * the print layouts render it as a compact band, and on the editorial one-pager
 * that is the difference between one sheet and two. It adds no deck slide — the
 * deck reads hand-off BEATS, by position.
 */
function preambleSeed(
	preamble: BeatPreamble,
	repeatsRoleKey: string | null,
	sortOrder: number,
): TemplateBeatSeed {
	return {
		sortOrder,
		kind: "role",
		label: preamble.roleName,
		detail: preamble.detail,
		minutes: preamble.minutes,
		roleKey: preamble.roleKey,
		repeatsRoleKey,
		flex: false,
		handoff: true,
		markGreen: null,
		markYellow: null,
		markRed: null,
		clubGoverned: false,
	};
}

function sectionSeed(label: string, sortOrder: number): TemplateBeatSeed {
	return {
		sortOrder,
		kind: "section",
		label,
		detail: null,
		minutes: 0,
		roleKey: null,
		repeatsRoleKey: null,
		flex: false,
		handoff: false,
		markGreen: null,
		markYellow: null,
		markRed: null,
		clubGoverned: false,
	};
}

/**
 * The key a beat fans out over, or null.
 *
 * A speaker or evaluator beat fans out across every matching slot, which is
 * what `repeatsRoleKey` means in the template model. Materialising it as a
 * literal row instead would give a three-speaker meeting ONE speech.
 *
 * Named rather than inlined in `beatSeed` because the preamble row has to join
 * the SAME block (#719), and a second copy of the predicate is how the two
 * would come to disagree about which beats repeat — leaving a preamble stranded
 * outside its block, printing once.
 */
function repeatsRoleKeyOf(beat: Beat): string | null {
	return beat.kind === "role" &&
		(beat.role === "speaker" || beat.role === "evaluator")
		? beat.roleKey
		: null;
}

function beatSeed(
	beat: Beat,
	sortOrder: number,
	/** True on the ONE beat {@link clubGovernedIndex} picked (#683): the club's
	 *  Table Topics window owns this row's marks from here on, and
	 *  `refreshTableTopicsMarks` re-derives them at every render. */
	clubGoverned: boolean,
): TemplateBeatSeed {
	const isRole = beat.kind === "role";
	const repeats = repeatsRoleKeyOf(beat);
	const marks = isRole ? beat.marks : null;
	return {
		clubGoverned,
		sortOrder,
		kind: beat.kind,
		label: isRole ? beat.roleName : beat.who,
		detail: qualifyRolesToken(beat) || null,
		minutes: beat.minutes,
		roleKey: isRole ? beat.roleKey : null,
		repeatsRoleKey: repeats,
		flex: beat.flex === true,
		handoff: beat.handoff === true,
		markGreen: marks?.green ?? null,
		markYellow: marks?.yellow ?? null,
		markRed: marks?.red ?? null,
	};
}

/**
 * Rewrite a bare `{roles}` into `{roles:<group>}`.
 *
 * The token resolves through the beat's `requiresGroup` today, and a
 * materialised row has no gating fields (D1). Putting the group INSIDE the
 * token keeps the list dynamic — it still names whoever holds those roles that
 * week — without a column and without reviving the gate.
 */
function qualifyRolesToken(beat: Beat): string {
	const group: RoleGroup | undefined = beat.requiresGroup;
	if (group == null) return beat.detail;
	return beat.detail.replaceAll("{roles}", `{roles:${group}}`);
}

// ---------------------------------------------------------------------------
// "Still on the standard agenda" (#910)
// ---------------------------------------------------------------------------

/**
 * The columns of a stored beat the comparator reads. Everything
 * {@link TemplateBeatSeed} carries except `sortOrder`, which is not compared
 * as a VALUE: the caller hands the beats over in `sort_order`, and the
 * comparison is positional.
 */
export type ComparableBeat = Omit<TemplateBeatSeed, "sortOrder">;

/** The two columns of a declared role the comparator reads. */
export type ComparableRole = { key: string; defaultCount: number };

/** A stored agenda, or the one the standard would produce, as compared. */
export type ComparableAgenda = {
	/** In `sort_order`. */
	beats: readonly ComparableBeat[];
	/** Any order; compared sorted by `key`. */
	roles: readonly ComparableRole[];
};

/**
 * Every beat column the comparison looks at. Listed rather than spread so a
 * column added to the table later has to be decided about here: `id`,
 * `template_id` and timestamps are the only columns deliberately left out.
 */
const COMPARED_BEAT_FIELDS = [
	"kind",
	"label",
	"detail",
	"minutes",
	"roleKey",
	"repeatsRoleKey",
	"flex",
	"handoff",
	"clubGoverned",
	"markGreen",
	"markYellow",
	"markRed",
] as const satisfies readonly (keyof ComparableBeat)[];

/** The three mark columns are `real` — FLOAT4 — so a stored mark reads back
 *  rounded to single precision: a club's 2:20 Table Topics cap is 2.333…
 *  minutes in the materialiser and 2.3333332538604736 out of Postgres.
 *  Compared at the precision the column keeps, or every club with a window
 *  that is not a whole half-minute would read as edited. */
const FLOAT4_FIELDS: ReadonlySet<string> = new Set([
	"markGreen",
	"markYellow",
	"markRed",
]);

function sameValue(field: string, a: unknown, b: unknown): boolean {
	if (
		FLOAT4_FIELDS.has(field) &&
		typeof a === "number" &&
		typeof b === "number"
	)
		return Math.fround(a) === Math.fround(b);
	return a === b;
}

/**
 * Whether a meeting's stored agenda is EXACTLY what the standard agenda would
 * materialise for its club right now (#910).
 *
 * Exists because a private copy no longer implies an edit: merely opening the
 * agenda editor materialises one (`loadAgendaDraft`). Setting a club default
 * applies it to meetings still on the standard agenda, and without this every
 * meeting an officer had so much as looked at would count as "kept its own
 * edited agenda" and keep the old shape.
 *
 * `expected` must be computed NOW from the club's CURRENT settings and roles,
 * never cached from when the copy was made. So a meeting opened last month,
 * before the club renamed a role or changed its Table Topics window, reads as
 * edited and is KEPT. That is the safe direction: the worst it costs is one
 * meeting the officer re-applies by hand, where the other direction silently
 * overwrites a real edit.
 *
 * Beats compared positionally, every column in `COMPARED_BEAT_FIELDS`; roles
 * compared as a SET of `{key, defaultCount}`, sorted by key, so the order the
 * declarations were written in does not matter.
 *
 * Pure and `#/db`-free, like the materialiser beside it, so every branch is a
 * unit test.
 */
export function agendaMatchesStandard(
	stored: ComparableAgenda,
	expected: ComparableAgenda,
): boolean {
	if (stored.beats.length !== expected.beats.length) return false;
	for (let i = 0; i < stored.beats.length; i++) {
		const a = stored.beats[i] as ComparableBeat;
		const b = expected.beats[i] as ComparableBeat;
		for (const field of COMPARED_BEAT_FIELDS) {
			if (!sameValue(field, a[field], b[field])) return false;
		}
	}
	if (stored.roles.length !== expected.roles.length) return false;
	const byKey = (x: ComparableRole, y: ComparableRole) =>
		x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
	const a = [...stored.roles].sort(byKey);
	const b = [...expected.roles].sort(byKey);
	return a.every(
		(role, i) =>
			role.key === b[i]?.key && role.defaultCount === b[i]?.defaultCount,
	);
}
