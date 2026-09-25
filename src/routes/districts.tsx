import { createFileRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { DistrictShare } from "#/components/marketing/district-share";
import { FounderNote } from "#/components/marketing/founder-note";
import { MarketingShell } from "#/components/marketing/marketing-shell";
import { Button } from "#/components/ui/button";
import { PILOT_PRICING_LINE } from "#/lib/brand";

const TITLE = "GavelUp for Toastmasters districts";
const DESCRIPTION =
	"Help more of your clubs run great meetings: shared role sign-ups with no account to create, an agenda that prints and projects itself, and DCP goals kept in view. Free for clubs during the pilot.";

/**
 * `/districts` (#868): the page a district director is sent. The ask of them is
 * "help more of your clubs use this", NOT "manage your district here" —
 * district-level features are tabled, and `districts.test.tsx` bans the words
 * that would claim or hint at one.
 *
 * Public, with no signed-in redirect (unlike `/`): an officer who is signed in
 * may still be the one forwarding it.
 */
export const Route = createFileRoute("/districts")({
	// Returned UNCHANGED, no coercion: a validated search that differs from the
	// parsed one makes SSR 307 (CLAUDE.md), and the router parses `?d=57` as the
	// NUMBER 57. The component does `String(d)`.
	validateSearch: (
		search: Record<string, unknown>,
	): { d?: string | number } => ({
		d: search.d as string | number | undefined,
	}),
	head: () => ({
		meta: [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
		],
	}),
	component: Districts,
});

const CLUB_GETS = [
	{
		title: "One shared sign-up sheet",
		body: "Members open the club's link, pick their name and claim a role. Open roles are obvious at a glance, so the week's gaps fill without a round of texts.",
	},
	{
		title: "Run the meeting",
		body: "The agenda prints and projects itself from the roles people claimed. The Timer runs from a phone, and Best Speaker votes come from every seat.",
	},
	{
		title: "Pathways & DCP",
		body: "Officers see each member's Pathways progress and the club's DCP goals in one place, so the goals stay visible all year.",
	},
];

const EASY_ROLLOUT = [
	{
		title: "Members need no account",
		body: "They claim roles from the club's link by picking their name. Nothing to install and no password to forget.",
	},
	{
		title: "We set each club up ourselves",
		body: "A club tells us it's interested and we do the setup, so officers start with their meetings already there.",
	},
	{
		title: "Each club's data stays its own",
		body: "Every club sees only its own members, meetings and progress.",
	},
];

const H2 =
	"font-display text-2xl font-semibold tracking-[-0.01em] text-[var(--sea-ink)]";

function Section({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children: ReactNode;
}) {
	return (
		<section
			data-section={id}
			aria-labelledby={`districts-${id}`}
			className="mt-14"
		>
			<h2 id={`districts-${id}`} className={H2}>
				{title}
			</h2>
			<div className="mt-4">{children}</div>
		</section>
	);
}

function PointList({ points }: { points: { title: string; body: string }[] }) {
	return (
		<ul className="grid gap-5 sm:grid-cols-3">
			{points.map((p) => (
				<li key={p.title}>
					<p className="font-semibold text-[var(--sea-ink)]">{p.title}</p>
					<p className="mt-1.5 text-[15px] leading-relaxed text-[var(--sea-ink-soft)]">
						{p.body}
					</p>
				</li>
			))}
		</ul>
	);
}

function Districts() {
	const { d } = Route.useSearch();
	return (
		<MarketingShell>
			<main className="mx-auto w-full max-w-5xl flex-1 px-5 pt-10 pb-20 sm:px-8 lg:pt-16">
				<section data-section="hero">
					<p className="font-extrabold text-[11.5px] text-[var(--palm)] uppercase tracking-[0.12em]">
						For district leaders
					</p>
					<h1
						className="mt-3.5 max-w-3xl text-balance font-display font-semibold text-4xl leading-[1.05] tracking-[-0.022em] sm:text-5xl"
						style={{ fontVariationSettings: "'opsz' 120" }}
					>
						Help more of your clubs run great meetings.
					</h1>
					<p className="mt-5 max-w-2xl text-lg leading-relaxed text-[var(--sea-ink-soft)]">
						GavelUp helps a club fill its meeting roles faster, run the room
						smoothly on the night, and keep its DCP goals in view all year.
					</p>
				</section>

				<Section id="clubs-get" title="What your clubs get">
					<PointList points={CLUB_GETS} />
					<p className="mt-5">
						<Link
							to="/tour"
							className="font-semibold text-[var(--sea-ink)] no-underline hover:underline"
						>
							See the tour →
						</Link>
					</p>
				</Section>

				<Section id="rollout" title="Why it's easy to roll out">
					<PointList points={EASY_ROLLOUT} />
				</Section>

				<Section id="cost" title="What it costs">
					<p className="text-base leading-relaxed">{PILOT_PRICING_LINE}</p>
				</Section>

				<Section id="talk" title="Talk to us">
					<p className="max-w-2xl text-base leading-relaxed text-[var(--sea-ink-soft)]">
						Tell us about your district and the clubs you have in mind, and
						we'll work out the easiest way to get them started.
					</p>
					<div className="mt-5">
						<Button asChild size="lg" className="px-6">
							<Link to="/request-access" search={{ kind: "district" }}>
								Talk to us about your district
							</Link>
						</Button>
					</div>
				</Section>

				<Section id="share" title="Share with your clubs">
					<p className="mb-5 max-w-2xl text-base leading-relaxed text-[var(--sea-ink-soft)]">
						A ready-made note to forward to your club presidents. Enter your
						district number and copy it into an email or your district's group
						chat.
					</p>
					<DistrictShare d={d === undefined ? undefined : String(d)} />
				</Section>

				<section data-section="founder" className="mt-14">
					<FounderNote />
				</section>
			</main>
		</MarketingShell>
	);
}
