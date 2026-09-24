// Input schema for the public request-access form (#866), split out of
// `access-requests.ts` so it is directly unit-testable and so the form can
// import its bounds: that module is a server-fn module, and
// `server-modules.guard.test.ts` lets those export ONLY server fns and types.
//
// Pure: no `#/db`. Keep the server-fn factory's name out of this file, prose
// included, or the guard's raw substring scan opts it back in.
import { z } from "zod";
import { isValidRef } from "#/lib/marketing-ref";

/** Who is asking. The db enum `access_request_kind` holds the same pair. */
export const ACCESS_REQUEST_KINDS = ["club", "district"] as const;
export type AccessRequestKind = (typeof ACCESS_REQUEST_KINDS)[number];

/**
 * Every field bound, stated once. The form reads these for its `maxLength` and
 * `pattern` attributes, so the browser and the server can never disagree about
 * what is too long. A `pattern` is written UNANCHORED because that is what the
 * HTML attribute expects (it anchors implicitly); the schema anchors it below.
 */
export const ACCESS_REQUEST_BOUNDS = {
	nameMax: 120,
	emailMax: 254,
	clubNameMax: 160,
	clubNumberPattern: "\\d{1,8}",
	clubNumberMax: 8,
	districtNumberPattern: "[0-9A-Za-z]{1,4}",
	districtNumberMax: 4,
	messageMax: 2000,
} as const;

/**
 * The honeypot input's DOM name and id. Deliberately meaningless: a field
 * called `website`, `url` or `email2` is one browser autofill or a password
 * manager may fill for a real person, who would then be silently dropped as a
 * bot. The payload key is `trap`; this is only what the page calls the input.
 */
export const ACCESS_REQUEST_HONEYPOT_FIELD = "ra-fx7q2m";

const B = ACCESS_REQUEST_BOUNDS;
const anchored = (pattern: string) => new RegExp(`^(?:${pattern})$`);

/** A trimmed optional string, with "" read as absent. */
const optionalTrimmed = (max: number) =>
	z
		.string()
		.trim()
		.max(max)
		.optional()
		.transform((v) => (v ? v : undefined));

/** A trimmed optional string matching `pattern`, with "" read as absent. */
const optionalPattern = (pattern: string, message: string) =>
	z
		.string()
		.trim()
		.optional()
		.transform((v) => (v ? v : undefined))
		.pipe(z.string().regex(anchored(pattern), message).optional());

/**
 * The PUBLIC, session-less access request. Every bound is load-bearing: this
 * is the only thing between an anonymous POST and an unbounded `text` column.
 *
 * Three fields never reject, on purpose:
 * - `ref` is attribution, and a malformed one must not cost the maintainer the
 *   lead, so anything not matching `REF_PATTERN` becomes null.
 * - `trap` is the honeypot. Rejecting a filled one would tell a bot which field
 *   tripped it, so any value parses and the logic answers it with the same
 *   `{ ok: true }` a real submission gets.
 * - `fillMs` is how long the form was open, measured on the CLIENT with
 *   `performance.now()` so no clock is compared with another. Anything that is
 *   not a finite, non-negative number is read as 0 — too fast — so a caller
 *   that omits it or sends garbage is treated as a bot, never waved through.
 */
export const accessRequestSchema = z
	.object({
		kind: z.enum(ACCESS_REQUEST_KINDS),
		name: z
			.string()
			.trim()
			.min(1, "Please enter your name.")
			.max(B.nameMax, "That name is too long."),
		email: z
			.string()
			.trim()
			.toLowerCase()
			.max(B.emailMax, "That email is too long.")
			.email("Please enter a valid email."),
		clubName: optionalTrimmed(B.clubNameMax),
		clubNumber: optionalPattern(
			B.clubNumberPattern,
			"A club number is digits only.",
		),
		districtNumber: optionalPattern(
			B.districtNumberPattern,
			"That doesn't look like a district.",
		),
		message: optionalTrimmed(B.messageMax),
		ref: z
			.unknown()
			.optional()
			.transform((v) => (typeof v === "string" && isValidRef(v) ? v : null)),
		trap: z
			.unknown()
			.optional()
			.transform((v) => (typeof v === "string" ? v : v == null ? "" : "x")),
		fillMs: z
			.unknown()
			.optional()
			.transform((v) =>
				typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0,
			),
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
