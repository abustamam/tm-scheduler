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
import { showWriteError } from "#/components/write-error-toast";
import {
	buildPickerRows,
	formatLastServed,
	resolveAssignAction,
	slotLabel,
	suggestFills,
} from "#/lib/agenda";
import { isNotOnRosterError, isSignInRequiredError } from "#/lib/write-proof";
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
	/** When `memberId` last held this slot's role; null = never. Seeded from
	 *  `FillSuggestion.lastServedAt`, re-read from the picker rows on a change. */
	lastServedAt: Date | null;
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
 *
 * Dismissal (Escape, outside click, the X) is REFUSED while a batch is
 * running: a dismissed-then-reopened dialog would start a fresh body while the
 * old batch kept writing, lose its failures, and let its completion close the
 * new one. `busy` lives here, above the body, so the gate sees it.
 */
export function SuggestFillsDialog(props: SuggestFillsDialogProps) {
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={props.open}
			onOpenChange={(next) => {
				if (!next && busy) return;
				props.onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-xl">
				{props.open ? (
					<SuggestFillsBody {...props} busy={busy} setBusy={setBusy} />
				) : null}
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
	busy,
	setBusy,
}: SuggestFillsDialogProps & {
	busy: boolean;
	setBusy: (busy: boolean) => void;
}) {
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
						lastServedAt: s.lastServedAt,
						noneEligible: s.memberId === null,
						error: null,
					},
				];
			},
		);
	});
	/** The single-slot sheet's ordering and annotations (#146, #377), per role. */
	const pickerRowsFor = (roleDefinitionId: string) => {
		const lastServedAt: Record<string, Date> = {};
		for (const [memberId, iso] of Object.entries(
			roleRecency[roleDefinitionId] ?? {},
		)) {
			lastServedAt[memberId] = new Date(iso);
		}
		return buildPickerRows(
			roster,
			roleByMemberId,
			unavailableIds,
			lastServedAt,
		);
	};
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
		let toasted = false;
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
				// A write-proof refusal carries a fix ("Sign in") that inline text
				// cannot offer, so it also goes through the app's one write-error
				// path — once, since every later row fails the same way.
				if (
					!toasted &&
					(isSignInRequiredError(err) || isNotOnRosterError(err))
				) {
					toasted = true;
					showWriteError(err, "Something went wrong.");
				}
			}
		}
		// A refresh failure must not swallow the outcome: the writes above have
		// already landed or failed, and the rows below are what says which.
		try {
			await onMutated();
		} catch (err) {
			showWriteError(err, "Couldn't refresh the agenda.");
		}
		setBusy(false);
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
						const pickerRows = pickerRowsFor(row.slot.roleDefinitionId);
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
												lastServedAt:
													pickerRows.find((p) => p.id === e.target.value)
														?.lastServedAt ?? null,
												error: null,
											})
										}
									>
										<option value="">Leave open</option>
										{pickerRows.map((m) => (
											<option key={m.id} value={m.id}>
												{m.name}
												{m.currentRole ? ` · ${m.currentRole}` : ""}
												{m.unavailable ? " · not available" : ""}
											</option>
										))}
									</select>
									<p className="text-muted-foreground text-xs">
										{row.memberId === ""
											? row.noneEligible
												? "No one available"
												: "Stays open"
											: row.lastServedAt
												? `Last: ${formatLastServed(row.lastServedAt)}`
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
