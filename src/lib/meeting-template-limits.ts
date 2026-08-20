/**
 * Absolute ceilings on a meeting template's size, kept in `lib/` so a unit test
 * can import them without a database. A constant defined in a module that
 * imports `#/db` at load throws `DATABASE_URL is not set` under vitest, which
 * makes it unassertable — the number could be raised arbitrarily with the whole
 * suite green (#519, #522). The renderer imports these; it does not define them.
 *
 * HONESTY NOTE: these are BOUNDS, not measurements. The seeded contest template
 * is ~26 beats and 8 roles, so each ceiling leaves generous headroom while
 * staying far below any plausible cost knee — but nobody has run the curve.
 * Phase 1's only writer is the seed, so these are a corruption guard rather
 * than a DoS control. BEFORE Phase 2 exposes a template editor to officers,
 * measure the render cost the way #519 did (500 and 5,000 chars both rendered
 * in 39ms; 49,999 took 3,707ms) and reset these to sit well below the knee.
 * Do not let this comment claim a measurement that has not happened.
 */

/**
 * Ordered rows one template may declare, BEFORE repeat expansion.
 * Enforced as a `.limit()` on `loadTemplateBeats` — the one seam every renderer
 * reads a template through — not at the writer, so a row that got past the
 * writer still cannot reach a render.
 */
export const MAX_TEMPLATE_BEATS = 200;

/** Distinct roles one template may declare. Enforced on `loadTemplateRoles`. */
export const MAX_TEMPLATE_ROLES = 40;

/**
 * Slots one repeat block may expand over. Bounds the expansion SEPARATELY from
 * the beat count: 200 beats each repeating over an unbounded role would
 * multiply out even though every stored row was within its own cap.
 */
export const MAX_ROLE_REPEAT_SLOTS = 20;

/** Characters in a beat's `label` (the activity name). */
export const MAX_TEMPLATE_LABEL_CHARS = 120;

/** Characters in a beat's `detail` (the notes column). */
export const MAX_TEMPLATE_DETAIL_CHARS = 400;
