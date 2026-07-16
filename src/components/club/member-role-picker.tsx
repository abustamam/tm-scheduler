import { useRouter } from "@tanstack/react-router";
import { Check, Loader2, UserMinus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import {
	meetingRoleOptions,
	type RoleOption,
	slotAction,
} from "#/lib/member-role-picker";
import { cn } from "#/lib/utils";
import type { SeasonGridData } from "#/server/season-grid";
import { claimSlot, reassignSlot, releaseSlot } from "#/server/slots";

/**
 * The member × meeting role picker (#officer-assign). Wraps a grid cell; opening
 * it shows the meeting's role slots and lets an officer (or the member on their
 * own row) assign / release / reassign roles for that member, plus toggle "Not
 * available" (delegated to the grid, which owns the release-and-mark confirm).
 * All role writes reuse the existing trust-guarded slot server fns.
 */
export function MemberRolePicker({
	data,
	meetingId,
	meetingDate,
	targetMemberId,
	targetName,
	isOwnRow,
	canReassign,
	actorMemberId,
	declined,
	onMarkUnavailable,
	onMarkAvailable,
	onChanged,
	children,
}: {
	data: SeasonGridData;
	meetingId: string;
	meetingDate: string;
	targetMemberId: string;
	targetName: string;
	isOwnRow: boolean;
	/** May bump a slot held by someone else (officer action). When false, taken
	 *  slots are shown for context but aren't clickable. */
	canReassign: boolean;
	actorMemberId: string;
	declined: boolean;
	onMarkUnavailable: () => void;
	onMarkAvailable: () => void;
	onChanged: () => void | Promise<void>;
	children: React.ReactNode;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const options = meetingRoleOptions(data, meetingId, targetMemberId);
	const who = isOwnRow ? "You" : targetName;

	async function act(o: RoleOption) {
		const action = slotAction(o.state);
		setBusy(o.slotId);
		try {
			if (action === "release") {
				await releaseSlot({ data: { slotId: o.slotId, actorMemberId } });
				toast.success(`Released ${o.label}.`);
			} else if (action === "reassign") {
				await reassignSlot({
					data: { slotId: o.slotId, memberId: targetMemberId, actorMemberId },
				});
				toast.success(`${who} now has ${o.label}.`);
			} else {
				await claimSlot({
					data: { slotId: o.slotId, memberId: targetMemberId, actorMemberId },
				});
				// Speaking slots start with no speech attached — nudge for details.
				if (o.isSpeakerRole) {
					toast.success(`Assigned ${o.label}.`, {
						description: "Add speech title & project on the meeting page.",
						action: {
							label: "Add details",
							onClick: () =>
								router.navigate({
									to: "/meetings/$id",
									params: { id: meetingId },
								}),
						},
					});
				} else {
					toast.success(`Assigned ${o.label}.`);
				}
			}
			await onChanged();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't update.");
		} finally {
			setBusy(null);
		}
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent align="center" className="w-72 p-0">
				<div className="border-b border-[var(--line)] px-3 py-2">
					<div className="text-sm font-semibold">{targetName}</div>
					<div className="text-xs text-[var(--sea-ink-soft)]">
						{meetingDate}
					</div>
				</div>
				<div className="max-h-72 overflow-y-auto py-1">
					{options.map((o) => {
						const action = slotAction(o.state);
						const locked = o.state === "other" && !canReassign;
						return (
							<button
								key={o.slotId}
								type="button"
								disabled={busy !== null || locked}
								onClick={() => act(o)}
								className={cn(
									"flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-[var(--foam)] disabled:opacity-50",
								)}
							>
								<span
									className={cn(
										"flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
										o.state === "mine"
											? "border-[var(--palm)] bg-[var(--palm)] text-white"
											: "border-[var(--line)]",
									)}
								>
									{busy === o.slotId ? (
										<Loader2 className="size-3 animate-spin" />
									) : o.state === "mine" ? (
										<Check className="size-3" />
									) : null}
								</span>
								<span className="shrink-0">{o.label}</span>
								{o.state === "other" ? (
									<span className="min-w-0 flex-1 truncate text-right text-xs text-[var(--sea-ink-soft)]">
										{o.holderName}
									</span>
								) : (
									<span className="flex-1" />
								)}
								{o.state === "other" && canReassign ? (
									<span className="shrink-0 text-[10px] font-bold tracking-[0.04em] text-[var(--warning-foreground)] uppercase">
										bump
									</span>
								) : action === "release" ? (
									<X className="size-3.5 shrink-0 text-[var(--sea-ink-soft)]" />
								) : null}
							</button>
						);
					})}
				</div>
				<div className="border-t border-[var(--line)] p-1">
					<button
						type="button"
						disabled={busy !== null}
						onClick={() => {
							setOpen(false);
							if (declined) onMarkAvailable();
							else onMarkUnavailable();
						}}
						className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--sea-ink-soft)] transition-colors hover:bg-[var(--foam)]"
					>
						<UserMinus className="size-4 shrink-0" aria-hidden />
						{declined
							? `Mark ${isOwnRow ? "yourself" : "them"} available`
							: `Mark ${isOwnRow ? "yourself" : "them"} not available`}
					</button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
