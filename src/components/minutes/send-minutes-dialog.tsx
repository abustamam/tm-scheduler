import { Copy, Download, Mail, X } from "lucide-react";
import { useMemo, useState } from "react";
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
import {
	buildMinutesMailto,
	isSingleMailbox,
	MINUTES_MAILTO_WARN_LENGTH,
	minutesBccList,
	partitionMinutesRecipients,
} from "#/lib/minutes-mailto";
import {
	buildMinutesBody,
	buildMinutesSubject,
} from "#/server/minutes-email-logic";

export interface SendMinutesRecipient {
	name: string;
	email: string;
}

export interface SendMinutesDialogProps {
	meetingId: string;
	clubName: string;
	/** The meeting date (drives the default subject + body). */
	meetingDate: Date | string;
	/**
	 * Default recipients (active members + present guests WITH an email),
	 * resolved by #152's Minutes tab (or the `getMinutesRecipients` server fn).
	 * Shown as an editable list; every entry that is one valid mailbox goes in
	 * the draft's bcc, and any that is not is listed as not included.
	 */
	initialRecipients: SendMinutesRecipient[];
	/**
	 * Members/guests WITHOUT an email — surfaced as "no email on file", never a
	 * blocker. Purely informational.
	 */
	skipped?: { name: string }[];
	/** Optional custom trigger; defaults to an "Email the minutes" button. */
	trigger?: React.ReactNode;
}

/** The guest copy of the minutes PDF: no club-internal action items (#529). */
function guestCopyPdfHref(meetingId: string): string {
	return `/api/meetings/${meetingId}/minutes/pdf?view=guests`;
}

/**
 * Admin-only "Email the minutes" control (#165, #903). GavelUp does not send
 * the minutes: every message to a person is sent by a human. So this composes a
 * DRAFT the officer opens in their own mail app — every recipient in bcc, their
 * own subject and body — and hands them the guest copy of the PDF to attach.
 * Nothing is written and there is no "sent" state; the app cannot know whether
 * the officer pressed send.
 */
export function SendMinutesDialog({
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

	// A stored address that is not exactly one mailbox (`a@x.org,b@evil.example`)
	// would become an extra recipient once a mail client decodes it, so the
	// builders leave it out — and the dialog lists it, never dropping it silently.
	const { valid, invalid } = useMemo(
		() => partitionMinutesRecipients(recipients),
		[recipients],
	);
	const defaultSubject = buildMinutesSubject(clubName, date);
	const mailto = useMemo(
		() => buildMinutesMailto({ recipients, subject, defaultSubject, body }),
		[recipients, subject, defaultSubject, body],
	);
	const longLink = mailto.length > MINUTES_MAILTO_WARN_LENGTH;

	function removeRecipient(email: string) {
		setRecipients((prev) => prev.filter((r) => r.email !== email));
	}

	function addRecipient() {
		const email = newEmail.trim();
		if (!isSingleMailbox(email)) {
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

	async function copyAddresses() {
		try {
			await navigator.clipboard.writeText(minutesBccList(recipients));
			toast.success(
				valid.length === 1
					? "Copied 1 address."
					: `Copied ${valid.length} addresses.`,
			);
		} catch {
			toast.error("Couldn't copy — your browser blocked clipboard access");
		}
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{trigger ?? (
					<Button type="button" variant="outline">
						<Mail className="size-4" />
						Email the minutes
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Email the minutes</DialogTitle>
					<DialogDescription>
						You send this from your own email. Download the PDF, then open a
						draft addressed to the club and attach it.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4">
					{/* Step 1 — the attachment */}
					<div className="space-y-1.5">
						<Button asChild variant="outline" size="sm">
							<a href={guestCopyPdfHref(meetingId)} download>
								<Download className="size-4" />
								Download the guest copy (PDF)
							</a>
						</Button>
						<p className="text-muted-foreground text-xs">
							Attach this to your email. It leaves out the club's internal
							action items, because guests are on the list.
						</p>
					</div>

					{/* Recipients */}
					<div className="space-y-2">
						<Label>Recipients, in Bcc ({valid.length})</Label>
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

					{/* Not included — stored address is not one valid mailbox */}
					{invalid.length > 0 ? (
						<div className="space-y-1.5">
							<Label className="text-destructive">
								Not included: invalid address ({invalid.length})
							</Label>
							<ul className="flex flex-col gap-1 text-sm">
								{invalid.map((r) => (
									<li key={r.email}>
										<span className="font-medium">{r.name}</span>{" "}
										<span className="break-all text-muted-foreground">
											{JSON.stringify(r.email)}
										</span>
									</li>
								))}
							</ul>
							<p className="text-muted-foreground text-xs">
								Fix the address on their record, or add a correct one above.
							</p>
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
					</div>

					{longLink ? (
						<output className="block rounded-md border border-border bg-muted px-3 py-2 text-sm">
							Your list is long; if the draft opens without addresses, paste
							them with Copy addresses.
						</output>
					) : null}
				</div>

				<DialogFooter showCloseButton>
					<Button
						type="button"
						variant="outline"
						onClick={() => void copyAddresses()}
						disabled={valid.length === 0}
					>
						<Copy className="size-4" />
						Copy addresses
					</Button>
					{valid.length === 0 ? (
						<Button type="button" disabled>
							<Mail className="size-4" />
							Open email draft
						</Button>
					) : (
						<Button asChild>
							<a href={mailto}>
								<Mail className="size-4" />
								Open email draft
							</a>
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
