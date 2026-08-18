// The offline write-queue's sync indicator, shared by the two surfaces that
// write through `useOfflineMinutes` (#176): the Minutes card, which queues its
// own Table Topics / awards / action-item edits, and the attendance panel's ROLL
// mode, which since PR 3 is the ONLY place attendance is recorded.
//
// It lived inside `meeting-minutes.tsx` until the panel absorbed roll call, and
// leaving it there was the bug: an officer took roll offline on the panel, every
// chip moved (the projection is faithful), and the only thing that could say the
// writes had not reached the server sat in a different card — on a phone, at the
// other end of the page (`order-1` vs the `order-2` column). They closed the tab
// and the drain only ever ran if someone reopened THAT meeting in THAT browser,
// while the minutes PDF and the emailed minutes went out with the roll missing.
//
// ONE copy rather than two: the two surfaces read the same hook instance, so two
// indicators could disagree about the same queue, and a fix to the copy or the
// priority order would have to be found twice.
import { AlertTriangle, CheckCircle2, Loader2, WifiOff } from "lucide-react";
import { Button } from "#/components/ui/button";

/**
 * Exactly what `useOfflineMinutes` returns, minus the parts a display cannot
 * use — exported so a caller threads ONE object instead of six same-typed
 * arguments it could shuffle (`draining` and `justSynced` are both booleans).
 */
export type SyncStatusProps = {
	online: boolean;
	/** `queue.length`. The offline copy shows it; the syncing copy counts it. */
	queueCount: number;
	draining: boolean;
	syncError: string | null;
	justSynced: boolean;
	onRetry: () => void;
};

/**
 * One cohesive indicator for the offline write-queue's sync lifecycle. Purely
 * presentational — it reads the hook state its caller threads in and never
 * drives a mutation. States, in priority order:
 *   • syncing  → a spinner + "Syncing N change(s)…"      (a drain is in flight)
 *   • error    → a warning + "Couldn't sync changes" + Retry
 *   • offline  → WifiOff + "N change(s) saved on this device…"
 *   • synced   → a brief "All changes synced" confirmation (auto-dismissed)
 * Online with an empty queue and none of the above → renders nothing (the steady
 * state is invisible).
 */
export function SyncStatus({
	online,
	queueCount,
	draining,
	syncError,
	justSynced,
	onRetry,
}: SyncStatusProps) {
	// Derived here rather than taken as a second number. It was
	// `online ? 0 : queue.length` at the one call site this component had; with
	// two call sites, a prop pair that must agree is a prop pair that can
	// disagree — and "how many changes are waiting" is this component's own
	// business, not something a route should be able to state wrongly.
	const pendingCount = online ? 0 : queueCount;
	if (draining) {
		return (
			<p className="flex items-center gap-2 text-muted-foreground text-sm">
				<Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
				Syncing {queueCount} change{queueCount === 1 ? "" : "s"}…
			</p>
		);
	}
	if (syncError) {
		return (
			<p className="flex items-center gap-2 text-warning-foreground text-sm">
				<AlertTriangle className="size-4 shrink-0" aria-hidden />
				<span>
					Couldn't sync changes —{" "}
					<Button
						type="button"
						variant="link"
						size="sm"
						className="h-auto p-0 align-baseline text-warning-foreground"
						onClick={onRetry}
					>
						Retry
					</Button>
				</span>
			</p>
		);
	}
	if (!online && pendingCount > 0) {
		return (
			<p className="flex items-center gap-2 text-muted-foreground text-sm">
				<WifiOff className="size-4 shrink-0" aria-hidden />
				{pendingCount} change{pendingCount === 1 ? "" : "s"} saved on this
				device — will sync when you're back online.
			</p>
		);
	}
	if (justSynced) {
		return (
			<p className="flex items-center gap-2 text-muted-foreground text-sm">
				<CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
				All changes synced.
			</p>
		);
	}
	return null;
}
