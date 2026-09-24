/**
 * `/oauth/consent` — approve or decline an app connecting to your GavelUp
 * account (#843 / ADR-0027).
 *
 * The OAuth provider sends a signed-in person here with a SIGNED copy of the
 * authorize request (`#/lib/oauth-continuation` has the shape). The page shows
 * who is asking and posts the decision to Better Auth's `/oauth2/consent`,
 * which owns the redirect back to the app on approval.
 *
 * Things this page must not do, each the obvious implementation:
 *
 * - **Add to or rewrite its search.** `validateSearch` passes the parsed search
 *   through untouched, because a changed search makes the server 307 to a
 *   re-serialised URL and the provider's signature then fails. The query that
 *   is POSTED is read off `window.location`, never rebuilt.
 * - **Render a client name from the query.** The name is looked up server-side
 *   by id (`#/server/oauth-consent-logic`); a name in a URL is a spoofing
 *   surface on the one screen where a spoof matters.
 * - **Approve as someone other than the account it shows.** The POST carries
 *   the displayed user's id and `src/lib/auth.ts` refuses a mismatch
 *   (`#/lib/oauth-consent-binding`).
 * - **Bounce a decline back to the app on its own.** It says, in place, that
 *   this request was not approved, and OFFERS the provider's `access_denied`
 *   redirect as a link so the app can stop waiting. Not a redirect to `/me`,
 *   which is what #843 first proposed: `_authed` replaces `/me` with its "not
 *   in a club yet" gate for an account with no membership.
 * - **Claim more than it knows.** A decline does not revoke an earlier
 *   approval, and an approval whose response was lost may have gone through;
 *   the copy for both says so rather than "nothing was connected".
 * - **Be framed.** One-click Approve is a clickjacking target, so the document
 *   is served with `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
 * - **Offer Approve to someone who may not approve.** Connecting is for club
 *   officers for now (#852, `mayUseConnector`). The loader says so up front
 *   (`eligible`), and the consent hook in `src/lib/auth.ts` refuses the POST
 *   with `not_an_officer` whatever this page shows; both land on the same
 *   Decline-only card.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import {
	assignLocation,
	reloadLocation,
	replaceLocation,
} from "#/lib/browser-location";
import { NOT_AN_OFFICER } from "#/lib/oauth-connector-clients";
import {
	CONSENT_ACCOUNT_CHANGED,
	CONSENT_ACCOUNT_FIELD,
} from "#/lib/oauth-consent-binding";
import {
	oauthAuthorizeContinuation,
	oauthQueryFromLocation,
	parseConsentQuery,
} from "#/lib/oauth-continuation";
import { AUTH_BASE_PATH } from "#/lib/well-known-forward";
import { signInHref } from "#/lib/write-proof";
import { getOAuthConsentClient } from "#/server/oauth-consent";

/**
 * The keys the page reads. DECLARED narrowly — an index signature here leaks
 * into the router's global search union and breaks unrelated `search`
 * reducers — but the value returned is the parsed search object itself, every
 * key intact, so the server has nothing to rewrite.
 */
interface ConsentSearch {
	client_id?: unknown;
	sig?: unknown;
	scope?: unknown;
}

export const Route = createFileRoute("/oauth/consent")({
	validateSearch: (search: Record<string, unknown>): ConsentSearch => search,
	// Served on the document itself; see "Be framed" above.
	headers: () => ({
		"X-Frame-Options": "DENY",
		"Content-Security-Policy": "frame-ancestors 'none'",
	}),
	loaderDeps: ({ search }) => ({ query: parseConsentQuery(search) }),
	loader: async ({ deps }) => {
		if (!deps.query.ok) return { query: deps.query, lookup: null };
		const lookup = await getOAuthConsentClient({
			data: { clientId: deps.query.clientId },
		});
		return { query: deps.query, lookup };
	},
	component: OAuthConsent,
});

/** Better Auth's consent endpoint, which owns the grant and the redirect. */
const CONSENT_ENDPOINT = `${AUTH_BASE_PATH}/oauth2/consent`;

/** What the not-an-officer card says, whichever way the page learned it. */
const NOT_AN_OFFICER_PAGE_MESSAGE =
	"Only club officers can connect apps to GavelUp right now.";

/** Where the page ends up after a decision it could not simply redirect on. */
type Outcome =
	| { kind: "declined"; returnUrl: string | null }
	| { kind: "uncertain" }
	| { kind: "account-changed" };

function OAuthConsent() {
	const { query, lookup } = Route.useLoaderData();
	const [busy, setBusy] = useState<"accept" | "deny" | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [error, setError] = useState<string | null>(null);
	// The server refused an approval as not-an-officer: the loader's answer was
	// stale (an office ended since the page loaded), so show what it now says.
	const [refusedAsNonOfficer, setRefusedAsNonOfficer] = useState(false);

	const signedOut = lookup !== null && !lookup.signedIn;
	useEffect(() => {
		// Signed out on a consent screen: sign in, then REPLAY the authorize
		// request rather than returning to this exact URL. Authorize lands a
		// signed-in person back on consent with a freshly signed query, so this
		// also survives the ten-minute expiry on this one — which a magic link
		// opened later, or on another device, would otherwise hit.
		if (signedOut) {
			const continuation = oauthAuthorizeContinuation(window.location.search);
			replaceLocation(
				signInHref(
					continuation ?? window.location.pathname + window.location.search,
				),
			);
		}
	}, [signedOut]);

	async function decide(accept: boolean, expectedUserId: string) {
		setBusy(accept ? "accept" : "deny");
		setError(null);
		let response: Response;
		try {
			response = await fetch(CONSENT_ENDPOINT, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					accept,
					oauth_query: oauthQueryFromLocation(window.location.search),
					[CONSENT_ACCOUNT_FIELD]: expectedUserId,
				}),
			});
		} catch {
			// No answer at all. A decline writes nothing, so it is still a
			// decline. An approval may have been recorded before the connection
			// dropped — and a Decline pressed now would not undo it — so the page
			// says it does not know, and stops offering either button.
			setOutcome(
				accept ? { kind: "uncertain" } : { kind: "declined", returnUrl: null },
			);
			return;
		}
		const body = (await response.json().catch(() => null)) as {
			url?: string;
			redirect_uri?: string;
			error?: string;
		} | null;
		if (body?.error === CONSENT_ACCOUNT_CHANGED) {
			setOutcome({ kind: "account-changed" });
			return;
		}
		if (accept && body?.error === NOT_AN_OFFICER) {
			// A 403 the hook raises before the provider writes anything, so
			// Decline is still meaningful and still offered.
			setRefusedAsNonOfficer(true);
			setBusy(null);
			return;
		}
		const next = body?.url ?? body?.redirect_uri ?? null;
		if (!accept) {
			setOutcome({ kind: "declined", returnUrl: response.ok ? next : null });
			return;
		}
		if ((response.ok && !next) || response.status >= 500) {
			// Two ways an approval can be recorded without the page learning so.
			// The provider said yes and the body saying where to go next was lost
			// or unreadable (the connection dropping after the headers is
			// enough). Or it failed server-side AFTER writing consent: the pinned
			// provider stores `oauth_consent` before it creates the code, with no
			// transaction around the two (reproduced in review). Either is the
			// same "we don't know" as no answer at all. Only a 4xx is a refusal
			// known to precede the write.
			setOutcome({ kind: "uncertain" });
			return;
		}
		if (!response.ok || !next) {
			// Refused outright, so nothing was recorded and trying again, or
			// declining, is safe.
			setError(consentErrorMessage(response.status, body?.error));
			setBusy(null);
			return;
		}
		assignLocation(next);
	}

	if (outcome) return <OutcomeCard outcome={outcome} />;

	if (!query.ok) {
		return (
			<ConsentShell title="This link doesn't work">
				<CardContent className="space-y-2 text-sm text-muted-foreground">
					<p>Go back to the app and choose Connect again.</p>
					<p>
						This link is missing the details GavelUp needs to know which app is
						asking, so there's nothing to approve here.
					</p>
				</CardContent>
			</ConsentShell>
		);
	}

	if (signedOut || !lookup || !lookup.signedIn) {
		return (
			<ConsentShell title="Taking you to sign in…">
				<CardContent className="text-sm text-muted-foreground">
					You need to be signed in to approve a connection.
				</CardContent>
			</ConsentShell>
		);
	}

	const identified = lookup.client !== null;
	const appName = lookup.client?.name ?? null;
	const userId = lookup.userId;
	if (!lookup.eligible || refusedAsNonOfficer) {
		return (
			<ConsentShell
				title={appName ? `Connect ${appName}?` : "Connect an app?"}
				description={`Signed in as ${lookup.email}.`}
			>
				<CardContent className="space-y-3 text-sm">
					<p role="alert">{NOT_AN_OFFICER_PAGE_MESSAGE}</p>
					<p className="text-muted-foreground">
						Decline to let {appName ?? "the app"} know it wasn't connected.
					</p>
				</CardContent>
				<CardFooter className="flex flex-col gap-2 sm:flex-row-reverse">
					<Button
						className="w-full sm:w-auto"
						disabled={busy !== null}
						onClick={() => void decide(false, userId)}
					>
						{busy === "deny" ? "Declining…" : "Decline"}
					</Button>
				</CardFooter>
			</ConsentShell>
		);
	}
	return (
		<ConsentShell
			title={appName ? `Connect ${appName}?` : "Connect an app?"}
			description={`Signed in as ${lookup.email}.`}
		>
			<CardContent className="space-y-3 text-sm">
				{identified ? null : (
					<p className="text-destructive" role="alert">
						GavelUp couldn't identify this app. Its id is{" "}
						<code className="break-all">{query.clientId}</code>. Only approve if
						you started this connection yourself just now.
					</p>
				)}
				<p>
					{appName ?? "This app"} will be able to act as you in every club where
					you're an admin or officer: read agendas, members and guests, and make
					changes such as assigning roles or adding meetings.
				</p>
				<p>
					Some of those changes happen as soon as the app makes them, so only
					approve an app you'd trust with your officer access. It can't do
					anything you can't already do yourself.
				</p>
				{error ? (
					<p className="text-destructive" role="alert">
						{error}
					</p>
				) : null}
			</CardContent>
			{/* An app GavelUp could not identify gets Decline as the primary
			    action: the visual weight should not steer toward approving it. */}
			<CardFooter
				className={
					identified
						? "flex flex-col gap-2 sm:flex-row-reverse"
						: "flex flex-col-reverse gap-2 sm:flex-row"
				}
			>
				<Button
					variant={identified ? "default" : "outline"}
					className="w-full sm:w-auto"
					disabled={busy !== null}
					onClick={() => void decide(true, userId)}
				>
					{busy === "accept" ? "Connecting…" : "Approve"}
				</Button>
				<Button
					variant={identified ? "outline" : "default"}
					className="w-full sm:w-auto"
					disabled={busy !== null}
					onClick={() => void decide(false, userId)}
				>
					{busy === "deny" ? "Declining…" : "Decline"}
				</Button>
			</CardFooter>
		</ConsentShell>
	);
}

/** The card for a decision the page settled in place rather than by redirect. */
function OutcomeCard({ outcome }: { outcome: Outcome }) {
	if (outcome.kind === "uncertain") {
		return (
			<ConsentShell title="We couldn't confirm the connection" live>
				<CardContent className="space-y-2 text-sm text-muted-foreground">
					<p>
						The connection dropped before GavelUp answered, so the approval may
						or may not have gone through.
					</p>
					<p>
						Go back to the app and check. If it isn't connected, choose Connect
						again.
					</p>
				</CardContent>
			</ConsentShell>
		);
	}
	if (outcome.kind === "account-changed") {
		return (
			<ConsentShell title="You're signed in as someone else now" live>
				<CardContent className="space-y-2 text-sm text-muted-foreground">
					<p>
						This page was opened for a different GavelUp account than the one
						signed in now, so nothing was approved.
					</p>
					<p>
						Reload the page to review the request as the account you're using.
					</p>
				</CardContent>
				<CardFooter>
					<Button
						variant="outline"
						className="w-full sm:w-auto"
						onClick={reloadLocation}
					>
						Reload
					</Button>
				</CardFooter>
			</ConsentShell>
		);
	}
	return (
		<ConsentShell title="Request declined" live>
			<CardContent className="space-y-2 text-sm text-muted-foreground">
				<p>You declined, so this request wasn't approved.</p>
				<p>
					If you had already connected this app before, declining now doesn't
					disconnect it.
				</p>
			</CardContent>
			<CardFooter className="flex flex-col gap-2 sm:flex-row">
				{outcome.returnUrl ? (
					// The provider's `access_denied` redirect, offered rather than
					// followed: it tells the app to stop waiting.
					<Button asChild className="w-full sm:w-auto">
						<a href={outcome.returnUrl}>Return to the app</a>
					</Button>
				) : null}
				<Button asChild variant="outline" className="w-full sm:w-auto">
					<Link to="/">Go to GavelUp</Link>
				</Button>
			</CardFooter>
		</ConsentShell>
	);
}

/**
 * Plain words for the provider's consent refusals. The signed query expires
 * ten minutes after it is issued, so "start again" is the answer to most of
 * them — including the cross-device case, where the magic link is opened long
 * after the prompt was.
 */
function consentErrorMessage(status: number, code: string | undefined): string {
	if (status === 401) {
		return "You've been signed out. Sign in again, then start connecting again from the app.";
	}
	if (code === "invalid_signature" || code === "invalid_request") {
		return "This approval link has expired or was changed. Start connecting again from the app.";
	}
	return "GavelUp couldn't complete the connection. Start connecting again from the app.";
}

function ConsentShell({
	title,
	description,
	live = false,
	children,
}: {
	title: string;
	description?: string;
	/** Announce the card: it replaced the one whose button had focus. */
	live?: boolean;
	children: React.ReactNode;
}) {
	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
			<BrandMark />
			<Card
				className="w-full max-w-sm"
				{...(live ? { role: "status", "aria-live": "polite" as const } : {})}
			>
				<CardHeader>
					<CardTitle className="font-display text-xl">
						<h1>{title}</h1>
					</CardTitle>
					{description ? (
						<CardDescription>{description}</CardDescription>
					) : null}
				</CardHeader>
				{children}
			</Card>
		</main>
	);
}
