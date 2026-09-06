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
	/** NUMBERED role labels, e.g. `["Toastmaster of the Day", "Evaluator 2"]`. */
	roleLabels: string[];
	/** The subject is the viewer. Changes the copy from third to first person. */
	self: boolean;
}

/**
 * "This frees Toastmaster of the Day and Evaluator 2" — the step between picking
 * "Not coming" and the roles actually going back to the open pool (#663).
 *
 * It exists because the release is NOT obviously reversible from the rail:
 * `releaseSlotsAndMarkUnavailable` nulls the assignee, opens the slot and
 * unlinks the speech, and nothing on the meeting page offers an undo. An officer
 * who only meant to record a decline must not discover the release afterwards,
 * from an agenda that has quietly lost its Toastmaster. The season grid has
 * confirmed the same action since #204 and the personal meeting page since #665;
 * this is the third surface, not a new idea.
 *
 * Presentational: no server fn, no fetch, no state. The route owns the write, so
 * this component is mountable in jsdom and its copy is assertable — which the
 * route's own is not.
 *
 * NAMES the roles rather than counting them. "This frees 2 roles" is the version
 * that reads fine in review and is useless in the room: the officer's next
 * question is always WHICH, and the answer decides whether they go ahead.
 */
export function DeclineReleaseDialog({
	pending,
	onCancel,
	onConfirm,
}: {
	pending: PendingDecline | null;
	onCancel: () => void;
	onConfirm: (pending: PendingDecline) => void;
}) {
	// SINGULAR vs plural on every one of the three, from the one array, so a
	// member holding exactly one role never reads "those roles ... put them back".
	const one = pending?.roleLabels.length === 1;
	const roles = pending ? listRoles(pending.roleLabels) : "";
	return (
		<Dialog open={pending !== null} onOpenChange={(o) => !o && onCancel()}>
			{/* No `max-h` and no `overflow-*` here: a dialog's height belongs to the
			 *  `DialogContent` primitive (CODING_STANDARDS.md, #619), and
			 *  `dialog-scroll.guard.test.ts` sweeps every call site for exactly
			 *  those classes. */}
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{pending?.self
							? "Mark yourself not coming?"
							: `Mark ${pending?.name} not coming?`}
					</DialogTitle>
					<DialogDescription>
						{pending?.self
							? `You're ${roles} for this meeting. Recording that frees ${
									one ? "the role" : "those roles"
								} for someone else, and we can't put ${
									one ? "it" : "them"
								} back automatically.`
							: `${pending?.name} is ${roles} for this meeting. Recording that frees ${
									one ? "the role" : "those roles"
								} for someone else, and we can't put ${
									one ? "it" : "them"
								} back automatically.`}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={onCancel}>
						Cancel
					</Button>
					<Button onClick={() => pending && onConfirm(pending)}>
						Not coming &amp; free the {one ? "role" : "roles"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
