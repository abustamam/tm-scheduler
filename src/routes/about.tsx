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
 * Paragraphs that follow {@link FOUNDER_BLURB} in "Who's behind GavelUp" (#869).
 *
 * EMPTY on purpose. The site is public, so every sentence here is a claim about
 * a real person, and only the blurb's facts are confirmed. The fuller bio is a
 * `ready-for-human` copy issue (#871): it appends here, and nothing else in the
 * page changes. `about.test.tsx` pins that an empty array renders nothing.
 */
const FOUNDER_SECTIONS: string[] = [];

/**
 * "What happens to your club's data" (#869): one sentence per fact the code
 * supports today, each cited in the PR that added it. Descriptions of what the
 * app DOES, not promises about what it will do — policy commitments are the
 * maintainer's to make (#871), which is why `about.test.tsx` bans "never",
 * "sell" and "guarantee" from this section.
 *
 * Sources, so the next edit can re-check them:
 * - hosting: `docs/adr/0007-railway-managed-paas.md`
 * - sign-in: `src/lib/auth.ts` (the `magicLink` plugin is the only sign-in)
 * - claiming: `claimSlot` in `src/server/slots.ts` (session-less, name-pick)
 * - connector: `maskEmail` / `maskPhone` in `src/server/mcp/serialize.ts` (`find_people`)
 * - scripts: no analytics dependency in `package.json`; the one inline script
 *   in `src/routes/__root.tsx` applies the saved theme
 */
const DATA_FACTS = [
	"GavelUp runs on Railway, and your club's data lives in a managed PostgreSQL database there.",
	"You sign in with a link emailed to you, so GavelUp stores no passwords.",
	"Members can claim roles from your club's shared sheet without creating an account.",
	"When your club connects Claude, guests' email addresses and phone numbers reach it masked.",
	"GavelUp loads no advertising or third-party analytics scripts.",
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
					<p className="mt-3 text-base leading-relaxed">{FOUNDER_BLURB}</p>
					{FOUNDER_SECTIONS.map((text) => (
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
