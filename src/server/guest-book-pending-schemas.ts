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
 * The STORED shape of `guest_book_pending_plans.entries`.
 *
 * `jsonb("entries").$type<PendingEntry[]>()` is a compile-time cast and nothing
 * else — drizzle hands back whatever is in the column. That is fine while one
 * release wrote every row, and it stops being fine at a deploy boundary:
 * migrations apply at container startup with no drain, and a pending row lives
 * for up to 48 hours, so the first release that renames or requires a field on
 * `PendingEntry` reads the previous release's rows as if they were its own —
 * and `applyGuestBookPlan` writes `e.write.name` / `email` / `phone` straight
 * into `guests` with nothing validating in between.
 *
 * So the read boundary parses. `parseStoredEntries` returns null for anything
 * this release cannot understand, and both readers turn that into a refusal
 * that names the problem rather than a plan built from a half-understood row.
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

/**
 * Stored entries this release can act on, or null.
 *
 * Null covers three cases and they all mean the same thing to a reader: the
 * column is missing, it holds something this code does not understand, or a
 * field it now depends on is absent.
 */
export function parseStoredEntries(
	raw: unknown,
): z.infer<typeof storedEntriesSchema> | null {
	if (raw === null || raw === undefined) return null;
	const parsed = storedEntriesSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/** What a reader says when `parseStoredEntries` returns null for a stored row. */
export const UNREADABLE_ENTRIES_MESSAGE =
	"This transcription was stored by an older version of GavelUp and can no longer be read. Transcribe the page again.";

export const applySchema = z.object({
	pendingId: z.string().uuid(),
	/** The hash the page last rendered. Opaque here; compared inside the lock. */
	planHash: z.string().min(1).max(200),
});
