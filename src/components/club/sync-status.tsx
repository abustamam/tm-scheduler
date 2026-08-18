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
// ONE COMPONENT rather than two, which is not the same claim as one indicator on
// screen — and this comment used to make the second, stronger one, which is simply
// not what meeting day looks like. In roll mode an officer sees this twice: once in
// the panel header, once in the Minutes card. That is correct and deliberate. The
// two RENDERS cannot disagree, because the route owns a single `useOfflineMinutes`
// instance and threads the same numbers to both (`use-offline-minutes-instance.guard.test.ts`),
// and the Minutes card genuinely needs its own copy — it still queues its own Table
// Topics, awards and action-item edits, which roll mode knows nothing about. What
// sharing this component buys is narrower: one copy of the wording and one priority
// order, so a fix is not made twice and cannot drift between the two.
import {
	AlertTriangle,
	CheckCircle2,
	CloudUpload,
	Loader2,
	WifiOff,
} from "lucide-react";
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
 *   • pending  → N change(s) still on this device, worded by connectivity:
 *                offline "saved on this device…", ONLINE "not yet synced…". The
 *                online half is not a theoretical branch — a write abandoned at
 *                its deadline queues with `navigator.onLine` still true.
 *   • synced   → a brief "All changes synced" confirmation (auto-dismissed)
 * An EMPTY queue with none of the above → renders nothing (the steady state is
 * invisible).
 */
export function SyncStatus({
	online,
	queueCount,
	draining,
	syncError,
	justSynced,
	onRetry,
}: SyncStatusProps) {
	// Derived here rather than taken as a second number: with two call sites, a
	// prop pair that must agree is a prop pair that can disagree, and "how many
	// changes are waiting" is this component's own business.
	//
	// It is NOT `online ? 0 : queueCount` any more, which is what it was, and that
	// line had two faults that hid each other. It rendered NOTHING for
	// `online && queueCount > 0 && !draining && !syncError` — near-unreachable when
	// this derivation was written for the Minutes card, and a NORMAL state since the
	// write deadline, because a write abandoned at its deadline is queued while
	// `navigator.onLine` is still true. (It is also the state a drain caught by a
	// meeting hop used to end in.) So the indicator added so an officer could tell
	// "on the server" from "on this device" was blind to the one state its sibling
	// fix creates. And it was UNFALSIFIABLE: `pendingCount` was read only inside
	// `if (!online && …)`, so `= queueCount` behaved identically and no test could
	// tell the two versions apart — which is why the copy below is split by `online`
	// rather than the count alone. Now a test can.
	const pendingCount = queueCount;
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
	if (pendingCount > 0) {
		const plural = pendingCount === 1 ? "" : "s";
		return (
			<p className="flex items-center gap-2 text-muted-foreground text-sm">
				{online ? (
					<CloudUpload className="size-4 shrink-0" aria-hidden />
				) : (
					<WifiOff className="size-4 shrink-0" aria-hidden />
				)}
				{online
					? `${pendingCount} change${plural} not yet synced — kept on this device until they are.`
					: `${pendingCount} change${plural} saved on this device — will sync when you're back online.`}
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
