import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { showWriteError } from "#/components/write-error-toast";
import { formatLastServed } from "#/lib/agenda";
import {
	type CoverSlot,
	coverDraft,
	meetingDayWord,
} from "#/lib/cover-sheet-logic";
import { DUTY_TOAST_MS, roleFreedDutyText } from "#/lib/role-duty-copy";

/** The server functions load on first use, not at import: `#/server/cover`
 *  pulls in the database client, and every page that can OPEN this sheet (and
 *  every test that mounts one) would otherwise need it at import time. */
const server = () => import("#/server/cover");

export type { CoverSlot };

interface Candidate {
	memberId: string;
	name: string;
	lastServedAt: string | null;
}

export interface CoverSheetProps {
	/** The roles on offer; empty closes the sheet. "release" mode takes one. */
	slots: CoverSlot[];
	/**
	 * "release" (default): nothing is released until Ask or Drop it anyway.
	 * "released": the roles are already open (a decline freed them, #1442), so
	 * no release call is made and Ask calls `askForCover` per slot instead.
	 */
	mode?: "release" | "released";
	/** Closes the sheet. */
	onClose: () => void;
	/** After a release, an ask or an Undo: the route re-fetches its data. */
	onChanged?: () => void | Promise<void>;
}

/**
 * "Who can cover <Role>?" (#1439): the handoff step between a member's own
 * Release and the role going back to the pool, on a drop inside 48h.
 *
 * The app suggests and drafts; the member sends (CONTEXT.md, "Cover request"):
 * Ask opens the share sheet with a message naming the candidate, never sends.
 * Closing the sheet without Ask or Drop it anyway leaves the role held.
 */
export function CoverSheet({
	slots,
	mode = "release",
	onClose,
	onChanged,
}: CoverSheetProps) {
	const open = slots.length > 0;
	const [index, setIndex] = useState(0);
	// Slots already handed off by this sheet (or open from the start): later
	// Asks only share.
	const [handedOff, setHandedOff] = useState<Set<string>>(new Set());
	const [candidates, setCandidates] = useState<Candidate[] | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [notSent, setNotSent] = useState(false);
	/** Release-toast id per slot, so an in-sheet Undo can dismiss it. */
	/** Set synchronously: `busy` only changes on the next render, after a
	 *  second tap of the same render has already got through. */
	const undoing = useRef(false);
	const releaseToasts = useRef(new Map<string, string | number>());

	const slotKey = slots.map((s) => s.slotId).join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new offer resets the sheet
	useEffect(() => {
		setIndex(0);
		setHandedOff(new Set());
		setNotSent(false);
	}, [slotKey]);

	const slot = slots[Math.min(index, Math.max(slots.length - 1, 0))];
	const slotId = slot?.slotId;
	const meetingId = slot?.meetingId;

	useEffect(() => {
		if (!slotId || !meetingId) return;
		let live = true;
		setCandidates(null);
		setLoadFailed(false);
		setNotSent(false);
		server()
			.then((m) => m.loadCoverCandidates({ data: { meetingId, slotId } }))
			.then((rows) => {
				if (live) setCandidates(rows);
			})
			.catch(() => {
				// A failed look-up must not block the handoff: the sheet says so and
				// still offers Ask (the generic draft) and Drop it anyway.
				if (live) {
					setLoadFailed(true);
					setCandidates([]);
				}
			});
		return () => {
			live = false;
		};
	}, [slotId, meetingId]);

	if (!slot) {
		return (
			<Sheet open={false}>
				<SheetContent side="bottom" />
			</Sheet>
		);
	}

	const scheduledAt = new Date(slot.scheduledAt);
	const dayWord = meetingDayWord(scheduledAt, new Date(), slot.timeZone);
	const slotHandedOff = handedOff.has(slot.slotId);
	const released = mode === "released" || slotHandedOff;

	function markHandedOff(id: string) {
		setHandedOff((prev) => new Set(prev).add(id));
	}

	function unmarkHandedOff(id: string) {
		setHandedOff((prev) => {
			const next = new Set(prev);
			next.delete(id);
			return next;
		});
	}

	/** Gives the role back exactly (`undoReleaseForCover`, eng review D4). The
	 *  sheet returns to its pre-release state, so the next Ask releases again
	 *  and Drop it anyway is back. */
	async function undoRelease(target: CoverSlot) {
		if (busy || undoing.current) return;
		undoing.current = true;
		setBusy(true);
		try {
			await (await server()).undoReleaseForCover({
				data: { slotId: target.slotId },
			});
			const toastId = releaseToasts.current.get(target.slotId);
			if (toastId !== undefined) {
				toast.dismiss(toastId);
				releaseToasts.current.delete(target.slotId);
			}
			toast.success("Role back.");
			unmarkHandedOff(target.slotId);
			await onChanged?.();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			undoing.current = false;
			setBusy(false);
		}
	}

	/** The release toast: the plain "role freed" line with Undo. While the
	 *  sheet is open its modal overlay covers the toaster, so the sheet carries
	 *  its own Undo button too (#1455); the toast's serves after the sheet closes. */
	function toastReleased(target: CoverSlot) {
		const toastId = toast.success(roleFreedDutyText(1), {
			duration: DUTY_TOAST_MS,
			action: { label: "Undo", onClick: () => undoRelease(target) },
		});
		releaseToasts.current.set(target.slotId, toastId);
	}

	async function drop() {
		if (busy) return;
		const target = slot;
		setBusy(true);
		try {
			await (await server()).releaseOwnSlotForCover({
				data: { slotId: target.slotId, kind: "dropped" },
			});
			toastReleased(target);
			await onChanged?.();
			onClose();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	async function ask(candidate: Candidate | null) {
		if (busy) return;
		const target = slot;
		setBusy(true);
		setNotSent(false);
		try {
			if (!handedOff.has(target.slotId)) {
				if (mode === "released") {
					await (await server()).askForCover({
						data: { slotId: target.slotId },
					});
				} else {
					await (await server()).releaseOwnSlotForCover({
						data: { slotId: target.slotId, kind: "finding_cover" },
					});
					toastReleased(target);
				}
				markHandedOff(target.slotId);
				await onChanged?.();
			}
		} catch (err) {
			showWriteError(err, "Something went wrong.");
			setBusy(false);
			return;
		}
		// From here the request stands whatever the share does.
		const firstName = candidate?.name.trim().split(/\s+/)[0] ?? null;
		const text = coverDraft({
			slot: target,
			origin: window.location.origin,
			firstName,
		});
		try {
			if (typeof navigator.share === "function") {
				await navigator.share({ text });
			} else {
				// A plain-text write: `copyShareLink` prepends the origin and would
				// corrupt the draft (eng review O9).
				await navigator.clipboard.writeText(text);
				toast.success(
					`Copied. Paste it to ${firstName ?? "someone who can cover"}.`,
				);
			}
		} catch {
			setNotSent(true);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Sheet
			open={open}
			onOpenChange={(o) => {
				if (!o && !busy) onClose();
			}}
		>
			<SheetContent side="bottom" className="max-h-[90svh] overflow-y-auto">
				<SheetHeader>
					<SheetTitle>Who can cover {slot.roleLabel}?</SheetTitle>
					<SheetDescription>
						{slotHandedOff
							? `The meeting is ${dayWord}. ${slot.roleLabel} is open and the request is in.`
							: mode === "released"
								? `The meeting is ${dayWord}. ${slot.roleLabel} is open. Ask someone to take it.`
								: `The meeting is ${dayWord}. If you just drop it, ${slot.roleLabel} sits empty and your VPE finds out at the meeting.`}
					</SheetDescription>
				</SheetHeader>

				<div className="flex flex-col gap-3 px-4 pb-4">
					{slots.length > 1 ? (
						<fieldset className="flex flex-wrap gap-2">
							<legend className="sr-only">Which role</legend>
							{slots.map((s, i) => (
								<Button
									key={s.slotId}
									type="button"
									size="touch"
									variant={i === index ? "default" : "outline"}
									aria-pressed={i === index}
									disabled={busy}
									onClick={() => setIndex(i)}
								>
									{s.roleLabel}
								</Button>
							))}
						</fieldset>
					) : null}

					{candidates === null ? (
						<p className="text-sm text-muted-foreground">Looking…</p>
					) : candidates.length === 0 ? (
						<>
							<p className="text-sm">
								{loadFailed
									? "Couldn't load who's coming."
									: "Nobody has said they're coming yet."}
							</p>
							<Button
								type="button"
								size="touch"
								disabled={busy}
								onClick={() => ask(null)}
							>
								Ask
							</Button>
						</>
					) : (
						<ul className="flex flex-col gap-2">
							{candidates.map((c) => (
								<li
									key={c.memberId}
									className="flex min-h-11 items-center justify-between gap-3"
								>
									<div className="min-w-0">
										<p className="truncate text-sm font-semibold">{c.name}</p>
										<p className="text-xs text-muted-foreground">
											{c.lastServedAt === null
												? `coming · never been ${slot.roleLabel}`
												: `coming · ${slot.roleLabel} ${formatLastServed(new Date(c.lastServedAt))}`}
										</p>
									</div>
									<Button
										type="button"
										size="touch"
										variant="outline"
										aria-label={`Ask ${c.name}`}
										disabled={busy}
										onClick={() => ask(c)}
									>
										Ask
									</Button>
								</li>
							))}
						</ul>
					)}

					{notSent ? (
						<output className="block text-sm text-destructive">
							Not sent. Ask someone else, or close.
						</output>
					) : null}

					{mode === "release" && slotHandedOff ? (
						<Button
							type="button"
							size="touch"
							variant="outline"
							disabled={busy}
							onClick={() => undoRelease(slot)}
						>
							Undo: I'll keep {slot.roleLabel}
						</Button>
					) : null}

					{released ? (
						<Button
							type="button"
							size="touch"
							variant="ghost"
							disabled={busy}
							onClick={onClose}
						>
							Close
						</Button>
					) : (
						<Button
							type="button"
							size="touch"
							variant="ghost"
							disabled={busy}
							onClick={drop}
						>
							Drop it anyway
						</Button>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
