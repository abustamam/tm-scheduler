import { useRouter } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { EditSpeechSheet } from "#/components/club/edit-speech-sheet";
import { Button } from "#/components/ui/button";
import { formatArchiveDate } from "#/lib/format";
import { speechLogHeadline } from "#/lib/speech-schedule-state";

/** The speech-log row fields the editor needs (#1159): a structural subset of
 *  `SpeechLogRow`, so this client component imports nothing from the server. */
type SpeechLogEditFields = {
	memberId: string | null;
	speechTitle: string | null;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	projectId: string | null;
	minMinutes: number | null;
	maxMinutes: number | null;
	presentationUrl: string | null;
	introduction: string | null;
};

export type SpeechLogEditRow =
	| (SpeechLogEditFields & {
			kind?: "meeting";
			slotId: string;
			scheduledAt: Date | string;
			roleName: string;
	  })
	| (SpeechLogEditFields & {
			kind: "past";
			speechId: string;
			deliveredYear: number | null;
			deliveredMonth: number | null;
	  });

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
	const onSaved = async () => {
		setOpen(false);
		await router.invalidate();
	};
	if (row.kind === "past") {
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
					writer="past-speech"
					slot={
						open ? pastSlot(row, row.speechId, row.speechTitle ?? "") : null
					}
					onOpenChange={setOpen}
					onSaved={onSaved}
				/>
			</>
		);
	}
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
								})} · ${formatArchiveDate(row.scheduledAt, timezone)}`,
								speechTitle: row.speechTitle,
								pathwayPath: row.pathwayPath,
								projectName: row.projectName,
								projectLevel: row.projectLevel,
								projectId: row.projectId,
								assigneeId: row.memberId,
								minMinutes: row.minMinutes,
								maxMinutes: row.maxMinutes,
								presentationUrl: row.presentationUrl,
								introduction: row.introduction,
							}
						: null
				}
				onOpenChange={setOpen}
				onSaved={onSaved}
			/>
		</>
	);
}

function pastSlot(
	row: Extract<SpeechLogEditRow, { kind: "past" }>,
	speechId: string | null,
	label: string,
) {
	return {
		id: speechId ?? `new-${row.memberId}`,
		label,
		speechTitle: row.speechTitle,
		pathwayPath: row.pathwayPath,
		projectName: row.projectName,
		projectLevel: row.projectLevel,
		projectId: row.projectId,
		assigneeId: row.memberId,
		minMinutes: row.minMinutes,
		maxMinutes: row.maxMinutes,
		presentationUrl: row.presentationUrl,
		introduction: row.introduction,
		past: {
			speechId,
			memberId: row.memberId,
			deliveredYear: row.deliveredYear,
			deliveredMonth: row.deliveredMonth,
		},
	};
}

/**
 * "Add past speech" (#1656): records a speech given outside any meeting for
 * this member. Shown under the same prediction as the pencil; the server
 * (`addPastSpeech`) is the gate.
 */
export function AddPastSpeechButton({
	memberId,
	memberName,
}: {
	memberId: string;
	memberName: string;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => setOpen(true)}
			>
				Add past speech
			</Button>
			<EditSpeechSheet
				writer="past-speech"
				slot={
					open
						? pastSlot(
								{
									kind: "past",
									speechId: "",
									memberId,
									speechTitle: null,
									pathwayPath: null,
									projectName: null,
									projectLevel: null,
									projectId: null,
									minMinutes: null,
									maxMinutes: null,
									presentationUrl: null,
									introduction: null,
									deliveredYear: null,
									deliveredMonth: null,
								},
								null,
								memberName,
							)
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
