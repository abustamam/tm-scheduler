import { createFileRoute } from "@tanstack/react-router";
import { BrandMark } from "#/components/brand-mark";
import {
	Card,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";

// Public, static. Every role-reminder email GavelUp ever sent (#274) linked here
// with a signed `?token=`. Reminder emails are gone (ADR-0028, #902: a human
// sends every message), so this page reads no token, calls no server fn and
// changes nothing — it only keeps those old links from 404ing.
export const Route = createFileRoute("/unsubscribe")({
	component: Unsubscribe,
});

function Unsubscribe() {
	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
			<BrandMark />
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="font-display text-xl">
						Nothing to unsubscribe from
					</CardTitle>
					<CardDescription>
						GavelUp no longer sends reminder emails, so there is nothing to
						unsubscribe from.
					</CardDescription>
				</CardHeader>
			</Card>
			<p className="w-full max-w-sm text-center text-[11px] leading-relaxed text-muted-foreground/80">
				{TOASTMASTERS_DISCLAIMER}
			</p>
		</main>
	);
}
