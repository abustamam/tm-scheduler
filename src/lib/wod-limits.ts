import { z } from "zod";

/**
 * Length caps on the Word-of-the-Day fields (#519).
 *
 * These values render into a PDF served by an UNAUTHENTICATED public GET
 * (`/api/meetings/:id/role-sheets/:sheet/pdf`), and `@react-pdf/renderer` lays
 * out synchronously inside the single Node process that serves everything else
 * (ADR-0007). An oversized note is therefore not a slow download — it is the
 * event loop, and so the whole server, stopped. Measured before the cap: a
 * 50,000-character definition took 3,596ms against an 87ms baseline, on a route
 * with `no-store` and no rate limit.
 *
 * Lives in `lib/` rather than beside either consumer for two reasons. It is
 * pure and client-safe, so the write path (`server/meetings.ts`, a server-fn
 * module that may export only server-fns and types) can read it without
 * exporting a constant of its own. And it lets the WRITE cap and the RENDER cap
 * read ONE source instead of two values a test has to keep agreeing — the same
 * reason `EVALUATION_TIMING_ASK` is shared between the agenda and the role
 * sheets rather than copied.
 *
 * Sized ~10x the largest value in real data (longest `wod_definition` on
 * record: 50 characters; longest `word_of_the_day`: 14), so nothing a club
 * would actually type is rejected on write or elided on print, and no row
 * written before the cap can fail an edit it used to pass.
 */
export const WOD_LIMITS = {
	/** The word itself. One word, plus room for a hyphenated or accented form. */
	word: 60,
	/** The definition — the only free-text field that reaches a printed sheet. */
	definition: 500,
	/** The usage example. Same order of magnitude as the definition. */
	example: 500,
} as const;

/**
 * The three field validators, exported so they can be TESTED.
 *
 * `server/meetings.ts` composes these into its three schemas. It cannot export
 * them itself — it is a server-fn module, which may export only server-fns and
 * types (`server-modules.guard.test.ts` enforces that, and caught the first
 * attempt at this). Keeping the validators beside the limits is the same shape
 * as `guest-pipeline-schemas.ts`, and means the write cap has a direct test
 * rather than being reachable only through a `createServerFn` that tests here
 * cannot invoke.
 *
 * `.trim()` runs BEFORE `.max()`, so trailing whitespace can never push an
 * otherwise-valid value over the cap.
 */
export const WOD_FIELDS = {
	word: z.string().trim().max(WOD_LIMITS.word),
	definition: z.string().trim().max(WOD_LIMITS.definition),
	example: z.string().trim().max(WOD_LIMITS.example),
} as const;
