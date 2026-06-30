import { Check, Link2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";

/**
 * Copies a shareable, login-free meeting/role link to the clipboard.
 * `path` is app-relative (e.g. `/club/abc/meeting/xyz`); the current
 * origin is prepended at click time so the link is correct in any env.
 * This is the MVP's "notification" workflow (spec §7) — the VPE copies the
 * link and pastes it into WhatsApp/email by hand.
 */
export function ShareLinkButton({
	path,
	label = "Copy share link",
	className,
}: {
	path: string;
	label?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);

	async function copy() {
		const url =
			typeof window === "undefined" ? path : window.location.origin + path;
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			toast.success("Link copied — paste it to share");
			setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error("Couldn't copy — your browser blocked clipboard access");
		}
	}

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={copy}
			className={className}
		>
			{copied ? (
				<Check className="size-4" aria-hidden />
			) : (
				<Link2 className="size-4" aria-hidden />
			)}
			{label}
		</Button>
	);
}
