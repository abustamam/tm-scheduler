import { CheckCircle2, Circle } from "lucide-react";

/**
 * One duty row. `min-h-11` + the padding is the whole point: these were bare
 * `text-sm` links at roughly a 20px target, and they are the navigation into
 * the editors where the duty actually gets done. The negative margin lets the
 * target reach the card's padding edge without the label moving.
 * Shared by `/me` (`personal-meeting-body.tsx`) and the meeting page's "Your
 * jobs" card (`meeting-your-jobs.tsx`).
 */
export const DUTY_ROW =
	"-mx-2 flex min-h-11 items-center gap-2 rounded-md px-2 py-2 text-sm text-primary hover:underline";

/** The tick/circle icon plus its screen-reader state. */
export function DutyMark({ done }: { done: boolean }) {
	return (
		<>
			{done ? (
				<CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" />
			) : (
				<Circle aria-hidden className="size-4 shrink-0 text-muted-foreground" />
			)}
			{/* The icons are aria-hidden, so without this the done/not-done state —
			    the whole point of a checklist — is inaudible to a screen reader. */}
			<span className="sr-only">{done ? "Done: " : "To do: "}</span>
		</>
	);
}

/** The label's class: struck through once the duty is done. */
export function dutyLabelClass(done: boolean): string {
	return done ? "text-muted-foreground line-through" : "";
}
