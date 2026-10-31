import { ShareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	CLAIM_EVENT,
	detectPhone,
	detectStandalone,
	HINT_DELAY_MS,
	isIosSafari,
	markDismissed,
	readClaims,
	readDismissed,
	shouldOfferInstall,
} from "#/lib/install-hint";

interface InstallPromptEvent extends Event {
	prompt: () => Promise<unknown>;
}

function eligible(): boolean {
	return shouldOfferInstall({
		claims: readClaims(),
		dismissed: readDismissed(),
		standalone: detectStandalone(),
		isPhone: detectPhone(),
	});
}

/**
 * Mounted once in the root (#1428). Keeps Chrome's `beforeinstallprompt`, and
 * after a member's second claim offers one toast, once per device. Renders
 * only the iOS "How" dialog.
 */
export function InstallHint() {
	const deferred = useRef<InstallPromptEvent | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [howOpen, setHowOpen] = useState(false);

	useEffect(() => {
		function onPrompt(e: Event) {
			e.preventDefault();
			deferred.current = e as InstallPromptEvent;
		}

		function show() {
			timer.current = null;
			// Re-checked now: the member may have installed or answered meanwhile.
			if (!eligible()) return;
			const event = deferred.current;
			const ios = !event && isIosSafari();
			if (!event && !ios) return; // nothing to offer: set nothing
			// Set when SHOWN, so dismissal, the action and expiry all count.
			if (!markDismissed()) return;
			toast("Put GavelUp on your home screen?", {
				action: event
					? {
							label: "Install",
							onClick: () => {
								void event.prompt();
							},
						}
					: { label: "How", onClick: () => setHowOpen(true) },
			});
		}

		function onClaim() {
			if (timer.current || !eligible()) return;
			timer.current = setTimeout(show, HINT_DELAY_MS);
		}

		window.addEventListener("beforeinstallprompt", onPrompt);
		window.addEventListener(CLAIM_EVENT, onClaim);
		return () => {
			window.removeEventListener("beforeinstallprompt", onPrompt);
			window.removeEventListener(CLAIM_EVENT, onClaim);
			if (timer.current) clearTimeout(timer.current);
		};
	}, []);

	return (
		<Dialog open={howOpen} onOpenChange={setHowOpen}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add GavelUp to your home screen</DialogTitle>
					<DialogDescription>
						Tap Share{" "}
						<ShareIcon
							aria-hidden
							className="inline size-4 align-text-bottom"
						/>
						, then Add to Home Screen.
					</DialogDescription>
				</DialogHeader>
			</DialogContent>
		</Dialog>
	);
}
