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
import { buildPickerRows } from "#/lib/agenda";
import { claimSlot, reassignSlot } from "#/server/slots";

type AssignSlot = {
	id: string;
	status: "open" | "claimed" | "confirmed";
	isSpeakerRole: boolean;
	label: string;
};

export function AssignSlotSheet({
	slot,
	roster,
	roleByMemberId,
	unavailableIds,
	actorMemberId,
	onOpenChange,
	onAssigned,
}: {
	slot: AssignSlot | null;
	roster: { id: string; name: string }[];
	roleByMemberId: Record<string, string>;
	unavailableIds: string[];
	actorMemberId: string | null;
	onOpenChange: (open: boolean) => void;
	onAssigned: () => void | Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const rows = buildPickerRows(roster, roleByMemberId, unavailableIds);
	const isReassign = slot !== null && slot.status !== "open";

	async function pick(memberId: string) {
		if (!slot || !actorMemberId) {
			toast.error("Your account isn't linked to a club member yet.");
			return;
		}
		setBusy(true);
		try {
			if (slot.status === "open") {
				await claimSlot({
					data: {
						slotId: slot.id,
						memberId,
						actorMemberId,
						speakerDetails: slot.isSpeakerRole
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
										<span>{row.name}</span>
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
