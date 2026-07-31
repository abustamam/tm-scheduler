// src/routes/club.$clubId_.meeting.$meetingId.word.tsx
//
// The Word of the Day poster: one letter-portrait sheet with the meeting's word
// in display type, for taping to the wall so the room can read it all meeting.
//
// PUBLIC, like the sibling /print and /present routes — it shows only what the
// public agenda already shows. The `$clubId_` escape renders it standalone,
// outside the club shell.
//
// The URL segment is deliberately the short `/word`, not `/word-of-the-day`:
// it is shorter to share and to say aloud in a meeting ("slash word"), and it
// matches the single-word `/print` and `/present` siblings. The `PdfArtifact`
// key below spells out `word-of-the-day` because that one is read off a saved
// file long after the fact, where the extra length is what disambiguates it
// from an agenda. The mismatch is intentional, not an oversight.
//
// Offline works for free: `isOfflineRoute` in public/sw.js matches
// /^\/club\/[^/]+\/meeting\//, which this path already satisfies.
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { LAGOON, SANS } from "#/components/agenda/print-theme";
import { WordOfTheDayPoster } from "#/components/agenda/word-of-the-day-poster";
import { PublicFooter } from "#/components/public-footer";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import { meetingPdfBasename } from "#/lib/pdf-filename";
import { hasWordOfTheDay } from "#/lib/word-poster";
import { getPublicMeetingByKey } from "#/server/meetings";

export const Route = createFileRoute("/club/$clubId_/meeting/$meetingId/word")({
	loader: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		// An unknown meeting key is a 404, not a 500: `getPublicMeetingByKey`
		// signals it by throwing, and without this the visitor gets the error
		// boundary instead of the router's not-found page. Same translation the
		// canonical meeting route does.
		const data = await getPublicMeetingByKey({
			data: { clubId: club.id, key: params.meetingId },
		}).catch((err) => {
			if (isMeetingNotFoundError(err)) throw notFound();
			throw err;
		});
		if (data.meeting.clubId !== club.id) throw notFound();
		return data;
	},
	component: WordPoster,
	// The <title> becomes the browser's default "Save as PDF" filename. The
	// "word-of-the-day" artifact keeps the saved file from being mistaken for an
	// agenda. loaderData is absent during the pending state → fallback.
	head: ({ loaderData }) => ({
		meta: [
			{
				title: loaderData
					? meetingPdfBasename(
							loaderData.clubName,
							loaderData.meeting.scheduledAt,
							loaderData.timezone,
							"word-of-the-day",
						)
					: "Word of the Day — GavelUp",
			},
			{ name: "robots", content: "noindex, nofollow" },
		],
	}),
});

function WordPoster() {
	const { clubId: clubIdParam, meetingId } = Route.useParams();
	const { meeting, timezone, clubName } = Route.useLoaderData();

	const word = meeting.wordOfTheDay;

	// Reached only by a typed or shared URL — the button will be hidden when there
	// is no word. Offer the way back rather than a blank sheet to print.
	//
	// This branch renders no poster, and so none of the poster's dark footer
	// either. It is still a public club surface, so it renders <PublicFooter /> to
	// carry the TI non-affiliation disclaimer (#381) — pinned by
	// public-disclaimer.guard.test.ts, which strips comments before matching.
	//
	// `hasWordOfTheDay` is a type predicate, so this narrows `word` to `string`
	// for the poster's `word` prop below — no cast.
	if (!hasWordOfTheDay(word)) {
		return (
			<>
				{/* The back link is the one control that gets a stranded visitor off a
				    dead-end page, so it has to answer the pointer. It cannot do that
				    from an inline style — `:hover` has no inline form, and an inline
				    colour outranks the stylesheet — and it cannot do it from a Tailwind
				    utility either: styles.css's bare `a` rule is UNLAYERED, so it beats
				    any layered utility. Hence an unlayered rule of the same specificity,
				    later in the document, which wins on source order.

				    Resting stays `--lagoon-ink` (measured 5.49:1 light / 12.75:1 dark);
				    hover goes to `--sea-ink`, which is a visible move in BOTH themes —
				    `--lagoon-ink` and `--lagoon-deep` are the same value in dark mode,
				    so the global rule's own hover would have been a no-op there. */}
				<style>{`
					a.wod-back { color: var(--lagoon-ink); }
					a.wod-back:hover {
						color: var(--sea-ink);
						text-decoration-color: currentColor;
					}
				`}</style>
				<div style={emptyWrapStyle}>
					{/* The only content on the page, so it is the page's heading. */}
					<h1 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>
						No Word of the Day set for this meeting yet.
					</h1>
					<Link
						to="/club/$clubId/meeting/$meetingId"
						params={{ clubId: clubIdParam, meetingId }}
						className="wod-back"
						style={{ fontWeight: 700, fontSize: 14 }}
					>
						← Back to the meeting
					</Link>
				</div>
				<PublicFooter />
			</>
		);
	}

	const dateLong = new Intl.DateTimeFormat(undefined, {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: timezone,
	}).format(new Date(meeting.scheduledAt));

	return (
		<div>
			<div className="no-print" style={toolbarStyle}>
				<button
					type="button"
					onClick={() => window.print()}
					style={printBtnStyle}
				>
					Print
				</button>
			</div>
			<style>{`
				@media screen { body { background: #d8e6dd; } }
				.pgwrap { padding: 28px 0; }
				@media print {
					.no-print { display: none !important; }
					body { background: #fff; }
					/* Required, not cosmetic: @page has margin 0, so the screen-only
					   28px padding would push 28 + 1056 + 28 = 1112px into a 1056px
					   page box and emit a blank second sheet. body has margin 0
					   (styles.css) and nothing else absorbs it. Both sibling print
					   routes carry this same reset. */
					.pgwrap { padding: 0 !important; }
					.agenda-page { box-shadow: none !important; }
					@page { size: letter portrait; margin: 0; }
				}
			`}</style>
			<div
				className="pgwrap"
				style={{ display: "flex", justifyContent: "center" }}
			>
				<WordOfTheDayPoster
					word={word}
					definition={meeting.wodDefinition}
					example={meeting.wodExample}
					clubName={clubName}
					dateLong={dateLong}
				/>
			</div>
		</div>
	);
}

// The no-word branch is a SCREEN surface, not a sheet: its <style> block only
// carries the back link's hover state, so it keeps the app's background and
// must use the app's theme tokens throughout — no print-page CSS here.
// The print palette's INK is a fixed near-black meant for white paper — on the
// dark-mode background it lands at 1.52:1 and is effectively invisible, while
// the public footer right below it (which does use tokens) stays readable.
// Dark mode auto-applies from prefers-color-scheme for a visitor with no stored
// preference, which is most of this public route's audience.
const emptyWrapStyle: React.CSSProperties = {
	minHeight: "60vh",
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	justifyContent: "center",
	gap: 12,
	color: "var(--sea-ink)",
	fontFamily: SANS,
	textAlign: "center",
	padding: 24,
};

const toolbarStyle: React.CSSProperties = {
	position: "fixed",
	top: 12,
	right: 12,
	zIndex: 10,
	display: "flex",
	gap: 8,
	alignItems: "center",
	background: "#fff",
	borderRadius: 10,
	padding: 6,
	boxShadow: "0 6px 20px rgba(23,58,64,.18)",
};

const printBtnStyle: React.CSSProperties = {
	padding: "6px 14px",
	background: LAGOON,
	color: "#fff",
	border: 0,
	borderRadius: 7,
	fontSize: 13,
	fontWeight: 700,
	cursor: "pointer",
};
