import { z } from "zod";

/**
 * Length and render caps for club action items (#529).
 *
 * These live in `lib/` rather than beside the writer or the renderer so the
 * NUMBERS are testable. A cap defined in a module that imports `#/db` at load
 * throws `DATABASE_URL is not set` when a unit test imports it, which makes the
 * value unassertable and therefore silently raisable to anything — the trap
 * `minutes-render-caps.ts` documents and that #522 shipped inside the very
 * change citing it.
 */
export const ACTION_ITEM_LIMITS = {
	/**
	 * The item text. A sentence, not a paragraph.
	 *
	 * Deliberately an order below `notes` and the announcements field (both
	 * 2,000): unlike those two, this one renders into the server-side minutes
	 * PDF, which lays out synchronously in the single Node process (ADR-0007),
	 * so an oversized value stalls every other request.
	 */
	text: 300,
} as const;

/**
 * Render-side caps for the action-item block in the minutes PDF.
 *
 * The per-row text cap above bounds each item; `rows` bounds how many there
 * are, which is the half #522's first pass missed. react-pdf's cost is
 * super-linear in ROW COUNT even when every row is short — measured through
 * this same renderer at 40 rows → 112ms, 500 → 285ms, 2,000 → 2,477ms,
 * 5,000 → 19,581ms — and the count here is user-controlled, because an item is
 * never auto-expired and a club can accumulate them indefinitely.
 *
 * Sized against ASTRAL text rather than ASCII: a length cap bounds code points,
 * not cost, and emoji rows measured ~13x ASCII rows through this renderer at
 * the same capped size.
 *
 * A club with more than 40 open action items has a real problem, and a list
 * that says "+N more" is honest signal rather than a defect.
 */
export const ACTION_ITEM_RENDER_CAPS = {
	/** How many action-item rows the minutes PDF prints before "+N more". */
	rows: 40,
	/** An owner's name beside an item. Defence in depth — names are capped on write elsewhere. */
	ownerName: 120,
} as const;

/**
 * A rejecting validator with a human message.
 *
 * REJECT, not truncate — and the distinction matters. `meeting-limits.ts` uses
 * truncating validators on the meeting update path because those ops are QUEUED
 * when minutes are taken offline, and `drainMinutesQueue` stops at the first
 * failing op and returns every successor as still-queued, so one over-long
 * value would freeze that meeting's writes permanently.
 *
 * Action items never enter that queue: they are written only from the online
 * admin route and are read-only everywhere else. So a rejection costs exactly
 * the field being typed, which is the case where rejecting is correct.
 *
 * The message matters as much as the cap: `ZodError.message` is
 * `JSON.stringify(issues)` and the form renders it into a toast, so omitting
 * one puts a raw multi-line JSON dump in front of a club officer.
 */
export const ACTION_ITEM_FIELDS = {
	text: z
		.string()
		.trim()
		.min(1, "An action item needs some text.")
		.max(
			ACTION_ITEM_LIMITS.text,
			`Keep the action item under ${ACTION_ITEM_LIMITS.text} characters.`,
		),
} as const;
