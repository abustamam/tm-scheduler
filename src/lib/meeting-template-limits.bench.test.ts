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
			id: `bench-beat-${i}`,
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
			id: `bench-repeat-${i}`,
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
	 * The curve the brief asked for, as a living regression gate — stated so
	 * that machine speed cancels out (#631).
	 *
	 * ## Why the absolute literals are gone
	 *
	 * They were `{25: 120ms, 50: 140ms, 100: 200ms, 200: 250ms}`, calibrated on
	 * an Apple M2 Max. That went red on CI twice. First at 135.67ms against a
	 * 100ms bound, which was diagnosed as a ~7x slower shared runner and fixed
	 * by raising the bounds to 250ms. Then at **331ms against that 250ms**, on
	 * an unrelated PR, with the identical commit passing on a re-run minutes
	 * later — the same commit red then green, which is proof of runner variance
	 * rather than a diagnosis of it.
	 *
	 * The second failure is what settles it. A shared runner has no upper bound
	 * on how slow it can be, so there is no absolute millisecond number that is
	 * both loose enough never to flake and tight enough to catch a modest
	 * regression: 331ms of pure variance already exceeds the ~10x margin over
	 * the ~33ms local measurement. Raising it again just moves the next
	 * recurrence, and each one reds out a PR that has nothing to do with this
	 * code — which trains people to re-run CI on red, the habit that lets a
	 * real failure through.
	 *
	 * ## What replaces them
	 *
	 * The per-row check below, which was already here as this file's
	 * machine-independent half. #631 widened it from two points to three and
	 * deleted the literals, rather than standing a second test up beside it.
	 * Per-row cost is measured against a baseline size in the SAME process, so
	 * machine speed appears in both terms and divides out.
	 *
	 * That is more coverage than the literals gave, not less: a curve that bends
	 * between 50 and 100 beats is now caught, where before only the 50-vs-200
	 * endpoints were compared and the bend could hide between them.
	 *
	 * The baseline stays 50 rather than dropping to the 25 the old ladder
	 * started at, and that is deliberate. 25 is a fine size for an ABSOLUTE
	 * bound and a bad one for a RATIO: row count is not proportional to beat
	 * count (see the next docblock), so the smallest fixture is the most
	 * dominated by fixed overhead — its per-row cost reads high, and every ratio
	 * measured against it looks reassuringly flat. That is passing for the wrong
	 * reason, which is a trap the check below already fell into once.
	 *
	 * ## What is NOT covered, stated because the file used to claim otherwise
	 *
	 * A CONSTANT-FACTOR regression — everything uniformly 2x slower. Every
	 * assertion here and in the shape check below is a ratio, and a ratio is
	 * structurally blind to it: both terms scale together and the quotient does
	 * not move.
	 *
	 * The previous version of this docblock said raising the literals was safe
	 * because "the shape check below now carries that half of the job on its
	 * own". It cannot, for the reason just given, so that sensitivity was
	 * already gone rather than relocated. The generous absolute bound on the
	 * ceiling case below is the only constant-factor net left, and it is sized
	 * to catch a catastrophe, not a 2x slip. Catching a 2x slip on shared CI
	 * needs a stored baseline to compare against, which this repo does not have
	 * and which is out of scope here.
	 *
	 * ## Measured sensitivity of the ratio, so it is not over-trusted
	 *
	 * The old docblock asserted a quadratic "lands at ~13.5x per row — caught
	 * with a factor of four to spare". That is the arithmetic for a quadratic
	 * whose per-operation cost matches the real per-row work; a cheaper inner
	 * loop dilutes it, and the threshold is not as sharp as that reads. Probed
	 * directly by injecting quadratic scans into `buildTemplateRows` (#631):
	 *
	 *   - a scan that roughly DOUBLED total runtime → per-row ratio ~1.9,
	 *     PASSES. A quadratic this mild slips through.
	 *   - a scan that roughly QUADRUPLED it → ratio 3.44, FAILS on the 200-beat
	 *     comparison, naming the size.
	 *
	 * So this catches a quadratic that roughly quadruples the work at the
	 * ceiling and misses one that merely doubles it. The threshold stays at 3
	 * rather than being tightened toward that floor: the natural per-row ratio
	 * falls to ~0.5x on a warm fast machine but amortizes differently on a cold
	 * shared runner, and squeezing the margin is how this file produced two
	 * false reds in the first place. Recorded rather than tightened — a number
	 * whose real sensitivity is written down is worth more than one that looks
	 * strict.
	 */

	/**
	 * The SHAPE of the curve, stated so that machine speed cancels out.
	 *
	 * Every absolute bound above is hostage to whatever runner drew the job:
	 * the same code measured 20ms on an M2 Max and 135.67ms on CI, a 7x
	 * spread that says nothing about `buildTemplateRows`. A ratio taken
	 * between two sizes in the SAME process on the SAME machine divides that
	 * factor out, which is what makes this the assertion worth trusting when
	 * the two disagree.
	 *
	 * Normalized PER OUTPUT ROW, which is the unit the cost is actually
	 * proportional to — and getting that wrong is a trap this test fell into
	 * once already. Beat count is not the workload: `hostileBeats` spends the
	 * first `MAX_TEMPLATE_ROLES` beats on non-repeating rows worth ONE output
	 * row each, then expands every remaining beat into `MAX_ROLE_REPEAT_SLOTS`
	 * rows. So 50 beats emits 240 rows and 200 beats emits 3,240 — 13.5x the
	 * work for 4x the beats. A first cut of this test read that as "4x beats,
	 * so allow up to 12x time"; a perfectly LINEAR implementation can measure
	 * 13.5x over this range and would have failed it. The bug would have
	 * surfaced as an intermittent red on whichever machine happened not to
	 * amortize the small end.
	 *
	 * Per row, cost should be roughly FLAT. Observed on an Apple M2 Max it
	 * falls to ~0.5x at the large end, because fixed overhead makes the small
	 * fixture look relatively expensive. The threshold allows a 3x RISE, which
	 * no linear implementation reaches on any machine, while a quadratic one
	 * lands at ~13.5x per row — caught with a factor of four to spare.
	 */
	it("keeps per-row render cost flat as the template grows, on any machine", () => {
		const costOf = (beatCount: number) => {
			const { beats, roles, slots } = hostileAtCap(beatCount);
			const t0 = performance.now();
			const rows = buildTemplateRows(beats, roles, slots);
			const ms = performance.now() - t0;
			expect(rows.length).toBeGreaterThan(0);
			return { msPerRow: ms / rows.length, rows: rows.length };
		};

		// Warm the JIT first, or the small size absorbs the compile cost and
		// the comparison reads far too flat — passing for the wrong reason.
		costOf(50);

		const small = costOf(50);
		expect(small.msPerRow).toBeGreaterThan(0);

		// Three points, not two (#631). The endpoints alone cannot see a curve
		// that bends in the middle and comes back — 100 is here so a knee
		// between 50 and 200 has somewhere to show up. This replaced the
		// absolute ladder that used to cover these sizes; see the docblock above
		// for why its millisecond literals could not survive a shared runner.
		const mid = costOf(100);
		const large = costOf(200);

		// Guards the normalization itself: if these ever emitted the same row
		// count, per-row cost would be a restatement of raw time and the
		// thresholds below would silently mean something else.
		expect(mid.rows).toBeGreaterThan(small.rows);
		expect(large.rows).toBeGreaterThan(mid.rows);
		expect(large.rows).toBeGreaterThan(small.rows * 4);

		expect(
			mid.msPerRow / small.msPerRow,
			"per-row cost at 100 beats grew against the 50-beat baseline",
		).toBeLessThan(3);
		expect(
			large.msPerRow / small.msPerRow,
			"per-row cost at 200 beats grew against the 50-beat baseline",
		).toBeLessThan(3);
	});

	/**
	 * The brief's own scaffold: ONE cold call at the actual ceilings
	 * (MAX_TEMPLATE_BEATS / MAX_TEMPLATE_ROLES / MAX_ROLE_REPEAT_SLOTS /
	 * MAX_TEMPLATE_LABEL_CHARS / MAX_TEMPLATE_DETAIL_CHARS, all emoji), the
	 * shape a real officer's maximally-abused template would actually hit.
	 * Measured cold (first call in a fresh vitest process, no JIT warm-up from
	 * a prior call in the same run — the shape a real request gets) at
	 * ~33-35ms across five repeated runs.
	 *
	 * ## This is a CATASTROPHE net, not a performance gate (#631)
	 *
	 * It used to assert 250ms, with the reasoning that "a jump anywhere near
	 * 250ms at the legal ceiling would mean something became quadratic, not
	 * that the machine is merely slower". CI falsified that directly: the
	 * ladder's 200-beat row, the same workload, hit **331ms of pure variance**
	 * on an unrelated PR and passed on a re-run of the identical commit. A
	 * number that a slow runner reaches on its own cannot discriminate a
	 * regression from a bad afternoon.
	 *
	 * So this is the file's ONLY absolute bound now, and it is deliberately far
	 * looser than any measurement: 2000ms, roughly 6x the worst variance
	 * observed on CI and ~60x the local cold number. It is not trying to catch
	 * a 2x slip. It catches the shape of failure that would make a real request
	 * hang — and it still discriminates, because the curve is LINEAR with no
	 * knee up to 3200 beats (16x this cap) at ~326ms locally, so genuinely
	 * quadratic behaviour at the legal ceiling lands in seconds, not
	 * milliseconds, on any machine.
	 *
	 * The sensitive, machine-independent regression detection lives in the
	 * per-row ladder above. Do not tighten this number to recover sensitivity:
	 * that is what produced two false reds. Tighten the ratio instead.
	 */
	it("renders the worst legal template without hanging", () => {
		const { beats, roles, slots } = hostileAtCap(MAX_TEMPLATE_BEATS);
		const t0 = performance.now();
		const rows = buildTemplateRows(beats, roles, slots);
		const ms = performance.now() - t0;
		// A control: the assertion below must not pass on a renderer that
		// silently returned nothing.
		expect(rows.length).toBeGreaterThan(0);
		// ABSOLUTE, and the only one left in this file. See the docblock for why
		// it is this loose and why tightening it is the wrong repair.
		expect(ms).toBeLessThan(2000);
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
		// "emoji are known to be slower somewhere in this codebase".
		//
		// BOTH forms, because each covers the other's blind spot. This comment
		// used to argue for the absolute bound ALONE, rejecting `asciiMs * 6`
		// on the grounds that a ratio still passes if both numbers regress
		// together. True, and an argument for adding the absolute — not for
		// omitting the ratio, which is the only form that survives a change of
		// machine. The absolute alone went red on CI at 127.33ms against a
		// 100ms bound picked from a ~33-37ms macOS measurement: a ~7x slower
		// shared runner, saying nothing whatever about emoji.
		//
		// So: the ratio states the actual claim (emoji is not an order of
		// magnitude worse than ASCII, on whatever machine is running), and the
		// absolute catches the both-regressed case the ratio cannot see. The
		// absolute is anchored to the same 250ms this file's ceiling case uses
		// for a comparable workload, rather than to a number only ever
		// observed on one laptop.
		expect(emojiMs / asciiMs).toBeLessThan(10);
		expect(emojiMs).toBeLessThan(250);
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
				id: "bench-one",
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
		//
		// 150, not the 50 this shipped with. 50 was ~7x the macOS measurement
		// and looked generous; CI's runner is itself ~7x slower, which put the
		// upper end of that measured range within a millisecond or two of the
		// bound — passing on luck rather than on margin. The uncapped shape
		// this guards against joins 50,000 holders and costs orders of
		// magnitude more, so tripling the ceiling does not blunt it.
		expect(ms).toBeLessThan(150);
	});
});
