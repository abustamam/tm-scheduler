import { Loader2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	formatLastServed,
	resolveAssignAction,
	slotLabel,
	suggestFills,
} from "#/lib/agenda";
import { claimSlot } from "#/server/slots";

export type SuggestFillsSlot = {
	id: string;
	roleDefinitionId: string;
	roleName: string;
	slotIndex: number;
	slotsUnordered?: boolean;
	status: "open" | "claimed" | "confirmed";
	assigneeId: string | null;
	isSpeakerRole: boolean;
};

/** roleDefinitionId → memberId → ISO date the member last held that role (#146). */
type RoleRecency = Record<string, Record<string, string>>;

type Row = {
	slot: SuggestFillsSlot;
	/** "" = Leave open. */
	memberId: string;
	/** The pass proposed nobody for this slot. */
	noneEligible: boolean;
	error: string | null;
};

export interface SuggestFillsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Every slot of the meeting, in render order. */
	slots: SuggestFillsSlot[];
	roster: { id: string; name: string }[];
	/** memberId → the role label they already hold at this meeting. */
	roleByMemberId: Readonly<Record<string, string>>;
	unavailableIds: string[];
	roleRecency: RoleRecency;
	roleCounts: Record<string, number>;
	actorMemberId: string | null;
	onMutated: () => void | Promise<void>;
}

/**
 * "Suggest fills" (#58): propose a member for every open slot by role recency
 * (`suggestFills`), let the manager edit or drop each proposal, and write the
 * rest one at a time through the SAME `claimSlot` call `AssignSlotSheet` makes —
 * so authorization, the archive gate, the meeting lock and activity logging are
 * the reviewed path's, not a new one's.
 *
 * The body mounts only while open, so the suggestions are computed once when
 * the dialog opens and are not recomputed under the manager's edits.
 */
export function SuggestFillsDialog(props: SuggestFillsDialogProps) {
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				{props.open ? <SuggestFillsBody {...props} /> : null}
			</DialogContent>
		</Dialog>
	);
}

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

function SuggestFillsBody({
	onOpenChange,
	slots,
	roster,
	roleByMemberId,
	unavailableIds,
	roleRecency,
	roleCounts,
	actorMemberId,
	onMutated,
}: SuggestFillsDialogProps) {
	const [rows, setRows] = useState<Row[]>(() => {
		const byId = new Map(slots.map((s) => [s.id, s]));
		return suggestFills({ slots, roster, unavailableIds, roleRecency }).flatMap(
			(s) => {
				const slot = byId.get(s.slotId);
				if (!slot) return [];
				return [
					{
						slot,
						memberId: s.memberId ?? "",
						noneEligible: s.memberId === null,
						error: null,
					},
				];
			},
		);
	});
	const [busy, setBusy] = useState(false);
	const unavailable = new Set(unavailableIds);
	const toAssign = rows.filter((r) => r.memberId !== "");
	const count = toAssign.length;

	function update(slotId: string, patch: Partial<Row>) {
		setRows((prev) =>
			prev.map((r) => (r.slot.id === slotId ? { ...r, ...patch } : r)),
		);
	}

	async function confirm() {
		if (!actorMemberId || count === 0) return;
		setBusy(true);
		const failed: Row[] = [];
		for (const row of toAssign) {
			const action = resolveAssignAction(row.slot);
			try {
				await claimSlot({
					data: {
						slotId: row.slot.id,
						memberId: row.memberId,
						actorMemberId,
						speakerDetails: action.speakerTba
							? { speechTitle: "TBA" }
							: undefined,
					},
				});
			} catch (err) {
				failed.push({ ...row, error: errMessage(err) });
			}
		}
		try {
			await onMutated();
		} finally {
			setBusy(false);
		}
		if (failed.length === 0) {
			onOpenChange(false);
		} else {
			setRows(failed);
		}
	}

	return (
		<>
			<DialogHeader>
				<DialogTitle>Suggest fills</DialogTitle>
				<DialogDescription>
					Whoever has gone longest without each role is suggested first. Change
					or remove any row, then confirm. Nothing is assigned until you do.
				</DialogDescription>
			</DialogHeader>

			{actorMemberId === null ? (
				<p className="text-destructive text-sm">
					Your account isn't linked to a club member yet.
				</p>
			) : null}

			{rows.length === 0 ? (
				<p className="text-muted-foreground text-sm">No open roles left.</p>
			) : (
				<ul className="space-y-3">
					{rows.map((row) => {
						const label = slotLabel(row.slot, roleCounts);
						const iso = row.memberId
							? roleRecency[row.slot.roleDefinitionId]?.[row.memberId]
							: undefined;
						const heldRole = row.memberId
							? roleByMemberId[row.memberId]
							: undefined;
						const alsoPickedFor = rows
							.filter(
								(other) =>
									other.slot.id !== row.slot.id &&
									row.memberId !== "" &&
									other.memberId === row.memberId,
							)
							.map((other) => slotLabel(other.slot, roleCounts));
						return (
							<li
								key={row.slot.id}
								data-testid={`suggest-row-${row.slot.id}`}
								className="flex items-start gap-2"
							>
								<div className="min-w-0 flex-1 space-y-1">
									<label
										htmlFor={`suggest-${row.slot.id}`}
										className="font-medium text-sm"
									>
										{label}
									</label>
									<select
										id={`suggest-${row.slot.id}`}
										className="h-9 w-full rounded-md border bg-background px-2 text-sm"
										value={row.memberId}
										disabled={busy}
										onChange={(e) =>
											update(row.slot.id, {
												memberId: e.target.value,
												error: null,
											})
										}
									>
										<option value="">Leave open</option>
										{roster.map((m) => (
											<option key={m.id} value={m.id}>
												{m.name}
												{unavailable.has(m.id) ? " (not available)" : ""}
											</option>
										))}
									</select>
									<p className="text-muted-foreground text-xs">
										{row.memberId === ""
											? row.noneEligible
												? "No one available"
												: "Stays open"
											: iso
												? `Last: ${formatLastServed(new Date(iso))}`
												: "Never done this role"}
										{heldRole ? ` · Already ${heldRole}` : ""}
										{alsoPickedFor.length > 0
											? ` · Also picked for ${alsoPickedFor.join(", ")}`
											: ""}
									</p>
									{row.error ? (
										<p role="alert" className="text-destructive text-xs">
											{row.error}
										</p>
									) : null}
								</div>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="mt-6"
									disabled={busy}
									aria-label={`Remove ${label}`}
									onClick={() =>
										setRows((prev) =>
											prev.filter((r) => r.slot.id !== row.slot.id),
										)
									}
								>
									<X className="size-4" />
								</Button>
							</li>
						);
					})}
				</ul>
			)}

			<DialogFooter>
				<Button
					type="button"
					variant="outline"
					disabled={busy}
					onClick={() => onOpenChange(false)}
				>
					Cancel
				</Button>
				<Button
					type="button"
					disabled={busy || count === 0 || actorMemberId === null}
					onClick={() => void confirm()}
				>
					{busy ? <Loader2 className="size-4 animate-spin" /> : null}
					Confirm ({count})
				</Button>
			</DialogFooter>
		</>
	);
}
