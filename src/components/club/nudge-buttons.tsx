import { Mail, MessageCircle } from "lucide-react";
import { Button } from "#/components/ui/button";
import { buildNudge, type NudgeMode } from "#/lib/nudge";

/**
 * WhatsApp/Email tap-to-nudge affordances (#37). Renders only the channels the
 * target has; a muted "No contact on file" when neither. Links open the VPE's
 * own app pre-drafted — the human edits and sends. The app never sends.
 */
export function NudgeButtons({
	name,
	phone,
	email,
	roleName,
	meetingDate,
	shareUrl,
	mode,
}: {
	name: string;
	phone: string | null;
	email: string | null;
	roleName: string;
	meetingDate: string;
	shareUrl: string;
	mode: NudgeMode;
}) {
	const nudge = buildNudge({
		name,
		phone,
		email,
		roleName,
		meetingDate,
		shareUrl,
		mode,
	});

	if (!nudge.whatsappUrl && !nudge.mailtoUrl) {
		return (
			<span className="text-xs text-[var(--sea-ink-soft)]">
				No contact on file
			</span>
		);
	}

	return (
		<div className="flex items-center gap-1.5">
			{nudge.whatsappUrl ? (
				<Button asChild size="sm" variant="outline">
					<a href={nudge.whatsappUrl} target="_blank" rel="noopener noreferrer">
						<MessageCircle className="size-4" aria-hidden />
						WhatsApp
					</a>
				</Button>
			) : null}
			{nudge.mailtoUrl ? (
				<Button asChild size="sm" variant="outline">
					<a href={nudge.mailtoUrl}>
						<Mail className="size-4" aria-hidden />
						Email
					</a>
				</Button>
			) : null}
		</div>
	);
}
