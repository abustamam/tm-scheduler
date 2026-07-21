import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
	AppShell,
	type ShellContext,
	shellPropsFromContext,
} from "#/components/app-shell";
import { BrandMark } from "#/components/brand-mark";
import { authClient } from "#/lib/auth-client";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { endImpersonation } from "#/server/impersonation";

/**
 * Wrapper for the `/resources` pages (#310). A signed-in user with a club (#317)
 * gets the full app sidebar shell so clicking "Resources" from the workspace
 * keeps them oriented; the routes' `beforeLoad` resolves `shell`/`authCtx` and
 * passes them here. An anonymous visitor gets the lightweight header (brand mark
 * → home) as the way back — unchanged.
 */
export function ResourcesShell({
	children,
	shell,
	authCtx,
}: {
	children: ReactNode;
	shell?: boolean;
	authCtx?: ShellContext | null;
}) {
	const router = useRouter();

	if (shell && authCtx) {
		async function onSignOut() {
			await authClient.signOut();
			await router.navigate({ to: "/signin", search: { redirect: "/" } });
		}
		async function onExitImpersonation() {
			try {
				await endImpersonation();
				await router.navigate({ to: "/superadmin" });
				await router.invalidate();
			} catch (err) {
				toast.error(
					err instanceof Error ? err.message : "Couldn't exit the session.",
				);
			}
		}
		return (
			<AppShell
				{...shellPropsFromContext(authCtx)}
				onSignOut={onSignOut}
				onExitImpersonation={onExitImpersonation}
			>
				<div className="mx-auto w-full max-w-4xl px-5 pb-16 pt-4 sm:px-8">
					{children}
				</div>
			</AppShell>
		);
	}

	return (
		<div className="flex min-h-svh flex-col bg-[var(--foam)] text-[var(--sea-ink)]">
			<header className="mx-auto flex w-full max-w-4xl items-center justify-between px-5 py-5 sm:px-8">
				<Link to="/" className="no-underline">
					<BrandMark size="sm" />
				</Link>
				<Link
					to="/resources"
					className="text-sm font-semibold text-[var(--sea-ink)] no-underline hover:underline"
				>
					All resources
				</Link>
			</header>
			<main className="mx-auto w-full max-w-4xl flex-1 px-5 pb-16 sm:px-8">
				{children}
			</main>
			<footer className="border-t border-[var(--line)]">
				<div className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8">
					<p className="max-w-3xl text-xs leading-relaxed text-[var(--sea-ink-soft)]">
						{TOASTMASTERS_DISCLAIMER}
					</p>
				</div>
			</footer>
		</div>
	);
}
