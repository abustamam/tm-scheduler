import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, Info } from "lucide-react";
import { z } from "zod";
import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { finishAccountClaim } from "#/server/account-invite";

// The post-sign-in landing that finishes binding a picked Person to the account
// (#266). Reached via the magic-link `callbackURL` of both an admin invite and
// the public "This is me" claim. The session cookie is already set by the
// magic-link verify redirect, so the loader runs authenticated; if not, the
// finish server fn rejects and we fall back to a sign-in prompt.

const personParam = z.string().uuid();

type ClaimView =
	| "linked"
	| "already_yours"
	| "already_other"
	| "email_mismatch"
	| "needs_invite"
	| "roster_conflict"
	| "not_found"
	| "needs_signin";

export const Route = createFileRoute("/claim")({
	validateSearch: (search: Record<string, unknown>) => {
		const parsed = personParam.safeParse(search.person);
		return { person: parsed.success ? parsed.data : null };
	},
	loaderDeps: ({ search }) => ({ person: search.person }),
	loader: async ({ deps }): Promise<{ view: ClaimView }> => {
		if (!deps.person) return { view: "not_found" };
		try {
			const res = await finishAccountClaim({ data: { memberId: deps.person } });
			return { view: res.outcome };
		} catch {
			// requireUser threw (no session) — the magic link wasn't completed here.
			return { view: "needs_signin" };
		}
	},
	component: ClaimResult,
});

const COPY: Record<
	ClaimView,
	{ title: string; body: string; success: boolean }
> = {
	linked: {
		title: "You're all set",
		body: "Your account is now linked to your club profile — your roles and speech history will follow you.",
		success: true,
	},
	already_yours: {
		title: "Already linked",
		body: "This profile is already connected to your account. You're good to go.",
		success: true,
	},
	already_other: {
		title: "Already claimed",
		body: "This name is already linked to a different account. If that's not right, ask a club officer for help.",
		success: false,
	},
	email_mismatch: {
		title: "Couldn't attach this name",
		body: "We couldn't automatically attach this name to your account — the email on file doesn't match. You're signed in; ask a club officer to send you an invite to the right address.",
		success: false,
	},
	needs_invite: {
		title: "Ask for an invite",
		body: "This name doesn't have an email on file yet, so it can't be claimed here. Ask a club officer to add your email to the roster and send you an invite — that link will attach it to your account.",
		success: false,
	},
	roster_conflict: {
		// Three different obstacles land here and only one of them is fixable by a
		// club officer, so the copy must not promise that it is. An earlier cut
		// said an officer could "get you set up directly" — false, the only
		// person-level repair is superadmin-gated — and the cut before that told
		// this group to ask for an invite, which fails identically and sends them
		// round the loop again. So: name the state, give the one step that is
		// always safe to take, and do not invent a remedy.
		title: "We can't attach this name yet",
		body: "Your email checks out, but this club's records need a change before an account can be attached to your name. Your club officers have been given the details — ask them, and if they can't resolve it they can get in touch with GavelUp.",
		success: false,
	},
	not_found: {
		title: "Link expired",
		body: "This claim link is no longer valid. You can still sign in and pick your name again.",
		success: false,
	},
	needs_signin: {
		title: "One more step",
		body: "Sign in with the email your link was sent to, then reopen the link to finish.",
		success: false,
	},
};

function ClaimResult() {
	const { view } = Route.useLoaderData();
	const copy = COPY[view];

	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
			<BrandMark />
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="flex items-center gap-2 font-display text-xl">
						{copy.success ? (
							<CheckCircle2 className="size-5 text-success" aria-hidden />
						) : (
							<Info className="size-5 text-muted-foreground" aria-hidden />
						)}
						{copy.title}
					</CardTitle>
					<CardDescription>{copy.body}</CardDescription>
				</CardHeader>
				<CardContent>
					{view === "needs_signin" ? (
						<Button asChild className="w-full">
							<Link to="/signin" search={{ redirect: "/" }}>
								Go to sign in
							</Link>
						</Button>
					) : (
						<Button asChild className="w-full">
							<Link to="/">Continue</Link>
						</Button>
					)}
				</CardContent>
			</Card>
		</main>
	);
}
