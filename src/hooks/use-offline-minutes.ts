import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useOnlineStatus } from "#/hooks/use-online-status";
import {
	dispatchOp,
	drainMinutesQueue,
	type MinutesServerFns,
} from "#/lib/drain-minutes";
import {
	enqueue,
	type MinutesOp,
	readQueue,
	readSnapshot,
	removeOp,
	saveSnapshot,
} from "#/lib/offline-minutes-queue";
import type { MinutesData } from "#/server/minutes-logic";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/**
 * The offline-capable write path for meeting-day edits (#176), lifted out of
 * `MeetingMinutes` so the attendance panel gets the same capability when it
 * absorbs roll call (PR 3). Behaviour is unchanged from the original — this is a
 * move, not a rewrite.
 *
 * `draining` joins the busy guard so a reconnect drain is not interleaved with a
 * fresh edit (which could reorder ops). A queue only ever exists after an actual
 * offline session, so `draining` is ALWAYS false for a normal online-only user —
 * their online path is byte-for-byte what it was.
 *
 * The eight dispatch fns (`setAttendance`, `addMinutesGuest`, ...) that the
 * drain replays against are loaded via a LAZY `import("#/server/minutes")`
 * inside `runDrain` rather than a static top-of-file import. `#/server/minutes`
 * transitively imports `#/db`, which throws eagerly at module load when
 * `DATABASE_URL` is unset (`src/db/index.ts`) — a static import would make this
 * hook module itself unimportable in a plain unit test that never touches a
 * database (this hook's own `use-offline-minutes.test.ts` does not mock
 * `#/db`, matching `meeting-minutes.tsx`'s ONLINE-path tests, which never drain
 * a queue either). Deferring the import until a drain actually runs keeps every
 * non-draining test import-safe while leaving the drained behaviour identical.
 */
export function useOfflineMinutes(input: {
	meetingId: string;
	onMutated: () => Promise<void>;
	/**
	 * The live loader data, ONLINE. Optional and additive to the brief's stated
	 * `{ meetingId, onMutated }` shape: without it, the "keep the offline
	 * snapshot fresh from every online render" effect below (moved verbatim from
	 * `meeting-minutes.tsx:176-181`) has nothing to persist and is a no-op —
	 * which is what happens for a caller that never goes offline anyway. A
	 * caller that DOES pass it gets the original behaviour back: the persisted
	 * base `deriveMinutes` falls back to while offline is refreshed on every
	 * online render, not stuck at whatever was last saved to IndexedDB. Omitting
	 * this would have been a silent regression across multiple offline
	 * excursions in one un-reloaded session — the original effect needs
	 * `setSnapshot`, which only this hook has once the state moves here.
	 */
	minutes?: MinutesData | null;
}) {
	const online = useOnlineStatus();
	const [busy, setBusy] = useState(false);
	const [queue, setQueue] = useState<MinutesOp[]>([]);
	const [snapshot, setSnapshot] = useState<MinutesData | null>(null);
	const [draining, setDraining] = useState(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	// Transient "All changes synced" confirmation shown briefly after a drain
	// fully lands, then auto-dismissed (the effect below clears it on a timer).
	const [justSynced, setJustSynced] = useState(false);
	// `draining` state lags a tick, so the drain effect can re-fire before it
	// flips — a synchronous ref blocks a second concurrent drain.
	const drainingRef = useRef(false);
	// `onMutated` is a fresh arrow every render (router.invalidate); stash it in a
	// ref so `runDrain`'s identity stays stable and the drain effect isn't
	// re-triggered on every parent re-render.
	const onMutatedRef = useRef(input.onMutated);
	onMutatedRef.current = input.onMutated;
	const { meetingId, minutes } = input;

	// Load any persisted snapshot + queue once per meeting (survives reloads).
	useEffect(() => {
		let alive = true;
		void (async () => {
			const [savedQueue, savedSnapshot] = await Promise.all([
				readQueue(meetingId),
				readSnapshot(meetingId),
			]);
			if (!alive) return;
			// A `mutate()` call can land WHILE this persisted load is still in
			// flight (the read started before that op was enqueued) — merge rather
			// than overwrite, or this slower-resolving mount-time load would
			// silently revert an optimistic queue update that arrived first.
			// Ops read here are chronologically EARLIER than anything already in
			// `current` (this read started at mount, before any such op existed),
			// so they sort first; de-dup by opId defensively.
			setQueue((current) => {
				if (current.length === 0) return savedQueue;
				const seen = new Set(current.map((o) => o.opId));
				return [...savedQueue.filter((o) => !seen.has(o.opId)), ...current];
			});
			setSnapshot(savedSnapshot);
			// Swallowed deliberately: a rejected `indexedDB.open` (Safari private
			// browsing) means there is no persisted queue to restore, which is the
			// same state as a first visit — the online path never touches IDB and is
			// unaffected. Left bare, it is an UNHANDLED rejection, and since PR 3 this
			// hook mounts for every viewer of the meeting page including anonymous
			// ones who can never write, so the page would log one for readers who have
			// nothing to do with the offline queue at all.
		})().catch(() => {});
		return () => {
			alive = false;
		};
	}, [meetingId]);

	// Keep the offline snapshot fresh from every ONLINE render of the loader
	// data. No-ops when `minutes` isn't supplied (see the input's doc comment).
	useEffect(() => {
		if (!online || !minutes) return;
		setSnapshot(minutes);
		void saveSnapshot(meetingId, minutes);
	}, [online, minutes, meetingId]);

	// #176 slice 4: replay the queued ops to the server IN ORDER, removing each as
	// it lands, then re-fetch authoritative state. Stops at the first failure and
	// keeps the failed op + successors queued for the next reconnect / Retry.
	const runDrain = useCallback(
		async (ops: MinutesOp[]) => {
			if (drainingRef.current || ops.length === 0) return;
			drainingRef.current = true;
			setDraining(true);
			setSyncError(null);
			setJustSynced(false);
			try {
				// Deferred import — see the hook's doc comment above for why this is
				// lazy rather than a static top-of-file import.
				const {
					setAttendance,
					addMinutesGuest,
					removeMinutesGuest,
					addTableTopics,
					removeTableTopics,
					moveTableTopics,
					setMinutesAward,
					clearMinutesAward,
				} = await import("#/server/minutes");
				const fns: MinutesServerFns = {
					setAttendance,
					addGuest: addMinutesGuest,
					removeGuest: removeMinutesGuest,
					addTableTopics,
					removeTableTopics,
					moveTableTopics,
					setAward: setMinutesAward,
					clearAward: clearMinutesAward,
				};
				const result = await drainMinutesQueue({
					meetingId,
					ops,
					dispatch: (op) => dispatchOp(op, meetingId, fns),
					onOpDrained: async (opId) => {
						await removeOp(meetingId, opId);
						setQueue((q) => q.filter((o) => o.opId !== opId));
					},
				});
				if (result.error) {
					// Stop-on-failure: the failed op + successors stay queued.
					setSyncError(errMessage(result.error));
				} else {
					// Everything replayed — re-fetch authoritative state (the online
					// snapshot-save effect then refreshes the offline snapshot).
					await onMutatedRef.current();
					// Flash a brief "All changes synced" confirmation (auto-dismissed).
					setJustSynced(true);
				}
			} catch (err) {
				setSyncError(errMessage(err));
			} finally {
				drainingRef.current = false;
				setDraining(false);
			}
		},
		[meetingId],
	);

	// Auto-drain when back online with a pending queue: covers the offline→online
	// transition and an online mount with a leftover queue (e.g. after a reload).
	// Skipped while a drain is in flight (ref guard) or a sync error is showing —
	// a persistent failure would otherwise tight-loop; the user retries explicitly.
	useEffect(() => {
		if (!online || queue.length === 0 || syncError) return;
		void runDrain(queue);
	}, [online, queue, syncError, runDrain]);

	// Going offline clears a stale sync error so the next genuine reconnect
	// auto-retries; while online, a persistent error stays set (see above).
	useEffect(() => {
		if (!online) setSyncError(null);
	}, [online]);

	// Auto-dismiss the "All changes synced" confirmation a few seconds after it
	// appears. The timer is cleared on unmount (or if it re-fires) so it never
	// fires against a gone component.
	useEffect(() => {
		if (!justSynced) return;
		const t = setTimeout(() => setJustSynced(false), 4000);
		return () => clearTimeout(t);
	}, [justSynced]);

	// ONLINE: run the server-fn and re-fetch (unchanged). OFFLINE: enqueue the op
	// and reflect it optimistically; never hit the server or onMutated.
	async function mutate(
		onlineFn: () => Promise<unknown>,
		makeOp: () => MinutesOp,
	) {
		// `draining` joins the guard so a reconnect drain isn't interleaved with a
		// fresh edit (which could reorder ops). A queue only ever exists after an
		// actual offline session, so `draining` is ALWAYS false for a normal
		// online-only user — their online path (below) is byte-for-byte unchanged.
		if (busy || draining) return;
		if (!online) {
			const op = makeOp();
			setQueue((q) => [...q, op]);
			try {
				await enqueue(meetingId, op);
			} catch (err) {
				toast.error(errMessage(err));
			}
			return;
		}
		setBusy(true);
		try {
			await onlineFn();
			await input.onMutated();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setBusy(false);
		}
	}

	const opMeta = () => ({
		opId: crypto.randomUUID(),
		queuedAt: Date.now(),
	});

	// The Sync-status banner's "Retry" button (moved verbatim in behaviour, not
	// name) re-attempts a drain that stopped on a failure — deliberately calling
	// `runDrain` directly rather than going through the auto-drain effect above,
	// since that effect gates on `!syncError` and would otherwise never re-fire
	// for exactly the case Retry exists for. Additive beyond the brief's stated
	// 8-key return (`mutate, opMeta, busy, queue, snapshot, draining, syncError,
	// justSynced`): `meeting-minutes.tsx`'s existing Retry control needs a way to
	// reach this, and the hook owns `runDrain` now.
	const retryDrain = () => runDrain(queue);

	return {
		mutate,
		opMeta,
		busy,
		queue,
		snapshot,
		draining,
		syncError,
		justSynced,
		retryDrain,
	};
}
