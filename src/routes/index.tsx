import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import {
	CalendarCheck,
	GraduationCap,
	MonitorPlay,
	UserPlus,
} from "lucide-react";
import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import { TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { homeRedirectTarget } from "#/lib/home-route";
import { getAuthContext } from "#/server/auth-context";

const TITLE = "GavelUp — the meeting runner for Toastmasters clubs";
const DESCRIPTION =
	"Schedule roles, run the agenda, and track Pathways & DCP — the tool officers use to keep their Toastmasters club moving.";
const ACCESS_MAILTO =
	"mailto:rasheed.bustamam@gmail.com?subject=GavelUp%20access%20request";

export const Route = createFileRoute("/")({
	// Public front door. Signed-in visitors are sent into the app, role-aware:
	// officers to the officer home, everyone else to the roster.
	beforeLoad: async () => {
		const ctx = await getAuthContext();
		if (ctx.user) {
			const activeClub =
				ctx.clubs.find((c) => c.clubId === ctx.activeClubId) ?? ctx.clubs[0];
			throw redirect({
				to: homeRedirectTarget({
					clubRole: activeClub?.clubRole,
					officerCount: ctx.officerPositions.length,
				}),
			});
		}
	},
	head: () => ({
		meta: [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
			{ property: "og:image", content: "/landing/hero.png" },
			{ name: "twitter:card", content: "summary_large_image" },
		],
	}),
	component: Landing,
});

const FEATURES = [
	{
		icon: CalendarCheck,
		title: "Shared sign-up sheet",
		body: "Members claim meeting roles from one grid — open slots are obvious at a glance, no spreadsheet wrangling.",
	},
	{
		icon: MonitorPlay,
		title: "Run the meeting",
		body: "Project the agenda on screen or print it. Present mode works offline, so a flaky room Wi-Fi never stops you.",
	},
	{
		icon: GraduationCap,
		title: "Pathways & DCP",
		body: "Track members' Pathways progress and the club's Distinguished Club Program goals in one place.",
	},
	{
		icon: UserPlus,
		title: "Guests & dues",
		body: "Log visitors through the guest pipeline and keep membership dues renewals on schedule.",
	},
];

function Landing() {
	return (
		<div className="flex min-h-svh flex-col bg-[var(--foam)] text-[var(--sea-ink)]">
			<header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
				<BrandMark />
				<Button asChild variant="ghost" className="font-semibold">
					<Link to="/signin" search={{ redirect: "/officers" }}>
						Sign in
					</Link>
				</Button>
			</header>

			<main className="flex-1">
				{/* Hero */}
				<section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 py-12 sm:px-8 lg:grid-cols-2 lg:gap-14 lg:py-20">
					<div className="max-w-xl">
						<h1 className="font-display text-4xl font-semibold leading-[1.08] tracking-[-0.02em] text-balance sm:text-5xl">
							Run a better Toastmasters meeting.
						</h1>
						<p className="mt-5 text-lg leading-relaxed text-[var(--sea-ink-soft)]">
							{DESCRIPTION}
						</p>
						<div className="mt-8 flex flex-wrap items-center gap-3">
							<Button asChild size="lg" className="px-6">
								<Link to="/signin" search={{ redirect: "/officers" }}>
									Sign in
								</Link>
							</Button>
							<Button asChild size="lg" variant="outline" className="px-6">
								<a href={ACCESS_MAILTO}>Request access</a>
							</Button>
						</div>
						<p className="mt-4 text-sm text-[var(--sea-ink-soft)]">
							New club? GavelUp is invite-only for now — reach out and we'll get
							you set up.
						</p>
					</div>

					{/* Device-framed product screenshot (frame is CSS; image swaps freely) */}
					<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-2 shadow-[0_1px_0_var(--inset-glint)_inset,0_24px_60px_rgba(23,58,64,.14)]">
						<div className="flex items-center gap-1.5 px-2.5 py-2">
							<span className="size-2.5 rounded-full bg-[#e0736a]" />
							<span className="size-2.5 rounded-full bg-[var(--warning)]" />
							<span className="size-2.5 rounded-full bg-[var(--lagoon)]" />
						</div>
						<img
							src="/landing/hero.png"
							alt="The GavelUp sign-up sheet: members claiming meeting roles across upcoming meetings."
							width={1280}
							height={800}
							className="w-full rounded-xl border border-[var(--line)]"
						/>
					</div>
				</section>

				{/* Value props */}
				<section className="mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8">
					<div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
						{FEATURES.map((f) => (
							<div
								key={f.title}
								className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5"
							>
								<span className="flex size-10 items-center justify-center rounded-xl bg-[var(--sand)] text-[var(--lagoon-deep)]">
									<f.icon className="size-5" aria-hidden />
								</span>
								<h2 className="mt-4 font-display text-lg font-semibold tracking-[-0.01em]">
									{f.title}
								</h2>
								<p className="mt-1.5 text-sm leading-relaxed text-[var(--sea-ink-soft)]">
									{f.body}
								</p>
							</div>
						))}
					</div>
				</section>
			</main>

			<footer className="border-t border-[var(--line)]">
				<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-5 py-8 text-sm text-[var(--sea-ink-soft)] sm:px-8">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<BrandMark size="sm" />
						<Link
							to="/signin"
							search={{ redirect: "/officers" }}
							className="font-semibold text-[var(--sea-ink)] no-underline hover:underline"
						>
							Sign in
						</Link>
					</div>
					<p className="max-w-3xl text-xs leading-relaxed">
						{TOASTMASTERS_DISCLAIMER}
					</p>
				</div>
			</footer>
		</div>
	);
}
