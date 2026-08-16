import { Mail, MessageCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { buildNudge, type NudgeMode } from "#/lib/nudge";
import { detectPlatform } from "#/lib/platform";

/**
 * WhatsApp/Email tap-to-nudge affordances (#37). Renders only the channels the
 * target has; a muted "No contact on file" when neither. Links open the VPE's
 * own app pre-drafted — the human edits and sends. The app never sends.
 */
export function NudgeButtons({
	name,
	preferredName,
	phone,
	email,
	roleName,
	meetingDate,
	shareUrl,
	mode,
	onContacted,
}: {
	name: string;
	/** What to call them in the draft, when it isn't the first token of `name`
	 *  (#486). Absent/null falls back to that first token. */
	preferredName?: string | null;
	phone: string | null;
	email: string | null;
	/** Omitted for `mode="attendance"` — see `NudgeInput.roleName`. */
	roleName?: string;
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

	// Detection is deferred to the post-mount render; the server pass falls back
	// to "mobile", the historical `wa.me` behavior (#485).
	//
	// NOT because `navigator` is missing on the server — it is not. Node 21+ ships
	// a global one, so on `node:22-slim` `detectPlatform(navigator)` returns
	// "desktop" (UA `Node.js/24`) rather than throwing. That is the actual hazard:
	// unguarded, the server would emit `web.whatsapp.com` while a phone's first
	// client render emits `wa.me`, and the two disagree on an attribute React has
	// to reconcile — a hydration MISMATCH, not a crash. The guard makes the server
	// pass and every first client render agree.
	//
	// This comment claimed the opposite until `WhatsAppPhoneLink` was written and
	// the claim was checked. Left uncorrected it invites the obvious cleanup:
	// verify `navigator` exists, delete the "unnecessary" guard, ship the
	// mismatch.
	const platform = mounted ? detectPlatform(navigator) : "mobile";

	const nudge = buildNudge({
		name,
		preferredName,
		phone,
		email,
		roleName,
		meetingDate,
		shareUrl,
		mode,
		platform,
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
