/**
 * Content-slide spacing, as PROPORTIONS of the slide frame (#359).
 *
 * One set of numbers, two renderers: the projected HTML deck
 * (`meeting-present.tsx`, which sizes in `cqw` — percent of container width) and
 * the `.pptx` export (`deck-to-pptx.ts`, which sizes in inches on a 13.33 x 7.5
 * frame). Neither unit is shared, but the proportion is, and the proportion is
 * the thing that has to agree: the export is what a club hands to whoever is
 * driving the projector, so a deck that reads well on screen and cramped in
 * PowerPoint is the same complaint twice.
 *
 * THIS MODULE EXISTS BECAUSE THEY ALREADY DRIFTED. Before #359 the header inset
 * was 6% and the body inset 7-7.5% — in BOTH files, independently. So the body
 * text sat indented past the maroon rule that heads it, on screen and in the
 * export, and it had never looked like a bug precisely because the two surfaces
 * agreed with each other while both disagreed internally. Two hand-kept copies
 * of a number drift; one derivation cannot.
 *
 * #359 fixed the header and the body and LEFT THE FOOTER OUT, so the same
 * failure sat one band lower for another two quarters: the navy footer carried
 * its own side inset (5%) and its own height in both files, four literals with
 * no shared source, and the footer's "GavelUp" mark stood 0.4in inside the body
 * text above it on the exported deck. #724 brought the footer in. The general
 * lesson is the one that keeps being relearned here: lifting SOME of a
 * surface's numbers into a shared module leaves the rest looking governed.
 *
 * Pure numbers, no imports — safe for the client bundle, which
 * `deck-to-pptx.ts` needs (it runs in the browser behind the download button).
 */

/**
 * Left/right inset for EVERY band of a content slide — the header, the body and
 * the navy footer — as a percent of frame width.
 *
 * One value, deliberately: the maroon rule under the header, the first line of
 * body text and the footer's "GavelUp" mark are read as a single left edge, and
 * #359 is what a 1.5% mismatch between the first two looks like on a projector.
 * The footer joined them in #724, which is what a 3% mismatch looks like: the
 * footer band is full-bleed, so its text was the only thing that could line up
 * with the slide above it, and it did not.
 *
 * Raised from 6/7 to 8 for the original complaint — content sat close to the
 * frame edge, which is far more obvious projected than on a laptop. It is not
 * free: `useFitTransform` measures the PADDED box, so every extra point of inset
 * is a point the densest slides scale down by (~2% at this value). Worth it
 * because the two cases do not overlap — a slide being scaled has its content
 * shrink AWAY from the padding, so it reads small but not tight; the tight
 * slides are the ones rendering at scale 1, where the inset is the only inset
 * there is.
 */
export const SLIDE_INSET_PCT = 8;

/** Space above the header text, as a percent of frame width. Unchanged by #359
 *  — the complaint was the body crowding the rule, not the header crowding the
 *  top. */
export const SLIDE_HEADER_TOP_PCT = 5;

/**
 * Gap between the maroon rule and the first line of body text, percent of frame
 * width. Raised from 2.5 to 4 (#359): "the body crowds the header rule" was the
 * first half of that report, and the rule is what separates a slide's title from
 * its content, so the gap under it is doing structural work rather than
 * decorative.
 */
export const SLIDE_HEADER_GAP_PCT = 4;

/**
 * Bottom inset for the body box — its clearance from the top of the navy footer
 * — as a percent of frame width.
 *
 * Raised from 1.5 to 3.5 (#724). The 1.5 was never CHOSEN: #359 named it so the
 * `.pptx` height arithmetic had something to read instead of a literal, and a
 * value that is only ever named is a value nobody has looked at. At 1.5 against
 * a 4% top gap the body sat 2.7x closer to the footer than to the rule above
 * it, which is the "not enough padding between segments" half of the report.
 *
 * Deliberately just UNDER {@link SLIDE_HEADER_GAP_PCT} rather than equal to it:
 * the two edges are not the same kind of edge. The rule above is a 0.7% hairline
 * that has to read as a divider rather than an underline of the title, so it
 * needs generous air on both sides; the footer is a solid 8.5% block of navy
 * that separates itself by sheer figure-ground, so it needs less. Landing a
 * shade under the top gap also seats the body fractionally above true centre,
 * which is where the eye expects it.
 *
 * The cost is the one {@link SLIDE_INSET_PCT} already documents, and it is
 * measured: `useFitTransform` scales to the PADDED box, so the densest slides
 * lose 6.6% of their fit box and scale down by that much.
 */
export const SLIDE_BODY_BOTTOM_PCT = 3.5;

/**
 * Height of the navy footer band, percent of frame WIDTH (not height) — the
 * same basis as every other constant here, so one number sizes it on a 16:9
 * screen and in the 13.33 x 7.5in export without either renderer converting.
 *
 * 8.5 is the value both renderers already carried; #724 changed where it lives,
 * not what it is. It was `h-[8.5cqw]` in `meeting-present.tsx` and
 * `FOOT_H = 1.13` in `deck-to-pptx.ts` under the comment `// ~8.5% of width` —
 * a hand copy that ADMITTED it was a hand copy, and was out by 0.003in. This
 * band is also the body's floor: {@link SLIDE_BODY_BOTTOM_PCT} measures down to
 * it, and the `.pptx` body height is arithmetic over both.
 */
export const SLIDE_FOOTER_HEIGHT_PCT = 8.5;

/** `SLIDE_INSET_PCT` etc. as a `cqw` length for the HTML deck. Container queries
 *  make `1cqw` one percent of the container's width, so a proportion IS the
 *  unit — no conversion, just a name. */
export const cqw = (pct: number): string => `${pct}cqw`;

/** A proportion of frame width in INCHES, for the `.pptx` export. Takes the
 *  frame width rather than closing over it, so a future 4:3 or 16:10 deck cannot
 *  silently inherit 16:9's arithmetic. */
export const inchesOfWidth = (pct: number, frameWidthInches: number): number =>
	(pct / 100) * frameWidthInches;
