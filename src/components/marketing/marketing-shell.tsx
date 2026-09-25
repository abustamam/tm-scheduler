import { Link, type LinkProps } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { captureRef } from "#/lib/marketing-ref";

/** One nav entry. `to`/`search` are the router's own types, so any real route fits. */
export type MarketingLink = {
	label: string;
	to: LinkProps["to"];
	search?: LinkProps["search"];
};

/**
 * The marketing header's nav (#865). This array and {@link FOOTER_LINKS} are the
 * one place marketing nav lives: a new marketing page appends here rather than
 * hand-rolling a header of its own.
 */
export const HEADER_LINKS: MarketingLink[] = [
	{ label: "How it works", to: "/tour" },
	{ label: "Resources", to: "/resources" },
	{ label: "Sign in", to: "/signin", search: { redirect: "/officers" } },
];

/** The marketing footer's links. See {@link HEADER_LINKS}. */
export const FOOTER_LINKS: MarketingLink[] = [
	{ label: "How it works", to: "/tour" },
	{ label: "Resources", to: "/resources" },
	{ label: "For districts", to: "/districts" },
	{ label: "About", to: "/about" },
	{ label: "Sign in", to: "/signin", search: { redirect: "/officers" } },
];

/**
 * The shared chrome for every marketing page (`/` today, more to come, #865):
 * header, footer, and the Toastmasters International non-affiliation disclaimer
 * (ADR-0024). `marketing-disclaimer.guard.test.ts` requires every anonymous,
 * non-club route to render this (or `ResourcesShell`) unless it is named in
 * that guard's `EXEMPT` list with a reason (signin, claim, oauth.consent and
 * unsubscribe are, today), so a new marketing page cannot ship without the
 * disclaimer.
 *
 * Markup and classes moved verbatim from `index.tsx`, so `/` is visually
 * unchanged.
 */
export function MarketingShell({ children }: { children: ReactNode }) {
	// First-touch `?ref=` attribution (#866). Raw `window.location.search`, not
	// router search: see `captureRef`.
	useEffect(() => captureRef(window.location.search), []);
	return (
		// No background colour here, deliberately (#612). styles.css gives `body`
		// a layered treatment — three radial washes on --hero-a/--hero-b over a
		// sand → foam → bg-base ramp, with dark-mode variants — and the landing
		// page used to set `bg-[var(--foam)]`, flat-filling straight over all of
		// it. Marketing pages are the surfaces that most need that atmosphere.
		<div className="flex min-h-svh flex-col text-[var(--sea-ink)]">
			{/* `flex-wrap` (#870): the brand plus three nav buttons need ~430px and
			    `Button` never shrinks, so on a phone the nav drops to its own row
			    instead of running "Sign in" off-screen, where body's
			    `overflow-x: hidden` clips it. `-ml-4` lines the first button's text
			    up with the brand on that row. `marketing-header-geometry.test.ts`. */}
			<header className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-y-2 px-5 py-5 sm:px-8">
				<BrandMark />
				<nav className="-ml-4 flex items-center gap-1 sm:ml-0">
					{HEADER_LINKS.map((l) => (
						<Button
							key={l.label}
							asChild
							variant="ghost"
							className="font-semibold"
						>
							<Link to={l.to} search={l.search}>
								{l.label}
							</Link>
						</Button>
					))}
				</nav>
			</header>

			{children}

			<footer className="border-t border-[var(--line)]">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-8 text-sm text-[var(--sea-ink-soft)] sm:px-8">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<BrandMark size="sm" />
						{/* Wraps for the same reason as the header nav (#870): five links
						    do not fit one 375px row. */}
						<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
							{FOOTER_LINKS.map((l) => (
								<Link
									key={l.label}
									to={l.to}
									search={l.search}
									className="font-semibold text-[var(--sea-ink)] no-underline hover:underline"
								>
									{l.label}
								</Link>
							))}
						</div>
					</div>
					<p className="max-w-3xl text-xs leading-relaxed">
						{TOASTMASTERS_DISCLAIMER}
					</p>
				</div>
			</footer>
			{/* The one toast container on a marketing page (#868): a leaf that
			    calls toast() (the /districts copy buttons) relies on it, and a
			    second <Toaster /> in a leaf would render every toast twice. */}
			<Toaster position="top-center" />
		</div>
	);
}
