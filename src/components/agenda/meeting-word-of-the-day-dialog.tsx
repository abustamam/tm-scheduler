import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { updateWordOfTheDay } from "#/server/meetings";

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * Grammarian's focused Word-of-the-Day editor — word, definition, and example
 * only (#296). Distinct from the TMOD's full meeting-meta dialog: the grammarian
 * owns the WOD but not the rest of the agenda meta, so this is all they can edit.
 * Lifted from the public route into the shared agenda so both meeting surfaces
 * inherit it (#302).
 */
export function MeetingWordOfTheDayDialog({
	open,
	onOpenChange,
	meeting,
	actorMemberId,
	selfMemberId,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	meeting: {
		id: string;
		wordOfTheDay: string | null;
		wodDefinition: string | null;
		wodExample: string | null;
	};
	actorMemberId: string | null;
	selfMemberId: string | null;
	onSaved: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		setSubmitting(true);
		try {
			await updateWordOfTheDay({
				data: {
					meetingId: meeting.id,
					actorMemberId,
					selfMemberId,
					wordOfTheDay:
						String(form.get("wordOfTheDay") ?? "").trim() || undefined,
					wodDefinition:
						String(form.get("wodDefinition") ?? "").trim() || undefined,
					wodExample: String(form.get("wodExample") ?? "").trim() || undefined,
				},
			});
			toast.success("Word of the day updated.");
			await onSaved();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Word of the day</DialogTitle>
					<DialogDescription>
						As Grammarian you can set the Word of the Day, its definition, and
						an example sentence for the meeting.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="wordOfTheDay">Word of the day</Label>
						<Input
							id="wordOfTheDay"
							name="wordOfTheDay"
							defaultValue={meeting.wordOfTheDay ?? ""}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="wodDefinition">Definition</Label>
						<Input
							id="wodDefinition"
							name="wodDefinition"
							defaultValue={meeting.wodDefinition ?? ""}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="wodExample">Example sentence</Label>
						<Input
							id="wodExample"
							name="wodExample"
							defaultValue={meeting.wodExample ?? ""}
						/>
					</div>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={submitting}>
								Cancel
							</Button>
						</DialogClose>
						<Button type="submit" disabled={submitting}>
							{submitting ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								"Save changes"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
