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
 * `server/meetings.ts` composes these. It cannot export them itself — it is a
 * server-fn module, which may export only server-fns and types
 * (`server-modules.guard.test.ts` enforces that, and caught the first attempt
 * at this).
 *
 * Only `word` is composed today: `createMeetingSchema` accepts a Word of the
 * Day but not its definition or example, which are set later through the edit
 * paths. `definition` and `example` are kept for symmetry with
 * `WOD_UPDATE_FIELDS` and are tested, but nothing on the create side reads them
 * yet — worth knowing before treating their presence as evidence a create path
 * is guarded. Keeping the validators beside the limits is the same shape
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

/**
 * The same caps for the UPDATE paths, which TRUNCATE instead of rejecting.
 *
 * Used by `updateMeetingSchema` ONLY, and the boundary is deliberate.
 *
 * A hard `.max()` is right when a failure costs only the field being edited.
 * The whole-meeting form is the case where it does not: it prefills all three
 * Word-of-the-Day fields from the stored row and resubmits them on every save,
 * so a single row written before this cap existed would fail `.parse()` and
 * block saving the meeting's theme, location, notes and date too — an admin
 * locked out of a meeting by text they cannot see.
 *
 * `updateWordOfTheDaySchema` deliberately does NOT use these. It touches
 * nothing but the Word of the Day, so rejecting there locks nobody out of
 * anything, while truncating would silently destroy the tail of a legacy
 * definition the moment someone opened that editor and pressed Save without
 * editing — on a path reachable with a self-asserted member id and no session.
 * Silent data loss is the worse failure when a clear error is available.
 *
 * The columns are unbounded `text` and this change ships no backfill, so such a
 * row is possible. Dev data maxes at 50 characters and production was not
 * checked, which is exactly why this path degrades instead of failing closed.
 *
 * Truncation is already the documented failure mode one layer down
 * (`RENDER_CAPS`/`capFill`), so the two halves now agree: over-long text is
 * shortened, never fatal.
 */
export const WOD_UPDATE_FIELDS = {
	word: z
		.string()
		.trim()
		.transform((v) => v.slice(0, WOD_LIMITS.word)),
	definition: z
		.string()
		.trim()
		.transform((v) => v.slice(0, WOD_LIMITS.definition)),
	example: z
		.string()
		.trim()
		.transform((v) => v.slice(0, WOD_LIMITS.example)),
} as const;
