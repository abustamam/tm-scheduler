/**
 * Input schemas for the guest-book confirm server fns (#806).
 *
 * A separate module for one reason, and it is a measured one. These schemas
 * live behind `createServerFn().validator(…)`, which only ever runs inside the
 * Start runtime — no test in this repo can execute a handler or its validator.
 * So a schema written inline in `guest-book-pending.ts` is a schema nothing can
 * parse an input against, and this one shipped broken: `patchSchema` had TWO
 * `z.discriminatedUnion` members both spelling `kind: "field"`.
 *
 * MEASURED, because the obvious fix was wrong. `z.discriminatedUnion` builds
 * its discriminator map LAZILY, so `Duplicate discriminator value "field"` is
 * thrown on the first PARSE, not when the union is constructed — a guard that
 * merely imported the module stayed green on the mutation. Every edit on the
 * confirm page failed, with typecheck, lint and 7,600 tests green, and it was
 * found by opening the page in a browser.
 *
 * Exported here so `guest-book-pending-schemas.test.ts` can parse real inputs
 * through the SAME objects the server fns validate with. A copy of the shapes
 * in a test is the one thing that could not have caught this.
 */
import { z } from "zod";

export const pendingIdSchema = z.object({ pendingId: z.string().uuid() });

/**
 * One edit to one line.
 *
 * `name` is the only field with no empty form — a guest row with an empty name
 * is a write nothing downstream can undo — and that rule is a `superRefine` on
 * the OUTER object rather than a second `field` branch, because a discriminated
 * union discriminates on one key and its members must stay plain objects.
 * Everything else accepts `""`, and `applyPendingEntryEdit` deletes the field.
 */
export const patchSchema = z
	.object({
		pendingId: z.string().uuid(),
		edit: z.discriminatedUnion("kind", [
			z.object({
				kind: z.literal("field"),
				id: z.string().min(1),
				field: z.enum(["name", "preferredName", "email", "phone"]),
				// 320 is the email bound, the longest of the four; `name` and
				// `preferredName` are bounded again by the guest schema on write.
				value: z.string().trim().max(320),
			}),
			z.object({
				kind: z.literal("resolve"),
				id: z.string().min(1),
				resolve: z
					.discriminatedUnion("kind", [
						z.object({
							kind: z.literal("existing"),
							guestId: z.string().uuid(),
						}),
						z.object({ kind: z.literal("new") }),
					])
					// Null puts an answered line back to ambiguous.
					.nullable(),
			}),
			z.object({
				kind: z.literal("dropped"),
				id: z.string().min(1),
				dropped: z.boolean(),
			}),
		]),
	})
	.superRefine((input, ctx) => {
		if (
			input.edit.kind === "field" &&
			input.edit.field === "name" &&
			input.edit.value.length === 0
		) {
			ctx.addIssue({
				code: "custom",
				path: ["edit", "value"],
				message: "A line needs a name.",
			});
		}
	});

/**
 * The STORED shape of a `record_guest_book` pending plan's `payload`.
 *
 * `jsonb("payload")` is `unknown` and nothing else — drizzle hands back whatever
 * is in the column. That is fine while one release wrote every row, and it stops
 * being fine at a deploy boundary: migrations apply at container startup with no
 * drain, and a pending row lives for up to 48 hours, so the first release that
 * renames or requires a field reads the previous release's rows as if they were
 * its own — and `applyGuestBookPlan` writes `e.write.name` / `email` / `phone`
 * straight into `guests` with nothing validating in between.
 *
 * So the read boundary parses, and it parses in TWO steps rather than one,
 * because the payload carries two things whose failures are not the same event.
 * The meeting date is the ENVELOPE — the page's header renders it, and an
 * unreadable line does not make the date unreadable. Parsing them together
 * would lose a perfectly good date to a transcription shape from a previous
 * release, and the page would then have nothing to say beyond "something is
 * wrong".
 *
 * `meetingDate` lives in the payload, NOT in a column, since #812. One table
 * now serves every MCP write tool, and `upsert_agendas` carries many dates and
 * has no single value for one — a column meaningful for one tool and always-null
 * for the other is two tables wearing one name. It is also #806's own rule
 * restated: store what was ASKED and re-derive everything else.
 */
const storedEntrySchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	preferredName: z.string().optional(),
	email: z.string().optional(),
	phone: z.string().optional(),
	dropped: z.boolean().optional(),
	resolve: z
		.discriminatedUnion("kind", [
			z.object({ kind: z.literal("existing"), guestId: z.string().min(1) }),
			z.object({ kind: z.literal("new") }),
		])
		.optional(),
});

export const storedEntriesSchema = z.array(storedEntrySchema);

/** Club-local `YYYY-MM-DD`, exactly as the caller named it. */
const storedMeetingDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** What this release can make of one stored `record_guest_book` payload. */
export interface StoredGuestBookPayload {
	meetingDate: string;
	/**
	 * The transcribed lines, or null.
	 *
	 * Null means there are deliberately none: the applied tombstone. Distinct
	 * from `entriesUnreadable`, which means the column held something this
	 * release cannot parse.
	 */
	entries: z.infer<typeof storedEntriesSchema> | null;
	entriesUnreadable: boolean;
}

/**
 * Parse one stored payload, or null when not even its envelope is readable.
 *
 * Null is the honest answer to "a release this one has never seen wrote this
 * row": there is no meeting date to render and no transcription to show, so a
 * reader can only say what to do next. An unreadable ENTRY list is the narrower
 * and far likelier case, and it keeps the date — see the header above.
 */
export function parseGuestBookPayload(
	raw: unknown,
): StoredGuestBookPayload | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return null;
	const record = raw as Record<string, unknown>;
	const date = storedMeetingDateSchema.safeParse(record.meetingDate);
	if (!date.success) return null;
	// An ABSENT `entries` key reads as the tombstone, not as corruption: the
	// applied row writes `{ meetingDate, entries: null }`, and a payload that
	// simply says nothing about entries is saying the same thing. Corruption is
	// `entries` PRESENT in a shape this release cannot read, which is the case
	// below.
	const rawEntries = record.entries;
	if (rawEntries === null || rawEntries === undefined) {
		return { meetingDate: date.data, entries: null, entriesUnreadable: false };
	}
	const entries = storedEntriesSchema.safeParse(rawEntries);
	if (!entries.success) {
		return { meetingDate: date.data, entries: null, entriesUnreadable: true };
	}
	return {
		meetingDate: date.data,
		entries: entries.data,
		entriesUnreadable: false,
	};
}

/** What a reader says when a stored payload cannot be read. */
export const UNREADABLE_ENTRIES_MESSAGE =
	"This transcription was stored by an older version of GavelUp and can no longer be read. Transcribe the page again.";

export const applySchema = z.object({
	pendingId: z.string().uuid(),
	/** The hash the page last rendered. Opaque here; compared inside the lock. */
	planHash: z.string().min(1).max(200),
});
