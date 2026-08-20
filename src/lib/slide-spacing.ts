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
 * Pure numbers, no imports — safe for the client bundle, which
 * `deck-to-pptx.ts` needs (it runs in the browser behind the download button).
 */

/**
 * Left/right inset for BOTH the header and the body, as a percent of frame
 * width.
 *
 * One value, deliberately: the maroon rule under the header and the first line
 * of body text are read as a single left edge, and #359 is what a 1.5% mismatch
 * between them looks like on a projector.
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

/** Bottom inset for the body box, percent of frame width. Unchanged; stated so
 *  the `.pptx` height arithmetic has a name to read rather than a literal. */
export const SLIDE_BODY_BOTTOM_PCT = 1.5;

/** `SLIDE_INSET_PCT` etc. as a `cqw` length for the HTML deck. Container queries
 *  make `1cqw` one percent of the container's width, so a proportion IS the
 *  unit — no conversion, just a name. */
export const cqw = (pct: number): string => `${pct}cqw`;

/** A proportion of frame width in INCHES, for the `.pptx` export. Takes the
 *  frame width rather than closing over it, so a future 4:3 or 16:10 deck cannot
 *  silently inherit 16:9's arithmetic. */
export const inchesOfWidth = (pct: number, frameWidthInches: number): number =>
	(pct / 100) * frameWidthInches;
