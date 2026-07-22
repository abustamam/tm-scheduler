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
 * pre-filled with this meeting's club, date, and scheduled speakers from
 * `/api/meetings/$id/role-sheets/$sheet/pdf` (member-gated). Client-safe: imports
 * only the registry in `#/data/role-sheets`, never the react-pdf layout. Lives on
 * the signed-in meeting view only, so the member-gated download is never shown to
 * anonymous guests.
 */
export function MeetingRoleSheets({ meetingId }: { meetingId: string }) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm">
					<FileDown />
					Role sheets
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 p-2">
				<p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
					Pre-filled with this meeting's date & speakers.
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
