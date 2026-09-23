import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { magicLinkCallbackURL } from "#/lib/magic-link-callback";
import {
	isOAuthAuthorizeTarget,
	isSignedOAuthQuery,
	isSignedOAuthSearch,
	oauthAuthorizeContinuation,
} from "#/lib/oauth-continuation";
import { safeRedirect } from "#/lib/write-proof";

export const Route = createFileRoute("/signin")({
	// Default post-sign-in landing is the Officer home (#202); it redirects
	// non-officers straight to their dashboard (#542), the member home.
	//
	// `redirect` goes straight to Better-Auth as `callbackURL` below, so it must
	// be a path on THIS origin. #761 makes every write refusal in the product
	// link here with a redirect, which is what turns an unvalidated forward into
	// a one-click open redirector carrying a freshly-minted session.
	//
	// TWO lines, in this order. `safeRedirect` (`#/lib/write-proof`, tested in
	// `write-proof.test.ts`) is the first; Better-Auth's own `callbackURL`
	// allowlist is the second, and it is a real one — it rejected all five of the
	// control-character payloads that got past this route's ORIGINAL prefix check
	// on 1.6.22 (measured during #761's review), which is why none of them was
	// ever reachable. Do not read that as "the route's check is decorative": it
	// is a dependency's behaviour on a pinned version, not a contract, and this
	// route is the half this repo owns.
	//
	// An OAuth prompt from the provider (#843) gets NO `redirect` added. Adding
	// one makes the server 307 to a re-serialised URL, which mangles the
	// provider's signed query (`#/lib/oauth-continuation` has the measurement);
	// the component builds the continuation from the untouched URL instead. The
	// parsed search is enough to say WHICH kind of visit this is, and not
	// enough to rebuild the query.
	validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
		isSignedOAuthSearch(search)
			? {}
			: { redirect: safeRedirect(search.redirect) },
	component: SignIn,
});

function SignIn() {
	const search = Route.useSearch();
	const router = useRouter();
	// Copy only, so it is read after hydration: SSR has no `window`, and the
	// value that matters is recomputed from the live URL at submit.
	const [connecting, setConnecting] = useState(false);
	useEffect(() => {
		setConnecting(
			isSignedOAuthQuery(window.location.search) ||
				isOAuthAuthorizeTarget(search.redirect),
		);
	}, [search.redirect]);
	const [email, setEmail] = useState("");
	const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setStatus("sending");
		setError(null);
		// Where the magic link lands. For an OAuth prompt that is the authorize
		// request replayed — so the flow resumes in whichever browser opens the
		// link — and it goes through `safeRedirect` like any other target.
		const continuation = oauthAuthorizeContinuation(window.location.search);
		const redirect =
			search.redirect ??
			(continuation ? safeRedirect(continuation) : safeRedirect(undefined));
		// Escaped for Better Auth's double decode, or a signed OAuth query
		// arrives with its `%2B`s turned into spaces (`#/lib/magic-link-callback`).
		const { error } = await authClient.signIn.magicLink({
			email,
			callbackURL: magicLinkCallbackURL(redirect),
		});
		if (error) {
			setStatus("error");
			setError(error.message ?? "Something went wrong. Please try again.");
			return;
		}
		setStatus("sent");
		void router.invalidate();
	}

	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
			<BrandMark />
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="font-display text-xl">Sign in</CardTitle>
					<CardDescription>
						{connecting
							? "An app is asking to connect to your GavelUp account. Sign in first, and you'll be asked to approve it next."
							: "Enter your email and we'll send you a magic link to sign in. No password needed."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{status === "sent" ? (
						<div className="space-y-2 text-sm">
							<p className="font-medium">Check your email</p>
							<p className="text-muted-foreground">
								We sent a sign-in link to{" "}
								<span className="font-medium text-foreground">{email}</span>.
								{connecting
									? " Open it and you'll be asked to approve the connection."
									: " Open it on this device to finish signing in."}
							</p>
							{connecting ? (
								<p className="text-muted-foreground">
									If the link opens on another device, finish there. This page
									won't move on by itself.
								</p>
							) : null}
							{import.meta.env.DEV ? (
								<p className="text-muted-foreground">
									(Dev: the link is printed in the server console.)
								</p>
							) : null}
						</div>
					) : (
						<form onSubmit={onSubmit} className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="email">Email</Label>
								<Input
									id="email"
									type="email"
									inputMode="email"
									autoComplete="email"
									required
									placeholder="you@example.com"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
								/>
							</div>
							{error ? (
								<p className="text-sm text-destructive" role="alert">
									{error}
								</p>
							) : null}
							<Button
								type="submit"
								className="w-full"
								disabled={status === "sending"}
							>
								{status === "sending" ? "Sending…" : "Send magic link"}
							</Button>
						</form>
					)}
				</CardContent>
			</Card>
			<p className="w-full max-w-sm text-center text-xs text-muted-foreground">
				Just signing up for a meeting role? No account needed — open your
				club&apos;s sign-up link and pick your name.
			</p>
			<p className="w-full max-w-sm text-center text-[11px] leading-relaxed text-muted-foreground/80">
				{TOASTMASTERS_DISCLAIMER}
			</p>
		</main>
	);
}
