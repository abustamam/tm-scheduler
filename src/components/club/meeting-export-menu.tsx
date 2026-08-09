import { Link } from "@tanstack/react-router";
import {
	ClipboardList,
	Download,
	FileDown,
	Loader2,
	Presentation,
	Printer,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { downloadDeckPptx } from "#/components/club/pptx-download-button";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { ROLE_SHEETS } from "#/data/role-sheets";
import type { Slide } from "#/lib/agenda-slides";
import { hasWordOfTheDay } from "#/lib/word-poster";

/**
 * The meeting view's single "Print & export" menu (#541 D2). Replaces the
 * MeetingViewActions chip row + the standalone MeetingRoleSheets popover:
 * every launch/export action lives here, one tap deep, in every phase.
 * Present appears here whenever the toolbar is not already leading with it
 * (deck-testing an upcoming meeting is a real officer behavior), so no
 * capability is ever phase-gated away.
 */
export function MeetingExportMenu({
	clubSlug,
	meetingId,
	dbMeetingId,
	printLayout = "grid",
	deck,
	clubName,
	wordOfTheDay,
	presentIsPrimary,
}: {
	clubSlug: string;
	/** URL key (date or uuid) — used by the print/present/word LINKS. */
	meetingId: string;
	/** Database uuid — used by the per-meeting role-sheet PDF endpoints. */
	dbMeetingId: string;
	printLayout?: AgendaLayout;
	deck?: Slide[];
	clubName?: string;
	wordOfTheDay: string | null;
	/** True when the toolbar already renders Present as the phase primary. */
	presentIsPrimary: boolean;
}) {
	const [sheetsOpen, setSheetsOpen] = useState(false);
	const [pptxBusy, setPptxBusy] = useState(false);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="outline" size="sm">
						<Printer />
						Print & export
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuItem asChild>
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
					</DropdownMenuItem>
					{presentIsPrimary ? null : (
						<DropdownMenuItem asChild>
							<Link
								to="/club/$clubId/meeting/$meetingId/present"
								params={{ clubId: clubSlug, meetingId }}
								target="_blank"
								rel="noopener noreferrer"
							>
								<Presentation />
								Present
							</Link>
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onSelect={() => setSheetsOpen(true)}>
						<FileDown />
						This meeting's role sheets…
					</DropdownMenuItem>
					{/* Club-level, meeting-agnostic printable of the club's roles (#341).
					    "All role sheets" (#542) disambiguates it from the per-meeting
					    download menu above. */}
					<DropdownMenuItem asChild>
						<Link
							to="/club/$clubId/roles"
							params={{ clubId: clubSlug }}
							target="_blank"
							rel="noopener noreferrer"
						>
							<ClipboardList />
							All role sheets
						</Link>
					</DropdownMenuItem>
					{/* Word of the Day wall poster. Hidden when the meeting has no word
					    — there would be nothing to print. Shares `hasWordOfTheDay` with
					    the poster route so the two cannot disagree about whether there
					    is one. */}
					{hasWordOfTheDay(wordOfTheDay) ? (
						<DropdownMenuItem asChild>
							<Link
								to="/club/$clubId/meeting/$meetingId/word"
								params={{ clubId: clubSlug, meetingId }}
								target="_blank"
								rel="noopener noreferrer"
							>
								<Sparkles />
								Word poster
							</Link>
						</DropdownMenuItem>
					) : null}
					{deck && clubName ? (
						<DropdownMenuItem
							disabled={pptxBusy}
							onSelect={(e) => {
								// Keep the menu open while the export runs so the busy
								// spinner is visible; the busy flag guards re-entry.
								e.preventDefault();
								if (pptxBusy) return;
								setPptxBusy(true);
								downloadDeckPptx({ deck, clubName }).finally(() =>
									setPptxBusy(false),
								);
							}}
						>
							{pptxBusy ? <Loader2 className="animate-spin" /> : <Download />}
							Download .pptx
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={sheetsOpen} onOpenChange={setSheetsOpen}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>This meeting's role sheets</DialogTitle>
					</DialogHeader>
					{/* Same public PDF links the retired MeetingRoleSheets popover
					    served (#365: role-sheet PDFs hold only public-agenda data). */}
					<p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
						Pre-filled with your club and this meeting's date. Each sheet
						includes what to say.
					</p>
					<div className="flex flex-col">
						{ROLE_SHEETS.map((sheet) => (
							<Button
								key={sheet.key}
								asChild
								variant="ghost"
								size="sm"
								className="h-auto justify-start px-2 py-1.5 font-normal"
							>
								<a
									href={`/api/meetings/${dbMeetingId}/role-sheets/${sheet.key}/pdf`}
									download
								>
									<FileDown className="text-muted-foreground" />
									{sheet.title}
								</a>
							</Button>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
