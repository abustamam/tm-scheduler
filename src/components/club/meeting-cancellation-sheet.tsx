// The cancellation notice sheet (#1057): the message an officer sends when a
// meeting is cancelled, naming the date and everyone who held a role, with the
// holders' addresses one tap away.
//
// The app DRAFTS; a human sends (ADR-0028). Both actions here copy text to the
// clipboard — nothing is sent from GavelUp's servers, and there is no mailto:
// because a cancellation goes to the club's own list, which the officer has.
//
// Built HERE with `buildCancellationNotice`, the same builder the
// `cancel_meeting` MCP tool uses, from the holders the route already has on
// its payload: the officer's slot rows carry each member holder's email, so
// nothing is fetched, and a guest is named but gets no address.

import { Copy } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { Textarea } from "#/components/ui/textarea";
import {
	buildCancellationNotice,
	type CancellationHolder,
} from "#/lib/meeting-cancellation-notice";

async function copyText(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(`${what} copied — paste it to share`);
	} catch {
		toast.error("Couldn't copy — your browser blocked clipboard access");
	}
}

export function MeetingCancellationSheet({
	open,
	onOpenChange,
	clubName,
	scheduledAt,
	timezone,
	holders,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	clubName: string;
	scheduledAt: Date | string;
	timezone: string;
	/** In agenda order, as the route derives them from its slot rows. */
	holders: readonly CancellationHolder[];
}) {
	const notice = useMemo(
		() => buildCancellationNotice({ clubName, scheduledAt, timezone, holders }),
		[clubName, scheduledAt, timezone, holders],
	);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
				<SheetHeader>
					<SheetTitle>Cancellation notice</SheetTitle>
					<SheetDescription>
						Everyone keeps their role. Copy this into your club's chat or an
						email so people know not to come. Nothing is sent from GavelUp.
					</SheetDescription>
				</SheetHeader>
				<div className="space-y-4 px-4 pb-6">
					{notice.lines.length > 0 ? (
						<ul
							className="space-y-1 text-sm"
							data-testid="cancellation-holders"
						>
							{notice.lines.map((line) => (
								<li key={line.roleName}>
									<span className="font-medium">{line.roleName}</span>
									{`: ${line.names.join(", ")}`}
								</li>
							))}
						</ul>
					) : (
						<p className="text-muted-foreground text-sm">
							Nobody held a role on this meeting.
						</p>
					)}
					<div className="space-y-1">
						<Label htmlFor="cancellation-text">Message</Label>
						<Textarea
							id="cancellation-text"
							rows={Math.min(14, 4 + notice.lines.length)}
							readOnly
							value={notice.text}
						/>
						<p className="text-muted-foreground text-xs">
							Subject, if you email it: {notice.subject}
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							size="sm"
							onClick={() => copyText(notice.text, "Notice")}
						>
							<Copy className="size-4" aria-hidden /> Copy text
						</Button>
						{/* Members with an address only, de-duplicated by the builder.
						    Disabled rather than hidden when there are none, so the
						    officer sees the affordance exists and why it is idle. */}
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={notice.emails.length === 0}
							onClick={() => copyText(notice.emails.join(", "), "Emails")}
						>
							<Copy className="size-4" aria-hidden /> Copy holders' emails
							{notice.emails.length > 0 ? ` (${notice.emails.length})` : ""}
						</Button>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}
