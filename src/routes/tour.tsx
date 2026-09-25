import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FounderNote } from "#/components/marketing/founder-note";
import { MarketingShell } from "#/components/marketing/marketing-shell";
import { AssistantDemo } from "#/components/marketing/tour/assistant-demo";
import { ClaimDemo } from "#/components/marketing/tour/claim-demo";
import { TimerDemo } from "#/components/marketing/tour/timer-demo";
import { VoteDemo } from "#/components/marketing/tour/vote-demo";
import { Button } from "#/components/ui/button";
import { PILOT_PRICING_LINE } from "#/lib/brand";

const TITLE = "How GavelUp works: a tour for Toastmasters officers";
const DESCRIPTION =
	"Members claim roles in one tap, the agenda prints and projects itself, and the Timer and the vote run from phones. A five-minute look at a GavelUp meeting.";

// Public, and deliberately no signed-in redirect (unlike `/`): an officer who
// is already in may still want to send this page to someone who is not.
export const Route = createFileRoute("/tour")({
	head: () => ({
		meta: [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
			{ property: "og:image", content: "/landing/tour-agenda.png" },
			{ name: "twitter:card", content: "summary_large_image" },
		],
	}),
	component: Tour,
});

/**
 * A screenshot, framed. Only scenes 2 and 3 use one: there the real output is
 * the proof, so a drawing would be the weaker claim. Both images come from
 * `bun run marketing:screenshots` against the seed club.
 */
function Shot({
	src,
	alt,
	sheet,
}: {
	src: string;
	alt: string;
	/**
	 * The print page draws one letter-width sheet (816px) at the left of a
	 * 1600px window and leaves the rest empty, so show only the sheet: crop to
	 * its width, anchored top-left, rather than a half-blank frame.
	 */
	sheet?: boolean;
}) {
	return (
		<img
			src={src}
			alt={alt}
			width={1600}
			height={1000}
			loading="lazy"
			className={`w-full rounded-2xl border border-[var(--line)] shadow-[0_20px_50px_rgba(23,58,64,.18)] ${
				sheet
					? "mx-auto aspect-[816/1000] max-w-md object-cover object-left-top"
					: "h-auto"
			}`}
		/>
	);
}

/**
 * One scene: headline and copy on one side, the visual on the other,
 * alternating on `lg` (`flip`). Stacked, copy first, below that.
 */
function Scene({
	n,
	title,
	badge,
	flip,
	children,
	visual,
}: {
	n: number;
	title: string;
	badge?: string;
	flip?: boolean;
	children: ReactNode;
	visual: ReactNode;
}) {
	return (
		<section
			data-scene={n}
			className="mx-auto grid w-full max-w-6xl items-center gap-8 px-5 py-12 sm:px-8 lg:grid-cols-2 lg:gap-14"
		>
			<div className={flip ? "max-w-xl lg:order-2" : "max-w-xl"}>
				<p className="font-extrabold text-[11.5px] text-[var(--palm)] uppercase tracking-[0.12em]">
					Step {n}
				</p>
				<h2
					className="mt-2 flex flex-wrap items-center gap-3 text-balance font-display font-semibold text-3xl tracking-[-0.018em]"
					style={{ fontVariationSettings: "'opsz' 80" }}
				>
					{title}
					{badge ? (
						<span className="rounded-full bg-warning-strong px-2.5 py-0.5 font-extrabold font-sans text-[11px] text-on-accent-fill uppercase tracking-[0.06em]">
							{badge}
						</span>
					) : null}
				</h2>
				<div className="mt-4 space-y-3 text-[17px] leading-relaxed text-[var(--sea-ink-soft)]">
					{children}
				</div>
			</div>
			<div className={flip ? "lg:order-1" : undefined}>{visual}</div>
		</section>
	);
}

function Tour() {
	return (
		<MarketingShell>
			<main className="flex-1">
				<div className="mx-auto w-full max-w-6xl px-5 pt-10 sm:px-8 lg:pt-16">
					<p className="font-extrabold text-[11.5px] text-[var(--palm)] uppercase tracking-[0.12em]">
						The tour
					</p>
					<h1
						className="mt-3.5 max-w-3xl text-balance font-display font-semibold text-4xl leading-[1.05] tracking-[-0.022em] sm:text-5xl"
						style={{ fontVariationSettings: "'opsz' 120" }}
					>
						One meeting, from sign-up sheet to Best Speaker.
					</h1>
					<p className="mt-5 max-w-2xl text-lg leading-relaxed text-[var(--sea-ink-soft)]">
						Five stops. The drawings are tappable, so go ahead and press things.
						The Ah-Counter isn't listening.
					</p>
				</div>

				<Scene n={1} title="Claim a role in one tap." visual={<ClaimDemo />}>
					<p>
						Members open the meeting link, pick their name, and tap the role
						they want. No account to make and no password to remember.
					</p>
					<p>Open roles are the ones with a button. Try one.</p>
				</Scene>

				<Scene
					n={2}
					flip
					title="The agenda writes itself."
					visual={
						<Shot
							src="/landing/tour-agenda.png"
							sheet
							alt="A printed GavelUp agenda for Harbor City Speakers, a sample club: the meeting's roles, speakers and evaluators laid out on one page."
						/>
					}
				>
					<p>
						Every role a member claims lands on the printed agenda: speakers,
						evaluators, the Timer, all of it. When someone swaps out on Monday
						night, the agenda already knows.
					</p>
					<p>That picture is the real print page, not a mock-up.</p>
				</Scene>

				<Scene
					n={3}
					title="Put it on the screen."
					visual={
						<Shot
							src="/landing/tour-present.png"
							alt="GavelUp's present mode for Harbor City Speakers, a sample club: the agenda shown as a full-screen slide for the projector."
						/>
					}
				>
					<p>
						The same agenda turns into slides for the projector, one tap from
						the meeting page. Need it in PowerPoint? Download it.
					</p>
					<p>
						Open it before the meeting and it keeps working when the room's
						Wi-Fi doesn't.
					</p>
				</Scene>

				<Scene
					n={4}
					flip
					title="Run the room."
					visual={
						<div className="grid gap-4 sm:grid-cols-2">
							<TimerDemo />
							<VoteDemo />
						</div>
					}
				>
					<p>
						The Timer gets a stopwatch on their phone with this meeting's own
						green, yellow and red. When it's time for Best Speaker, everyone
						votes from their seat and the counter sees the tally.
					</p>
					<p>Tap the light to cycle it, then cast a vote.</p>
				</Scene>

				<Scene
					n={5}
					title="Works with your AI assistant."
					badge="Beta"
					visual={<AssistantDemo />}
				>
					<p>
						Connect your assistant and ask it in plain words: fill a role, show
						Thursday's agenda, add the guests from tonight's guest book.
					</p>
				</Scene>

				<section className="mx-auto w-full max-w-6xl px-5 pt-6 pb-16 sm:px-8">
					<div className="max-w-xl rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-6">
						<p className="font-semibold text-[var(--sea-ink)]">
							{PILOT_PRICING_LINE}
						</p>
						<FounderNote className="mt-3" />
						<div className="mt-5">
							<Button asChild size="lg" className="px-6">
								{/* A plain anchor rather than a typed <Link>: /request-access
								    is #866's route, built in parallel, and a <Link to> it
								    would not type-check until that lands. */}
								<a href="/request-access">Request access</a>
							</Button>
						</div>
					</div>
				</section>
			</main>
		</MarketingShell>
	);
}
