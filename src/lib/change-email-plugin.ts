/**
 * A member changes their own sign-in address (#1091, ADR-0030), as a small
 * Better Auth plugin: two endpoints under `/api/auth`, and nothing else.
 *
 * Why not Better Auth's own `user.changeEmail` (left DISABLED in `auth.ts`):
 *  - its link names the OLD address, not the account, and its verify finds the
 *    user by that address when the link is clicked — so a link can land on
 *    whichever account holds the address by then;
 *  - its write happens outside any transaction of ours and knows nothing of
 *    `people.email`, our collision rule, superadmin or the activity log;
 *  - its silent "existing user" no-op sends nothing, where decision 3 wants the
 *    new inbox told the address is in use;
 *  - it needs `emailVerification.sendVerificationEmail`, which also arms
 *    Better Auth's public `/send-verification-email` sender.
 *
 * Why a plugin rather than a server fn: the request path goes through Better
 * Auth's own rate limiter (decision 7) and its origin check, and signs its link
 * with the auth secret.
 *
 * The link is a one-hour HS256 JWT naming `{userId, from, to}` and a `purpose`
 * no other token signed with this secret carries. Requesting again does not
 * cancel an earlier link; but once ANY change lands, a link whose `from` is no
 * longer the account's address is dead (`confirmEmailChange`).
 *
 * All the DB work is `#/server/account-email-change-logic`.
 */
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	sessionMiddleware,
} from "better-auth/api";
import { signJWT, verifyJWT } from "better-auth/crypto";
import * as z from "zod";
import { CHANGE_EMAIL_LINK_EXPIRY_SECONDS } from "#/lib/magic-link-email";
import {
	type EmailChangeOutcome,
	MEMBER_EMAIL_CONFIRM_PATH,
	MEMBER_EMAIL_REQUEST_PATH,
} from "#/lib/member-email-change";
import {
	confirmEmailChange,
	type EmailChangeClaim,
	requestEmailChange,
} from "#/server/account-email-change-logic";

/** Per client address, through Better Auth's limiter (decision 7). The
 *  per-ACCOUNT cap is `takeEmailChangeRequestSlot`, because this limiter keys
 *  on address and path only. */
export const MEMBER_EMAIL_REQUEST_RATE_LIMIT = { window: 60 * 60, max: 3 };

export { MEMBER_EMAIL_CONFIRM_PATH, MEMBER_EMAIL_REQUEST_PATH };

export const RATE_LIMITED_MESSAGE = "Too many requests, try again later.";
export const UNBOUND_MESSAGE =
	"Your account isn't linked to a club member, so there is no address to change here. Sign in with the other address instead.";

const TOKEN_PURPOSE = "gavelup-member-email-change";

const claimSchema = z.object({
	purpose: z.literal(TOKEN_PURPOSE),
	userId: z.string().min(1),
	from: z.string().min(1),
	to: z.string().min(1),
});

/** Sign a change claim into the confirm link's token. */
export async function signEmailChangeToken(
	claim: EmailChangeClaim,
	secret: string,
	expiresIn: number = CHANGE_EMAIL_LINK_EXPIRY_SECONDS,
): Promise<string> {
	return signJWT({ purpose: TOKEN_PURPOSE, ...claim }, secret, expiresIn);
}

/** The claim a token carries, or null when it is expired, forged or foreign. */
export async function readEmailChangeToken(
	token: string,
	secret: string,
): Promise<EmailChangeClaim | null> {
	const payload = await verifyJWT(token, secret);
	const parsed = claimSchema.safeParse(payload);
	if (!parsed.success) return null;
	const { userId, from, to } = parsed.data;
	return { userId, from, to };
}

/** Where a clicked link lands: Account settings, with the outcome. */
export function confirmRedirect(outcome: EmailChangeOutcome): string {
	return `/account?emailChange=${encodeURIComponent(outcome)}`;
}

export function memberEmailChange() {
	return {
		id: "member-email-change",
		endpoints: {
			requestMemberEmailChange: createAuthEndpoint(
				MEMBER_EMAIL_REQUEST_PATH,
				{
					method: "POST",
					body: z.object({ newEmail: z.string().max(320) }),
					use: [sessionMiddleware],
				},
				async (ctx) => {
					const result = await requestEmailChange({
						userId: ctx.context.session.user.id,
						newEmail: ctx.body.newEmail,
						mintLink: async (claim) => {
							const token = await signEmailChangeToken(
								claim,
								ctx.context.secret,
							);
							return `${ctx.context.baseURL}${MEMBER_EMAIL_CONFIRM_PATH}?token=${encodeURIComponent(token)}`;
						},
					});
					switch (result.kind) {
						case "sent":
							// Identical whether the new inbox got a link or the
							// "already in use" email (decision 3).
							return ctx.json({ status: true });
						case "unbound":
							throw new APIError("FORBIDDEN", { message: UNBOUND_MESSAGE });
						case "rate_limited":
							throw new APIError("TOO_MANY_REQUESTS", {
								message: RATE_LIMITED_MESSAGE,
							});
						case "same":
							throw new APIError("BAD_REQUEST", {
								message: "That's already your sign-in address.",
							});
						case "invalid":
							throw new APIError("BAD_REQUEST", {
								message: "Enter a valid email address.",
							});
					}
				},
			),
			confirmMemberEmailChange: createAuthEndpoint(
				MEMBER_EMAIL_CONFIRM_PATH,
				{
					method: "GET",
					query: z.object({ token: z.string().max(4096) }),
				},
				async (ctx) => {
					const claim = await readEmailChangeToken(
						ctx.query.token,
						ctx.context.secret,
					);
					if (!claim) throw ctx.redirect(confirmRedirect("expired"));
					const result = await confirmEmailChange(claim);
					throw ctx.redirect(confirmRedirect(result.kind));
				},
			),
		},
		rateLimit: [
			{
				pathMatcher: (path: string) => path === MEMBER_EMAIL_REQUEST_PATH,
				...MEMBER_EMAIL_REQUEST_RATE_LIMIT,
			},
		],
	} satisfies BetterAuthPlugin;
}
