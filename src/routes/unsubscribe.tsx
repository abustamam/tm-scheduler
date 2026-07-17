import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, XCircle } from "lucide-react";
import { BrandMark } from "#/components/brand-mark";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { unsubscribeFromReminders } from "#/server/notification-prefs";

// Public, no-auth one-click unsubscribe (#274). The link in every reminder email
// points here with a signed token; the loader redeems it server-side (the server
// fn verifies the HMAC and flips the person's opt-out) and this page confirms.
export const Route = createFileRoute("/unsubscribe")({
	validateSearch: (search: Record<string, unknown>) => ({
		token: typeof search.token === "string" ? search.token : "",
	}),
	loaderDeps: ({ search: { token } }) => ({ token }),
	loader: async ({ deps: { token } }) => {
		if (!token) return { ok: false as const };
		return unsubscribeFromReminders({ data: token });
	},
	component: Unsubscribe,
});

function Unsubscribe() {
	const { ok } = Route.useLoaderData();

	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
			<BrandMark />
			<Card className="w-full max-w-sm">
				<CardHeader>
					<div className="flex items-center gap-2">
						{ok ? (
							<CheckCircle2
								className="size-5 text-[var(--success)]"
								aria-hidden
							/>
						) : (
							<XCircle className="size-5 text-destructive" aria-hidden />
						)}
						<CardTitle className="font-display text-xl">
							{ok ? "You're unsubscribed" : "Link not valid"}
						</CardTitle>
					</div>
					<CardDescription>
						{ok
							? "You won't receive reminder emails about your meeting roles anymore."
							: "This unsubscribe link is invalid or has expired. Nothing was changed."}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3 text-sm text-muted-foreground">
					{ok ? (
						<p>
							Changed your mind? You can turn reminders back on any time from{" "}
							<Link to="/me" className="font-medium text-primary underline">
								your roles page
							</Link>{" "}
							after signing in.
						</p>
					) : (
						<p>
							If you meant to unsubscribe, open the link straight from your
							reminder email, or manage reminders from{" "}
							<Link to="/me" className="font-medium text-primary underline">
								your roles page
							</Link>{" "}
							after signing in.
						</p>
					)}
				</CardContent>
			</Card>
			<p className="w-full max-w-sm text-center text-[11px] leading-relaxed text-muted-foreground/80">
				{TOASTMASTERS_DISCLAIMER}
			</p>
		</main>
	);
}
