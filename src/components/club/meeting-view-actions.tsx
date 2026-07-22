import { Link } from "@tanstack/react-router";
import { Presentation, Printer } from "lucide-react";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { PptxDownloadButton } from "#/components/club/pptx-download-button";
import { Button } from "#/components/ui/button";
import type { Slide } from "#/lib/agenda-slides";

/**
 * Print + Present launch buttons for a meeting. Both open the public,
 * auth-agnostic standalone pages (which take a club slug + meeting id) in a new
 * tab. Shared by the signed-in agenda and meeting-detail views so their
 * external-launch affordances can't re-diverge (issue #140).
 *
 * When a built `deck` (+ club name) is supplied, a "Download .pptx" action
 * appears beside Present/Print (issue #147) — same ungated visibility. The deck
 * is the same `buildSlideDeck` output present mode renders.
 */
export function MeetingViewActions({
	clubSlug,
	meetingId,
	printLayout = "grid",
	deck,
	clubName,
}: {
	clubSlug: string;
	meetingId: string;
	printLayout?: AgendaLayout;
	deck?: Slide[];
	clubName?: string;
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
			{deck && clubName ? (
				<PptxDownloadButton deck={deck} clubName={clubName} />
			) : null}
		</>
	);
}
