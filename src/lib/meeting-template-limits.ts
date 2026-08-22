/**
 * Absolute ceilings on a meeting template's size, kept in `lib/` so a unit test
 * can import them without a database. A constant defined in a module that
 * imports `#/db` at load throws `DATABASE_URL is not set` under vitest, which
 * makes it unassertable — the number could be raised arbitrarily with the whole
 * suite green (#519, #522). The renderer imports these; it does not define them.
 *
 * HONESTY NOTE (#task-10, 2026-08-21): these are now MEASURED, not merely
 * unprofiled bounds — and the thing they used to only guard against
 * corruption from a fixed seed now also has to survive an officer holding a
 * button. Tasks 1-9 added a per-meeting agenda editor (`addAgendaRow`,
 * `addAgendaRole`, `moveAgendaRow`, …, `meeting-agenda-edit-logic.ts`), so
 * these ceilings are the first time this codebase lets a CLUB OFFICER, not
 * just the seed, decide how big a template gets.
 *
 * What was measured, and how: `buildTemplateRows` (the pure renderer every
 * templated meeting's agenda goes through, via `resolveAgendaRows`) against
 * an ALL-AXES-HOSTILE fixture — every one of these five constants at its
 * ceiling AT ONCE, every string built from EMOJI code points rather than
 * ASCII (#522's own lesson: an all-ASCII fixture has measured a cap several
 * times too high before), and assignee names at their own real ceiling
 * (`MAX_NAME_CHARS` = 200, `person-name.ts`). Full fixture construction and
 * the written axis list are in `meeting-template-limits.bench.test.ts`,
 * which is the enforcement, not just the report — its numbers are asserted,
 * not merely logged. Measured on an Apple M2 Max, macOS 15.7.4, Bun 1.2.8,
 * 2026-08-21 — a developer's laptop, not CI's Linux runner (this repo
 * usually develops on Ubuntu; see `print-density.test.tsx` for the same
 * caveat on a different harness) — so treat the numbers below as
 * HARNESS-RELATIVE and order-of-magnitude, not a promise for every machine.
 *
 * The curve, at the fixture described above, beat count varying and every
 * other axis pinned to its cap:
 *
 *     25 beats   ->  ~3-11ms
 *     50 beats   ->  ~3-8ms
 *    100 beats   ->  ~8ms
 *    200 beats   ->  ~17-20ms   (warm; ~33-35ms measured COLD, five runs)
 *    400 beats   ->  ~42ms
 *    800 beats   ->  ~82ms
 *   1600 beats   -> ~171ms
 *   3200 beats   -> ~326ms      (16x MAX_TEMPLATE_BEATS)
 *
 * This is LINEAR, not the exponential/cubic shape #519 found — no knee
 * appears anywhere in this range, including 16x past the current beat
 * ceiling. Emoji vs ASCII at the same hostile fixture measured ~33ms vs
 * ~25ms (~1.3x) — nowhere near #522's ~13x, because that figure belongs to a
 * DIFFERENT renderer; `capChars`'s only emoji-sensitive step here is a
 * `[...value]` code-point spread, not per-character work. Because the curve
 * is linear with a wide, unbroken margin well past the legal range, none of
 * the five ceilings below needed to move: the seeded contest's original
 * headroom turned out to be real, not merely asserted. What changed is that
 * this comment can now say so.
 *
 * Two gaps that measuring for real turned up, both closed alongside this:
 * the non-repeating branch of `buildTemplateRows` had no cap on how many
 * slots' names it would join into one row (the repeat path's
 * `MAX_ROLE_REPEAT_SLOTS` had no analogue there) — fixed in
 * `agenda-template-rows.ts`, since a writer-side cap on `defaultCount`
 * (`addAgendaRole`, `role-definitions-logic.ts`) is not the only way that
 * number can grow past it. And `renumberRows`
 * (`meeting-agenda-edit-logic.ts`) issued 2N sequential single-row UPDATEs
 * per reorder — up to 400 round trips at `MAX_TEMPLATE_BEATS` — measured at
 * ~170-187ms against a real local Postgres before being replaced with two
 * bulk `CASE`-based statements, measured at ~11-16ms after. See that
 * function's own docblock for the numbers; this file is about render cost,
 * that one is about write cost, and an editor is now the writer for both.
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
