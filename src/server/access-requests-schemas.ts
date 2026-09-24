// Input schema for the public request-access form (#866), split out of
// `access-requests.ts` so it is directly unit-testable: that module is a
// server-fn module, and `server-modules.guard.test.ts` lets those export ONLY
// server fns and types.
//
// Pure: no `#/db`. Keep the server-fn factory's name out of this file, prose
// included, or the guard's raw substring scan opts it back in.
import { z } from "zod";
import { isValidRef } from "#/lib/marketing-ref";

/** A trimmed optional string, with "" read as absent. */
const optionalTrimmed = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.optional()
		.transform((v) => (v ? v : undefined));

/**
 * The PUBLIC, session-less access request. Every bound is load-bearing: this
 * is the only thing between an anonymous POST and an unbounded `text` column.
 *
 * Two fields never reject, on purpose:
 * - `ref` is attribution, and a malformed one must not cost the maintainer the
 *   lead, so anything not matching `REF_PATTERN` becomes null.
 * - `website` is the honeypot. Rejecting a filled one would tell a bot which
 *   field tripped it, so any value parses and the logic answers it with the
 *   same `{ ok: true }` a real submission gets.
 */
export const accessRequestSchema = z
	.object({
		kind: z.enum(["club", "district"]),
		name: z
			.string()
			.trim()
			.min(1, "Please enter your name.")
			.max(120, "That name is too long."),
		email: z
			.string()
			.trim()
			.toLowerCase()
			.max(254, "That email is too long.")
			.email("Please enter a valid email."),
		clubName: optionalTrimmed(160),
		clubNumber: z
			.string()
			.trim()
			.optional()
			.transform((v) => (v ? v : undefined))
			.pipe(
				z
					.string()
					.regex(/^\d{1,8}$/, "A club number is digits only.")
					.optional(),
			),
		districtNumber: z
			.string()
			.trim()
			.optional()
			.transform((v) => (v ? v : undefined))
			.pipe(
				z
					.string()
					.regex(/^[0-9A-Za-z]{1,4}$/, "That doesn't look like a district.")
					.optional(),
			),
		message: optionalTrimmed(2000),
		ref: z
			.unknown()
			.optional()
			.transform((v) => (typeof v === "string" && isValidRef(v) ? v : null)),
		website: z
			.unknown()
			.optional()
			.transform((v) => (typeof v === "string" ? v : v == null ? "" : "x")),
		renderedAt: z.number().finite(),
	})
	.superRefine((v, ctx) => {
		if (v.kind === "club" && !v.clubName) {
			ctx.addIssue({
				code: "custom",
				path: ["clubName"],
				message: "Please enter your club's name.",
			});
		}
		if (v.kind === "district" && !v.districtNumber) {
			ctx.addIssue({
				code: "custom",
				path: ["districtNumber"],
				message: "Please enter your district number.",
			});
		}
	});

/** What the form sends (pre-parse). */
export type AccessRequestFormInput = z.input<typeof accessRequestSchema>;
/** What the logic receives (post-parse: trimmed, lowercased, ref vetted). */
export type AccessRequestInput = z.output<typeof accessRequestSchema>;
