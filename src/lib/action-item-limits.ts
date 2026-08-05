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
	/**
	 * How many action-item rows a minutes surface shows before "+N more".
	 *
	 * Applied ONCE, in `loadActionItemsForMinutes`, to the open list and to the
	 * resolved list separately — so the section's real budget is 2 x this. It is
	 * applied there rather than in each renderer on purpose: capping in the
	 * renderer alone bounds the PDF while leaving the wire payload, the DOM and
	 * the offline IndexedDB snapshot unbounded, which is the same
	 * bounded-render/unbounded-pipeline shape #519 shipped.
	 */
	rows: 40,
	/** An owner's name beside an item. Defence in depth — names are capped on write elsewhere. */
	ownerName: 120,
} as const;

/**
 * How many rows a single club's action-item read may return.
 *
 * Nothing prunes this table — an item never auto-expires and resolved ones are
 * kept as history — so the row count is user-controlled and grows forever. The
 * render cap above bounds what is DISPLAYED; this bounds what Postgres returns,
 * what is serialized over the server-fn boundary, and what `saveSnapshot` writes
 * into IndexedDB on a phone at a meeting.
 *
 * Deliberately far above the render cap so the "+N more" count stays meaningful
 * for any real club, and far below the point where the payload matters: 500 rows
 * at the 300-character text cap is ~150KB of text, against 27.9MB measured for
 * an uncapped 20,000-row club.
 */
export const ACTION_ITEM_READ_CAP = 500;

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
