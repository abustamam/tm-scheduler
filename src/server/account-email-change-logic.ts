// A member changes their own sign-in address (#1091, ADR-0030).
//
// The DB half of the flow, kept out of the Better Auth plugin
// (`src/lib/change-email-plugin.ts`) so it is directly integration-testable,
// and in a `*-logic.ts` module so its `#/db` → `pg` import stays server-side.
//
// The shape, from the issue's decisions:
//  - REQUEST: only a user bound to a Person; at most 3 per account per hour;
//    the new inbox gets either a verification link or an "already in use"
//    email, and the requester sees the same answer either way.
//  - CONFIRM: one transaction re-checks everything, moves `user.email` and the
//    bound Person's `people.email` together, reconciles superadmin and writes
//    one `member_edit` per holding club. Then the OLD address gets a notice.
//  - Nothing else: sessions, OAuth grants and `tmk_` tokens key off the user
//    id and are untouched (decision 4).
import { randomUUID } from "node:crypto";
import { and, count, eq, gt, lte, sql } from "drizzle-orm";
import { db } from "#/db";
import { members, people, user, verification } from "#/db/schema";
import { sendEmail } from "#/lib/email";
import {
	buildAddressChangedNoticeEmail,
	buildAddressInUseEmail,
	buildChangeEmailVerificationEmail,
} from "#/lib/magic-link-email";
import { reconcileSuperadminFlag } from "#/lib/superadmin";
import { addressHeldByAnother, normalizeEmail } from "./account-link-logic";
import { logActivity } from "./activity";
import { isUniqueViolation } from "./pg-errors";

/** Per-account cap on change requests (decision 7). */
export const EMAIL_CHANGE_REQUESTS_PER_HOUR = 3;
const REQUEST_WINDOW_MS = 60 * 60 * 1000;

/** The `verification.identifier` one account's request rows are counted under. */
export function emailChangeRequestIdentifier(userId: string): string {
	return `change-email-request:${userId}`;
}

/** First int of the per-account advisory lock key: ASCII "EmlC". Its own
 *  namespace, so it never equals the club write lock's or the merge lock's. */
export const EMAIL_CHANGE_LOCK_NAMESPACE = 0x456d6c43;

/** What the requester is told. `sent` covers "already in use" on purpose. */
export type EmailChangeRequestResult =
	| { kind: "sent" }
	/** No Person is bound to this account (decision 6). */
	| { kind: "unbound" }
	/** The fourth request inside an hour (decision 7). */
	| { kind: "rate_limited" }
	/** The typed address is already this account's. */
	| { kind: "same" }
	/** Not an address at all. */
	| { kind: "invalid" };

/** The bound Person for an account, or null (decision 6). */
export async function boundPersonFor(
	userId: string,
	executor: Pick<typeof db, "select"> = db,
): Promise<{ personId: string } | null> {
	const [row] = await executor
		.select({ personId: people.id })
		.from(people)
		.where(eq(people.userId, userId))
		.limit(1);
	return row ?? null;
}

/** What Account settings shows: the address, and whether it may change it. */
export interface SignInEmailState {
	email: string | null;
	/** Bound to a Person: the only accounts that get the control (decision 6). */
	canChange: boolean;
}

export async function signInEmailStateFor(
	userId: string,
): Promise<SignInEmailState> {
	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return {
		email: account?.email ?? null,
		canChange: Boolean(account) && (await boundPersonFor(userId)) !== null,
	};
}

/**
 * Take one of this account's hourly request slots, or refuse.
 *
 * A row per request in Better Auth's own `verification` table, under
 * `change-email-request:<userId>`, expiring an hour later. It holds no address
 * (the value is a fixed marker): the pending change lives only in the signed
 * link, never in a table (decision 7). The advisory lock serialises two
 * requests from one account so they cannot both count 2 and both insert.
 *
 * This is the PER-ACCOUNT half. The plugin also registers a per-IP rule on the
 * same path with Better Auth's own limiter, which keys on client address and
 * path and so cannot express "per account" by itself.
 */
export async function takeEmailChangeRequestSlot(
	userId: string,
	now: Date = new Date(),
): Promise<boolean> {
	const identifier = emailChangeRequestIdentifier(userId);
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(${EMAIL_CHANGE_LOCK_NAMESPACE}::int4, hashtext(${userId}))`,
		);
		await tx
			.delete(verification)
			.where(
				and(
					eq(verification.identifier, identifier),
					lte(verification.expiresAt, now),
				),
			);
		const [row] = await tx
			.select({ n: count() })
			.from(verification)
			.where(
				and(
					eq(verification.identifier, identifier),
					gt(verification.expiresAt, now),
				),
			);
		if ((row?.n ?? 0) >= EMAIL_CHANGE_REQUESTS_PER_HOUR) return false;
		await tx.insert(verification).values({
			id: randomUUID(),
			identifier,
			value: "rate-limit",
			expiresAt: new Date(now.getTime() + REQUEST_WINDOW_MS),
		});
		return true;
	});
}

/** A signed change-of-address claim: which account, from what, to what. */
export interface EmailChangeClaim {
	userId: string;
	from: string;
	to: string;
}

/**
 * Ask to move `userId`'s sign-in address to `newEmail`.
 *
 * `mintLink` turns a claim into the confirm URL; the plugin supplies it, since
 * signing needs the auth secret. The collision check here is the courtesy one;
 * the confirm transaction asks again, because an address can be taken in the
 * hour the link is alive.
 */
export async function requestEmailChange(input: {
	userId: string;
	newEmail: string;
	mintLink: (claim: EmailChangeClaim) => Promise<string>;
}): Promise<EmailChangeRequestResult> {
	if (!(await boundPersonFor(input.userId))) return { kind: "unbound" };

	const to = normalizeEmail(input.newEmail);
	if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { kind: "invalid" };

	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, input.userId))
		.limit(1);
	const from = normalizeEmail(account?.email);
	if (!from) return { kind: "unbound" };
	if (from === to) return { kind: "same" };

	if (!(await takeEmailChangeRequestSlot(input.userId))) {
		return { kind: "rate_limited" };
	}

	if (await addressHeldByAnother(to, input.userId)) {
		const { subject, html, text } = buildAddressInUseEmail(to);
		await sendEmail({ to, subject, html, text });
		return { kind: "sent" };
	}

	const url = await input.mintLink({ userId: input.userId, from, to });
	const { subject, html, text } = buildChangeEmailVerificationEmail(url, to);
	await sendEmail({ to, subject, html, text });
	return { kind: "sent" };
}

/** How a confirm ended. */
export type EmailChangeConfirmResult =
	| { kind: "changed"; from: string; to: string }
	/** The account's address is no longer the claim's `from`: another change
	 *  landed first, so this link is dead. */
	| { kind: "stale" }
	/** Another account or another holding Person took the address meanwhile. */
	| { kind: "in_use" }
	/** No Person is bound to the account any more, or the account is gone. */
	| { kind: "unbound" };

/**
 * Apply a VERIFIED change: the new inbox just clicked its link.
 *
 * One transaction, in this order:
 *  1. lock the bound Person (Person before anything else, the order the roster
 *     edit takes them in, `members-logic.ts`) and the account;
 *  2. refuse a claim whose `from` is not the account's address NOW — after any
 *     other change has landed, an older link must not move the address again;
 *  3. ask the collision question again, inside the transaction;
 *  4. move `user.email` and `people.email` together;
 *  5. reconcile `is_superadmin` against the NEW address, both directions;
 *  6. one `member_edit` per club that holds the member, actor = that member.
 *
 * Only after commit does the OLD address get its notice (decision 1), so a
 * refused or rolled-back confirm never tells anyone a change happened.
 */
export async function confirmEmailChange(
	claim: EmailChangeClaim,
): Promise<EmailChangeConfirmResult> {
	const to = normalizeEmail(claim.to);
	const from = normalizeEmail(claim.from);
	if (!to || !from) return { kind: "stale" };

	let result: EmailChangeConfirmResult;
	try {
		result = await db.transaction(async (tx) => {
			const [person] = await tx
				.select({ id: people.id })
				.from(people)
				.where(eq(people.userId, claim.userId))
				.limit(1)
				.for("update");
			if (!person) return { kind: "unbound" } as const;

			const [account] = await tx
				.select({ email: user.email })
				.from(user)
				.where(eq(user.id, claim.userId))
				.for("update");
			if (!account) return { kind: "unbound" } as const;
			if (normalizeEmail(account.email) !== from || from === to) {
				return { kind: "stale" } as const;
			}

			if (await addressHeldByAnother(to, claim.userId, tx)) {
				return { kind: "in_use" } as const;
			}

			await tx
				.update(user)
				.set({ email: to, emailVerified: true })
				.where(eq(user.id, claim.userId));
			const moved = await tx
				.update(people)
				.set({ email: to })
				.where(and(eq(people.id, person.id), eq(people.userId, claim.userId)))
				.returning({ id: people.id });
			if (moved.length !== 1) {
				throw new Error("change-email: the bound Person did not move");
			}

			await reconcileSuperadminFlag(claim.userId, tx);

			const holdings = await tx
				.selectDistinctOn([members.clubId], {
					memberId: members.id,
					clubId: members.clubId,
				})
				.from(members)
				.where(eq(members.personId, person.id))
				.orderBy(members.clubId, members.id);
			for (const holding of holdings) {
				await logActivity(tx, {
					clubId: holding.clubId,
					actorMemberId: holding.memberId,
					action: "member_edit",
					targetType: "member",
					targetId: holding.memberId,
					detail: {
						before: { email: from },
						after: { email: to },
						via: "self_service_email_change",
					},
					impersonatedBy: null,
				});
			}
			return { kind: "changed", from, to } as const;
		});
	} catch (err) {
		// `user.email` is UNIQUE: an account created with this address between
		// the check above and the UPDATE lands here rather than as a 500.
		if (isUniqueViolation(err)) return { kind: "in_use" };
		throw err;
	}

	if (result.kind === "changed") {
		const { subject, html, text } = buildAddressChangedNoticeEmail(result.to);
		try {
			await sendEmail({ to: result.from, subject, html, text });
		} catch (err) {
			// The change stands; a lost notice is logged, not rolled back.
			console.error("change-email: notice to the old address failed", err);
		}
	}
	return result;
}
