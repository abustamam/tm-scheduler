import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { BrandMark } from "#/components/brand-mark";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Toaster } from "#/components/ui/sonner";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { submitGuestBook } from "#/server/guest-pipeline";

// Escapes the `/club/$clubId` shell (trailing `_`) so it never hits the
// pick-your-name member gate — this is the PUBLIC, no-auth guest front door
// (#208 / #239). The URL segment stays `/club/:clubId/guest-book`.
export const Route = createFileRoute("/club/$clubId_/guest-book")({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		return {
			clubId: club.id,
			clubName: club.name,
			clubNumber: club.clubNumber,
		};
	},
	component: GuestBook,
});

function GuestBook() {
	const { clubId, clubName, clubNumber } = Route.useLoaderData();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [phone, setPhone] = useState("");
	const [done, setDone] = useState(false);

	const submit = useMutation({
		mutationFn: () =>
			submitGuestBook({
				data: {
					clubId,
					name: name.trim(),
					email: email.trim(),
					phone: phone.trim(),
				},
			}),
		onSuccess: () => setDone(true),
	});

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim() || submit.isPending) return;
		submit.mutate();
	}

	return (
		<div className="flex min-h-svh w-full flex-col bg-background">
			<header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 md:px-6">
				<BrandMark size="sm" />
				<span className="min-w-0 flex-1 truncate text-right text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
					{clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				</span>
				<ThemeToggle compact />
			</header>

			<main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-5 py-10">
				{done ? (
					<div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card px-6 py-10 text-center shadow-sm">
						<CheckCircle2 className="size-12 text-success" aria-hidden />
						<div className="space-y-1">
							<h1 className="font-display text-2xl font-semibold text-foreground">
								Welcome, {name.trim().split(/\s+/)[0] || "friend"}!
							</h1>
							<p className="text-sm text-muted-foreground">
								Thanks for signing our guest book — we're glad you're visiting{" "}
								{clubName}. Enjoy the meeting!
							</p>
						</div>
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								setName("");
								setEmail("");
								setPhone("");
								submit.reset();
								setDone(false);
							}}
						>
							Sign in another guest
						</Button>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="space-y-6">
						<header className="space-y-1">
							<h1 className="font-display text-2xl font-semibold text-foreground">
								Welcome to {clubName} 👋
							</h1>
							<p className="text-sm text-muted-foreground">
								Visiting us today? Sign our guest book so we can say hello.
							</p>
						</header>

						<div className="space-y-4 rounded-2xl border border-border bg-card p-5 shadow-sm">
							<div className="space-y-2">
								<Label htmlFor="guest-name">Your name</Label>
								<Input
									id="guest-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Jamie Rivera"
									autoComplete="name"
									required
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="guest-phone">
									Phone{" "}
									<span className="font-normal text-muted-foreground">
										(optional)
									</span>
								</Label>
								<Input
									id="guest-phone"
									type="tel"
									value={phone}
									onChange={(e) => setPhone(e.target.value)}
									placeholder="(555) 123-4567"
									autoComplete="tel"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="guest-email">
									Email{" "}
									<span className="font-normal text-muted-foreground">
										(optional)
									</span>
								</Label>
								<Input
									id="guest-email"
									type="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									placeholder="jamie@example.com"
									autoComplete="email"
								/>
							</div>
						</div>

						{submit.isError ? (
							<p className="text-sm text-destructive">
								{submit.error instanceof Error
									? submit.error.message
									: "Something went wrong — please try again."}
							</p>
						) : null}

						<Button
							type="submit"
							className="w-full"
							disabled={!name.trim() || submit.isPending}
						>
							{submit.isPending ? (
								<Loader2 className="size-4 animate-spin" aria-hidden />
							) : (
								"Sign the guest book"
							)}
						</Button>
						<p className="text-center text-xs text-muted-foreground">
							We only use this to welcome you back — never shared.
						</p>
					</form>
				)}
			</main>
			<Toaster position="top-center" />
		</div>
	);
}
