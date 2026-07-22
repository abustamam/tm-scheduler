import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { utcToZonedWallTime } from "#/lib/datetime";
import { type getMeeting, updateMeeting } from "#/server/meetings";
import { meetingUpdateFromForm } from "./meeting-meta-form";

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * The shared "Edit meeting" dialog — theme, location, Word of the Day + its
 * definition/example, notes, and (admins only) date/time + length. Merged from
 * the authed admin dialog and the public TMOD meta dialog into one component
 * (#302), gated upstream by `viewer.canEditMeetingMeta` and shown with the
 * reschedule fields only when `canReschedule` (admin). A self-serve TMOD
 * (`canReschedule=false`) never sees the date/time or length fields and
 * re-submits the meeting's current wall time unchanged, so the server's
 * meta-only path accepts it as a no-op — reschedule stays admin-only (ADR-0010).
 */
export function MeetingMetaDialog({
	open,
	onOpenChange,
	meeting,
	timezone,
	actorMemberId,
	selfMemberId,
	canReschedule,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	meeting: Awaited<ReturnType<typeof getMeeting>>["meeting"];
	timezone: string;
	actorMemberId: string | null;
	selfMemberId: string | null;
	canReschedule: boolean;
	onSaved: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		// Admins pick the date/time from the form. A self-serve TMOD has no such
		// field, so re-submit the meeting's current wall time unchanged — the
		// server treats a same-minute value as a no-op, not a reschedule.
		const scheduledAt = canReschedule
			? String(form.get("scheduledAt") ?? "")
			: utcToZonedWallTime(new Date(meeting.scheduledAt), timezone);
		if (canReschedule && !scheduledAt) {
			toast.error("Date & time is required.");
			return;
		}
		setSubmitting(true);
		try {
			await updateMeeting({
				data: meetingUpdateFromForm(form, {
					meetingId: meeting.id,
					actorMemberId,
					selfMemberId,
					scheduledAt,
				}),
			});
			toast.success("Meeting updated.");
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
					<DialogTitle>Edit meeting</DialogTitle>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					{canReschedule ? (
						<>
							<div className="space-y-2">
								<Label htmlFor="scheduledAt">Date &amp; time</Label>
								<Input
									id="scheduledAt"
									name="scheduledAt"
									type="datetime-local"
									required
									defaultValue={utcToZonedWallTime(
										new Date(meeting.scheduledAt),
										timezone,
									)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="lengthMinutes">Length (minutes)</Label>
								<Input
									id="lengthMinutes"
									name="lengthMinutes"
									type="number"
									min={1}
									step={1}
									defaultValue={meeting.lengthMinutes}
								/>
							</div>
						</>
					) : null}
					<div className="space-y-2">
						<Label htmlFor="theme">Theme</Label>
						<Input id="theme" name="theme" defaultValue={meeting.theme ?? ""} />
					</div>
					<div className="space-y-2">
						<Label htmlFor="location">Location</Label>
						<Input
							id="location"
							name="location"
							defaultValue={meeting.location ?? ""}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="wordOfTheDay">Word of the day</Label>
						<Input
							id="wordOfTheDay"
							name="wordOfTheDay"
							defaultValue={meeting.wordOfTheDay ?? ""}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="wodDefinition">Word of the day — definition</Label>
						<Input
							id="wodDefinition"
							name="wodDefinition"
							defaultValue={meeting.wodDefinition ?? ""}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="wodExample">
							Word of the day — example sentence
						</Label>
						<Input
							id="wodExample"
							name="wodExample"
							defaultValue={meeting.wodExample ?? ""}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="reminders">Announcements</Label>
						<Textarea
							id="reminders"
							name="reminders"
							rows={3}
							defaultValue={meeting.reminders ?? ""}
						/>
						<p className="text-xs text-muted-foreground">
							Shown publicly on the agenda, printout, and slides — visible to
							guests. One per line.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="notes">Notes</Label>
						<Input id="notes" name="notes" defaultValue={meeting.notes ?? ""} />
						<p className="text-xs text-muted-foreground">
							Private — only visible to organizers.
						</p>
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
