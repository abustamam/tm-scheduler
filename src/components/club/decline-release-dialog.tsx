import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { listRoles } from "#/lib/list-roles";

/** The pending decline, or `null` when nothing is being confirmed. The subject
 *  is identified by `memberId` so the caller can hand the same object straight
 *  back to its write. */
export interface PendingDecline {
	memberId: string;
	/** The subject's name. `self` is what picks the copy, so this is only read on
	 *  the someone-else branch — but it is required rather than optional, because
	 *  a missing name there renders "Mark undefined not coming?". */
	name: string;
	/** NUMBERED role labels, e.g. `["Toastmaster of the Day", "Evaluator 2"]`.
	 *
	 *  MAY BE EMPTY, and empty does NOT mean "nothing will be freed". It is read
	 *  off the page's loader payload, and the rail does not poll
	 *  (CODING_STANDARDS.md), so a slot claimed since the page rendered is absent
	 *  from it while the server frees it anyway. The copy below says so rather
	 *  than asserting a list it cannot vouch for — which is why this dialog opens
	 *  for EVERY decline and not only for the ones with a known role. */
	roleLabels: string[];
	/** The subject is the viewer. Changes the copy from third to first person. */
	self: boolean;
	/** Whether this caller's arm frees roles at all. False only for a
	 *  self-asserted Toastmaster acting on someone ELSE's row, where the server
	 *  records the rung and deliberately keeps the slot — so the copy has to say
	 *  the role stays, not that it goes. */
	willRelease: boolean;
}

/**
 * The step between picking "Not coming" and the roles going back to the open
 * pool (#663).
 *
 * It exists because the release is NOT reversible from the meeting page:
 * `releaseSlotsAndMarkUnavailable` nulls the assignee, opens the slot and
 * unlinks the speech, nothing here offers an undo, and re-claiming the slot
 * mints a NEW speech row rather than reattaching the old one. An officer who
 * only meant to record a decline must not discover the release afterwards, from
 * an agenda that has quietly lost its Toastmaster. The season grid has confirmed
 * the same action since #204 and the personal meeting page since #665; this is
 * the third surface, not a new idea.
 *
 * OPENS FOR EVERY DECLINE, never only for a member the page believes holds a
 * role — see `roleLabels`. The first cut gated on `roleLabels.length > 0`, which
 * is the sibling surface's documented first-cut bug in the same words
 * (`personal-meeting-body.tsx`): the check is computed from loader data against
 * a page that does not poll, so the one case it skips is the one where the
 * officer has the least idea what is about to happen. A receipt afterwards is
 * not consent beforehand.
 *
 * Presentational: no server fn, no fetch, no state beyond the closing animation
 * below. The route owns the write, so this component is mountable in jsdom and
 * its copy is assertable — which the route's own is not.
 *
 * NAMES the roles rather than counting them. "This frees 2 roles" is the version
 * that reads fine in review and is useless in the room: the officer's next
 * question is always WHICH, and the answer decides whether they go ahead.
 */
export function DeclineReleaseDialog({
	pending,
	busy = false,
	onCancel,
	onConfirm,
}: {
	pending: PendingDecline | null;
	/** A confirmed write is in flight. Disables both controls — the dialog stays
	 *  up until the write resolves, so the route's own in-flight guards are not
	 *  bypassed by a second tap landing while the first is still going. */
	busy?: boolean;
	onCancel: () => void;
	onConfirm: (pending: PendingDecline) => void;
}) {
	// Radix animates the close over ~200ms and keeps the content mounted for it,
	// so rendering straight off `pending` flashed "Mark undefined not coming?" —
	// the subject's name blanked while the box was still on screen — on every
	// single close, confirm and cancel alike. Holding the LAST non-null value
	// keeps the copy stable through the exit; `open` alone drives the animation.
	const [shown, setShown] = useState<PendingDecline | null>(pending);
	useEffect(() => {
		if (pending) setShown(pending);
	}, [pending]);

	// SINGULAR vs plural on every one of the three, from the one array, so a
	// member holding exactly one role never reads "those roles ... put them back".
	const one = shown?.roleLabels.length === 1;
	const known = (shown?.roleLabels.length ?? 0) > 0;
	const roles = shown ? listRoles(shown.roleLabels) : "";
	const who = shown?.self ? "You're" : `${shown?.name} is`;

	/** Three cases, and the third is not a variant of the other two: it is the
	 *  arm that keeps the role. Written out rather than assembled from flags,
	 *  because the sentence a reader has to trust is the whole sentence. */
	function description(): string {
		if (!shown?.willRelease) {
			// Only reachable for a self-asserted Toastmaster acting on someone
			// ELSE's row, so this branch is always third person.
			return known
				? `${shown?.name} is ${roles} for this meeting. That stays theirs — this only records that they're not coming.`
				: `This records that ${shown?.name} isn't coming. Any role they hold stays theirs.`;
		}
		if (!known) {
			// The stale-page case, stated honestly. The page cannot see a slot
			// claimed since it loaded, so it promises nothing and warns anyway.
			return shown.self
				? "This also frees any role you've taken for this meeting, and we can't put it back automatically."
				: `This also frees any role ${shown.name} has taken for this meeting, and we can't put it back automatically.`;
		}
		return `${who} ${roles} for this meeting. Recording that frees ${
			one ? "the role" : "those roles"
		} for someone else, and we can't put ${
			one ? "it" : "them"
		} back automatically.`;
	}

	// "any role" on the stale-page branch, not "the role": the page cannot see a
	// slot claimed since it loaded, so the button must not name a thing it has
	// not shown.
	const confirmLabel = !shown?.willRelease
		? "Mark not coming"
		: !known
			? "Not coming & free any role"
			: `Not coming & free the ${one ? "role" : "roles"}`;

	return (
		<Dialog
			open={pending !== null}
			onOpenChange={(o) => {
				// `busy` holds the dialog open through the write: Escape and the
				// overlay both route here, and dismissing mid-flight would leave the
				// officer with no idea whether it landed.
				if (!o && !busy) onCancel();
			}}
		>
			{/* No `max-h` and no `overflow-*` here: a dialog's height belongs to the
			 *  `DialogContent` primitive (CODING_STANDARDS.md, #619), and
			 *  `dialog-scroll.guard.test.ts` sweeps every call site for exactly
			 *  those classes. */}
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{shown?.self
							? "Mark yourself not coming?"
							: `Mark ${shown?.name} not coming?`}
					</DialogTitle>
					<DialogDescription>{description()}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					{/* The CANCEL label names what keeping means, not "Cancel". Below
					 *  `sm` this footer is `flex-col-reverse`, so the confirm sits at
					 *  the TOP of the stack — the first thing a thumb reaches on the
					 *  phone this rail is actually run from — and "Cancel" next to it
					 *  says nothing about which outcome keeps the role. */}
					<Button variant="outline" disabled={busy} onClick={onCancel}>
						{shown?.willRelease && known
							? one
								? "Keep the role"
								: "Keep the roles"
							: "Never mind"}
					</Button>
					{/* `destructive` when it frees something, matching the sibling
					 *  confirm. The default variant on a top-of-stack button that
					 *  unassigns roles with no undo reads as the safe choice. */}
					<Button
						variant={shown?.willRelease ? "destructive" : "default"}
						disabled={busy}
						onClick={() => shown && onConfirm(shown)}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
