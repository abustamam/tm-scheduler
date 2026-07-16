import { LogOut, ShieldCheck, Users } from "lucide-react";
import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import { ACCESS_REQUEST_MAILTO, TOASTMASTERS_DISCLAIMER } from "#/lib/brand";

/**
 * The signed-in "you're not in a club yet" screen (#267). Shown by the authed
 * shell when `getAuthContext` resolves no memberships (`clubs` empty / no active
 * club) — instead of the workspace nav + an empty Outlet, which dead-ends the
 * user. Gives a purposeful explanation and at least one actionable next step:
 * "Request access" (the invite-only mailto precedent from `index.tsx`) plus the
 * hint to sign in with the email their club has on its roster.
 *
 * A club-less platform superadmin still gets an escape hatch to `/superadmin`
 * (a full-page link — this shell renders outside the workspace router chrome).
 * Presentational + router-context-free so it renders anywhere and stays testable.
 */
export function NoClubScreen({
	email,
	onSignOut,
	isSuperadmin = false,
}: {
	/** The signed-in user's email, so they can tell which account they're in. */
	email: string;
	onSignOut: () => void;
	isSuperadmin?: boolean;
}) {
	return (
		<div className="flex min-h-svh w-full flex-col bg-[var(--foam)] font-sans text-[var(--sea-ink)]">
			<header className="flex items-center justify-between border-b border-[var(--line)] bg-[var(--surface)] px-5 py-4 sm:px-8">
				<BrandMark />
				<Button
					variant="ghost"
					size="sm"
					className="font-semibold"
					onClick={onSignOut}
				>
					<LogOut className="size-4" aria-hidden />
					Sign out
				</Button>
			</header>

			<main className="flex flex-1 items-center justify-center px-5 py-12">
				<div className="w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-7 text-center shadow-[0_1px_0_var(--inset-glint)_inset,0_18px_44px_rgba(23,58,64,.10)] sm:p-9">
					<span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-[var(--sand)] text-[var(--lagoon-deep)]">
						<Users className="size-6" aria-hidden />
					</span>
					<h1 className="mt-5 font-display text-2xl font-semibold tracking-[-0.01em]">
						You're not in a club yet
					</h1>
					<p className="mt-3 text-sm leading-relaxed text-[var(--sea-ink-soft)]">
						You're signed in as{" "}
						<span className="font-semibold text-[var(--sea-ink)]">{email}</span>
						, but this account isn't linked to a Toastmasters club on GavelUp
						yet.
					</p>

					<div className="mt-6 flex flex-col gap-2.5">
						<Button asChild size="lg">
							<a href={ACCESS_REQUEST_MAILTO}>Request access</a>
						</Button>
						{isSuperadmin ? (
							<Button asChild variant="outline" size="lg">
								<a href="/superadmin">
									<ShieldCheck className="size-4" aria-hidden />
									Go to Superadmin
								</a>
							</Button>
						) : null}
					</div>

					<p className="mt-6 text-xs leading-relaxed text-[var(--sea-ink-soft)]">
						Already on a club's roster? Make sure you sign in with the same
						email your club has on file — otherwise{" "}
						<button
							type="button"
							onClick={onSignOut}
							className="font-semibold text-[var(--sea-ink)] underline underline-offset-2"
						>
							sign out
						</button>{" "}
						and try again with that address.
					</p>
				</div>
			</main>

			<footer className="border-t border-[var(--line)] px-5 py-4 text-center text-[11px] leading-relaxed text-[var(--sea-ink-soft)] sm:px-8">
				{TOASTMASTERS_DISCLAIMER}
			</footer>
		</div>
	);
}
