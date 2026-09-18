import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { isStrandedConvertedGuest } from "#/lib/guest-convert";
import { firstNameOf } from "#/lib/person-name";
import { updateGuest } from "#/server/guest-pipeline";

/**
 * Exactly what this form writes, and nothing else (#727).
 *
 * `PipelineGuestRow` is a superset — stage, conversion pointers, derived visit
 * and slot counts — and structurally assignable to this, so VP Membership hands
 * its own row straight in. The meeting rail does NOT have a pipeline row (the
 * meeting payload deliberately carries guests as `{ id, name }`, see
 * `meetings.ts`'s `clubGuests` comment), so narrowing the prop to the five
 * fields the form actually touches is what lets a second caller supply one
 * without inheriting the board's whole shape.
 */
export interface GuestEditFields {
	id: string;
	name: string;
	/** What they're called, when it isn't the first token of `name` (#486). */
	preferredName: string | null;
	email: string | null;
	/**
	 * The `guests.phone` COLUMN verbatim — never the display value.
	 *
	 * `PipelineGuestRow` carries the number twice: `phone` is coalesced to E.164
	 * for the card's WhatsApp link, `phoneRaw` is what is stored. Coalescing is a
	 * country-code GUESS, so a guest stored as `"415-555-2671 x12"` displays as
	 * `"+1415555267112"` — a number nobody typed, prefilled into the dialog they
	 * opened to fix a NAME. The field is named `phoneRaw` here so a caller
	 * handing over the coalesced value has to say so.
	 */
	phoneRaw: string | null;
	/**
	 * The pipeline stage and the conversion pointer — NOT written by this form,
	 * carried so the dialog can work out for itself whether this guest has
	 * already joined the roster (see `joined` below).
	 *
	 * They are here rather than as a `joined` PROP because the prop was
	 * droppable and got dropped: VP Membership passed `joined={joined}` and the
	 * meeting rail's call site did not, so a guest who joined at tonight's
	 * meeting — still on tonight's rail, because `applyConvertGuestToMember`
	 * re-points role slots and sets `stage: "joined"` but never touches
	 * `meeting_attendance` — opened a dialog that said "Fix X's name and contact
	 * details" instead of telling the officer they were editing a dead guest row.
	 * A field the type REQUIRES cannot be forgotten at one of two call sites;
	 * a boolean prop with a default can. `PipelineGuestRow` carries both, so VP
	 * Membership's row still assigns straight in.
	 */
	stage: string;
	convertedMembershipId: string | null;
}

/**
 * Fix a guest's name and contact details (#364, lifted to a shared component in
 * #727). ONE dialog, two call sites: VP Membership's per-guest Edit button and
 * the meeting page's attendance rail.
 *
 * Lifted rather than copied. The form wires four fields across three places that
 * nothing type-checks against each other — the input's `name`, the
 * `form.get(…)` that reads it back, and the `defaultValue` that seeds it — and a
 * mismatch is SILENT and destructive: `form.get` returns null, the handler sends
 * null, and the save wipes the stored value while the form still looks like it
 * works. `goes-by-field.guard.test.ts` guards that wiring in ONE file; a second
 * copy of this form would be a second place for it to rot, unguarded.
 *
 * CONTROLLED (`open` / `onOpenChange`) and trigger-less on purpose. The two call
 * sites open it from completely different affordances — an Edit button in a row
 * of buttons, and a guest's own name in a badge — and a `trigger` prop would be
 * this component growing a flag for each.
 *
 * ## Who may open it
 *
 * The gate is the CALLER's, and it must be a server-resolved capability rather
 * than a local boolean: the meeting page is not under `_authed`. The write
 * itself re-checks — `updateGuest` runs `requireUser()` + `requireClubRole(…,
 * ["admin"])` on every call (`guest-pipeline.ts`) — so a hidden button is not
 * the permission and never was. See the meeting rail's own gate comment for the
 * deliberate gap between the two.
 */
export function GuestEditDialog({
	guest,
	clubId,
	open,
	onOpenChange,
	onSaved,
}: {
	guest: GuestEditFields;
	clubId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Refresh whatever holds this guest's fields OUTSIDE the router's loaders,
	 * awaited before the dialog closes.
	 *
	 * `router.invalidate()` below re-runs route LOADERS and nothing else. VP
	 * Membership's row is loader-fetched, so it needs no more than that. The
	 * meeting rail's is not: its fields come from a TanStack Query cache entry
	 * (`["guest-pipeline", clubId]`), which `router.invalidate()` never touches —
	 * so without this the rail's badge NAME updated (that comes from the meeting
	 * payload) while the dialog kept prefilling the PRE-EDIT email, phone and
	 * goes-by. Reopen and save again and the first edit is silently reverted:
	 * a blank-field save writes `null`, and a stale-field save writes the old
	 * value, which is the same data loss one step further on. That is the exact
	 * hazard `GuestEditCapability` exists to make unrepresentable, and stale rows
	 * do it as surely as absent ones.
	 *
	 * Optional HERE (VP Membership has nothing extra to refresh) and REQUIRED on
	 * `GuestEditCapability`, so a caller that feeds the dialog from a query has
	 * to say how that query gets refreshed. The compiler is the reminder.
	 */
	onSaved?: () => void | Promise<void>;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	// DERIVED here, not passed in — see `GuestEditFields.stage`. This guest has
	// already been converted onto the roster, so the description says which
	// record is being edited: the guest row is still the record of the VISITOR
	// and is always safe to correct (`applyUpdateGuest` allows every stage), but
	// their ROSTER details live on the roster, and someone who opened this to fix
	// a member's email needs telling.
	//
	// STRANDED is not joined (#618): converted once, then the membership was
	// removed from the roster, which nulls `converted_membership_id` and leaves
	// the stage saying `joined` forever. Same predicate VP Membership uses to
	// decide whether to offer Delete, from the same helper, so the two cannot
	// disagree about what "joined" means.
	const joined = guest.stage === "joined" && !isStrandedConvertedGuest(guest);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const name = String(form.get("name") ?? "").trim();
		if (!name) {
			toast.error("Name is required.");
			return;
		}
		setBusy(true);
		try {
			// TWO phases with SEPARATE failure handling, because they fail in
			// different worlds. Wrapping both in one `try` — which this did — fires
			// `toast.success` and then `toast.error` for a single action whenever the
			// refresh rejects, over a write that has already COMMITTED, and leaves
			// the dialog open with no indication which half went wrong.
			try {
				await updateGuest({
					data: {
						clubId,
						guestId: guest.id,
						name,
						preferredName:
							String(form.get("preferredName") ?? "").trim() || null,
						email: String(form.get("email") ?? "").trim() || null,
						phone: String(form.get("phone") ?? "").trim() || null,
					},
				});
			} catch (err) {
				// The write itself. This is the user's error to see and act on —
				// `applyUpdateGuest` refuses a phone/email that already belongs to
				// another club guest, and that message names the clash. Stay open so
				// they can fix the field they just typed.
				toast.error(
					err instanceof Error ? err.message : "Something went wrong.",
				);
				return;
			}
			toast.success("Guest updated.");
			// REFRESH FIRST, CLOSE LAST — both halves matter.
			//
			// Refresh: `onSaved` covers a caller whose fields live outside the
			// loaders (see its doc), `router.invalidate()` covers the loader-backed
			// ones. Both call sites need the second; only the rail needs the first.
			//
			// Close last, rather than the other way round, because this dialog is
			// MODAL: while it is up nothing behind it is tappable, which is the only
			// in-flight guard the surface has. Closing first re-arms VP Membership's
			// Edit and Delete buttons for the length of the refetch — the window the
			// pre-#727 `busy` flag covered, and the same reasoning
			// `DeclineReleaseDialog` carries on the meeting route ("stays OPEN until
			// the write resolves, with both controls disabled").
			try {
				await onSaved?.();
				await router.invalidate();
			} catch {
				// The write LANDED; this is a stale view, not a failed save, and
				// saying "something went wrong" about a change that is in the database
				// is the more damaging error of the two. Swallowed deliberately: the
				// success toast already told the truth, and the next navigation or
				// refetch repairs the display.
			}
			onOpenChange(false);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Edit guest</DialogTitle>
					<DialogDescription>
						{joined
							? `Fix ${guest.name}'s guest record. They are already a member — their roster details are edited on the roster.`
							: `Fix ${guest.name}'s name and contact details.`}
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={onSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor={`guest-name-${guest.id}`}>Name</Label>
						<Input
							id={`guest-name-${guest.id}`}
							name="name"
							required
							defaultValue={guest.name}
							autoFocus
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`guest-preferred-${guest.id}`}>Goes by</Label>
						<Input
							id={`guest-preferred-${guest.id}`}
							name="preferredName"
							defaultValue={guest.preferredName ?? ""}
							placeholder={firstNameOf(guest.name)}
							aria-describedby={`guest-preferred-hint-${guest.id}`}
						/>
						<p
							id={`guest-preferred-hint-${guest.id}`}
							className="text-xs text-[var(--sea-ink-soft)]"
						>
							Used to greet them in WhatsApp and email drafts. Leave blank to
							use their first name.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`guest-email-${guest.id}`}>Email</Label>
						<Input
							id={`guest-email-${guest.id}`}
							name="email"
							type="email"
							defaultValue={guest.email ?? ""}
							placeholder="name@example.com"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`guest-phone-${guest.id}`}>Phone</Label>
						{/* `phoneRaw`, NOT a coalesced display value — see the field's own
						    doc on `GuestEditFields`. */}
						<Input
							id={`guest-phone-${guest.id}`}
							name="phone"
							type="tel"
							defaultValue={guest.phoneRaw ?? ""}
						/>
					</div>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={busy}>
								Cancel
							</Button>
						</DialogClose>
						<Button type="submit" disabled={busy}>
							{busy ? "Saving…" : "Save changes"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
