import { Check, Link2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";

const DEFAULT_SUCCESS = "Link copied — paste it to share";

/**
 * Copies `origin + path` to the clipboard and toasts the outcome. Returns
 * whether it copied. Shared by the button below and the schedule's Share menu
 * (#1316), so the two cannot drift on clipboard behaviour or wording.
 */
export async function copyShareLink(
	path: string,
	successMessage: string = DEFAULT_SUCCESS,
): Promise<boolean> {
	const url =
		typeof window === "undefined" ? path : window.location.origin + path;
	try {
		await navigator.clipboard.writeText(url);
		toast.success(successMessage);
		return true;
	} catch {
		toast.error("Couldn't copy — your browser blocked clipboard access");
		return false;
	}
}

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
	successMessage = DEFAULT_SUCCESS,
	className,
}: {
	path: string;
	label?: string;
	/** The toast shown after a successful copy. */
	successMessage?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);

	async function copy() {
		if (!(await copyShareLink(path, successMessage))) return;
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
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
