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
import {
	GUEST_KINDS,
	GUEST_TEXT_MAX,
	HOME_CLUB_TOO_LONG_MESSAGE,
} from "#/lib/guest-profile";

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
		.max(GUEST_TEXT_MAX, "That name is too long."),
	email: z.string().trim().email().max(200).optional().or(z.literal("")),
	phone: z.string().trim().max(40).optional().or(z.literal("")),
});

export type GuestBookInput = z.infer<typeof guestBookSchema>;

/**
 * Record an invite draft (#899). `.strict()` with NO actor field: the inviter is
 * the membership the gate resolves from the session, so a client-supplied
 * `actorMemberId` must fail parsing rather than be silently dropped.
 */
export const recordGuestInviteSchema = z
	.object({
		clubId: uuid,
		guestId: uuid,
		meetingId: uuid,
	})
	.strict();

export type RecordGuestInviteSchemaInput = z.infer<
	typeof recordGuestInviteSchema
>;

/**
 * Set a guest's kind, home club and introducer (#1050). `.strict()` for the
 * same reason as `recordGuestInviteSchema`: nothing here names an actor, and an
 * unknown key should fail parsing rather than be dropped.
 *
 * `homeClub` is trimmed BEFORE the cap, so trailing spaces cannot push an
 * otherwise-legal name over it. The cap applies only when the kind is not
 * Visitor: a Visitor's home club is CLEARED (`normalizeHomeClub`), so refusing
 * an over-long one would refuse a value that is about to be thrown away.
 * `introducedByMemberId` is only shaped here — whether it names a member of
 * THIS club is a database question, answered by `applyUpdateGuestProfile`.
 */
export const updateGuestProfileSchema = z
	.object({
		clubId: uuid,
		guestId: uuid,
		kind: z.enum(GUEST_KINDS),
		homeClub: z.string().trim().nullable().optional(),
		introducedByMemberId: uuid.nullable().optional(),
	})
	.strict()
	.superRefine((d, ctx) => {
		if (
			d.kind !== "visitor" &&
			d.homeClub != null &&
			d.homeClub.length > GUEST_TEXT_MAX
		) {
			ctx.addIssue({
				code: "custom",
				path: ["homeClub"],
				message: HOME_CLUB_TOO_LONG_MESSAGE,
			});
		}
	});

export type UpdateGuestProfileInput = z.infer<typeof updateGuestProfileSchema>;
