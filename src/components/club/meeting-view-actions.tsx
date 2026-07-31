import { Link } from "@tanstack/react-router";
import { ClipboardList, Presentation, Printer, Sparkles } from "lucide-react";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { PptxDownloadButton } from "#/components/club/pptx-download-button";
import { Button } from "#/components/ui/button";
import type { Slide } from "#/lib/agenda-slides";
import { hasWordOfTheDay } from "#/lib/word-poster";

/**
 * Launch buttons for a meeting. They open the public, auth-agnostic standalone
 * pages (which take a club slug + meeting id) in a new tab. Shared by the
 * signed-in agenda and meeting-detail views so their external-launch
 * affordances can't re-diverge (issue #140).
 *
 * When a built `deck` (+ club name) is supplied, a "Download .pptx" action
 * appears beside Present/Print (issue #147) — same ungated visibility. The deck
 * is the same `buildSlideDeck` output present mode renders.
 *
 * The "Word poster" action is the one gated affordance: it appears only when the
 * meeting has a Word of the Day, because with no word there is nothing to print.
 * `wordOfTheDay` is REQUIRED (`string | null`, not optional) for exactly that
 * reason: with one call site, optionality bought nothing and let the whole
 * button disappear for every user if the prop were dropped from the wiring —
 * silently, with typecheck and the full suite green. Required, the compiler
 * pins it.
 */
export function MeetingViewActions({
	clubSlug,
	meetingId,
	printLayout = "grid",
	deck,
	clubName,
	wordOfTheDay,
}: {
	clubSlug: string;
	meetingId: string;
	printLayout?: AgendaLayout;
	deck?: Slide[];
	clubName?: string;
	wordOfTheDay: string | null;
}) {
	return (
		<>
			<Button asChild variant="outline" size="sm">
				<Link
					to="/club/$clubId/meeting/$meetingId/print"
					params={{ clubId: clubSlug, meetingId }}
					search={{ layout: printLayout }}
					target="_blank"
					rel="noopener noreferrer"
				>
					<Printer />
					Print agenda
				</Link>
			</Button>
			<Button asChild variant="outline" size="sm">
				<Link
					to="/club/$clubId/meeting/$meetingId/present"
					params={{ clubId: clubSlug, meetingId }}
					target="_blank"
					rel="noopener noreferrer"
				>
					<Presentation />
					Present
				</Link>
			</Button>
			{/* Club-level, meeting-agnostic printable of the club's roles (#341). */}
			<Button asChild variant="outline" size="sm">
				<Link
					to="/club/$clubId/roles"
					params={{ clubId: clubSlug }}
					target="_blank"
					rel="noopener noreferrer"
				>
					<ClipboardList />
					Role sheet
				</Link>
			</Button>
			{/* Word of the Day wall poster. Hidden when the meeting has no word —
			    there would be nothing to print. Shares `hasWordOfTheDay` with the
			    poster route so the two cannot disagree about whether there is one. */}
			{hasWordOfTheDay(wordOfTheDay) ? (
				<Button asChild variant="outline" size="sm">
					<Link
						to="/club/$clubId/meeting/$meetingId/word"
						params={{ clubId: clubSlug, meetingId }}
						target="_blank"
						rel="noopener noreferrer"
					>
						{/* Same glyph as the Word of the Day chip on the meeting page —
						    one concept, one icon. */}
						<Sparkles />
						Word poster
					</Link>
				</Button>
			) : null}
			{deck && clubName ? (
				<PptxDownloadButton deck={deck} clubName={clubName} />
			) : null}
		</>
	);
}
