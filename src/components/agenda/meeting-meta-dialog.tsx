import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
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
import { normalizePresentationUrl } from "#/lib/presentation-url";
import { type getMeeting, updateMeeting } from "#/server/meetings";
import { meetingUpdateFromForm } from "./meeting-meta-form";

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/** What a non-empty video-call link that normalizes to null is told (#731).
 *  Names the two shapes that get typed into a link field and are not links —
 *  a placeholder word, and a non-http scheme. */
export const JOIN_URL_ERROR =
	"That doesn't look like a link. Paste the full meeting URL, e.g. https://zoom.us/j/1234567890.";

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
	selfMemberId,
	canReschedule,
	effectiveMeetingNumber = null,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	meeting: Awaited<ReturnType<typeof getMeeting>>["meeting"];
	timezone: string;
	selfMemberId: string | null;
	canReschedule: boolean;
	/** The meeting's EFFECTIVE number (stored or derived, #358) — shown as the
	 *  placeholder so an admin can see what automatic numbering would produce. */
	effectiveMeetingNumber?: number | null;
	onSaved: () => void | Promise<void>;
}) {
	const [submitting, setSubmitting] = useState(false);
	const [joinUrlError, setJoinUrlError] = useState<string | null>(null);

	/**
	 * #731. The join-link INPUT is uncontrolled, like every other field here, and
	 * that is load-bearing rather than stylistic.
	 *
	 * This component is mounted whenever the viewer may edit meta — see
	 * `meeting-agenda.tsx` — not when the dialog opens, so state declared out here
	 * lives for the lifetime of the meeting page. Radix unmounts `DialogContent`'s
	 * children on close, so an uncontrolled input re-reads the row on every open;
	 * a `useState(meeting.joinUrl ?? "")` does not. Since this field is sent on
	 * EVERY save, holding it in state meant a cancelled edit came back and won:
	 * clear the field, press Cancel, reopen, save a theme, and the club's join
	 * link is gone. It also never picked up a link saved by anyone else.
	 *
	 * The error MESSAGE still lives out here, because the submit handler has to be
	 * able to raise it, so it is the one thing that needs resetting by hand.
	 */
	useEffect(() => {
		if (!open) setJoinUrlError(null);
	}, [open]);

	/** The same validator the server stores through (`normalizePresentationUrl`),
	 *  run here only so a typo is caught before the round trip. Blank is always
	 *  fine — it CLEARS the link, which is a legitimate edit. */
	function checkJoinUrl(value: string): boolean {
		const ok = !value.trim() || normalizePresentationUrl(value) !== null;
		setJoinUrlError(ok ? null : JOIN_URL_ERROR);
		return ok;
	}

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const joinUrl = String(form.get("joinUrl") ?? "").trim();
		// Refuse the save rather than silently storing null: the server normalizes
		// "tbd" to null too, so without this the officer's typo would look saved
		// and the link would simply be gone.
		if (!checkJoinUrl(joinUrl)) {
			toast.error(JOIN_URL_ERROR);
			return;
		}
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
				data: {
					...meetingUpdateFromForm(form, {
						meetingId: meeting.id,
						selfMemberId,
						scheduledAt,
					}),
					// ALWAYS sent, blank included (#731). `updateMeeting` is a full
					// REPLACE, so `""` is how the officer clears the link — omitting it
					// would clear it too, but then there would be no way to keep one.
					//
					// Read off the same `form` as everything else.
					// `meetingUpdateFromForm` builds the fields this dialog has always
					// had and does not know about this one; the key is spread last, so
					// it stays correct if that ever changes.
					joinUrl,
				},
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
							{/* #358 — admin-only, and deliberately pre-filled from the
							    STORED number only: leaving it blank keeps the meeting on
							    automatic numbering instead of freezing today's guess. */}
							<div className="space-y-2">
								<Label htmlFor="meetingNumber">Meeting number</Label>
								<Input
									id="meetingNumber"
									name="meetingNumber"
									type="number"
									min={1}
									step={1}
									defaultValue={meeting.meetingNumber ?? ""}
									placeholder={
										effectiveMeetingNumber != null
											? String(effectiveMeetingNumber)
											: undefined
									}
								/>
								<p className="text-muted-foreground text-xs">
									{effectiveMeetingNumber != null &&
									meeting.meetingNumber == null
										? `Leave blank to number automatically — this is currently meeting #${effectiveMeetingNumber}.`
										: "Leave blank to number automatically from the club's last numbered meeting."}
								</p>
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
					{/* #731 — a sibling of Location, never a replacement for it: a
					    hybrid club fills in both, and an online-only club leaves
					    Location blank. Deliberately NOT shown on /print, /present,
					    /word or the .pptx export; see the column's comment in
					    `schema.ts`. */}
					<div className="space-y-2">
						<Label htmlFor="joinUrl">Video call link</Label>
						<Input
							id="joinUrl"
							name="joinUrl"
							// NOT type="url". The browser's own validation rejects a bare
							// host, and `normalizePresentationUrl` deliberately ACCEPTS one
							// (coercing it to https://) — so the native tooltip would block
							// the submit on a value the app handles perfectly well, with a
							// message this dialog cannot phrase.
							type="text"
							inputMode="url"
							placeholder="https://zoom.us/j/…"
							defaultValue={meeting.joinUrl ?? ""}
							onChange={() => {
								// Clear a standing error as soon as the officer edits, so the
								// message never contradicts what is on screen.
								if (joinUrlError) setJoinUrlError(null);
							}}
							onBlur={(e) => checkJoinUrl(e.target.value)}
							aria-invalid={joinUrlError ? true : undefined}
							aria-describedby={joinUrlError ? "joinUrl-error" : undefined}
						/>
						{joinUrlError ? (
							<p id="joinUrl-error" className="text-destructive text-xs">
								{joinUrlError}
							</p>
						) : (
							<p className="text-muted-foreground text-xs">
								Shown to members on the meeting page and in role reminder
								emails. Left off the printout, slides and poster.
							</p>
						)}
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
							Organizer notes — not shown on the agenda, printout, or slides.
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
