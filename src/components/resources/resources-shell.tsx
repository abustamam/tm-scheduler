import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { BrandMark } from "#/components/brand-mark";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";

/**
 * Public wrapper for the `/resources` pages (#310). These routes render OUTSIDE
 * the `_authed` sidebar shell, so a signed-in visitor who lands here gets this
 * lightweight header (brand mark → home) as the way back. Wrapping public
 * routes in the full app shell for authed users is tracked in #317.
 */
export function ResourcesShell({ children }: { children: ReactNode }) {
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
