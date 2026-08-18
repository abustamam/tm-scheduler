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
import {
	ONLINE_WRITE_TIMEOUT_MS,
	raceWithDeadline,
} from "#/lib/offline-write-deadline";
import type { MinutesData } from "#/server/minutes-logic";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/** Shown when a write is abandoned at its deadline. Says where the tap WENT —
 *  "couldn't save" would be false (it is queued, durably) and would invite the
 *  re-tap the queue exists to make unnecessary. */
const WRITE_STALLED_MESSAGE =
	"No response from the network — saved on this device and will sync later.";

/** Same event on the DRAIN side, where there is no toast: it becomes the sync
 *  error, which stops the drain, keeps the ops queued and offers Retry. */
const DRAIN_STALLED_MESSAGE = "No response from the network.";

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

	// PER-MEETING ISOLATION, and it is load-bearing. `meetingId` is a PROP, and
	// this hook's owner — the meeting route — is NOT remounted when the URL's
	// meeting param changes (`grep -rn remountDeps src/` finds nothing, so
	// TanStack Router reconciles the route instead), while the meeting nav strip
	// links straight at the same route with a different param. One tap therefore
	// changes `meetingId` with every piece of state below surviving.
	//
	// Unreset, that was live data corruption: the persisted load for meeting B
	// MERGED its saved queue with meeting A's still-queued ops (the merge is the
	// mount-race fix below and is correct WITHIN one meeting), and `runDrain`
	// then replayed A's ops with B's id — last week's roll written onto this
	// meeting, and twice over, since `removeOp` targets B and leaves the ops
	// queued under A to replay correctly later too. `snapshot` had the same bug
	// on the READ side: it is what the panel's offline projection falls back to,
	// so a hop rendered another meeting's rows, guests and counts under this
	// meeting's heading, coherently and with no error anywhere.
	//
	// A RENDER-PHASE reset (React's documented "adjusting state when a prop
	// changes" pattern), deliberately, rather than a branch inside the load
	// effect — the effect cannot cover either half of this. An effect runs after
	// the commit, so the auto-drain effect would already have fired once with A's
	// ops against B's id; and the load can REJECT (the Safari-private case its
	// catch exists for), which is exactly when a reset written into its success
	// path never runs at all. React throws this render away and re-renders
	// immediately, so nothing downstream ever observes the carried-over state.
	//
	// A drain already IN FLIGHT for A keeps the `meetingId` its closure captured
	// and so keeps writing to A, which is correct, and clears `drainingRef` /
	// `draining` itself when it finishes.
	const [stateMeetingId, setStateMeetingId] = useState(meetingId);
	if (stateMeetingId !== meetingId) {
		setStateMeetingId(meetingId);
		setQueue([]);
		setSnapshot(null);
		setSyncError(null);
		setJustSynced(false);
	}

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
			//
			// The chronology argument holds only because `current` can no longer
			// belong to a DIFFERENT meeting: the render-phase reset above empties
			// the queue on the render where `meetingId` changes, so everything
			// still in `current` here was enqueued for THIS meeting after that
			// reset. Merging across a meeting hop is what wrote one meeting's roll
			// onto another — do not restore this to an unconditional merge without
			// that reset.
			setQueue((current) => {
				if (current.length === 0) return savedQueue;
				const seen = new Set(current.map((o) => o.opId));
				return [...savedQueue.filter((o) => !seen.has(o.opId)), ...current];
			});
			setSnapshot(savedSnapshot);
		})().catch((err) => {
			// A rejected `indexedDB.open` (Safari private browsing) is HANDLED here
			// rather than left bare: since PR 3 this hook mounts for every viewer of
			// the meeting page, anonymous ones included, so an unhandled rejection
			// would be logged for readers who have nothing to do with the queue.
			//
			// But it is no longer swallowed. A silent failure here is
			// indistinguishable from a first visit — an empty queue and no snapshot
			// — which is precisely what turns a read error into a DATA bug: the
			// officer sees a clean panel and takes roll believing the changes saved
			// on this device are gone or absent. Surfacing it as `syncError` also
			// suppresses the auto-drain (it gates on `!syncError`), so a partially
			// readable queue is never replayed as if it were the whole of it.
			if (!alive) return;
			setSyncError(errMessage(err));
		});
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
					// Deadlined for the same reason the write below is, and it is the
					// other half of the same fix: without it, closing the `busy`
					// hang merely moved it. A write that times out is queued, the
					// auto-drain effect fires the moment it sees a queue with
					// `navigator.onLine` true, the replay hits the same
					// unreachable network, and `draining` — which the panel also
					// disables on — never clears. Throwing lands on
					// `drainMinutesQueue`'s stop-on-failure path: this op and its
					// successors stay queued, `syncError` shows with Retry, and
					// the auto-drain stops tight-looping (it gates on
					// `!syncError`).
					dispatch: async (op) => {
						const raced = await raceWithDeadline(
							dispatchOp(op, meetingId, fns),
							ONLINE_WRITE_TIMEOUT_MS,
						);
						if (raced === "timeout") throw new Error(DRAIN_STALLED_MESSAGE);
					},
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

	/** Reflect the op optimistically and persist it. The OFFLINE path, and also
	 *  where an online write that blew its deadline lands. */
	async function queueOp(op: MinutesOp) {
		setQueue((q) => [...q, op]);
		try {
			await enqueue(meetingId, op);
		} catch (err) {
			toast.error(errMessage(err));
		}
	}

	/**
	 * The online write. `"queue"` means the network never answered and the caller
	 * must fall through to the queue — NOT that the write failed: a genuine
	 * rejection still toasts and returns `"done"`, because an error the server
	 * chose (a 403, a rejected `assertAttendanceRecordable`) will be rejected
	 * identically on every replay and queueing it would only turn one toast into a
	 * permanent stuck queue plus a sync-error banner.
	 */
	async function writeOnline(
		onlineFn: () => Promise<unknown>,
	): Promise<"done" | "queue"> {
		setBusy(true);
		try {
			const raced = await raceWithDeadline(onlineFn(), ONLINE_WRITE_TIMEOUT_MS);
			if (raced === "timeout") {
				toast.error(WRITE_STALLED_MESSAGE);
				return "queue";
			}
			await input.onMutated();
			return "done";
		} catch (err) {
			toast.error(errMessage(err));
			return "done";
		} finally {
			setBusy(false);
		}
	}

	// ONLINE: run the server-fn against a deadline and re-fetch. OFFLINE — or
	// online-but-unreachable, which `navigator.onLine` cannot tell apart — enqueue
	// the op and reflect it optimistically; never hit the server or onMutated.
	async function mutate(
		onlineFn: () => Promise<unknown>,
		makeOp: () => MinutesOp,
	) {
		// `draining` joins the guard so a reconnect drain isn't interleaved with a
		// fresh edit (which could reorder ops). A queue only ever exists after an
		// actual offline session, so `draining` is ALWAYS false for a normal
		// online-only user — their online path (below) is byte-for-byte unchanged.
		if (busy || draining) return;
		// `navigator.onLine` is TRUE for a phone associated to an access point that
		// routes nowhere — a captive portal, or the dead venue wifi this feature
		// exists for — so "online" is a hypothesis, and the deadline inside
		// `writeOnline` is what tests it. Before it, such a tap hung forever with
		// `busy` stuck true, which disabled every chip and the guest group with no
		// spinner, no toast and no recovery short of a reload, on the one surface
		// #176's queue was built for.
		if (!online || (await writeOnline(onlineFn)) === "queue") {
			await queueOp(makeOp());
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
	const retryDrain = async () => {
		// Nothing queued, yet an error is showing: the only way into that state is
		// the persisted-load failure above, and `runDrain` returns immediately on an
		// empty queue without touching `syncError` — so a bare `runDrain(queue)`
		// here gives that banner a Retry button that provably cannot do anything.
		// Clearing it is the honest response, and it re-arms the auto-drain (which
		// gates on `!syncError`) for the moment a queue does appear.
		if (queue.length === 0) {
			setSyncError(null);
			return;
		}
		await runDrain(queue);
	};

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
