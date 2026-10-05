/**
 * A member changes their own sign-in address (#1091, ADR-0030), as a small
 * Better Auth plugin: three endpoints under `/api/auth`, and nothing else.
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
 *    Better Auth's public `/send-verification-email` sender;
 *  - its verify is a GET that changes the address, which a mail scanner that
 *    prefetches links would trigger.
 *
 * Why a plugin rather than a server fn: the request path goes through Better
 * Auth's own rate limiter (decision 7) and its origin check, and signs its link
 * with the auth secret.
 *
 * The three endpoints:
 *  - `POST /member-email/request` (session): mint and send the link.
 *  - `GET /member-email/confirm?token=` : a PAGE naming the new address, with
 *    one button. It changes NOTHING, so a link scanner's prefetch is harmless.
 *  - `POST /member-email/apply` (form, `token`): the button. Trusted origins
 *    only (the auth instance's `trustedOrigins`), checked here whether or not
 *    a cookie came with it. The only path that runs `confirmEmailChange`.
 *
 * The link is a one-hour HS256 JWT naming `{userId, from, to, generation}` and
 * a `purpose` no other token signed with this secret carries. Requesting again
 * does not cancel an earlier link; once ANY change lands, the account's change
 * generation moves on and every link minted before it is dead
 * (`confirmEmailChange`).
 *
 * All the DB work is `#/server/account-email-change-logic`.
 */
import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	sessionMiddleware,
} from "better-auth/api";
import { signJWT, verifyJWT } from "better-auth/crypto";
import * as z from "zod";
import { escapeHtml } from "#/lib/html-escape";
import {
	EMAIL_CHANGE_LINK_LIFETIME_SECONDS,
	EMAIL_CHANGE_REQUEST_WINDOW_SECONDS,
	EMAIL_CHANGE_REQUESTS_PER_WINDOW,
	type EmailChangeOutcome,
	MEMBER_EMAIL_APPLY_PATH,
	MEMBER_EMAIL_CONFIRM_PATH,
	MEMBER_EMAIL_REQUEST_PATH,
	NEEDS_MERGE_MESSAGE,
	RATE_LIMITED_MESSAGE,
} from "#/lib/member-email-change";
import {
	confirmEmailChange,
	type EmailChangeClaim,
	requestEmailChange,
} from "#/server/account-email-change-logic";

/** Per client address, through Better Auth's limiter (decision 7). The
 *  per-ACCOUNT cap is `takeEmailChangeRequestSlot`, because this limiter keys
 *  on address and path only. */
export const MEMBER_EMAIL_REQUEST_RATE_LIMIT = {
	window: EMAIL_CHANGE_REQUEST_WINDOW_SECONDS,
	max: EMAIL_CHANGE_REQUESTS_PER_WINDOW,
};

export const UNBOUND_MESSAGE =
	"Your account isn't linked to a club member, so there is no address to change here. Sign in with the other address instead.";

const TOKEN_PURPOSE = "gavelup-member-email-change";

const claimSchema = z.object({
	purpose: z.literal(TOKEN_PURPOSE),
	userId: z.string().min(1),
	from: z.string().min(1),
	to: z.string().min(1),
	generation: z.number().int().nonnegative(),
});

/** Sign a change claim into the confirm link's token. */
export async function signEmailChangeToken(
	claim: EmailChangeClaim,
	secret: string,
	expiresIn: number = EMAIL_CHANGE_LINK_LIFETIME_SECONDS,
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
	const { userId, from, to, generation } = parsed.data;
	return { userId, from, to, generation };
}

/** Where an applied link lands: Account settings, with the outcome. */
export function confirmRedirect(outcome: EmailChangeOutcome): string {
	return `/account?emailChange=${encodeURIComponent(outcome)}`;
}

/** Headers for the confirm page: never cached, never framed. */
const PAGE_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
	"content-security-policy":
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	"x-frame-options": "DENY",
	"referrer-policy": "same-origin",
};

/**
 * The confirm page. Every interpolated value is escaped. The GET renders it
 * only for a token that has already VERIFIED (signature, purpose, expiry), so
 * a forged token never reaches this markup; but the address inside a genuine
 * one came from a member's typing, and escaping every value is the rule
 * whatever its source.
 */
export function confirmPageHtml(input: {
	applyUrl: string;
	token: string;
	to: string;
}): string {
	const to = escapeHtml(input.to);
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Confirm your new sign-in address · GavelUp</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <main style="max-width:480px;margin:0 auto;padding:32px 16px;">
      <h1 style="font-size:20px;color:#18181b;margin:0 0 16px;">Confirm your new sign-in address</h1>
      <p style="font-size:15px;line-height:1.5;color:#3f3f46;margin:0 0 24px;word-break:break-all;">
        Change your GavelUp sign-in address to <strong>${to}</strong>?
      </p>
      <form method="post" action="${escapeHtml(input.applyUrl)}">
        <input type="hidden" name="token" value="${escapeHtml(input.token)}" />
        <button type="submit" style="background:#18181b;color:#ffffff;border:0;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px;cursor:pointer;">
          Confirm this address
        </button>
      </form>
      <p style="font-size:13px;line-height:1.5;color:#a1a1aa;margin:24px 0 0;">
        If you didn't ask for this, close this page. Nothing changes until you confirm.
      </p>
    </main>
  </body>
</html>`;
}

/**
 * Trusted origins only (the auth instance's `trustedOrigins`), cookie or not.
 * Better Auth's global check validates the
 * Origin only when a cookie comes with the request, and this POST is meant to
 * work from a phone with no session — so it checks for itself: an Origin that
 * is one of the auth instance's trusted origins, or refused.
 */
const trustedOriginOnly = createAuthMiddleware(async (ctx) => {
	const origin = ctx.request?.headers.get("origin") ?? null;
	if (
		!origin ||
		origin === "null" ||
		!ctx.context.isTrustedOrigin(origin, { allowRelativePaths: false })
	) {
		throw new APIError("FORBIDDEN", { message: "Invalid origin" });
	}
});

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
						case "needs_merge":
							throw new APIError("CONFLICT", { message: NEEDS_MERGE_MESSAGE });
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
			// GET: a page, never a write (#1091 review, F2).
			showMemberEmailConfirm: createAuthEndpoint(
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
					return new Response(
						confirmPageHtml({
							applyUrl: `${ctx.context.baseURL}${MEMBER_EMAIL_APPLY_PATH}`,
							token: ctx.query.token,
							to: claim.to,
						}),
						{ status: 200, headers: PAGE_HEADERS },
					);
				},
			),
			// POST: the page's button, and the only writer.
			applyMemberEmailChange: createAuthEndpoint(
				MEMBER_EMAIL_APPLY_PATH,
				{
					method: "POST",
					body: z.object({ token: z.string().max(4096) }),
					use: [trustedOriginOnly],
					// A plain HTML form posts urlencoded; Better Auth's router
					// accepts only JSON unless an endpoint says otherwise.
					metadata: {
						allowedMediaTypes: ["application/x-www-form-urlencoded"],
					},
				},
				async (ctx) => {
					const claim = await readEmailChangeToken(
						ctx.body.token,
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
