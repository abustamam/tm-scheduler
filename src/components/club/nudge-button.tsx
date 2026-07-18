import { Mail, MessageCircle, Send } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "#/components/ui/popover";
import { buildNudge, firstName } from "#/lib/nudge-links";
import { cn } from "#/lib/utils";

/**
 * VPE "tap-to-nudge" (spec §7, issue #37): a compact action that opens WhatsApp
 * or email prefilled with a friendly message + the public sign-up-sheet link.
 *
 * This is an authed, VPE-initiated action — it uses contact the signed-in
 * officer can already see. `path` is app-relative (e.g. `/club/acme`); the
 * current origin is prepended at render (client-only) so the shared link is
 * correct in any environment, exactly like {@link ShareLinkButton}. No PII is
 * ever emitted server-side or onto a public payload.
 */
export function NudgeButton({
	memberName,
	clubName,
	path,
	email,
	phone,
	className,
}: {
	memberName: string;
	clubName?: string | null;
	/** App-relative path to the public sign-up sheet (origin prepended at click). */
	path: string;
	email?: string | null;
	phone?: string | null;
	className?: string;
}) {
	const hasContact = !!(email?.trim() || phone?.trim());
	// Resolve the absolute link client-side. The popover content only mounts once
	// opened (Radix), so this never runs during the closed SSR pass — no mismatch.
	const link =
		typeof window === "undefined" ? path : window.location.origin + path;
	const nudge = buildNudge({ memberName, clubName, link, email, phone });
	const who = firstName(memberName);

	if (!hasContact) {
		return (
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled
				title={`No phone or email on file for ${who}`}
				className={cn("text-muted-foreground", className)}
			>
				<Send className="size-4" aria-hidden />
				Nudge
			</Button>
		);
	}

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className={className}
					aria-label={`Nudge ${who} about open roles`}
				>
					<Send className="size-4" aria-hidden />
					Nudge
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64 space-y-3">
				<PopoverHeader>
					<PopoverTitle>Nudge {who}</PopoverTitle>
					<PopoverDescription>
						Opens a prefilled message with the sign-up link — you send it.
					</PopoverDescription>
				</PopoverHeader>
				<div className="flex flex-col gap-2">
					{nudge.whatsappHref ? (
						<Button
							asChild
							variant="outline"
							size="sm"
							className="justify-start"
						>
							<a
								href={nudge.whatsappHref}
								target="_blank"
								rel="noreferrer noopener"
							>
								<MessageCircle className="size-4" aria-hidden />
								WhatsApp
							</a>
						</Button>
					) : null}
					{nudge.mailtoHref ? (
						<Button
							asChild
							variant="outline"
							size="sm"
							className="justify-start"
						>
							<a href={nudge.mailtoHref}>
								<Mail className="size-4" aria-hidden />
								Email
							</a>
						</Button>
					) : null}
				</div>
			</PopoverContent>
		</Popover>
	);
}
