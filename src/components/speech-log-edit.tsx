import { useRouter } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { EditSpeechSheet } from "#/components/club/edit-speech-sheet";
import { Button } from "#/components/ui/button";
import { formatMeetingDate } from "#/lib/format";
import { speechLogHeadline } from "#/lib/speech-schedule-state";

/** The speech-log row fields the editor needs (#1159): a structural subset of
 *  `SpeechLogRow`, so this client component imports nothing from the server. */
export type SpeechLogEditRow = {
	slotId: string;
	memberId: string | null;
	scheduledAt: Date | string;
	roleName: string;
	speechTitle: string | null;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	projectId: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
	presentationUrl: string | null;
};

/**
 * A pencil on a speech-log row that opens the speech sheet with the
 * `speech-log` writer (`editSpeechFromLog`), which accepts a completed meeting.
 * Whether to render it at all is `mayShowSpeechLogEdit`'s prediction; the
 * server is the gate. `timezone` is the club's, where the page has one.
 */
export function SpeechLogEditButton({
	row,
	timezone,
}: {
	row: SpeechLogEditRow;
	timezone?: string;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="Edit speech details"
				onClick={() => setOpen(true)}
			>
				<Pencil className="size-4" />
			</Button>
			<EditSpeechSheet
				writer="speech-log"
				slot={
					open
						? {
								id: row.slotId,
								label: `${speechLogHeadline({
									speechTitle: row.speechTitle,
									roleName: row.roleName,
								})} · ${formatMeetingDate(row.scheduledAt, timezone)}`,
								speechTitle: row.speechTitle,
								pathwayPath: row.pathwayPath,
								projectName: row.projectName,
								projectLevel: row.projectLevel,
								projectId: row.projectId,
								assigneeId: row.memberId,
								minMinutes: row.minMinutes,
								maxMinutes: row.maxMinutes,
								presentationUrl: row.presentationUrl,
							}
						: null
				}
				onOpenChange={setOpen}
				onSaved={async () => {
					setOpen(false);
					await router.invalidate();
				}}
			/>
		</>
	);
}
