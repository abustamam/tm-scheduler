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

/**
 * Two heavy, two light — not four equal cards (#612).
 *
 * Four uniform cards assert that four things matter equally. They do not: the
 * shared sheet and running the meeting in the room are why a club leaves its
 * spreadsheet; Pathways tracking and the officer admin are why it stays. The
 * competitive read also found the 4-up icon grid is the category's most
 * repeated shape, so equal weighting cost differentiation as well as accuracy.
 */
const MAJOR_FEATURES = [
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
];

const MINOR_FEATURES = [
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

/**
 * The role list a member sees, drawn as markup rather than shipped as a
 * screenshot (#612).
 *
 * The hero used to show `/landing/hero.png` — the officer's sign-up grid. The
 * competitive read found that exact visual (role rows against date columns,
 * coloured status chips) repeats almost identically across Planning Center,
 * TeamSnap, Toastmanagers, ToastmastersClubSoftware and OurClubHQ. It is the
 * category's signature, so leading with it made GavelUp look like everyone.
 *
 * This shows the other side: what a MEMBER sees. No competitor shows it, and it
 * demonstrates the one claim none of them make — there is no sign-in step
 * anywhere in the frame. Deliberately markup and not a screenshot, so it stays
 * crisp at any density, follows the light/dark tokens, and never goes stale
 * against the UI it depicts.
 *
 * Colours come from the SEMANTIC pairs, not the raw ramp. `--lagoon-ink` is
 * dark in light mode and LIGHT in dark mode (`var(--lagoon-deep)`, #8de5db), so
 * a hand-rolled white-on-lagoon-ink chip lands near 1.3:1 for dark-mode
 * readers. `bg-primary` / `bg-success` and their foregrounds are the pairs
 * styles.css already verifies in both themes.
 */
const DEMO_ROLES = [
	{ role: "Toastmaster", detail: "Runs the meeting", taken: false },
	{ role: "Speaker 2", detail: "5–7 min", taken: false },
	{ role: "Evaluator 1", detail: "Evaluates a speech", taken: false },
	{ role: "Timer", detail: "Nina Petrov", taken: true },
	{ role: "Ah-Counter", detail: "Marcus Doyle", taken: true },
];

function MemberRoleList() {
	return (
		<div className="flex justify-center">
			{/* pb-6 keeps the caption pill clear of the device frame rather than
			    straddling its bottom edge. */}
			<div className="relative pb-6">
				{/*
				 * aria-hidden, with a visually-hidden caption doing the job the old
				 * <img> alt text did. Every string inside is illustrative and none of
				 * it is interactive, so a screen reader announcing "Toastmaster Runs
				 * the meeting Claim Speaker 2 5-7 min Claim…" would be noise.
				 */}
				<p className="sr-only">
					An illustration of the GavelUp sign-up sheet as a club member sees it
					on their phone: the roles for one meeting, three open to claim with a
					single tap and two already taken by other members. There is no sign-in
					step.
				</p>
				{/* The bezel hex is deliberately theme-independent, not an escaped
				    token: a device bezel is dark in both themes because real phones
				    are. Same reasoning as the window-chrome dots this replaced.
				    Everything INSIDE the screen is tokenised and flips. */}
				<div
					aria-hidden
					className="w-[300px] rounded-[34px] bg-[#0e2a2e] p-2.5 shadow-[0_30px_70px_rgba(23,58,64,.26)]"
				>
					<div className="overflow-hidden rounded-[27px] bg-[var(--foam)]">
						<div className="border-[var(--line)] border-b bg-[var(--surface-strong)] px-4 pt-3.5 pb-3">
							<div className="font-extrabold text-[11.5px] text-[var(--sea-ink-soft)] uppercase tracking-[0.06em]">
								Harbor City Speakers
							</div>
							<div className="mt-0.5 font-display font-semibold text-[17px]">
								Tuesday, 26 August
							</div>
							<div className="mt-1 text-[11.5px] text-[var(--sea-ink-soft)]">
								Tap a role to take it. That's the whole thing.
							</div>
						</div>
						<div className="flex flex-col gap-[7px] p-[9px]">
							{DEMO_ROLES.map((r) => (
								<div
									key={r.role}
									className="flex items-center justify-between gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2.5"
								>
									<div className="min-w-0">
										<div className="truncate font-bold text-[14px]">
											{r.role}
										</div>
										<div className="truncate text-[11.5px] text-[var(--sea-ink-soft)]">
											{r.detail}
										</div>
									</div>
									<span
										className={
											r.taken
												? "shrink-0 rounded-full bg-success px-3 py-1.5 font-extrabold text-[12.5px] text-success-foreground"
												: "shrink-0 rounded-full bg-primary px-3 py-1.5 font-extrabold text-[12.5px] text-primary-foreground"
										}
									>
										{r.taken ? "Taken" : "Claim"}
									</span>
								</div>
							))}
						</div>
					</div>
				</div>
				<span className="-translate-x-1/2 absolute bottom-0 left-1/2 whitespace-nowrap rounded-full border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-1.5 font-extrabold text-[12.5px] text-[var(--palm)]">
					No sign-in. No app to install.
				</span>
			</div>
		</div>
	);
}

function Landing() {
	return (
		// No background colour here, deliberately (#612). styles.css gives `body`
		// a layered treatment — three radial washes on --hero-a/--hero-b over a
		// sand → foam → bg-base ramp, with dark-mode variants — and this page set
		// `bg-[var(--foam)]`, flat-filling straight over all of it. The landing
		// page was the one surface discarding the app's own atmosphere, and it is
		// the surface that most needs it.
		<div className="flex min-h-svh flex-col text-[var(--sea-ink)]">
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
						<p className="font-extrabold text-[11.5px] text-[var(--palm)] uppercase tracking-[0.12em]">
							For Toastmasters clubs
						</p>
						{/*
						 * `opsz` is the reason to use Fraunces rather than a static serif.
						 * The face is loaded with the axis (`opsz,wght@9..144` in
						 * styles.css) and this headline left it at the browser default, so
						 * a 48px line rendered text-optimised letterforms scaled up:
						 * thicker strokes and wider apertures than the size wants. 120 is
						 * what the axis is for, and the font is already downloaded.
						 */}
						<h1
							className="mt-3.5 text-balance font-display font-semibold text-4xl leading-[1.05] tracking-[-0.022em] sm:text-5xl"
							style={{ fontVariationSettings: "'opsz' 120" }}
						>
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

					<MemberRoleList />
				</section>

				{/* Value props — two heavy, two light. See MAJOR/MINOR_FEATURES. */}
				<section className="mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8">
					<div className="grid gap-5 lg:grid-cols-2">
						{MAJOR_FEATURES.map((f) => (
							<div
								key={f.title}
								className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-6"
							>
								<span className="flex size-10 items-center justify-center rounded-xl bg-[var(--sand)] text-[var(--lagoon-deep)]">
									<f.icon className="size-5" aria-hidden />
								</span>
								<h2
									className="mt-4 font-display font-semibold text-[22px] tracking-[-0.015em]"
									style={{ fontVariationSettings: "'opsz' 60" }}
								>
									{f.title}
								</h2>
								<p className="mt-2 text-[15px] leading-relaxed text-[var(--sea-ink-soft)]">
									{f.body}
								</p>
							</div>
						))}
					</div>
					<div className="mt-6 grid gap-x-10 lg:grid-cols-2">
						{MINOR_FEATURES.map((f) => (
							<div key={f.title} className="border-[var(--line)] border-t py-4">
								<h3 className="flex items-center gap-2 font-extrabold text-[15px]">
									<f.icon
										className="size-4 shrink-0 text-[var(--lagoon-deep)]"
										aria-hidden
									/>
									{f.title}
								</h3>
								<p className="mt-1 text-sm leading-relaxed text-[var(--sea-ink-soft)]">
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
