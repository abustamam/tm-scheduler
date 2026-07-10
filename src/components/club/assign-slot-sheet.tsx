import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
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
	onOpenChange,
	onAssigned,
}: {
	slot: AssignSlot | null;
	roster: { id: string; name: string }[];
	roleByMemberId: Record<string, string>;
	unavailableIds: string[];
	roleRecency: RoleRecency;
	actorMemberId: string | null;
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
												<span className="font-medium text-amber-600 text-xs dark:text-amber-500">
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
				</div>
			</SheetContent>
		</Sheet>
	);
}
