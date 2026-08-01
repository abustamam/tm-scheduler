// Input schemas for the guest pipeline, split out of `guest-pipeline.ts` so they
// are directly unit-testable. That module is a server-fn module, and
// `server-modules.guard.test.ts` allows those to export ONLY server fns and
// types — so a schema exported from there fails the guard, and a schema that
// cannot be imported cannot be tested.
//
// This module is pure: no `#/db`, no server fns. Client-safe, and exempt from
// that guard because the guard skips any file not containing the server-fn
// factory name. Keep that name out of this file, prose included — the check is
// a raw substring scan, so even a mention in a comment opts the file back in.
import { z } from "zod";

const uuid = z.string().uuid();

/**
 * The PUBLIC, session-less guest-book submission (#239).
 *
 * Every bound here is load-bearing rather than cosmetic. `name` reaches
 * `namesAgree`, whose token-pairing search is bounded separately
 * (`MAX_MATCH_TOKENS`); this is the second layer. It is also the only thing
 * standing between an unauthenticated POST and an unbounded `text` column —
 * the guest-book form sets no `maxLength` of its own.
 *
 * `.max()` sits BEFORE `.optional().or(z.literal(""))` on the contact fields so
 * an omitted or empty value still parses; only a present, over-long one fails.
 */
export const guestBookSchema = z.object({
	clubId: uuid,
	name: z
		.string()
		.trim()
		.min(1, "Please enter your name.")
		.max(120, "That name is too long."),
	email: z.string().trim().email().max(200).optional().or(z.literal("")),
	phone: z.string().trim().max(40).optional().or(z.literal("")),
});

export type GuestBookInput = z.infer<typeof guestBookSchema>;
