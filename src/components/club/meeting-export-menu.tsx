import { Link } from "@tanstack/react-router";
import {
	ChevronDown,
	ClipboardList,
	Download,
	FileDown,
	Presentation,
	Printer,
	Sparkles,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";
import { downloadDeckPptx } from "#/components/club/pptx-download-button";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
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
	// required (not optional) on purpose — optional would let the Word poster
	// affordance vanish for every user if the wiring dropped the prop,
	// silently, with typecheck and suite green (rationale carried from the
	// retired MeetingViewActions).
	wordOfTheDay: string | null;
	/** True when the toolbar already renders Present as the phase primary. */
	presentIsPrimary: boolean;
}) {
	const [sheetsOpen, setSheetsOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button ref={triggerRef} variant="outline" size="sm">
						<Printer />
						Print & export
						<ChevronDown className="opacity-60" />
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
							onSelect={() => {
								// The menu closes on select (Radix default) — a modal menu
								// would hold the whole page pointer-inert for the seconds
								// the ~1MB library download + logo fetch take. Progress
								// lives in a toast instead; downloadDeckPptx surfaces its
								// own failure toast and never rejects.
								const id = toast.loading("Building the PowerPoint file…");
								downloadDeckPptx({ deck, clubName })
									// The helper contractually never rejects (it toasts its own
									// failures); the catch is insurance so a future contract
									// breach can't become an unhandled rejection here.
									.catch(() => {})
									.finally(() => toast.dismiss(id));
							}}
						>
							<Download />
							Download .pptx
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={sheetsOpen} onOpenChange={setSheetsOpen}>
				<DialogContent
					className="sm:max-w-sm"
					onCloseAutoFocus={(e) => {
						// State-controlled dialog has no DialogTrigger, so Radix's
						// default focus-return is a silent no-op that dumps focus on
						// <body>. Return it to the menu trigger ourselves.
						e.preventDefault();
						triggerRef.current?.focus();
					}}
				>
					<DialogHeader>
						<DialogTitle>This meeting's role sheets</DialogTitle>
					</DialogHeader>
					{/* Same public PDF links the retired MeetingRoleSheets popover
					    served (#365: role-sheet PDFs hold only public-agenda data). */}
					<DialogDescription className="px-2 pt-1 pb-1.5 text-xs">
						Pre-filled with your club and this meeting's date. Each sheet
						includes what to say.
					</DialogDescription>
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
