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

	// The meeting an ASYNC CONTINUATION must re-check before it touches shared
	// state, and the fix for the corruption the write deadline reopened.
	// `queueOp` and the drain's per-op callback each CAPTURE `meetingId` for
	// their durable half (`enqueue` / `removeOp`) while their optimistic half
	// goes through a HOOK-LEVEL setter — which writes whichever meeting is on
	// screen when the continuation resumes. The two could not disagree while
	// `queueOp` only ran synchronously inside the offline branch; the deadline
	// made it reachable ONLINE_WRITE_TIMEOUT_MS after the tap, which is ample
	// time for one tap on the meeting nav strip. Kept current by the
	// render-phase reset below, so it is right from the render where `meetingId`
	// changes onward — a state value cannot do this job, because the closure
	// that has to make the comparison captured the render it was created in.
	const meetingIdRef = useRef(meetingId);

	// Whether this hook's owner is still on screen. The write deadline resolves up
	// to ONLINE_WRITE_TIMEOUT_MS after the tap, by which time the officer may have
	// navigated somewhere else entirely: the `enqueue` still has to happen (the tap
	// is real and the queue is durable), but its toast would land on whatever page
	// they are looking at now, about a meeting they have left.
	//
	// It is NOT SUFFICIENT on its own, and the mechanism that defeats it is stated
	// thirty lines below: the meeting route is NOT remounted when the meeting param
	// changes, so a tap on the nav strip leaves `mountedRef.current === true`.
	// Meeting A's deadline toast therefore landed on meeting B, whose own
	// `SyncStatus` shows nothing (B's queue is empty) — so B read fully synced while
	// A's op sat stranded with no indicator anywhere. The toast is gated on
	// `meetingIdRef` as well for that reason, the same test `queueOp` and all four
	// drain callbacks already make.
	//
	// The stranded op itself is a separate problem and NOT closed by this: it stays
	// in IndexedDB under meeting A and surfaces the moment A is opened again, which
	// is the same recovery the drain's own meeting-scoped `syncError` relies on.
	const mountedRef = useRef(true);
	useEffect(() => {
		// Re-armed on mount, not only cleared on unmount: React 19's StrictMode
		// mounts, unmounts and remounts in development, and a cleared flag never
		// set again would silence every toast for the rest of the session.
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

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
		meetingIdRef.current = meetingId;
		setQueue([]);
		setSnapshot(null);
		setSyncError(null);
		setJustSynced(false);
		// `busy` too, and it is not cosmetic. The route wires
		// `busy={offlineMinutes.busy || offlineMinutes.draining}` into the panel's
		// `locked`, and `mutate` refuses outright on it — so a hop taken during a
		// stalled write left meeting B's ENTIRE roll surface disabled (every chip,
		// the menu items, the guest group) for the remainder of A's deadline, and
		// any tap that did get through returned silently. That is a scoped repeat
		// of the symptom the deadline exists to kill.
		setBusy(false);
		// NOT `draining` / `drainingRef`, deliberately: a drain genuinely in flight
		// for A must KEEP its re-entrancy guard, or clearing it here lets a second
		// concurrent drain start against the same persisted queue and reorder ops.
		// What lets B's queue drain once A's drain finishes is the `draining`
		// dependency on the auto-drain effect below — not a reset here.
	}

	// Bumped by `retryDrain`, and the load effect below depends on it. Without it
	// Retry's entire effect on a failed-read banner is to HIDE it: that effect's
	// deps were `[meetingId]` alone and it is the only reader of the durable queue
	// there is, so "re-arms the auto-drain for the moment a queue does appear"
	// described a moment that could not come.
	const [loadNonce, setLoadNonce] = useState(0);

	// Load any persisted snapshot + queue once per meeting (survives reloads), and
	// again whenever Retry bumps `loadNonce`. The suppression below is the point of
	// the dependency, not a workaround for it: the body never READS the nonce, it
	// exists so that bumping it re-runs this effect, and biome's rule can only see
	// the read. One physical line — a wrapped reason silences nothing.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `loadNonce` is a deliberate re-run trigger — Retry bumps it so this effect re-READS the persisted queue (F6); without it Retry's only effect is to hide the banner
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
			// belong to a DIFFERENT meeting, and that now takes TWO guards rather
			// than one. The render-phase reset above empties the queue on the
			// render where `meetingId` changes — but a write abandoned at its
			// deadline resumes up to ONLINE_WRITE_TIMEOUT_MS after the tap, so the
			// reset ALONE left `queueOp` free to push meeting A's op into B's
			// queue afterwards (this comment claimed otherwise, and was wrong from
			// the commit that added the deadline). `queueOp`'s own `meetingIdRef`
			// check is the second guard. With both, everything still in `current`
			// here was enqueued for THIS meeting after that reset. Merging across a
			// meeting hop is what wrote one meeting's roll onto another — do not
			// restore this to an unconditional merge without both guards.
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
	}, [meetingId, loadNonce]);

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
						// Same split as `queueOp`, same reason: the durable removal is
						// scoped to the meeting THIS drain belongs to, the state update is
						// not. A drain still in flight across a hop would otherwise filter
						// the NEXT meeting's queue by this meeting's opIds.
						if (meetingIdRef.current === meetingId) {
							setQueue((q) => q.filter((o) => o.opId !== opId));
						}
					},
				});
				if (result.error) {
					// Stop-on-failure: the failed op + successors stay queued. The
					// banner and the confirmation both DESCRIBE THIS MEETING'S QUEUE,
					// so a drain that finishes after a hop keeps quiet rather than
					// painting its verdict onto the meeting now on screen: "All changes
					// synced" over a queue that is still pending is the false
					// reassurance this indicator exists to prevent, and a stale
					// `syncError` would additionally suppress the next meeting's
					// auto-drain (which gates on `!syncError`). The ops stay in
					// IndexedDB under their own meeting either way, so the failure is
					// surfaced the moment that meeting is opened again.
					if (meetingIdRef.current === meetingId) {
						setSyncError(errMessage(result.error));
					}
				} else {
					// Everything replayed — re-fetch authoritative state (the online
					// snapshot-save effect then refreshes the offline snapshot).
					// UNCONDITIONAL: server state really did change, and the refetch is
					// for the router, not for this meeting's banner.
					await onMutatedRef.current();
					// Flash a brief "All changes synced" confirmation (auto-dismissed).
					if (meetingIdRef.current === meetingId) setJustSynced(true);
				}
			} catch (err) {
				if (meetingIdRef.current === meetingId) setSyncError(errMessage(err));
			} finally {
				// NOT meeting-scoped, deliberately: these two are the re-entrancy
				// guard and the panel's disabled-everything signal, and the failure
				// mode of not clearing them is the stuck-disabled panel the deadline
				// exists to kill. A guard clears unconditionally; only queue and
				// display state is meeting-scoped.
				drainingRef.current = false;
				setDraining(false);
			}
		},
		[meetingId],
	);

	// Auto-drain when back online with a pending queue: covers the offline→online
	// transition and an online mount with a leftover queue (e.g. after a reload).
	// Skipped while a drain is in flight or a sync error is showing — a persistent
	// failure would otherwise tight-loop; the user retries explicitly.
	//
	// `draining` is BOTH a guard here and a dependency, and it is the fix for a
	// silent drop rather than a tidy-up: this effect is the only caller of
	// `runDrain` on the automatic path, and `runDrain`'s own `drainingRef` early
	// return says nothing to anyone. A drain in flight for meeting A across a hop
	// to B therefore swallowed B's drain outright — the effect fired on the commit
	// that loaded B's persisted queue, hit the ref guard, and had no reason to ever
	// fire again, because the RELEASE of that drain changes `draining` and nothing
	// else in this list. B's roll then sat on the device with the panel reading
	// "All changes synced." for four seconds and nothing at all after that.
	// Depending on `draining` means a drain's completion RE-ARMS the effect.
	//
	// It cannot tight-loop, and the reason is the `!syncError` gate rather than
	// anything about `draining`: each pass either shortens the queue (progress),
	// empties it, or sets `syncError` and is gated out here. "stops a DRAIN the
	// network never answers" holds that with a dispatch-count assertion.
	useEffect(() => {
		if (!online || queue.length === 0 || syncError || draining) return;
		void runDrain(queue);
	}, [online, queue, syncError, runDrain, draining]);

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
		// `enqueue` stays on the CAPTURED meeting and must: the op is that
		// meeting's roll and has to persist under it, so it replays against it
		// later. The optimistic `setQueue` is hook-level, so it is SKIPPED once a
		// hop has happened since the tap. Unskipped, one deadlined tap wrote A's
		// roll into B's queue, B's auto-drain dispatched it against B's id, and
		// `removeOp` then cleared B's copy — leaving A's still queued to replay
		// against A as well. One tap, two meetings, no error on either.
		if (meetingIdRef.current === meetingId) {
			setQueue((q) => [...q, op]);
		}
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
				// The QUEUEING below is unconditional — the tap must survive either
				// way. Only the toast is gated on still being here, which takes BOTH
				// conditions: mounted, AND still on the meeting this write belongs to
				// (see `mountedRef`, which explains why the second is not implied by
				// the first on this route).
				if (mountedRef.current && meetingIdRef.current === meetingId) {
					toast.error(WRITE_STALLED_MESSAGE);
				}
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
		// Nothing queued, yet an error is showing. TWO ways into that state, not the
		// one this comment used to claim: the persisted load rejected
		// (`indexedDB.open` in Safari private browsing), or a drain in which every op
		// landed but `onMutatedRef.current()` threw — which exits through `runDrain`'s
		// catch with an empty queue and an error set. `runDrain` returns immediately
		// on an empty queue without touching `syncError`, so a bare `runDrain(queue)`
		// here gives that banner a Retry button that provably cannot do anything.
		//
		// Clearing the error alone is not enough either, and the version that did
		// only that was arguing with itself: it re-armed the auto-drain "for the
		// moment a queue does appear" while the load effect — the ONLY reader of the
		// durable queue — could not re-run to make one appear. So Retry RE-READS,
		// via `loadNonce`. On the read-failure path that is the retry the button
		// names; on the `onMutated` path the re-read is a no-op over an already
		// drained queue and clearing the error is the whole of the fix.
		if (queue.length === 0) {
			setSyncError(null);
			setLoadNonce((n) => n + 1);
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
