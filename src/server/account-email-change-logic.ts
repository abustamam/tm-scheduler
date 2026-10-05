// A member changes their own sign-in address (#1091, ADR-0030).
//
// The DB half of the flow, kept out of the Better Auth plugin
// (`src/lib/change-email-plugin.ts`) so it is directly integration-testable,
// and in a `*-logic.ts` module so its `#/db` → `pg` import stays server-side.
//
// The shape, from the issue's decisions:
//  - REQUEST: only an account bound to exactly one Person; at most 3 per
//    account per hour; the new inbox gets either a verification link or an
//    "already in use" email, and the requester sees the same answer either way.
//  - CONFIRM: one transaction re-checks everything, moves `user.email` and the
//    bound Person's `people.email` together, reconciles superadmin, writes one
//    `member_edit` per holding club and advances the account's change
//    generation, which kills every link minted before it. Then
//    the OLD address gets a notice.
//  - Nothing else: sessions, OAuth grants and `tmk_` tokens key off the user
//    id and are untouched (decision 4).
import { createHmac, randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, lte, sql } from "drizzle-orm";
import * as z from "zod";
import { db } from "#/db";
import { members, people, user, verification } from "#/db/schema";
import { sendEmail } from "#/lib/email";
import {
	buildAddressChangedNoticeEmail,
	buildAddressInUseEmail,
	buildChangeEmailVerificationEmail,
} from "#/lib/magic-link-email";
import {
	EMAIL_CHANGE_REQUEST_WINDOW_SECONDS,
	EMAIL_CHANGE_REQUESTS_PER_WINDOW,
} from "#/lib/member-email-change";
import { reconcileSuperadminFlag } from "#/lib/superadmin";
import { addressHeldByAnother, normalizeEmail } from "./account-link-logic";
import { logActivity } from "./activity";
import { isUniqueViolation } from "./pg-errors";

/**
 * The per-account part of every `verification.identifier` this flow writes:
 * an HMAC of the user id under the auth secret, never the user id itself
 * (#1091 review, fix round 3).
 *
 * Why. Better Auth's magic-link verify, given a `token` naming an identifier,
 * consumes the newest `verification` row with it and then deletes EVERY row
 * with it, before checking it is a magic link. So any identifier an outsider
 * can build — `…:<userId>` — is deletable by anyone, with no session: the
 * per-account request count (cap cleared in one request) and the change
 * generation (back to 0, reviving a replayed link). An HMAC under the secret
 * cannot be built without it. The HMAC input is `"<kind>:<userId>"`.
 *
 * `secret` is the auth instance's (`ctx.context.secret`), threaded in by the
 * plugin. Rotating it orphans these rows, so the count and the generation read
 * as fresh; that revives nothing, because rotation also invalidates every link
 * signed with the old secret.
 */
function accountKey(kind: string, userId: string, secret: string): string {
	return createHmac("sha256", secret)
		.update(`${kind}:${userId}`)
		.digest("base64url");
}

/** The `verification.identifier` one account's request rows are counted under. */
export function emailChangeRequestIdentifier(
	userId: string,
	secret: string,
): string {
	return `change-email-request:${accountKey("change-email-request", userId, secret)}`;
}

/**
 * The `verification.identifier` holding this account's CHANGE GENERATION
 * (#1091 review, the A→B→A replay): an integer, absent = 0, incremented by
 * every landed change under the account row lock. A link carries the
 * generation it was minted at and applies only while it is still current.
 *
 * A counter, not a timestamp: two `Date.now()` readings compared across a
 * backward clock step could revive a replayed link; a counter only moves up.
 */
export function emailChangeGenerationIdentifier(
	userId: string,
	secret: string,
): string {
	return `change-email-generation:${accountKey("change-email-generation", userId, secret)}`;
}

/**
 * The generation row never expires. Better Auth deletes EVERY expired
 * `verification` row whenever it looks one up, and a generation that fell back
 * to 0 would make a link minted at generation 0 current again. Making that safe
 * by expiry would rest on JWT `exp`, which is the same clock this replaces. So
 * the row is kept: one small row per account that has ever changed address.
 */
const GENERATION_NEVER_EXPIRES = new Date("9999-12-31T00:00:00Z");

/** The account's current change generation (0 when it never changed). */
export async function emailChangeGenerationFor(
	userId: string,
	secret: string,
	executor: Pick<typeof db, "select"> = db,
): Promise<number> {
	const rows = await executor
		.select({ value: verification.value })
		.from(verification)
		.where(
			eq(
				verification.identifier,
				emailChangeGenerationIdentifier(userId, secret),
			),
		);
	return Math.max(0, ...rows.map((row) => Number.parseInt(row.value, 10) || 0));
}

/** First int of the per-account advisory lock key: ASCII "EmlC". Its own
 *  namespace, so it never equals the club write lock's or the merge lock's. */
export const EMAIL_CHANGE_LOCK_NAMESPACE = 0x456d6c43;

/** What the requester is told. `sent` covers "already in use" on purpose. */
export type EmailChangeRequestResult =
	| { kind: "sent" }
	/** No Person is bound to this account (decision 6). */
	| { kind: "unbound" }
	/** Two or more Persons are bound to this account: merge first. */
	| { kind: "needs_merge" }
	/** The fourth request inside an hour (decision 7). */
	| { kind: "rate_limited" }
	/** The typed address is already this account's. */
	| { kind: "same" }
	/** Not an address at all. */
	| { kind: "invalid" };

/** Which Person an account changes, if it may change at all. */
export type BoundPerson =
	| { kind: "one"; personId: string }
	| { kind: "none" }
	/** `people.user_id` is not unique; duplicates predate #329's dedupe. Which
	 *  one's address to move is a merge decision, not ours (#1091 review). */
	| { kind: "many" };

/** The Person bound to an account (decision 6), refusing an ambiguous one. */
export async function boundPersonFor(
	userId: string,
	executor: Pick<typeof db, "select"> = db,
): Promise<BoundPerson> {
	const rows = await executor
		.select({ personId: people.id })
		.from(people)
		.where(eq(people.userId, userId))
		.limit(2);
	if (rows.length > 1) return { kind: "many" };
	const [row] = rows;
	return row ? { kind: "one", personId: row.personId } : { kind: "none" };
}

/** What Account settings shows: the address, and whether it may change it. */
export interface SignInEmailState {
	email: string | null;
	/** Bound to exactly one Person: the only accounts that get the control. */
	canChange: boolean;
	/** Bound to two or more: shown why there is no control. */
	needsMerge: boolean;
}

export async function signInEmailStateFor(
	userId: string,
): Promise<SignInEmailState> {
	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	const bound = account ? await boundPersonFor(userId) : { kind: "none" };
	return {
		email: account?.email ?? null,
		canChange: bound.kind === "one",
		needsMerge: bound.kind === "many",
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
	secret: string,
	now: Date = new Date(),
): Promise<boolean> {
	const identifier = emailChangeRequestIdentifier(userId, secret);
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
		if ((row?.n ?? 0) >= EMAIL_CHANGE_REQUESTS_PER_WINDOW) return false;
		await tx.insert(verification).values({
			id: randomUUID(),
			identifier,
			value: "rate-limit",
			expiresAt: new Date(
				now.getTime() + EMAIL_CHANGE_REQUEST_WINDOW_SECONDS * 1000,
			),
		});
		return true;
	});
}

/**
 * A signed change-of-address claim: which account, from what, to what, and
 * the account's change generation when it was minted. `generation` is what
 * kills a link once ANY change lands, including one that lands the account
 * back on this link's `from`.
 */
export interface EmailChangeClaim {
	userId: string;
	from: string;
	to: string;
	generation: number;
}

const isEmail = (value: string) => z.email().safeParse(value).success;

/**
 * Ask to move `userId`'s sign-in address to `newEmail`.
 *
 * `mintLink` turns a claim into the confirm URL; the plugin supplies it, since
 * signing needs the auth secret. The collision check here is the courtesy one;
 * the confirm transaction asks again, because an address can be taken in the
 * hour the link is alive.
 *
 * Both branches do the same work (#1091 review): both collision arms always
 * run and a link is always minted, whichever email is sent, so the queries
 * issued are the same. That is NOT a claim the timing is indistinguishable: a
 * LIMIT-1 scan over an unindexed normalised expression can still finish sooner
 * on a hit. That residual is accepted and unmeasured.
 *
 * The generation is read without a lock: a change landing between this read
 * and the click only makes the link dead, which fails closed.
 */
export async function requestEmailChange(input: {
	userId: string;
	newEmail: string;
	/** The auth instance's secret, for this flow's row identifiers. */
	secret: string;
	mintLink: (claim: EmailChangeClaim) => Promise<string>;
}): Promise<EmailChangeRequestResult> {
	const bound = await boundPersonFor(input.userId);
	if (bound.kind === "none") return { kind: "unbound" };
	if (bound.kind === "many") return { kind: "needs_merge" };

	const to = normalizeEmail(input.newEmail);
	if (!to || !isEmail(to)) return { kind: "invalid" };

	const [account] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, input.userId))
		.limit(1);
	const from = normalizeEmail(account?.email);
	if (!from) return { kind: "unbound" };
	if (from === to) return { kind: "same" };

	if (!(await takeEmailChangeRequestSlot(input.userId, input.secret))) {
		return { kind: "rate_limited" };
	}

	const held = await addressHeldByAnother(to, input.userId);
	const url = await input.mintLink({
		userId: input.userId,
		from,
		to,
		generation: await emailChangeGenerationFor(input.userId, input.secret),
	});
	const { subject, html, text } = held
		? buildAddressInUseEmail(to)
		: buildChangeEmailVerificationEmail(url, to);
	await sendEmail({ to, subject, html, text });
	return { kind: "sent" };
}

/** How a confirm ended. */
export type EmailChangeConfirmResult =
	| { kind: "changed"; from: string; to: string }
	/** The link predates a change that has since landed (or names an address
	 *  the account no longer has): it is dead. */
	| { kind: "stale" }
	/** Another account or another holding Person took the address meanwhile. */
	| { kind: "in_use" }
	/** No Person is bound to the account any more, or the account is gone. */
	| { kind: "unbound" }
	/** Two or more Persons are bound to the account: merge first. */
	| { kind: "needs_merge" };

/**
 * Apply a VERIFIED change: the new inbox just clicked its link and pressed
 * the confirm page's button.
 *
 * One transaction, in this order:
 *  1. lock every Person bound to the account (Person before anything else, the
 *     order the roster edit takes them in, `members-logic.ts`), refusing two or
 *     more, then the account row;
 *  2. refuse a claim minted at an earlier change generation, or whose `from` is
 *     not the account's address now;
 *  3. ask the collision question again, inside the transaction;
 *  4. move `user.email` and `people.email` together;
 *  5. reconcile `is_superadmin` against the NEW address, both directions;
 *  6. one `member_edit` per club that holds the member, actor = that member;
 *  7. advance the change generation, which kills every link minted before it.
 *
 * Only after commit does the OLD address get its notice (decision 1), so a
 * refused or rolled-back confirm never tells anyone a change happened.
 */
export async function confirmEmailChange(
	claim: EmailChangeClaim,
	/** The auth instance's secret, for this flow's row identifiers. */
	secret: string,
): Promise<EmailChangeConfirmResult> {
	const to = normalizeEmail(claim.to);
	const from = normalizeEmail(claim.from);
	if (!to || !from) return { kind: "stale" };

	let result: EmailChangeConfirmResult;
	try {
		result = await db.transaction(async (tx) => {
			const bound = await tx
				.select({ id: people.id })
				.from(people)
				.where(eq(people.userId, claim.userId))
				.orderBy(asc(people.id))
				.for("update");
			if (bound.length > 1) return { kind: "needs_merge" } as const;
			const [person] = bound;
			if (!person) return { kind: "unbound" } as const;

			const [account] = await tx
				.select({ email: user.email })
				.from(user)
				.where(eq(user.id, claim.userId))
				.for("update");
			if (!account) return { kind: "unbound" } as const;

			// Serialised by the account row lock above: every landing for this
			// account advances the generation under that same lock.
			const generation = await emailChangeGenerationFor(
				claim.userId,
				secret,
				tx,
			);
			if (claim.generation !== generation) {
				return { kind: "stale" } as const;
			}
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

			// Advance the generation: every link minted before this landing is
			// now dead. Kept forever — see GENERATION_NEVER_EXPIRES.
			await tx
				.delete(verification)
				.where(
					eq(
						verification.identifier,
						emailChangeGenerationIdentifier(claim.userId, secret),
					),
				);
			await tx.insert(verification).values({
				id: randomUUID(),
				identifier: emailChangeGenerationIdentifier(claim.userId, secret),
				value: String(generation + 1),
				expiresAt: GENERATION_NEVER_EXPIRES,
			});
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
