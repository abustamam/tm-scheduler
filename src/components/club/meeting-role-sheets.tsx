import { FileDown } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { ROLE_SHEETS } from "#/data/role-sheets";

/**
 * "Role sheets" download menu for a meeting (#311). Each item downloads a PDF
 * pre-filled with this meeting's club and date — plus the booked speakers on the
 * Timer's log and the Word of the Day on the Grammarian's — from
 * `/api/meetings/$id/role-sheets/$sheet/pdf` (public — the sheet holds only
 * public-agenda data, no contact/minutes). Client-safe: imports only the registry
 * in `#/data/role-sheets`, never the react-pdf layout. Shown to every audience on
 * the canonical meeting page (#317/#365).
 *
 * Every sheet also carries a "What to say" script (#509), so the holder can read
 * their part aloud instead of having to already know it.
 */
export function MeetingRoleSheets({ meetingId }: { meetingId: string }) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				{/* "This meeting's role sheets" (#542): disambiguates from the
				    club-level "All role sheets" link rendered beside it — these PDFs
				    are pre-filled with THIS meeting's club, date and speakers. */}
				<Button variant="outline" size="sm">
					<FileDown />
					This meeting's role sheets
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 p-2">
				{/* #509: no longer promises "& speakers". Only the Timer's log is
				    pre-filled with them now, and saying so here implied every sheet
				    was a list of the booked speakers — which is the misreading that
				    had Ah-Counters tallying three names and missing the meeting. */}
				<p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
					Pre-filled with your club and this meeting's date. Each sheet includes
					what to say.
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
								href={`/api/meetings/${meetingId}/role-sheets/${sheet.key}/pdf`}
								download
							>
								<FileDown className="text-muted-foreground" />
								{sheet.title}
							</a>
						</Button>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
