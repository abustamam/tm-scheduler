import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import {
	CalendarCheck,
	GraduationCap,
	MonitorPlay,
	UserPlus,
} from "lucide-react";
import { BrandMark } from "#/components/brand-mark";
import { Button } from "#/components/ui/button";
import { ACCESS_REQUEST_MAILTO, TOASTMASTERS_DISCLAIMER } from "#/lib/brand";
import { homeRedirectTarget } from "#/lib/home-route";
import { getAuthContext } from "#/server/auth-context";

const TITLE = "GavelUp — the meeting runner for Toastmasters clubs";
/**
 * Search-facing. Kept keyword-shaped (roles, agenda, Pathways, DCP) because it
 * is what a search result shows. Deliberately NOT reused as the hero paragraph
 * any more: a meta description and a first sentence have different jobs, and
 * one string cannot do both well.
 */
const DESCRIPTION =
	"Schedule roles, run the agenda, and track Pathways & DCP — the tool officers use to keep their Toastmasters club moving.";

export const Route = createFileRoute("/")({
	// Public front door. Signed-in visitors are sent into the app, role-aware:
	// officers to the officer home, everyone else to their dashboard.
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

/**
 * Hero paragraph. Written for the officer deciding whether to move their club
 * off a spreadsheet, so it leads with what they stop doing rather than with a
 * feature list. Every claim here ships today: members identify by picking their
 * name (no account), the agenda prints and projects, present mode and the
 * attendance queue work offline.
 */
const HERO_BODY =
	"Members claim their own roles from one shared sheet — no account to create, no password to forget, no spreadsheet that only one person can edit. Come meeting night, print the agenda, put it on the screen, and take the roll even when the room's Wi-Fi gives up.";

const FEATURES = [
	{
		icon: CalendarCheck,
		title: "Members fill the sheet",
		body: "Open roles are obvious at a glance, and members claim them without an account — so signing up is one tap, not a text to the VPE.",
	},
	{
		icon: MonitorPlay,
		title: "Works in the room",
		body: "Print the agenda, project it, take the roll, run the vote for best speaker. Present mode and attendance keep working when the Wi-Fi does not.",
	},
	{
		icon: GraduationCap,
		title: "Pathways & DCP",
		body: "Every member's Pathways progress and the club's Distinguished Club Program goals in one place — plus the official evaluation form for each project.",
	},
	{
		icon: UserPlus,
		title: "The rest of the officer's job",
		body: "Guests through the pipeline, dues renewals on schedule, minutes and awards recorded — the admin that usually lives in someone's inbox.",
	},
];

function Landing() {
	return (
		<div className="flex min-h-svh flex-col bg-[var(--foam)] text-[var(--sea-ink)]">
			<header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 sm:px-8">
				<BrandMark />
				<nav className="flex items-center gap-1">
					<Button asChild variant="ghost" className="font-semibold">
						<Link to="/resources">Resources</Link>
					</Button>
					<Button asChild variant="ghost" className="font-semibold">
						<Link to="/signin" search={{ redirect: "/officers" }}>
							Sign in
						</Link>
					</Button>
				</nav>
			</header>

			<main className="flex-1">
				{/* Hero */}
				<section className="mx-auto grid w-full max-w-6xl items-center gap-10 px-5 py-12 sm:px-8 lg:grid-cols-2 lg:gap-14 lg:py-20">
					<div className="max-w-xl">
						<h1 className="font-display text-4xl font-semibold leading-[1.08] tracking-[-0.02em] text-balance sm:text-5xl">
							Every role filled before the meeting starts.
						</h1>
						<p className="mt-5 text-lg leading-relaxed text-[var(--sea-ink-soft)]">
							{HERO_BODY}
						</p>
						<div className="mt-8 flex flex-wrap items-center gap-3">
							<Button asChild size="lg" className="px-6">
								<Link to="/signin" search={{ redirect: "/officers" }}>
									Sign in
								</Link>
							</Button>
							<Button asChild size="lg" variant="outline" className="px-6">
								<a href={ACCESS_REQUEST_MAILTO}>Request access</a>
							</Button>
						</div>
						<p className="mt-4 text-sm text-[var(--sea-ink-soft)]">
							New club? GavelUp is invite-only while it's young — send a note
							and we'll set your club up ourselves.
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
						<div className="flex items-center gap-4">
							<Link
								to="/resources"
								className="font-semibold text-[var(--sea-ink)] no-underline hover:underline"
							>
								Resources
							</Link>
							<Link
								to="/signin"
								search={{ redirect: "/officers" }}
								className="font-semibold text-[var(--sea-ink)] no-underline hover:underline"
							>
								Sign in
							</Link>
						</div>
					</div>
					<p className="max-w-3xl text-xs leading-relaxed">
						{TOASTMASTERS_DISCLAIMER}
					</p>
				</div>
			</footer>
		</div>
	);
}
