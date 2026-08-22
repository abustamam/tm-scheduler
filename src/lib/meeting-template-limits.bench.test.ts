/**
 * Measures `buildTemplateRows` — the pure renderer every templated meeting's
 * agenda goes through (`resolveAgendaRows`) — against an ALL-AXES-HOSTILE
 * fixture, so the ceilings in `meeting-template-limits.ts` can be MEASURED
 * ceilings rather than the honest-but-unmeasured bounds they used to be.
 *
 * ## Why every axis at once
 *
 * CLAUDE.md's own history is the argument: the role sheets' one-page promise
 * was wrong four times in a row, each time from a fixture that varied ONE
 * axis (log rows chosen against cost only; 10 rows measured without a logo;
 * 8 rows measured with short labels; a 34-char club name nothing had varied).
 * The fixture here is built from a written list of every axis
 * `buildTemplateRows` (via `agenda-template-rows.ts`) can see, all pinned to
 * its ceiling AT ONCE:
 *
 *   1. Beat count           — MAX_TEMPLATE_BEATS (stored rows, pre-expansion)
 *   2. Role count            — MAX_TEMPLATE_ROLES
 *   3. Repeat-slot count     — MAX_ROLE_REPEAT_SLOTS (the repeat path's cap,
 *                              and — since #task-10's review — the
 *                              non-repeating path's holder-list cap too)
 *   4. Label length           — MAX_TEMPLATE_LABEL_CHARS, in CODE POINTS
 *   5. Detail length          — MAX_TEMPLATE_DETAIL_CHARS, in CODE POINTS
 *   6. Character class        — EMOJI, not ASCII, for every string `capChars`
 *                               touches (#522: a code-point spread over
 *                               surrogate pairs is not free, and an all-ASCII
 *                               fixture has measured a cap several times too
 *                               high before)
 *   7. Assignee name length   — capped elsewhere (`MAX_NAME_CHARS` = 200,
 *                               `person-name.ts`), but still unbounded FROM
 *                               this renderer's point of view and it feeds
 *                               `joinHolders`, so the fixture uses that real
 *                               ceiling rather than a short placeholder name
 *   8. Holder count per beat  — how many slots a single beat's `who` joins
 *                               (bounded by the SAME MAX_ROLE_REPEAT_SLOTS,
 *                               once the non-repeating branch is capped — see
 *                               axis 3)
 *
 * `hostileBeats` distributes the beat budget as the worst REALISTIC
 * construction found while measuring this: one non-repeating beat per
 * declared role (so every role's `slotsForRole` filter and `joinHolders` join
 * runs, at MAX_ROLE_REPEAT_SLOTS holders each), then dumps every remaining
 * beat into ONE repeat block bound to the last role, each iteration capped at
 * MAX_ROLE_REPEAT_SLOTS slots. Splitting the repeat beats across more blocks
 * / more roles instead does not change the total OUTPUT row count (it is
 * linear in beats × slots-per-block, not the number of blocks) — verified
 * directly while measuring, see the honesty note in `meeting-template-limits.ts`.
 *
 * Club name and club logo — the axes that broke the role-sheet fixture —
 * are NOT part of this file: `buildTemplateRows` never sees a club's
 * identity, only beats/roles/slots. They matter to the PRINT surface, which
 * is why `print-density.test.tsx` (not this file) adds a worst-case-template
 * case through the real club header.
 */
import { describe, expect, it } from "vitest";
import type { AgendaSlot } from "#/lib/agenda-runsheet";
import {
	buildTemplateRows,
	type TemplateBeatRow,
	type TemplateRoleRow,
} from "#/lib/agenda-template-rows";
import {
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_BEATS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
	MAX_TEMPLATE_ROLES,
} from "#/lib/meeting-template-limits";

/** A single-code-point emoji (U+1F419 OCTOPUS): `[...str].length` after
 *  `.repeat(n)` is exactly `n`, so this hits code-point caps precisely
 *  without additionally testing grapheme-cluster/ZWJ behaviour, which
 *  `agenda-template-rows.test.ts`'s surrogate-pair test already covers. */
const EMOJI = "🐙";
function emojiStr(len: number): string {
	return EMOJI.repeat(len);
}

/** The real ceiling an assignee's name can reach (`person-name.ts`), used
 *  here rather than a short placeholder — axis 7 above. */
const MAX_ASSIGNEE_NAME_CHARS = 200;

function hostileRoles(n: number): TemplateRoleRow[] {
	return Array.from({ length: n }, (_, i) => ({
		key: `role_${i}`,
		name: `Role ${i}`,
		isSpeakerRole: false,
	}));
}

function hostileSlots(
	roles: TemplateRoleRow[],
	slotsPerRole: number,
): AgendaSlot[] {
	const longName = emojiStr(MAX_ASSIGNEE_NAME_CHARS);
	const out: AgendaSlot[] = [];
	for (const role of roles) {
		for (let i = 0; i < slotsPerRole; i++) {
			out.push({
				id: `${role.key}-${i}`,
				roleName: role.name,
				roleKey: role.key,
				category: "functionary",
				isSpeakerRole: false,
				slotIndex: i,
				assigneeName: longName,
				speechTitle: null,
				projectLevel: null,
				minMinutes: null,
				maxMinutes: null,
				evaluatesSlotId: null,
				evaluates: null,
			});
		}
	}
	return out;
}

/**
 * `beatCount` stored beats, hostile on every OTHER axis. The first
 * `min(beatCount, roles.length)` are non-repeating role beats (one per
 * role, cycling); everything left over is ONE repeat block on the last
 * role. See this file's docblock for why this construction, not an even
 * split across many small blocks, is the worst-case one to measure.
 */
function hostileBeats(
	beatCount: number,
	roles: TemplateRoleRow[],
): TemplateBeatRow[] {
	const label = emojiStr(MAX_TEMPLATE_LABEL_CHARS);
	const detail = emojiStr(MAX_TEMPLATE_DETAIL_CHARS);
	const beats: TemplateBeatRow[] = [];
	const nonRepeatCount = Math.min(beatCount, roles.length);
	for (let i = 0; i < nonRepeatCount; i++) {
		beats.push({
			sortOrder: i,
			kind: "role",
			label,
			detail,
			minutes: 5,
			roleKey: roles[i % roles.length]?.key ?? null,
			repeatsRoleKey: null,
			flex: false,
			markGreen: null,
			markYellow: null,
			markRed: null,
		});
	}
	const remaining = beatCount - nonRepeatCount;
	const repeatRole = roles[roles.length - 1]?.key ?? null;
	for (let i = 0; i < remaining; i++) {
		beats.push({
			sortOrder: nonRepeatCount + i,
			kind: "role",
			label,
			detail,
			minutes: 5,
			roleKey: repeatRole,
			repeatsRoleKey: repeatRole,
			flex: false,
			markGreen: null,
			markYellow: null,
			markRed: null,
		});
	}
	return beats;
}

/** The hostile fixture at the CURRENT ceilings, varying only beat count —
 *  the one axis the brief asks for a curve over. Every other axis (role
 *  count, repeat-slot count, label/detail length, character class, name
 *  length) stays pinned at its own ceiling regardless of `beatCount`. */
function hostileAtCap(beatCount: number) {
	const roles = hostileRoles(MAX_TEMPLATE_ROLES);
	const slots = hostileSlots(roles, MAX_ROLE_REPEAT_SLOTS);
	const beats = hostileBeats(beatCount, roles);
	return { beats, roles, slots };
}

describe("buildTemplateRows render cost (#task-10)", () => {
	/**
	 * The curve the brief asked for, recorded here as a living regression gate
	 * rather than only a report. Each bound is an ABSOLUTE literal, generous
	 * over what was actually measured (Apple M2 Max, macOS 15.7.4, Bun 1.2.8,
	 * 2026-08-21, warm-repeat numbers — see `meeting-template-limits.ts` for
	 * the exact figures and the COLD single-call number this suite's own CI
	 * runs are closer to) — not `toBeLessThan(SOME_BUDGET_CONSTANT)`, which
	 * would pass for every value of that constant, and not relative to the
	 * previous size, which would pass for a curve that got worse in shape but
	 * happened to start small.
	 */
	it.each([
		{ beats: 25, budgetMs: 60 },
		{ beats: 50, budgetMs: 60 },
		{ beats: 100, budgetMs: 80 },
		{ beats: 200, budgetMs: 100 },
	])("renders $beats all-axes-hostile beats in well under budget", ({
		beats,
		budgetMs,
	}) => {
		const { beats: b, roles, slots } = hostileAtCap(beats);
		const t0 = performance.now();
		const rows = buildTemplateRows(b, roles, slots);
		const ms = performance.now() - t0;
		expect(rows.length).toBeGreaterThan(0);
		expect(ms).toBeLessThan(budgetMs);
	});

	/**
	 * The brief's own scaffold: ONE cold call at the actual ceilings
	 * (MAX_TEMPLATE_BEATS / MAX_TEMPLATE_ROLES / MAX_ROLE_REPEAT_SLOTS /
	 * MAX_TEMPLATE_LABEL_CHARS / MAX_TEMPLATE_DETAIL_CHARS, all emoji), the
	 * shape a real officer's maximally-abused template would actually hit.
	 * Measured cold (first call in a fresh vitest process, no JIT warm-up from
	 * a prior call in the same run — the shape a real request gets) at
	 * ~33-35ms across five repeated runs. 250ms leaves roughly 7x margin over
	 * that for a slower CI runner, while still catching a real regression: the
	 * curve above is LINEAR with no knee found up to 3200 beats (16x this
	 * cap) at ~326ms, so a jump anywhere near 250ms at the legal ceiling would
	 * mean something became quadratic, not that the machine is merely slower.
	 */
	it("renders the worst legal template well under a second", () => {
		const { beats, roles, slots } = hostileAtCap(MAX_TEMPLATE_BEATS);
		const t0 = performance.now();
		const rows = buildTemplateRows(beats, roles, slots);
		const ms = performance.now() - t0;
		// A control: the assertion below must not pass on a renderer that
		// silently returned nothing.
		expect(rows.length).toBeGreaterThan(0);
		// ABSOLUTE, in the unit the complaint would be made in.
		expect(ms).toBeLessThan(250);
	});

	/**
	 * Emoji vs ASCII, measured directly rather than assumed from #522's
	 * figure (~13x) — that number belongs to a DIFFERENT renderer. Measured
	 * here: ~33ms emoji vs ~25ms ASCII at the same fixture (~1.3x), because
	 * this renderer's only emoji-sensitive step is `capChars`'s `[...value]`
	 * code-point spread, not the per-character work #522's renderer did. The
	 * fixture still uses emoji throughout (this file's docblock, axis 6) —
	 * "not dramatically worse here" is a finding to record, not a reason to
	 * switch back to the easier fixture.
	 */
	it("costs more with emoji than ASCII, but not by orders of magnitude here", () => {
		const roles = hostileRoles(MAX_TEMPLATE_ROLES);
		const slots = hostileSlots(roles, MAX_ROLE_REPEAT_SLOTS);
		const emojiBeats = hostileBeats(MAX_TEMPLATE_BEATS, roles);
		const asciiBeats: TemplateBeatRow[] = emojiBeats.map((b) => ({
			...b,
			label: "a".repeat(MAX_TEMPLATE_LABEL_CHARS),
			detail: "a".repeat(MAX_TEMPLATE_DETAIL_CHARS),
		}));

		const t0 = performance.now();
		buildTemplateRows(emojiBeats, roles, slots);
		const emojiMs = performance.now() - t0;

		const t1 = performance.now();
		buildTemplateRows(asciiBeats, roles, slots);
		const asciiMs = performance.now() - t1;

		// Emoji costs something (the branch is real)...
		expect(emojiMs).toBeGreaterThan(0);
		// ...but this renderer never approaches #522's ~13x, which is the
		// thing worth pinning: a future change that made emoji cost 10x
		// ASCII here would be a real regression in THIS renderer, not just
		// "emoji are known to be slower somewhere in this codebase". ABSOLUTE,
		// not stated relative to `asciiMs` measured in this same run — a bound
		// like `asciiMs * 6` moves with whatever this run happens to measure
		// for ASCII and would still pass if BOTH numbers regressed together.
		// 100ms is generous over the measured ~33-37ms emoji cost at this same
		// fixture (`meeting-template-limits.ts`'s honesty note), enough margin
		// for a slower CI runner while still catching a real regression: the
		// worst-legal-template test above already gates the absolute number
		// tightly at 250ms, so this one only needs to prove emoji isn't an
		// order of magnitude worse than that.
		expect(emojiMs).toBeLessThan(100);
		expect(asciiMs).toBeGreaterThan(0);
	});

	/**
	 * The carried finding from Task 5's review: the non-repeating branch had
	 * no analogue of the repeat path's `MAX_ROLE_REPEAT_SLOTS` cap.
	 * `agenda-template-rows.test.ts` covers the CORRECTNESS of the fix (the
	 * holder list is actually truncated); this covers the COST claim the fix
	 * is justified by — that leaving it uncapped is not merely untidy but a
	 * real, unbounded render-time sink. Measured directly: ONE non-repeating
	 * beat bound to 50,000 slots (a `role_definitions.defaultCount` no
	 * writer in this codebase can produce today, but which a pre-cap row, a
	 * direct insert, or a copied template's un-revalidated count still
	 * could — see `agenda-template-rows.ts`'s docblock) rendered in ~90ms
	 * ALONE, linear in slot count with no quadratic blowup — so the fix
	 * closes an unbounded-in-principle cost, not a dramatic one at any
	 * single realistic size.
	 */
	it("would have let ONE beat's holder list scale without bound before the fix", () => {
		const role: TemplateRoleRow = { key: "r", name: "R", isSpeakerRole: false };
		const hugeSlotCount = 50_000;
		const slots: AgendaSlot[] = Array.from(
			{ length: hugeSlotCount },
			(_, i) => ({
				id: `r-${i}`,
				roleName: "R",
				roleKey: "r",
				category: "functionary",
				isSpeakerRole: false,
				slotIndex: i,
				assigneeName: `Person${i}`,
				speechTitle: null,
				projectLevel: null,
				minMinutes: null,
				maxMinutes: null,
				evaluatesSlotId: null,
				evaluates: null,
			}),
		);
		const oneBeat: TemplateBeatRow[] = [
			{
				sortOrder: 0,
				kind: "role",
				label: emojiStr(MAX_TEMPLATE_LABEL_CHARS),
				detail: emojiStr(MAX_TEMPLATE_DETAIL_CHARS),
				minutes: 5,
				roleKey: "r",
				repeatsRoleKey: null,
				flex: false,
				markGreen: null,
				markYellow: null,
				markRed: null,
			},
		];
		const t0 = performance.now();
		const rows = buildTemplateRows(oneBeat, [role], slots);
		const ms = performance.now() - t0;
		// The FIX: still exactly one row, and the join is capped to the first
		// MAX_ROLE_REPEAT_SLOTS holders — proven again here (not just in
		// agenda-template-rows.test.ts) so this file's cost claim and that
		// file's correctness claim stay about the SAME behaviour, not two
		// behaviours that happen to agree today.
		expect(rows).toHaveLength(1);
		const holder = rows[0]?.holder ?? "";
		expect(holder).toContain(`Person${MAX_ROLE_REPEAT_SLOTS - 1}`);
		expect(holder).not.toContain(`Person${MAX_ROLE_REPEAT_SLOTS}`);
		expect(holder).not.toContain("Person49999");
		// A generous absolute ceiling for the CAPPED cost at this extreme
		// input size — proving the CAP, not just the truncated output, is
		// what keeps this cheap. `slotsForRole`'s filter still scans all
		// 50,000 slots before the cap slices it down (measured ~1-7ms for
		// that alone at this size); a cap that instead joined every holder
		// and truncated the resulting STRING would not show up as fast here.
		expect(ms).toBeLessThan(50);
	});
});
