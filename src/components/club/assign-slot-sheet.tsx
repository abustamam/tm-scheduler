import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import { Input } from "#/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import {
	buildPickerRows,
	formatLastServed,
	resolveAssignAction,
} from "#/lib/agenda";
import { assignGuestSlot } from "#/server/guests";
import { claimSlot, reassignSlot } from "#/server/slots";

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
	allowGuests = false,
	clubGuests = [],
	onOpenChange,
	onAssigned,
}: {
	slot: AssignSlot | null;
	roster: { id: string; name: string }[];
	roleByMemberId: Record<string, string>;
	unavailableIds: string[];
	roleRecency: RoleRecency;
	actorMemberId: string | null;
	/** Admin-only: offer the "assign a guest" path (#151). Never on the public
	 *  self-serve/TMOD view. */
	allowGuests?: boolean;
	/** Existing club guests to pick from (admin path only). */
	clubGuests?: { id: string; name: string }[];
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
	const isReassign =
		slot !== null && resolveAssignAction(slot).kind === "reassign";

	async function pick(memberId: string) {
		if (!slot || !actorMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		setBusy(true);
		try {
			const action = resolveAssignAction(slot);
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
				await reassignSlot({
					data: { slotId: slot.id, memberId, actorMemberId },
				});
			}
			toast.success(isReassign ? "Role reassigned." : "Role assigned.");
			await onAssigned();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
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
			await assignGuestSlot({
				data: { slotId: slot.id, actorMemberId, ...payload },
			});
			toast.success("Guest assigned.");
			await onAssigned();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
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
					<Command key={slot?.id ?? "closed"}>
						<CommandInput placeholder="Search members…" />
						<CommandList>
							<CommandEmpty>No members found.</CommandEmpty>
							<CommandGroup>
								{rows.map((row) => (
									<CommandItem
										key={row.id}
										value={`${row.name} ${row.id}`}
										disabled={busy}
										onSelect={() => pick(row.id)}
										className="flex items-center justify-between gap-2"
									>
										<span className="flex flex-col">
											<span>{row.name}</span>
											{row.lastServedAt ? (
												<span className="text-muted-foreground text-xs">
													Last: {formatLastServed(row.lastServedAt)}
												</span>
											) : (
												<span className="font-medium text-warning-foreground text-xs">
													Never done this role
												</span>
											)}
										</span>
										<span className="flex items-center gap-1">
											{row.currentRole ? (
												<Badge variant="secondary">{row.currentRole}</Badge>
											) : null}
											{row.unavailable ? (
												<Badge variant="outline">Not available</Badge>
											) : null}
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>

					{allowGuests ? (
						<div className="mt-4 space-y-3 border-t pt-4">
							<p className="font-medium text-sm">Or assign a guest</p>
							<p className="text-muted-foreground text-xs">
								Guests aren't roster members — they won't appear in the member
								picker or roster.
							</p>
							{clubGuests.length > 0 ? (
								<div className="flex flex-wrap gap-2">
									{clubGuests.map((g) => (
										<Button
											key={g.id}
											type="button"
											size="sm"
											variant="secondary"
											disabled={busy}
											onClick={() => void assignGuest({ guestId: g.id })}
										>
											{g.name}
										</Button>
									))}
								</div>
							) : null}
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
