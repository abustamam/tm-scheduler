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
	oauthAuthorizeContinuation,
	oauthQueryFromLocation,
	parseConsentQuery,
} from "#/lib/oauth-continuation";
import { AUTH_BASE_PATH } from "#/lib/well-known-forward";
import { signInHref } from "#/lib/write-proof";
import { getOAuthConsentClient } from "#/server/oauth-consent";

/**
 * `/oauth/consent` — approve or decline an app connecting to your GavelUp
 * account (#843 / ADR-0027).
 *
 * The OAuth provider sends a signed-in person here with a SIGNED copy of the
 * authorize request (`#/lib/oauth-continuation` has the shape). The page shows
 * who is asking and posts the decision to Better Auth's `/oauth2/consent`,
 * which owns the redirect back to the app on approval.
 *
 * Three things this page must not do, each the obvious implementation:
 *
 * - **Add to or rewrite its search.** `validateSearch` passes the parsed search
 *   through untouched, because a changed search makes the server 307 to a
 *   re-serialised URL and the provider's signature then fails. The query that
 *   is POSTED is read off `window.location`, never rebuilt.
 * - **Render a client name from the query.** The name is looked up server-side
 *   by id (`#/server/oauth-consent-logic`); a name in a URL is a spoofing
 *   surface on the one screen where a spoof matters.
 * - **Bounce a decline back to the app.** Better Auth answers a decline with
 *   the app's redirect URI and an `access_denied` error; this page stays put
 *   and says, in place, that nothing was connected. Not a redirect to `/me`,
 *   which is what #843 first proposed: `_authed` replaces `/me` with its "not
 *   in a club yet" gate for an account with no membership, so the one sentence
 *   that matters would never render for exactly the person least likely to
 *   know what they just declined.
 */
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

function OAuthConsent() {
	const { query, lookup } = Route.useLoaderData();
	const [busy, setBusy] = useState<"accept" | "deny" | null>(null);
	const [declined, setDeclined] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const signedOut = lookup !== null && !lookup.signedIn;
	useEffect(() => {
		// Signed out on a consent screen: sign in, then REPLAY the authorize
		// request rather than returning to this exact URL. Authorize lands a
		// signed-in person back on consent with a freshly signed query, so this
		// also survives the ten-minute expiry on this one — which a magic link
		// opened later, or on another device, would otherwise hit.
		if (signedOut) {
			const continuation = oauthAuthorizeContinuation(window.location.search);
			window.location.replace(
				signInHref(
					continuation ?? window.location.pathname + window.location.search,
				),
			);
		}
	}, [signedOut]);

	async function decide(accept: boolean) {
		setBusy(accept ? "accept" : "deny");
		setError(null);
		try {
			const response = await fetch(CONSENT_ENDPOINT, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					accept,
					oauth_query: oauthQueryFromLocation(window.location.search),
				}),
			});
			if (!accept) {
				// A decline writes nothing either way, so whether the provider
				// answered is not the person's problem: they asked for nothing to
				// be connected, and nothing was.
				setDeclined(true);
				return;
			}
			const body = (await response.json().catch(() => null)) as {
				url?: string;
				redirect_uri?: string;
				error?: string;
				error_description?: string;
			} | null;
			const next = body?.url ?? body?.redirect_uri;
			if (!response.ok || !next) {
				setError(consentErrorMessage(body?.error));
				setBusy(null);
				return;
			}
			window.location.assign(next);
		} catch {
			if (!accept) {
				setDeclined(true);
				return;
			}
			setError(
				"We couldn't reach GavelUp. Check your connection and try again.",
			);
			setBusy(null);
		}
	}

	if (declined) {
		return (
			<ConsentShell title="Nothing was connected">
				<CardContent className="space-y-2 text-sm text-muted-foreground">
					<p>
						You declined, so no app was given access to your GavelUp account.
						You can close this tab.
					</p>
				</CardContent>
				<CardFooter>
					<Button asChild variant="outline" className="w-full sm:w-auto">
						<Link to="/">Go to GavelUp</Link>
					</Button>
				</CardFooter>
			</ConsentShell>
		);
	}

	if (!query.ok) {
		return (
			<ConsentShell title="This link doesn't work">
				<CardContent className="space-y-2 text-sm text-muted-foreground">
					<p>
						It's missing the details GavelUp needs to know which app is asking,
						so there's nothing to approve here.
					</p>
					<p>
						Start connecting again from the app. If you opened a sign-in link on
						another device, finish there — this page won't pick it up.
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

	const appName = lookup.client?.name ?? null;
	return (
		<ConsentShell
			title={appName ? `Connect ${appName}?` : "Connect an app?"}
			description={`Signed in as ${lookup.email}.`}
		>
			<CardContent className="space-y-3 text-sm">
				{lookup.client ? null : (
					<p className="text-destructive" role="alert">
						GavelUp couldn't identify this app. Its id is{" "}
						<code className="break-all">{query.clientId}</code>. Only approve if
						you started this connection yourself just now.
					</p>
				)}
				<p>
					{appName ?? "This app"} will be able to act as you in every club where
					you're an admin or officer: read agendas, members and guests, and make
					changes. It will ask you to confirm each change before it happens.
				</p>
				<p className="text-muted-foreground">
					It can't do anything you can't already do yourself.
				</p>
				{error ? (
					<p className="text-destructive" role="alert">
						{error}
					</p>
				) : null}
			</CardContent>
			<CardFooter className="flex flex-col gap-2 sm:flex-row-reverse">
				<Button
					className="w-full sm:w-auto"
					disabled={busy !== null}
					onClick={() => void decide(true)}
				>
					{busy === "accept" ? "Connecting…" : "Approve"}
				</Button>
				<Button
					variant="outline"
					className="w-full sm:w-auto"
					disabled={busy !== null}
					onClick={() => void decide(false)}
				>
					{busy === "deny" ? "Declining…" : "Decline"}
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
function consentErrorMessage(code: string | undefined): string {
	if (code === "invalid_signature" || code === "invalid_request") {
		return "This approval link has expired or was changed. Start connecting again from the app.";
	}
	return "GavelUp couldn't complete the connection. Start connecting again from the app.";
}

function ConsentShell({
	title,
	description,
	children,
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
}) {
	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
			<BrandMark />
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="font-display text-xl">{title}</CardTitle>
					{description ? (
						<CardDescription>{description}</CardDescription>
					) : null}
				</CardHeader>
				{children}
			</Card>
		</main>
	);
}
