import { createFileRoute, Link } from "@tanstack/react-router";
import { MarketingShell } from "#/components/marketing/marketing-shell";
import { CONTACT_MAILTO, FOUNDER_BLURB } from "#/lib/brand";

const TITLE = "About GavelUp";
const DESCRIPTION =
	"Who builds GavelUp, and what happens to a Toastmasters club's data when it uses it.";

export const Route = createFileRoute("/about")({
	// Public, and deliberately NOT redirecting a signed-in visitor the way `/`
	// does: an officer forwarding this page to a district director is the reader.
	head: () => ({
		meta: [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
		],
	}),
	component: AboutPage,
});

/**
 * Paragraphs that follow {@link FOUNDER_BLURB} in "Who's behind GavelUp".
 *
 * The maintainer's own bio, approved final on #871 (2026-09-25). The site is
 * public, so every sentence here is a claim about a real person: change the
 * wording only with the maintainer. `about.test.tsx` pins the blurb plus
 * exactly these paragraphs, in order, as literals.
 */
const FOUNDER_PARAGRAPHS = [
	"By day, I'm a software engineer at Salty, where I build tools that help drivers find better car insurance without the paperwork. I've been shipping software since 2016.",
	"In Toastmasters, I chartered Simply the Best at Kaiser South Sacramento, served as an Area Director in 2014, and I'm chartering THR Speaking Club in Roseville, in District 206, right now.",
	"As a VP Education, I ran sign-ups on a shared spreadsheet. Two people could claim the same role, nothing checked the entries, and I had no easy way to see who'd done which role or how the club was growing. The club software I tried wasn't much better: hard to use, and it signed me out constantly. Filling a role as Toastmaster meant clicking a name, finding a phone number in a pop-up, copying it into my messaging app and pasting in a message, once for every person.",
	"So I built GavelUp to do that busywork: one sign-up sheet that can't double-book, role history at a glance, contact details one tap from a ready-to-send message, and the agenda and slide deck built for you. (I really don't like PowerPoint.) When I was VP Membership, I wanted every guest in one place, so inviting them back to the next meeting is easy.",
	"What GavelUp won't do is talk to your members for you. Members still reach out to each other about roles; GavelUp just makes that quicker.",
];

/**
 * "What happens to your club's data" (#869): one sentence per fact the code
 * supports today, each cited in the PR that added it. Descriptions of what the
 * app DOES, not promises about what it will do. The maintainer's commitments
 * are {@link DATA_PROMISES}, rendered after these. `about.test.tsx` bans
 * "never", "sell" and "guarantee" from the whole section, facts and promises
 * alike.
 *
 * Sources, so the next edit can re-check them:
 * - hosting: `docs/adr/0007-railway-managed-paas.md`
 * - sign-in: `src/lib/auth.ts` (the `magicLink` plugin is the only sign-in)
 * - claiming: `claimSlot` in `src/server/slots.ts` (session-less, name-pick)
 * - connector: `maskEmail` / `maskPhone` in `src/server/mcp/serialize.ts`, as
 *   `find_people` returns guests. Scoped to LOOKUPS on purpose: guest-book
 *   transcription (`record_guest_book`) sends Claude's plaintext reading of the
 *   photo IN, so "Claude only ever sees masked contact" would be false.
 * - scripts: no analytics dependency in `package.json`; the one inline script
 *   in `src/routes/__root.tsx` applies the saved theme
 */
const DATA_FACTS = [
	"GavelUp runs on Railway, and your club's data lives in a managed PostgreSQL database there.",
	"You sign in with a link emailed to you, so GavelUp stores no passwords.",
	"Members can claim roles from your club's shared sheet without creating an account.",
	"When Claude looks up guests in GavelUp, their email addresses and phone numbers come back masked.",
	"GavelUp loads no advertising or third-party analytics scripts.",
];

/**
 * The maintainer's commitments about a club's data, approved on #871
 * (2026-09-25). Unlike {@link DATA_FACTS} these are policy, not descriptions of
 * code, so nothing in the build can check them. What makes each one false:
 *
 * 1. No advertisers or data brokers: adding an analytics, advertising or
 *    data-broker dependency.
 * 2. Only the services that run it: adding ANY new outside service that
 *    receives club data. The list in this sentence must be updated in the
 *    same PR that adds the service.
 * 3. Used only to run GavelUp: using club data for anything other than
 *    running that club's GavelUp.
 *
 * Deletion on request and self-serve export are deliberately absent: both are
 * false today, and each is added here by the change that makes it true
 * (#914, #915).
 */
const DATA_PROMISES = [
	"GavelUp doesn't share your club's data with advertisers or data brokers.",
	"GavelUp shares your club's data only with the services that run it: Railway (hosting), Resend (email), and Anthropic, if a member connects Claude.",
	"Your club's data is used only to run GavelUp for your club.",
];

function AboutPage() {
	return (
		<MarketingShell>
			<main className="mx-auto w-full max-w-3xl flex-1 px-5 pt-8 pb-20 sm:px-8">
				<h1 className="font-display text-4xl font-semibold tracking-[-0.02em]">
					About GavelUp
				</h1>

				<section aria-labelledby="about-founder" className="mt-10">
					<h2
						id="about-founder"
						className="font-display text-2xl font-semibold tracking-[-0.01em]"
					>
						Who's behind GavelUp
					</h2>
					{/* Not lazy: it is the first thing in the section, near the fold. */}
					<figure className="mt-4">
						<img
							src="/about/rasheed-speaking.webp"
							alt="Rasheed Bustamam speaking on stage to a large audience"
							width={1400}
							height={350}
							className="block aspect-[4/1] h-auto w-full rounded-2xl object-cover"
						/>
						<figcaption className="mt-2 text-sm text-[var(--sea-ink-soft)]">
							Speaking to an audience of 700.
						</figcaption>
					</figure>
					<div className="mt-6 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
						<img
							src="/about/rasheed-headshot.png"
							alt="Rasheed Bustamam"
							width={400}
							height={400}
							loading="lazy"
							className="size-28 shrink-0 rounded-full object-cover"
						/>
						<p className="text-base leading-relaxed">{FOUNDER_BLURB}</p>
					</div>
					{FOUNDER_PARAGRAPHS.map((text) => (
						<p key={text} className="mt-3 text-base leading-relaxed">
							{text}
						</p>
					))}
				</section>

				<section aria-labelledby="about-data" className="mt-10">
					<h2
						id="about-data"
						className="font-display text-2xl font-semibold tracking-[-0.01em]"
					>
						What happens to your club's data
					</h2>
					<ul className="mt-3 list-disc space-y-2 pl-5 text-base leading-relaxed">
						{DATA_FACTS.map((fact) => (
							<li key={fact}>{fact}</li>
						))}
						{DATA_PROMISES.map((promise) => (
							<li key={promise}>{promise}</li>
						))}
					</ul>
				</section>

				<section aria-labelledby="about-contact" className="mt-10">
					<h2
						id="about-contact"
						className="font-display text-2xl font-semibold tracking-[-0.01em]"
					>
						Get in touch
					</h2>
					<p className="mt-3 text-base leading-relaxed">
						GavelUp is invite-only for now. To bring it to your club or
						district,{" "}
						<Link to="/request-access" className="font-semibold underline">
							request access
						</Link>
						. For anything else,{" "}
						<a href={CONTACT_MAILTO} className="font-semibold underline">
							email us
						</a>
						.
					</p>
				</section>
			</main>
		</MarketingShell>
	);
}
