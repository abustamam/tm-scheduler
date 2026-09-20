/**
 * Input and stored-payload schemas for `upsert_agendas` (#808).
 *
 * A separate module for the reason #806 measured the hard way. These schemas sit
 * behind a server fn's `validator(…)`, which only ever runs inside the Start
 * runtime — no test in this repo can execute a handler or its validator — so a
 * schema written inline in the wrapper module is a schema nothing can parse an
 * input against. `patchSchema` shipped there with two discriminated-union
 * members spelling the same discriminator and broke every edit on the guest-book
 * confirm page with typecheck, lint and 7,600 tests green.
 *
 * Exported here so `agenda-plan-pending-schemas.test.ts` can feed real inputs
 * through the SAME objects the server fns and the MCP tool validate with. A copy
 * of the shapes in a test is the one thing that could not have caught it.
 */
import { z } from "zod";
import type { AgendaEntry } from "#/lib/agenda-upsert";
import { localDate } from "#/lib/club-local-date";
import { MEETING_FIELDS } from "#/lib/meeting-limits";
import { MAX_BATCH } from "#/lib/meeting-recurrence";
import { WOD_FIELDS } from "#/lib/wod-limits";

/** Club-local `HH:MM`, 24-hour. The same shape `club_meeting_recurrence` stores. */
export const localTime = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour club-local time, HH:MM.");

/**
 * One date's instruction.
 *
 * The free-text fields compose the REJECTING create-path validators
 * (`MEETING_FIELDS`, `WOD_FIELDS`) rather than the truncating update ones. The
 * lockout argument that drives truncation elsewhere is about a form that
 * prefills and resubmits a value stored before the caps existed; an MCP call
 * carries only what the caller just said, so a rejection costs that one value
 * and is actionable — the same reasoning `createMeetingSchema` rests on.
 *
 * `.nullable().optional()` on every one, and the three states are the whole
 * interface: absent leaves the stored value alone, `null` (or blank) clears it,
 * a value stores it trimmed. See `AgendaEntry`.
 *
 * `.strict()` so a misspelled field is an error rather than a silent no-op. An
 * LLM writing `word_of_the_day` would otherwise get a cheerful plan showing no
 * change at all.
 */
export const agendaEntrySchema = z
	.object({
		date: localDate.describe("Club-local date of the meeting, YYYY-MM-DD."),
		time: localTime
			.optional()
			.describe(
				"Club-local start time, HH:MM. Only used when the meeting does not " +
					"exist yet; required then if the club has no standing schedule.",
			),
		theme: MEETING_FIELDS.theme.nullable().optional(),
		wordOfTheDay: WOD_FIELDS.word.nullable().optional(),
		wodDefinition: WOD_FIELDS.definition.nullable().optional(),
		wodExample: WOD_FIELDS.example.nullable().optional(),
		location: MEETING_FIELDS.location.nullable().optional(),
	})
	.strict();

/**
 * The list, bounded and with no date named twice.
 *
 * `MAX_BATCH` (52) is the club-year the batch-create form already uses, so one
 * call can set a whole season and no more.
 *
 * A repeated date is a `VALIDATION` rejection rather than a blocking item, and
 * that is the same boundary `errors.ts` draws for `FIELD_TOO_LONG`: it is a
 * mistake visible in the call itself, needing no club state to see. The
 * alternative — last-write-wins — would silently discard one of two
 * instructions, which is what `DUPLICATE_SLOT` exists to refuse for
 * `assign_roles`. Enforcing it here rather than in the planner is what lets
 * `plan()` assume one entry per date and stay a single pass.
 */
export const agendaEntriesSchema = z
	.array(agendaEntrySchema)
	.min(1)
	.max(MAX_BATCH)
	.superRefine((entries, ctx) => {
		const seen = new Map<string, number>();
		for (const [index, entry] of entries.entries()) {
			const first = seen.get(entry.date);
			if (first === undefined) {
				seen.set(entry.date, index);
				continue;
			}
			ctx.addIssue({
				code: "custom",
				path: [index, "date"],
				message: `${entry.date} is named twice (entries ${first} and ${index}). Send one instruction per date.`,
			});
		}
	});

/** What one apply left behind, kept on the tombstone so the page can say it. */
export interface AgendaAppliedSummary {
	created: number;
	updated: number;
	/** The club-local dates the apply touched, in plan order. */
	dates: string[];
}

const appliedSummarySchema = z.object({
	created: z.number().int().nonnegative(),
	updated: z.number().int().nonnegative(),
	dates: z.array(localDate),
});

/** What this release can make of one stored `upsert_agendas` payload. */
export interface StoredAgendaPayload {
	/**
	 * The dates the caller named, or null.
	 *
	 * Null means there are deliberately none: the applied tombstone. Distinct
	 * from `entriesUnreadable`, which means the column held something this
	 * release cannot parse.
	 */
	entries: AgendaEntry[] | null;
	entriesUnreadable: boolean;
	/** Present only on an applied tombstone, and only if it parsed. */
	applied: AgendaAppliedSummary | null;
}

/**
 * Parse one stored payload, or null when not even its envelope is readable.
 *
 * `jsonb("payload")` is `unknown` and nothing else — drizzle hands back whatever
 * is in the column. That is fine while one release wrote every row and stops
 * being fine at a deploy boundary: migrations apply at container startup with no
 * drain, and a pending row lives for up to 48 hours, so the first release that
 * renames or requires a field reads the previous release's rows as if they were
 * its own. This tool's apply writes straight into `meetings` with nothing
 * validating in between, so the read boundary parses.
 *
 * An ABSENT or null `meetings` key reads as the tombstone, not as corruption:
 * the applied row writes `{ meetings: null, applied: {…} }`, and a payload that
 * simply says nothing about the dates is saying the same thing. Corruption is
 * `meetings` PRESENT in a shape this release cannot read.
 */
export function parseAgendaPayload(raw: unknown): StoredAgendaPayload | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const record = raw as Record<string, unknown>;
	const applied = appliedSummarySchema.safeParse(record.applied);
	const rawEntries = record.meetings;
	if (rawEntries === null || rawEntries === undefined) {
		return {
			entries: null,
			entriesUnreadable: false,
			applied: applied.success ? applied.data : null,
		};
	}
	const entries = agendaEntriesSchema.safeParse(rawEntries);
	if (!entries.success) {
		return {
			entries: null,
			entriesUnreadable: true,
			applied: applied.success ? applied.data : null,
		};
	}
	return {
		entries: entries.data,
		entriesUnreadable: false,
		applied: applied.success ? applied.data : null,
	};
}

export const pendingIdSchema = z.object({ pendingId: z.string().uuid() });

export const applySchema = z.object({
	pendingId: z.string().uuid(),
	/** The hash the page last rendered. Opaque here; compared inside the lock. */
	planHash: z.string().min(1).max(200),
});
