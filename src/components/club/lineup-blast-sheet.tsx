// The Lineup blast sheet (#1024): one message listing every role on the
// meeting in agenda order, marked confirmed, claimed (left blank, the prompt to
// confirm) or open.
//
// The app DRAFTS; a human sends. Every action here copies text or opens the
// person's own mail app — nothing is sent from GavelUp's servers.
//
// The server returns the data the draft is built from, and the draft is built
// HERE with `buildLineupBlast`, the same builder `get_lineup_blast` uses, so the
// button and the connector cannot draft different messages. The #731 rule
// holds in this file too: it never names the meeting's video-call field, and
// `lineup-blast.test.ts` sweeps it raw to hold that.

import { Copy, Loader2, Mail } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
	buildLineupBlast,
	CONFIRMED_MARK,
	type LineupBlastData,
	lineupMailtoHref,
} from "#/lib/lineup-blast";
import { getLineupBlast } from "#/server/lineup-blast";

async function copyText(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(`${what} copied — paste it to share`);
	} catch {
		toast.error("Couldn't copy — your browser blocked clipboard access");
	}
}

/** Copy as rich text where the browser supports it, so a paste into Gmail or
 *  Outlook keeps the yellow "Confirmed" highlight and the red "needed" text;
 *  plain text otherwise. */
async function copyRich(html: string, text: string, what: string) {
	try {
		if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
			await navigator.clipboard.write([
				new ClipboardItem({
					"text/html": new Blob([html], { type: "text/html" }),
					"text/plain": new Blob([text], { type: "text/plain" }),
				}),
			]);
			toast.success(`${what} copied — paste it into your email`);
			return;
		}
	} catch {
		// fall through to plain text
	}
	await copyText(text, what);
}

export function LineupBlastSheet({
	open,
	onOpenChange,
	meetingId,
	selfMemberId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	meetingId: string;
	/** The viewer's roster id, for the Toastmaster arm of the server's check. */
	selfMemberId: string | null;
}) {
	const [data, setData] = useState<LineupBlastData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [origin, setOrigin] = useState("");

	useEffect(() => {
		if (!open) return;
		setOrigin(window.location.origin);
		let cancelled = false;
		setError(null);
		getLineupBlast({ data: { meetingId, selfMemberId } })
			.then((d) => {
				if (!cancelled) setData(d);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(
						err instanceof Error ? err.message : "Something went wrong.",
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [open, meetingId, selfMemberId]);

	const blast = useMemo(
		() => (data ? buildLineupBlast(data, origin) : null),
		[data, origin],
	);

	function openMail() {
		if (!blast) return;
		const href = lineupMailtoHref(blast);
		if (!href) {
			void copyText(
				`${blast.subject}\n\n${blast.text}`,
				"Too long for a mail link — the subject and body were",
			);
			return;
		}
		window.location.href = href;
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
				<SheetHeader>
					<SheetTitle>Lineup blast</SheetTitle>
					<SheetDescription>
						Every role, and who has it. Copy it into your club's chat or an
						email. Nothing is sent from GavelUp.
					</SheetDescription>
				</SheetHeader>
				<div className="space-y-4 px-4 pb-6">
					{error ? (
						<p className="text-destructive text-sm">{error}</p>
					) : !blast ? (
						<p className="flex items-center gap-2 text-muted-foreground text-sm">
							<Loader2 className="size-4 animate-spin" /> Loading…
						</p>
					) : (
						<>
							<ul className="space-y-1 text-sm" data-testid="lineup-preview">
								{blast.lines.map((line, i) => (
									<li
										// Labels repeat for an unordered role; the index is the
										// slot's place in agenda order, which is stable here.
										// biome-ignore lint/suspicious/noArrayIndexKey: see above
										key={i}
									>
										<span className="font-medium">{line.label}</span>
										{" – "}
										{line.state === "open" ? (
											<span className="text-red-700 dark:text-red-400">
												Needed
											</span>
										) : (
											<>
												{line.name}
												{" – "}
												{line.state === "confirmed" ? (
													<span className="rounded-sm bg-yellow-200 px-1 text-yellow-950">
														{CONFIRMED_MARK}
													</span>
												) : null}
											</>
										)}
									</li>
								))}
							</ul>
							{blast.openCount > 0 ? (
								<p className="text-red-700 text-sm dark:text-red-400">
									{blast.openCount === 1
										? "1 role still open"
										: `${blast.openCount} roles still open`}
								</p>
							) : null}
							<div className="space-y-1">
								<Label htmlFor="lineup-text">Message</Label>
								<Textarea
									id="lineup-text"
									rows={14}
									readOnly
									value={blast.text}
								/>
							</div>
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									size="sm"
									onClick={() => copyText(blast.text, "Lineup")}
								>
									<Copy className="size-4" aria-hidden /> Copy for WhatsApp
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => copyRich(blast.html, blast.text, "Lineup")}
								>
									<Copy className="size-4" aria-hidden /> Copy for email
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={openMail}
								>
									<Mail className="size-4" aria-hidden /> Open in mail app
								</Button>
							</div>
						</>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
