import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	PersonPicker,
	type PickerPerson,
} from "#/components/club/person-picker";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { showWriteError } from "#/components/write-error-toast";
import {
	buildPickerRows,
	formatLastServed,
	type PickerRow,
	pickerTier,
	resolveAssignAction,
} from "#/lib/agenda";
import { assignGuestSlot } from "#/server/guests";
import { claimSlot, reassignSlot } from "#/server/slots";

type AssignPerson = PickerPerson &
	({ kind: "guest"; row?: undefined } | { kind: "member"; row: PickerRow });

type AssignSlot = {
	id: string;
	roleDefinitionId: string;
	status: "open" | "claimed" | "confirmed";
	isSpeakerRole: boolean;
	label: string;
};

/** roleDefinitionId → memberId → ISO date the member last held that role (#146). */
type RoleRecency = Record<string, Record<string, string>>;

export function AssignSlotSheet({
	slot,
	roster,
	roleByMemberId,
	unavailableIds,
	roleRecency,
	actorMemberId,
	canReassign = false,
	allowGuests = false,
	clubGuests = [],
	onOpenChange,
	onAssigned,
}: {
	slot: AssignSlot | null;
	roster: {
		id: string;
		name: string;
		preferredName?: string | null;
		stage?: string;
	}[];
	roleByMemberId: Record<string, string>;
	unavailableIds: string[];
	roleRecency: RoleRecency;
	/** Who is asserting the CLAIM of an open slot — `claimSlot` still carries an
	 *  actor on the wire (the TMOD's asserted claim, #747). `reassignSlot` does
	 *  not: it reads the session (#763). */
	actorMemberId: string | null;
	/**
	 * May this viewer reassign a HELD slot (#1003)? `reassignSlot` refuses a
	 * caller with no session since #763, so a non-manager TMOD identified by a
	 * name-pick is offered the picker on an OPEN slot only, and a held one shows
	 * who holds it and how to get the control. Defaults FALSE (fail closed); the
	 * agenda passes `viewer.canReassignHeld`.
	 */
	canReassign?: boolean;
	/** Admin-only: offer the "assign a guest" path (#151). Never on the public
	 *  self-serve/TMOD view. */
	allowGuests?: boolean;
	/** Existing club guests to pick from (admin path only). */
	clubGuests?: {
		id: string;
		name: string;
		preferredName?: string | null;
		stage?: string;
	}[];
	onOpenChange: (open: boolean) => void;
	onAssigned: () => void | Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	// Revive the ISO recency for the role being assigned into Dates for the rows.
	const lastServedAt: Record<string, Date> = {};
	if (slot) {
		for (const [memberId, iso] of Object.entries(
			roleRecency[slot.roleDefinitionId] ?? {},
		)) {
			lastServedAt[memberId] = new Date(iso);
		}
	}
	const rows = buildPickerRows(
		roster,
		roleByMemberId,
		unavailableIds,
		lastServedAt,
	);
	const people: AssignPerson[] = [
		...rows.map(
			(row): AssignPerson => ({
				kind: "member",
				id: row.id,
				name: row.name,
				preferredName: row.preferredName,
				rank: pickerTier(row),
				row,
			}),
		),
		...(allowGuests
			? clubGuests.map(
					(g): AssignPerson => ({
						kind: "guest",
						id: g.id,
						name: g.name,
						preferredName: g.preferredName,
						stage: g.stage,
						rank: 0,
					}),
				)
			: []),
	];
	const isReassign =
		slot !== null && resolveAssignAction(slot).kind === "reassign";
	// The visibility rule sits beside the claim-vs-reassign decision it guards:
	// a held slot's picker renders only where `reassignSlot` would accept it.
	const reassignBlocked = isReassign && !canReassign;

	async function pick(memberId: string) {
		if (!slot || reassignBlocked) return;
		const action = resolveAssignAction(slot);
		if (action.kind === "claim" && !actorMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		setBusy(true);
		try {
			if (action.kind === "claim") {
				await claimSlot({
					data: {
						slotId: slot.id,
						memberId,
						actorMemberId,
						speakerDetails: action.speakerTba
							? { speechTitle: "TBA" }
							: undefined,
					},
				});
			} else {
				await reassignSlot({ data: { slotId: slot.id, memberId } });
			}
			toast.success(isReassign ? "Role reassigned." : "Role assigned.");
			await onAssigned();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	async function assignGuest(payload: {
		guestId?: string;
		newGuest?: { name: string; email?: string; phone?: string };
	}) {
		if (!slot) return;
		setBusy(true);
		try {
			// No actor on the wire: assignGuestSlot is admin-gated and credits the
			// membership the server resolved from the session (#396).
			await assignGuestSlot({ data: { slotId: slot.id, ...payload } });
			toast.success("Guest assigned.");
			await onAssigned();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	function onCreateGuest(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const name = String(form.get("guestName") ?? "").trim();
		if (!name) {
			toast.error("A guest name is required.");
			return;
		}
		void assignGuest({
			newGuest: {
				name,
				email: String(form.get("guestEmail") ?? "").trim() || undefined,
				phone: String(form.get("guestPhone") ?? "").trim() || undefined,
			},
		});
	}

	return (
		<Sheet open={slot !== null} onOpenChange={onOpenChange}>
			<SheetContent side="bottom" className="max-h-[90svh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>
						{isReassign ? "Reassign" : "Assign"} {slot?.label ?? "role"}
					</SheetTitle>
					<SheetDescription className="flex items-center gap-2">
						Pick a member to fill this role.
						{busy ? <Loader2 className="size-4 animate-spin" /> : null}
					</SheetDescription>
				</SheetHeader>
				<div className="px-4 pb-4">
					{reassignBlocked ? (
						<p className="text-sm text-muted-foreground">
							Someone already holds this role. Sign in to reassign it.
						</p>
					) : (
						<PersonPicker
							key={slot?.id ?? "closed"}
							people={people}
							disabled={busy}
							placeholder={
								allowGuests ? "Search members and guests…" : "Search members…"
							}
							emptyText={
								allowGuests ? "No matching people." : "No members found."
							}
							onPick={(person) =>
								person.kind === "guest"
									? void assignGuest({ guestId: person.id })
									: void pick(person.id)
							}
							// Only the NAME recedes for a Not-available member (#377). Dimming
							// the whole row would drag the muted sub-line and the amber "Never
							// done this role" hint below WCAG AA; the "Not available" badge
							// carries the semantic signal.
							nameClassName={(person) =>
								person.row?.unavailable ? "text-muted-foreground" : undefined
							}
							renderSubline={(person) =>
								person.kind === "guest" ? null : person.row.lastServedAt ? (
									<span className="text-muted-foreground text-xs">
										Last: {formatLastServed(person.row.lastServedAt)}
									</span>
								) : (
									<span className="font-semibold text-warning-foreground text-xs">
										Never done this role
									</span>
								)
							}
							renderMeta={(person) =>
								person.kind === "guest" ? (
									<Badge variant="outline">Guest</Badge>
								) : (
									<span className="flex items-center gap-1">
										{person.row.currentRole ? (
											<Badge variant="secondary">
												{person.row.currentRole}
											</Badge>
										) : null}
										{person.row.unavailable ? (
											<Badge variant="outline">Not available</Badge>
										) : null}
									</span>
								)
							}
						/>
					)}

					{allowGuests && !reassignBlocked ? (
						<div className="mt-4 space-y-3 border-t pt-4">
							<p className="font-semibold text-sm">Add a new guest</p>
							<p className="text-muted-foreground text-xs">
								Guests aren't roster members — they won't appear in the member
								picker or roster.
							</p>
							<form onSubmit={onCreateGuest} className="space-y-2">
								<Input
									name="guestName"
									placeholder="New guest name"
									aria-label="New guest name"
									required
								/>
								<div className="grid grid-cols-2 gap-2">
									<Input
										name="guestEmail"
										type="email"
										placeholder="Email (optional)"
										aria-label="Guest email"
									/>
									<Input
										name="guestPhone"
										placeholder="Phone (optional)"
										aria-label="Guest phone"
									/>
								</div>
								<Button
									type="submit"
									size="sm"
									variant="outline"
									disabled={busy}
								>
									Add &amp; assign guest
								</Button>
							</form>
						</div>
					) : null}
				</div>
			</SheetContent>
		</Sheet>
	);
}
