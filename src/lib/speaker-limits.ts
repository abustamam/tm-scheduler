import { z } from "zod";
import { cap } from "./cap";

/**
 * A truncating string validator, built once rather than spelled out per field.
 *
 * Truncation goes through the audited `cap` (#/lib/cap), NOT a bare
 * `.slice()`. A UTF-16 slice cuts surrogate pairs in half: #522's review
 * measured `"a" + "🎤".repeat(150)` truncating to a 200-unit string ending in a
 * lone high surrogate, which react-pdf renders as a tombstone glyph and which
 * is invalid in a PDF text string. `cap` slices by code point and bounds its
 * own cost by `max` rather than by input length.
 *
 * Consequence worth knowing: the bound is `max` CODE POINTS, so an all-astral
 * value can still be up to `2 * max` UTF-16 units. That is bounded, which is
 * what matters here; assert on code points, not `.length`.
 */
const truncating = (max: number) =>
	z
		.string()
		.trim()
		.transform((v) => cap(v, max));

/**
 * Length caps on the speaker-detail fields (#522).
 *
 * These are written through `claimSlot` and `updateSpeakerDetails`, both of
 * which are reachable on the PUBLIC no-session path — a self-asserted member id
 * is enough. Before this cap every string field was `z.string().trim()` with no
 * upper bound, so a single request could store an arbitrarily large value in an
 * unbounded `text` column.
 *
 * `speechTitle` is the one that reaches a server-rendered PDF, which is what
 * makes this a cost bug and not only a hygiene one: `@react-pdf/renderer` lays
 * out synchronously inside the single Node process that serves everything else
 * (ADR-0007), so an oversized title is the event loop — and so the whole server
 * — stopped. It reaches TWO such renderers. `role-sheets-pdf-logic.ts` was
 * already bounded by `RENDER_CAPS.speakerLabel` when #519 shipped;
 * `minutes-pdf-logic.ts` was not, and #522 notes those paths were never audited.
 * That render cap is added alongside these write caps, because a write cap
 * cannot protect rows that predate it.
 *
 * Lives in `lib/` for the same two reasons as [[wod-limits]]: it is pure and
 * client-safe, so `server/slots.ts` (a server-fn module, which may export only
 * server-fns and types) can read it without exporting a constant of its own;
 * and it lets the write cap and the render cap read ONE source rather than two
 * values a test has to keep agreeing.
 *
 * Sizing. Real data is far below these: the longest `title` on record is 23
 * characters, `project_name` 38, `pathway_path` 23, `project_level` 7, and
 * `introduction` is empty everywhere. The binding constraint is NOT the speech
 * data — it is the Pathways catalog. `applyProjectDisplay` (#418) OVERWRITES
 * `pathwayPath`/`projectName`/`projectLevel` from the catalog AFTER this schema
 * runs, so a cap below the catalog's own widest value would be one the app
 * itself violates on every project-linked speech. The catalog's longest project
 * name is 56 characters, so `projectName` is sized to clear it with room for
 * catalog growth rather than to the 38 the speeches table happens to show.
 */
export const SPEAKER_LIMITS = {
	/** Speech title. The only field that reaches a server-rendered PDF. */
	speechTitle: 200,
	/**
	 * The spoken introduction the Toastmaster reads aloud. A paragraph or two,
	 * so this is the one field sized for prose rather than for a label.
	 */
	introduction: 2_000,
	/** Pathways path name. Catalog longest: 23. */
	pathwayPath: 120,
	/** Pathways project name. Catalog longest: 56 — this MUST clear that. */
	projectName: 120,
	/** Pathways level label. Observed longest: 7. */
	projectLevel: 60,
	/** Link to slides. Sized for a real URL with query parameters. */
	presentationUrl: 500,
	/**
	 * Upper bound on a speech window, in minutes.
	 *
	 * `minMinutes`/`maxMinutes` were `z.number().int().positive()` with no upper
	 * bound anywhere in the codebase. Two things follow. The value feeds
	 * `speech-window.ts` and thence the agenda timeline, so a huge one shifts
	 * every following start time into nonsense; and the column is `integer`, so
	 * anything past 2^31 fails in the DRIVER and surfaces as a 500 rather than a
	 * validation error. 600 is ten hours — far past any real speech, still a
	 * bound.
	 */
	maxSpeechMinutes: 600,
} as const;

/**
 * The field validators that REJECT, exported so they can be TESTED.
 *
 * `speaker-details-schema.ts` composes these. Keeping them here rather than
 * inline gives the cap a direct test instead of one reachable only through a
 * `createServerFn` that tests cannot invoke.
 *
 * `.trim()` runs BEFORE `.max()`, so trailing whitespace can never push an
 * otherwise-valid value over the cap.
 *
 * Every cap carries a HUMAN message. Without one, zod's default surfaces as
 * `ZodError.message`, which is `JSON.stringify(issues)` — and the claim sheet
 * renders exactly that string in a toast (`toast.error(errMessage(err))`).
 * Before #522 these fields had no `.max()` at all, so a ZodError was
 * effectively unreachable from that form; adding the cap without a message
 * would have made a raw multi-line JSON dump one paste away on a public
 * no-auth page.
 */
const rejecting = (max: number, label: string) =>
	z.string().trim().max(max, `Keep the ${label} under ${max} characters.`);

export const SPEAKER_FIELDS = {
	speechTitle: rejecting(SPEAKER_LIMITS.speechTitle, "speech title"),
	introduction: rejecting(SPEAKER_LIMITS.introduction, "introduction"),
	pathwayPath: rejecting(SPEAKER_LIMITS.pathwayPath, "path name"),
	projectName: rejecting(SPEAKER_LIMITS.projectName, "project name"),
	projectLevel: rejecting(SPEAKER_LIMITS.projectLevel, "project level"),
	presentationUrl: rejecting(SPEAKER_LIMITS.presentationUrl, "slides link"),
} as const;

/**
 * The same caps for the UPDATE path, which TRUNCATE and CLAMP instead of
 * rejecting.
 *
 * The split follows the precedent set by [[wod-limits]] on #519: reject where a
 * failure costs only the field being edited, truncate only where a legacy value
 * would block saving unrelated fields on the same form.
 *
 * `updateSpeakerDetails` is squarely the second case. `edit-speech-sheet.tsx`
 * prefills `speechTitle` and `presentationUrl` with `defaultValue` from the
 * stored row and resubmits them on every save, so one value written before this
 * cap existed would fail `.parse()` and block editing the pathway, the timing
 * and the slides link too. Worse, the row would be unrepairable through the UI:
 * the only way to shorten the offending value is to save the form, and the form
 * is what the value blocks. Truncating instead makes opening and saving the
 * form the repair.
 *
 * Two caveats worth knowing before treating this list as uniform. The three
 * Pathways fields are rendered by `ProjectPicker`, which only emits them from
 * its free-text fallback — with a picked project they arrive `undefined` and
 * are overwritten from the catalog anyway. And `introduction` appears in no
 * form at all; it is here for symmetry with the create side, the same caveat
 * [[wod-limits]] already makes for its `definition`/`example`.
 *
 * `claimSlot` deliberately does NOT use these. Nothing is prefilled there — the
 * person just typed the value — so rejecting locks nobody out of anything,
 * while truncating would silently discard the tail of what they wrote. Silent
 * data loss is the worse failure when a clear error is available.
 *
 * The columns are unbounded `text` and this change ships no backfill, so an
 * over-long row is possible; that is exactly why this path degrades instead of
 * failing closed.
 */
export const SPEAKER_UPDATE_FIELDS = {
	speechTitle: truncating(SPEAKER_LIMITS.speechTitle),
	introduction: truncating(SPEAKER_LIMITS.introduction),
	pathwayPath: truncating(SPEAKER_LIMITS.pathwayPath),
	projectName: truncating(SPEAKER_LIMITS.projectName),
	projectLevel: truncating(SPEAKER_LIMITS.projectLevel),
	presentationUrl: truncating(SPEAKER_LIMITS.presentationUrl),
} as const;

/**
 * A speech-window bound, rejecting (create) or clamped later (update).
 *
 * The update variant deliberately does NOT clamp here, and that ordering is the
 * whole point. Clamping inside the field runs BEFORE the object's
 * both-or-neither refinement, which sees only post-transform values — so an
 * inverted pair whose ends BOTH exceed the cap collapsed into a valid-looking
 * one. Measured in #522's review: `{minMinutes: 700, maxMinutes: 650}` was
 * accepted and rewritten to `{600, 600}`, a window nobody typed, which is
 * exactly what `speech-window.ts` exists to prevent. The original test used
 * `{999_999, 5}`, where only one end is over the cap, so it rejected either way
 * and could not see this.
 *
 * `clampSpeechWindow` below therefore runs AFTER the refinement, so the order
 * check reads the values the caller actually sent.
 */
export const speechMinutesField = z
	.number()
	.int()
	.positive()
	.max(
		SPEAKER_LIMITS.maxSpeechMinutes,
		`A speech can run at most ${SPEAKER_LIMITS.maxSpeechMinutes} minutes.`,
	);

export const speechMinutesUpdateField = z.number().int().positive();

/**
 * Clamp an already-VALIDATED speech window onto the cap.
 *
 * Applied as an object-level transform after `superRefine`, so it can never
 * manufacture a passing pair out of a rejected one. Clamping (not rejecting)
 * for the same lockout reason as the strings: a number stored before this cap
 * must not be the thing that stops an admin fixing the row.
 */
export function clampSpeechWindow<
	T extends { minMinutes?: number; maxMinutes?: number },
>(value: T): T {
	const clamp = (n: number | undefined) =>
		n == null ? n : Math.min(n, SPEAKER_LIMITS.maxSpeechMinutes);
	return {
		...value,
		minMinutes: clamp(value.minMinutes),
		maxMinutes: clamp(value.maxMinutes),
	};
}
