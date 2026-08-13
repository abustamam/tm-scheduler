// src/lib/agenda-print-type.ts

/**
 * Declared type sizes for the narrative run-of-show (`RunNarrative`).
 *
 * These live in `lib/` rather than inline in the renderer for the reason
 * CLAUDE.md gives about numbers that ARE the fix: a constant defined inside
 * `meeting-agenda-print.tsx` is reachable from a component test, but the
 * property worth protecting here is not a rendered string — it is the POINT
 * SIZE the club's printer puts on paper, and computing that needs the constant
 * and a real browser measurement in the same assertion. Exporting it from a
 * module with no `#/db` import keeps `print-density.test.tsx` able to read it.
 *
 * WHY A CHANGE HERE IS NOT WHAT IT LOOKS LIKE. Both narrative layouts sit inside
 * `FitPage`, which scales the whole sheet down until it fits one page. So the
 * printed size is NOT the number below — it is that number times
 * `(PAGE_H - 2) / naturalHeight`. Raising `detail` from 10.5 to 11.5 grew the
 * editorial sheet from 1304px to 1377px, and the two effects very nearly
 * cancelled: 9.5% more declared type bought 3.7% more printed type. Height is
 * the real lever, and the only reason this bump lands at all is that the fixed
 * paddings around the text do not grow with it.
 *
 * Measured on the MCF 2026-08-13 fixture in `print-density.test.tsx`, harness
 * fonts (see that file on why these are not the deployed page's numbers):
 *
 *   declared 10.5  ·  1484px  ·  scale 0.710  ·  5.59pt   ← before #562
 *   declared 10.5  ·  1304px  ·  scale 0.808  ·  6.36pt   ← consolidation only
 *   declared 11.5  ·  1321px  ·  scale 0.798  ·  6.88pt   ← plus this bump
 *
 * `sm` is editorial's; `lg` is the two-page spacious layout's and is unchanged —
 * spacious gets its legibility back from consolidation alone, and leaving it
 * alone keeps this change off a surface nobody reported a problem with.
 */
export const RUN_NARRATIVE_TYPE = {
	sm: { stamp: 11.5, name: 12.5, detail: 11.5 },
	lg: { stamp: 13, name: 14, detail: 12 },
} as const;

/**
 * The floor `print-density.test.tsx` holds editorial to, in printed points.
 *
 * An ABSOLUTE number, deliberately, and stated in points rather than as a
 * ceiling on the sheet's height: a height ceiling passes for ANY declared size,
 * so it would happily accept a layout that got shorter by shrinking its type,
 * which is the change it exists to prevent.
 *
 * WHAT IT DOES NOT CATCH, measured rather than assumed. Reverting `detail` to
 * 10.5 and leaving everything else alone still prints about 6.65pt — the sheet
 * gets shorter, `FitPage` shrinks it less, and most of the declared loss comes
 * back. So this floor gates the OUTCOME (the club's agenda stays readable) and
 * `keeps the measured type bump` below gates the CONSTANT. Two failures, two
 * assertions; a single tight floor covering both would sit ~1% under the
 * measurement and break on the next copy edit.
 *
 * WHY THE MARGIN IS WIDE. 6.2 against a measured 6.88 looks slack, and the slack
 * is deliberate: this is measured through a browser with NO web fonts (the
 * harness blocks the network), so the text is laid out in whatever the platform
 * substitutes for Manrope — and that differs between the macOS machine this was
 * tuned on and CI's Ubuntu runner. Substitution does not change type size
 * directly; it changes where lines WRAP, and each extra wrapped line is ~16px of
 * sheet that `FitPage` then takes back out of the type. A handful of wraps is
 * worth several tenths of a point, so a floor set snugly against the local
 * number would fail in CI for a reason that has nothing to do with the layout.
 *
 * The floor is still meaningful at 6.2: this surface printed 5.59pt before, so
 * anything that gives back most of the gain fails, and the assertion beside it
 * pins the declared constant exactly. Precision there, robustness here.
 *
 * Lowering this is a decision to print the club's agenda smaller. Make it with a
 * fresh measurement in this comment, not to turn a red test green.
 */
export const EDITORIAL_MIN_PRINTED_PT = 6.2;

/** As above, for an agenda with two more alternating beats — measured 6.42pt
 *  against 5.26pt before. Consolidation cannot help beats that change presenter
 *  every time, so a bigger club lands lower; bounded separately rather than
 *  assumed to follow from the case above, with the same cross-platform margin. */
export const EDITORIAL_DENSE_MIN_PRINTED_PT = 5.8;

/** CSS px → typographic points at the 96dpi `FitPage` and `@page` both assume. */
export function pxToPt(px: number): number {
	return px * 0.75;
}
