import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import type { HeldRoleLine } from "#/lib/absent-release-roles";

/** The pending Absent mark, or `null` when nothing is being confirmed. */
export interface PendingAbsent {
	memberId: string;
	name: string;
	/** Every role the loader says they hold, each with its slot id: the ids are
	 *  what Release roles sends, so the release frees what was LISTED. Never empty: a member the page sees
	 *  holding nothing is written straight through, with no dialog (#1256). */
	roles: HeldRoleLine[];
}

/**
 * The step between roll mode's "Absent" chip and the roles going back to the
 * open pool (#1256).
 *
 * Three answers, and each is a different write: Release roles (the default,
 * focused) records Absent AND frees every role; Keep roles records Absent only,
 * for the officer who is marking someone who will still be credited; Cancel
 * writes nothing. The release has no undo from the meeting page, and the speech
 * survives it, unscheduled, in the member's own queue (ADR-0009).
 *
 * Presentational, like `DeclineReleaseDialog`: the route owns the write, so
 * this mounts in jsdom and its copy is assertable.
 */
export function AbsentReleaseDialog({
	pending,
	offline = false,
	busy = false,
	onRelease,
	onKeep,
	onCancel,
}: {
	pending: PendingAbsent | null;
	/** The write will be queued, not sent: the release happens on reconnect. */
	offline?: boolean;
	busy?: boolean;
	onRelease: (pending: PendingAbsent) => void;
	onKeep: (pending: PendingAbsent) => void;
	onCancel: () => void;
}) {
	// Held through Radix's ~200ms close animation, so the copy does not blank to
	// "Mark undefined absent?" on every close (see `DeclineReleaseDialog`).
	const [shown, setShown] = useState<PendingAbsent | null>(pending);
	const releaseRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (pending) setShown(pending);
	}, [pending]);

	return (
		<Dialog
			open={pending !== null}
			onOpenChange={(o) => {
				if (!o && !busy) onCancel();
			}}
		>
			{/* No `max-h` / `overflow-*`: a dialog's height belongs to
			 *  `DialogContent` (CODING_STANDARDS.md, #619). */}
			<DialogContent
				// Release roles is the default (#1256), focused HERE rather than by
				// `autoFocus`: roll mode opens this from a dropdown item, and React's
				// autoFocus runs before Radix's focus trap is listening, so when the
				// closing menu hands focus back to its trigger the trap has no
				// "last focused" to restore and lands on the first tabbable, Cancel.
				// Focused in the trap's own mount event, Release is what it restores.
				onOpenAutoFocus={(e) => {
					e.preventDefault();
					releaseRef.current?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>Mark {shown?.name} absent?</DialogTitle>
					<DialogDescription>
						{shown?.name} holds{" "}
						{shown?.roles.length === 1 ? "this role" : "these roles"} in this
						meeting. Releasing frees {shown?.roles.length === 1 ? "it" : "them"}{" "}
						for someone else, and we can't put{" "}
						{shown?.roles.length === 1 ? "it" : "them"} back automatically.
					</DialogDescription>
				</DialogHeader>
				<ul className="list-disc space-y-1 pl-5 text-sm">
					{shown?.roles.map((r) => (
						<li key={r.slotId}>
							{r.speechTitle
								? `${r.label} — '${r.speechTitle}' goes back to their queue`
								: r.label}
						</li>
					))}
				</ul>
				{offline ? (
					<p className="text-sm text-muted-foreground">
						Roles will be released when you're back online.
					</p>
				) : null}
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={onCancel}>
						Cancel
					</Button>
					<Button
						variant="outline"
						disabled={busy}
						onClick={() => shown && onKeep(shown)}
					>
						Keep roles
					</Button>
					<Button
						ref={releaseRef}
						variant="destructive"
						disabled={busy}
						onClick={() => shown && onRelease(shown)}
					>
						Release roles
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
