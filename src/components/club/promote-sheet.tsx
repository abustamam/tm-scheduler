// The Promote sheet (#931): drafts a WhatsApp message, an email and a flyer
// for a meeting from the club's blast template.
//
// The app DRAFTS; a human sends. Every action here copies text, hands it to
// the device's own share sheet, or opens the officer's own mail app — nothing
// is sent from GavelUp's servers, so there is no mailing list or consent store
// behind it.
//
// Every draft is editable once before copying. Edits live in this sheet only:
// they never change the template, and they reset when another meeting is
// picked. The #731 source guard sweeps this file raw, so
// it never names the meeting's video-call field; the drafts carry the public
// meeting page, which is where that link lives.

import { Link } from "@tanstack/react-router";
import { Copy, Loader2, Mail, Printer, Share2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { FlyerSquareExport } from "#/components/agenda/flyer-square-export";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { Textarea } from "#/components/ui/textarea";
import { escapeHtml } from "#/lib/html-escape";
import {
	buildEmailBlast,
	buildFlyerContent,
	buildWhatsAppBlast,
	type FlyerMeeting,
	PROMO_LIMITS,
	type PromoClub,
	type PromoTemplate,
	promoDate,
	promoMailtoHref,
	promoValues,
	templateWarnings,
} from "#/lib/promo-template";
import { getPromoContext, type PromoContext } from "#/server/promo";

async function copyText(text: string, what: string) {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(`${what} copied — paste it to share`);
	} catch {
		toast.error("Couldn't copy — your browser blocked clipboard access");
	}
}

/** Copy as rich text where the browser supports it, so a paste into an email
 *  keeps the bullets and the link; plain text otherwise. */
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

/** Plain text as the simplest HTML that keeps its line breaks. */
export function plainTextToHtml(text: string): string {
	return text
		.split(/\n{2,}/)
		.map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`)
		.join("\n");
}

/** A dismissed share sheet. `DOMException` is not an `Error` in every engine,
 *  so this reads the name rather than checking the class. */
function isAbortError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { name?: unknown }).name === "AbortError"
	);
}

function canShare(): boolean {
	return (
		typeof navigator !== "undefined" && typeof navigator.share === "function"
	);
}

export function PromoteSheet({
	open,
	onOpenChange,
	meetingId,
	clubId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The meeting to open on (the meeting page). */
	meetingId?: string;
	/** The club, when opened without a meeting — opens on the next one. */
	clubId?: string;
}) {
	const [ctx, setCtx] = useState<PromoContext | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [origin, setOrigin] = useState("");

	useEffect(() => {
		if (!open) return;
		setOrigin(window.location.origin);
		let cancelled = false;
		setError(null);
		getPromoContext({
			data: meetingId ? { meetingId } : { clubId },
		})
			.then((c) => {
				if (cancelled) return;
				setCtx(c);
				setSelected(c.selectedId);
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
	}, [open, meetingId, clubId]);

	const meeting = ctx?.meetings.find((m) => m.id === selected) ?? null;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
				<SheetHeader>
					<SheetTitle>Promote this meeting</SheetTitle>
					<SheetDescription>
						Drafts for you to send from your own apps. Nothing is sent from
						GavelUp.
					</SheetDescription>
				</SheetHeader>
				<div className="space-y-4 px-4 pb-6">
					{error ? (
						<p className="text-destructive text-sm">{error}</p>
					) : !ctx ? (
						<p className="flex items-center gap-2 text-muted-foreground text-sm">
							<Loader2 className="size-4 animate-spin" /> Loading…
						</p>
					) : !meeting ? (
						<p className="text-muted-foreground text-sm">
							No upcoming meeting to promote yet.
						</p>
					) : (
						<>
							{ctx.meetings.length > 1 ? (
								<div className="space-y-1">
									<Label htmlFor="promo-meeting">Meeting</Label>
									<select
										id="promo-meeting"
										className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs md:text-sm dark:bg-input/30"
										value={meeting.id}
										onChange={(e) => setSelected(e.target.value)}
									>
										{ctx.meetings.map((m) => (
											<option key={m.id} value={m.id}>
												{promoDate(m.scheduledAt, ctx.club.timezone)}
												{m.theme ? ` — ${m.theme}` : ""}
											</option>
										))}
									</select>
								</div>
							) : null}
							<PromoDrafts
								// Keyed so a one-time edit never survives a change of meeting.
								key={meeting.id}
								club={ctx.club}
								template={ctx.template}
								meeting={meeting}
								origin={origin}
								logoUrl={ctx.logoUrl}
							/>
						</>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

export function PromoDrafts({
	club,
	template,
	meeting,
	origin,
	logoUrl,
}: {
	club: PromoClub;
	template: PromoTemplate;
	meeting: FlyerMeeting;
	origin: string;
	logoUrl: string | null;
}) {
	const values = useMemo(
		() => promoValues(club, meeting, origin),
		[club, meeting, origin],
	);
	const whatsappDraft = useMemo(
		() => buildWhatsAppBlast(template, values),
		[template, values],
	);
	const emailDraft = useMemo(
		() => buildEmailBlast(template, values),
		[template, values],
	);
	const flyer = useMemo(
		() => buildFlyerContent(template, values),
		[template, values],
	);
	const warnings = templateWarnings(template);

	const [whatsapp, setWhatsapp] = useState(whatsappDraft);
	const [subject, setSubject] = useState(emailDraft.subject);
	const [body, setBody] = useState(emailDraft.text);
	// The origin arrives after mount; until the officer edits, follow the
	// freshly built drafts so the link appears in them.
	const [edited, setEdited] = useState({ whatsapp: false, email: false });
	useEffect(() => {
		if (!edited.whatsapp) setWhatsapp(whatsappDraft);
	}, [whatsappDraft, edited.whatsapp]);
	useEffect(() => {
		if (!edited.email) {
			setSubject(emailDraft.subject);
			setBody(emailDraft.text);
		}
	}, [emailDraft, edited.email]);

	const bodyHtml = edited.email ? plainTextToHtml(body) : emailDraft.html;
	const flyerPath = `/club/${club.slug}/meeting/${meeting.urlKey}/flyer`;

	async function share() {
		try {
			await navigator.share({ text: whatsapp });
		} catch (err) {
			// Dismissing the share sheet rejects with an AbortError: the officer
			// changed their mind, so there is nothing to report.
			if (isAbortError(err)) return;
			// Anything else (no share target, a permissions refusal, a payload
			// the platform rejects) must not look like success: say so, and hand
			// the officer the message another way.
			toast.error("Couldn't open the share sheet.");
			await copyText(whatsapp, "Message");
		}
	}

	function openMail() {
		const href = promoMailtoHref(subject, body);
		if (!href) {
			// Too long for a mailto: link. Copy BOTH, subject first, so nothing
			// the officer wrote is silently dropped.
			void copyText(
				`${subject}\n\n${body}`,
				"Too long for a mail link — the subject and body were",
			);
			return;
		}
		window.location.href = href;
	}

	return (
		<div className="space-y-3">
			{warnings.length > 0 ? (
				<p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm">
					The template uses {warnings.map((w) => `{${w}}`).join(", ")}, which
					isn't a placeholder, so it's shown as typed. Fix it in club settings.
				</p>
			) : null}
			<Tabs defaultValue="whatsapp">
				<TabsList>
					<TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
					<TabsTrigger value="email">Email</TabsTrigger>
					<TabsTrigger value="flyer">Flyer</TabsTrigger>
				</TabsList>

				<TabsContent value="whatsapp" className="space-y-2">
					<Label htmlFor="promo-whatsapp" className="sr-only">
						WhatsApp message
					</Label>
					<Textarea
						id="promo-whatsapp"
						rows={14}
						value={whatsapp}
						onChange={(e) => {
							setEdited((s) => ({ ...s, whatsapp: true }));
							setWhatsapp(e.target.value);
						}}
					/>
					<p
						className={
							whatsapp.length > PROMO_LIMITS.whatsappSoft
								? "text-amber-700 text-xs dark:text-amber-400"
								: "text-muted-foreground text-xs"
						}
					>
						{whatsapp.length} characters
						{whatsapp.length > PROMO_LIMITS.whatsappSoft
							? ` — long for a group chat (aim for ${PROMO_LIMITS.whatsappSoft})`
							: ""}
					</p>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							size="sm"
							onClick={() => copyText(whatsapp, "Message")}
						>
							<Copy className="size-4" aria-hidden /> Copy
						</Button>
						{canShare() ? (
							<Button type="button" size="sm" variant="outline" onClick={share}>
								<Share2 className="size-4" aria-hidden /> Share
							</Button>
						) : null}
					</div>
				</TabsContent>

				<TabsContent value="email" className="space-y-2">
					<Label htmlFor="promo-subject">Subject</Label>
					<Input
						id="promo-subject"
						value={subject}
						onChange={(e) => {
							setEdited((s) => ({ ...s, email: true }));
							setSubject(e.target.value);
						}}
					/>
					<Label htmlFor="promo-body">Body</Label>
					<Textarea
						id="promo-body"
						rows={14}
						value={body}
						onChange={(e) => {
							setEdited((s) => ({ ...s, email: true }));
							setBody(e.target.value);
						}}
					/>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => copyText(subject, "Subject")}
						>
							<Copy className="size-4" aria-hidden /> Copy subject
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => copyRich(bodyHtml, body, "Body")}
						>
							<Copy className="size-4" aria-hidden /> Copy body
						</Button>
						<Button type="button" size="sm" onClick={openMail}>
							<Mail className="size-4" aria-hidden /> Open in mail app
						</Button>
					</div>
				</TabsContent>

				<TabsContent value="flyer" className="space-y-3">
					<div className="flex flex-wrap gap-2">
						<Button asChild size="sm">
							<Link
								to="/club/$clubId/meeting/$meetingId/flyer"
								params={{ clubId: club.slug, meetingId: meeting.urlKey }}
								search={{ layout: "letter" }}
								target="_blank"
								rel="noopener noreferrer"
							>
								<Printer className="size-4" aria-hidden /> Print / Save as PDF
							</Link>
						</Button>
					</div>
					<p className="text-muted-foreground text-xs">
						Square image for group chats and social media:
					</p>
					<FlyerSquareExport
						content={flyer}
						clubName={club.name}
						logoUrl={logoUrl}
						filename={`${club.slug}-flyer-${meeting.urlKey}.png`}
					/>
					<p className="text-muted-foreground text-xs">
						Flyer link: <span className="break-all">{origin + flyerPath}</span>
					</p>
				</TabsContent>
			</Tabs>
		</div>
	);
}
