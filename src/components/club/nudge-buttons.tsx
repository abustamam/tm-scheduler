import { Mail, MessageCircle } from "lucide-react";
import { useEffect, useState } from "react";
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
	onContacted,
}: {
	name: string;
	phone: string | null;
	email: string | null;
	roleName: string;
	meetingDate: string;
	shareUrl: string;
	mode: NudgeMode;
	/** Fired when the WhatsApp or Email draft link is tapped (auto-mark contacted). */
	onContacted?: () => void;
}) {
	// Render the channel links only after mount. The caller builds `shareUrl` with
	// a `window.location.origin` prefix that is correct only on the client; during
	// SSR it falls back to a RELATIVE path, so an anchor tapped before hydration
	// would carry a broken link in the draft message. Gating on mount keeps the
	// links off the server render entirely (#37). The no-contact state needs no
	// URL, so it still renders on the server.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);

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

	if (!mounted) return null;

	return (
		<div className="flex items-center gap-1.5">
			{nudge.whatsappUrl ? (
				<Button asChild size="sm" variant="outline">
					<a
						href={nudge.whatsappUrl}
						target="_blank"
						rel="noopener noreferrer"
						onClick={onContacted}
					>
						<MessageCircle className="size-4" aria-hidden />
						WhatsApp
					</a>
				</Button>
			) : null}
			{nudge.mailtoUrl ? (
				<Button asChild size="sm" variant="outline">
					<a href={nudge.mailtoUrl} onClick={onContacted}>
						<Mail className="size-4" aria-hidden />
						Email
					</a>
				</Button>
			) : null}
		</div>
	);
}
