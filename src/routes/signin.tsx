import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
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

export const Route = createFileRoute("/signin")({
	// Default post-sign-in landing is the Officer home (#202); it redirects
	// non-officers straight to the roster, so members still land on "/".
	validateSearch: (search: Record<string, unknown>) => ({
		redirect:
			typeof search.redirect === "string" ? search.redirect : "/officers",
	}),
	component: SignIn,
});

function SignIn() {
	const { redirect } = Route.useSearch();
	const router = useRouter();
	const [email, setEmail] = useState("");
	const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setStatus("sending");
		setError(null);
		const { error } = await authClient.signIn.magicLink({
			email,
			callbackURL: redirect,
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
		<main className="flex min-h-svh items-center justify-center p-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>Sign in</CardTitle>
					<CardDescription>
						Enter your email and we&apos;ll send you a magic link to sign in. No
						password needed.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{status === "sent" ? (
						<div className="space-y-2 text-sm">
							<p className="font-medium">Check your email</p>
							<p className="text-muted-foreground">
								We sent a sign-in link to{" "}
								<span className="font-medium text-foreground">{email}</span>.
								Open it on this device to finish signing in.
							</p>
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
		</main>
	);
}
