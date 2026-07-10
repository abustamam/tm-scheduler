import { useMutation } from "@tanstack/react-query";
import { Mail, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { sendMeetingMinutesEmail } from "#/server/minutes-email";
import {
	buildMinutesBody,
	buildMinutesSubject,
} from "#/server/minutes-email-logic";

export interface SendMinutesRecipient {
	name: string;
	email: string;
}

export interface SendMinutesDialogProps {
	clubId: string;
	meetingId: string;
	clubName: string;
	/** The meeting date (drives the default subject + attachment filename). */
	meetingDate: Date | string;
	/**
	 * Default recipients (active members + present guests WITH an email),
	 * resolved by #152's Minutes tab (or the `getMinutesRecipients` server fn).
	 * Shown as an editable to-list.
	 */
	initialRecipients: SendMinutesRecipient[];
	/**
	 * Members/guests WITHOUT an email — surfaced as "no email on file", never a
	 * blocker. Purely informational.
	 */
	skipped?: { name: string }[];
	/** Optional custom trigger; defaults to a "Send minutes" button. */
	trigger?: React.ReactNode;
}

function isEmailish(value: string): boolean {
	const v = value.trim();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * Admin-only "Send minutes" control (#165). Self-contained so #152's Minutes
 * tab can drop it in: it takes the resolved recipient list as a prop and, on
 * send, calls the admin-gated `sendMeetingMinutesEmail` server fn (which renders
 * the #152 PDF and attaches it). The parent is responsible for only rendering
 * this for admins — the server fn re-checks the admin role regardless.
 */
export function SendMinutesDialog({
	clubId,
	meetingId,
	clubName,
	meetingDate,
	initialRecipients,
	skipped = [],
	trigger,
}: SendMinutesDialogProps) {
	const date =
		typeof meetingDate === "string" ? new Date(meetingDate) : meetingDate;
	const [open, setOpen] = useState(false);
	const [recipients, setRecipients] =
		useState<SendMinutesRecipient[]>(initialRecipients);
	const [newEmail, setNewEmail] = useState("");
	const [subject, setSubject] = useState(() =>
		buildMinutesSubject(clubName, date),
	);
	const [body, setBody] = useState(() => buildMinutesBody(clubName, date));

	const sendMutation = useMutation({
		mutationFn: () =>
			sendMeetingMinutesEmail({
				data: {
					clubId,
					meetingId,
					recipients: recipients.map((r) => ({ name: r.name, email: r.email })),
					subject: subject.trim() || undefined,
					body,
				},
			}),
	});

	function removeRecipient(email: string) {
		setRecipients((prev) => prev.filter((r) => r.email !== email));
	}

	function addRecipient() {
		const email = newEmail.trim();
		if (!isEmailish(email)) {
			toast.error("Enter a valid email address.");
			return;
		}
		if (recipients.some((r) => r.email.toLowerCase() === email.toLowerCase())) {
			toast.error("That address is already on the list.");
			setNewEmail("");
			return;
		}
		setRecipients((prev) => [...prev, { name: email, email }]);
		setNewEmail("");
	}

	async function handleSend() {
		if (recipients.length === 0 || sendMutation.isPending) return;
		try {
			const result = await sendMutation.mutateAsync();
			const sentCount = result.sent.length;
			toast.success(
				sentCount === 1
					? "Minutes sent to 1 recipient."
					: `Minutes sent to ${sentCount} recipients.`,
			);
			setOpen(false);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't send the minutes.",
			);
		}
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{trigger ?? (
					<Button type="button" variant="outline">
						<Mail className="size-4" />
						Send minutes
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Send minutes</DialogTitle>
					<DialogDescription>
						Email the minutes PDF to the club. Remove anyone you don't want, or
						add extra addresses.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					{/* Recipients */}
					<div className="space-y-2">
						<Label>Recipients ({recipients.length})</Label>
						{recipients.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								No recipients — add at least one address below.
							</p>
						) : (
							<ul className="flex max-h-40 flex-col gap-1.5 overflow-y-auto rounded-md border border-border p-2">
								{recipients.map((r) => (
									<li
										key={r.email}
										className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-accent"
									>
										<span className="flex min-w-0 flex-col">
											<span className="truncate font-medium text-foreground">
												{r.name}
											</span>
											{r.name !== r.email ? (
												<span className="truncate text-muted-foreground text-xs">
													{r.email}
												</span>
											) : null}
										</span>
										<button
											type="button"
											aria-label={`Remove ${r.name}`}
											onClick={() => removeRecipient(r.email)}
											className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
										>
											<X className="size-4" />
										</button>
									</li>
								))}
							</ul>
						)}
						<div className="flex gap-2">
							<Input
								type="email"
								placeholder="add another address…"
								value={newEmail}
								onChange={(e) => setNewEmail(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										addRecipient();
									}
								}}
								autoComplete="off"
							/>
							<Button
								type="button"
								variant="secondary"
								onClick={addRecipient}
								disabled={!newEmail.trim()}
							>
								Add
							</Button>
						</div>
					</div>

					{/* Skipped — no email on file */}
					{skipped.length > 0 ? (
						<div className="space-y-1.5">
							<Label className="text-muted-foreground">
								No email on file ({skipped.length}) — skipped
							</Label>
							<div className="flex flex-wrap gap-1.5">
								{skipped.map((s) => (
									<Badge key={s.name} variant="outline">
										{s.name}
									</Badge>
								))}
							</div>
						</div>
					) : null}

					{/* Subject */}
					<div className="space-y-2">
						<Label htmlFor="minutes-subject">Subject</Label>
						<Input
							id="minutes-subject"
							value={subject}
							onChange={(e) => setSubject(e.target.value)}
						/>
					</div>

					{/* Body */}
					<div className="space-y-2">
						<Label htmlFor="minutes-body">Message</Label>
						<Textarea
							id="minutes-body"
							value={body}
							onChange={(e) => setBody(e.target.value)}
							rows={5}
						/>
						<p className="text-muted-foreground text-xs">
							The minutes PDF is attached automatically.
						</p>
					</div>
				</div>

				<DialogFooter showCloseButton>
					<Button
						type="button"
						onClick={() => void handleSend()}
						disabled={recipients.length === 0 || sendMutation.isPending}
					>
						{sendMutation.isPending
							? "Sending…"
							: `Send to ${recipients.length}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
