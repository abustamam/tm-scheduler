import { Loader2 } from "lucide-react";
import { Button } from "#/components/ui/button";

/** The one fallback when a refusal carries no message of its own. */
export const MENTOR_REQUEST_FAILED_MESSAGE = "Something went wrong. Try again.";

/** What a failed mentor-request call shows: its own message, else the fallback. */
export function mentorRequestErrorText(err: unknown): string {
	return err instanceof Error && err.message
		? err.message
		: MENTOR_REQUEST_FAILED_MESSAGE;
}

/** Absolute origin for a draft's link; only read after a click, never in SSR. */
export function currentOrigin(): string {
	return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * Accept and Decline for one pending request (#1209), shared by the mentor's
 * card and the admin's list. `canAccept` false (a party is no longer active:
 * the server refuses the accept) leaves Decline alone, which clears the
 * request. `busy` marks THIS row's button; `disabled` holds every row while
 * any answer is in flight.
 */
export function DecideButtons({
	busy,
	disabled,
	canAccept = true,
	onDecide,
}: {
	busy: boolean;
	disabled: boolean;
	canAccept?: boolean;
	onDecide: (accept: boolean) => void;
}) {
	return (
		<span className="flex gap-2">
			{canAccept ? (
				<Button size="sm" disabled={disabled} onClick={() => onDecide(true)}>
					{busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
					Accept
				</Button>
			) : null}
			<Button
				size="sm"
				variant="outline"
				disabled={disabled}
				onClick={() => onDecide(false)}
			>
				Decline
			</Button>
		</span>
	);
}

/**
 * Answer a request, then reload the page's data. Rejects only when the ANSWER
 * failed. A reload that fails after the answer landed is swallowed: the
 * request is decided either way, and reporting it as a failed answer would hide
 * the mentor's welcome draft for a pairing that exists and invite a second
 * Accept the server then refuses as already answered.
 */
export async function answerThenReload(
	answer: () => Promise<unknown>,
	reload: () => Promise<unknown>,
): Promise<void> {
	await answer();
	try {
		await reload();
	} catch {
		// The next load shows the new state.
	}
}
