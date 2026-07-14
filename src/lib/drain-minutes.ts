// Reconnect drain of the offline minutes write-queue (issue #176 slice 4).
// PURE + CLIENT-ONLY.
//
// When the minutes screen comes back ONLINE with a non-empty queue,
// `drainMinutesQueue` replays the queued `MinutesOp`s to the server IN ORDER,
// removing each from the queue as it succeeds, then the caller re-fetches
// authoritative state. `dispatchOp` maps one op to the matching server-fn call,
// threading the client-generated entity ids (`op.guestId` for a new guest,
// `op.id` for a Table Topics speaker row) that slice 2's server schemas accept
// so a replay is idempotent (`onConflictDoNothing` on the PK) and the server's
// ids match the offline-derived ones.
//
// This module never imports `#/db` or the server-fn *modules* — it takes the
// thunks + queue-removal as injected params, so it stays out of the `pg` client
// bundle and is directly unit-testable. `MinutesOp` is imported TYPE-ONLY.
//
// KNOWN ACCEPTED LIMITATION (deferred, do not fix here): a brand-new guest
// embedded inline in an `addTableTopics` or `setAward` op has no client guest id
// (only the speaker-row / category is keyed). A single clean drain is correct
// and the transactional server-fns roll a truly-failed op back with no partial
// write — but a *lost-ack* retry (the op committed server-side yet the ack was
// lost, so the op re-drains) can create an orphan/phantom guest. Full hardening
// (minting that guest as its own idempotent op with a client id) is slice-5+.
//
// The literal-union types (`AttendanceStatus`/`AwardCategory`) are imported
// TYPE-ONLY (erased at build time, like the queue module) so the fn signatures
// match `MinutesOp`'s fields exactly — a plain `string` here would make the real
// server-fns (whose params carry the narrower unions) fail to assign to
// `MinutesServerFns` by parameter contravariance.
import type { AttendanceStatus, AwardCategory } from "#/server/minutes-logic";
import type { MinutesOp, NewGuestPayload } from "./offline-minutes-queue";

/**
 * The eight server-fn thunks the drain calls, named by OP (not by the
 * component's import names) so the op→fn mapping is explicit. Each takes the
 * `{ data }` envelope a `createServerFn` expects and resolves when the write
 * lands (or rejects to stop the drain).
 */
export type MinutesServerFns = {
	setAttendance: (args: {
		data: { meetingId: string; memberId: string; status: AttendanceStatus };
	}) => Promise<unknown>;
	addGuest: (args: {
		data: {
			meetingId: string;
			id?: string;
			guestId?: string;
			newGuest?: NewGuestPayload;
		};
	}) => Promise<unknown>;
	removeGuest: (args: {
		data: { meetingId: string; guestId: string };
	}) => Promise<unknown>;
	addTableTopics: (args: {
		data: {
			meetingId: string;
			id: string;
			memberId?: string;
			guestId?: string;
			newGuest?: NewGuestPayload;
			topic?: string;
		};
	}) => Promise<unknown>;
	removeTableTopics: (args: {
		data: { meetingId: string; id: string };
	}) => Promise<unknown>;
	moveTableTopics: (args: {
		data: { meetingId: string; id: string; direction: "up" | "down" };
	}) => Promise<unknown>;
	setAward: (args: {
		data: {
			meetingId: string;
			category: AwardCategory;
			memberId?: string;
			guestId?: string;
			newGuest?: NewGuestPayload;
		};
	}) => Promise<unknown>;
	clearAward: (args: {
		data: { meetingId: string; category: AwardCategory };
	}) => Promise<unknown>;
};

/**
 * Replay one queued op to the server via `fns`. Builds the exact `{ data }`
 * payload each server schema accepts, threading client ids for idempotency:
 * `addGuest` (new path) passes `id: op.guestId`, `addTableTopics` passes
 * `id: op.id`. The `switch` is exhaustive (a `never` default) so a new op type
 * is a compile error here.
 */
export async function dispatchOp(
	op: MinutesOp,
	meetingId: string,
	fns: MinutesServerFns,
): Promise<void> {
	switch (op.type) {
		case "setAttendance":
			await fns.setAttendance({
				data: { meetingId, memberId: op.memberId, status: op.status },
			});
			return;

		case "addGuest":
			if (op.newGuest) {
				// New-guest create: pass the client id so the server row matches the
				// offline-derived guest and the replay is idempotent.
				await fns.addGuest({
					data: { meetingId, id: op.guestId, newGuest: op.newGuest },
				});
			} else {
				await fns.addGuest({ data: { meetingId, guestId: op.guestId } });
			}
			return;

		case "removeGuest":
			await fns.removeGuest({ data: { meetingId, guestId: op.guestId } });
			return;

		case "addTableTopics":
			// Pass the client speaker-row id so remove/move ops queued after this one
			// target the same row, and the replay is idempotent.
			await fns.addTableTopics({
				data: {
					meetingId,
					id: op.id,
					memberId: op.memberId,
					guestId: op.guestId,
					newGuest: op.newGuest,
					topic: op.topic,
				},
			});
			return;

		case "removeTableTopics":
			await fns.removeTableTopics({ data: { meetingId, id: op.id } });
			return;

		case "moveTableTopics":
			await fns.moveTableTopics({
				data: { meetingId, id: op.id, direction: op.direction },
			});
			return;

		case "setAward":
			await fns.setAward({
				data: {
					meetingId,
					category: op.category,
					memberId: op.memberId,
					guestId: op.guestId,
					newGuest: op.newGuest,
				},
			});
			return;

		case "clearAward":
			await fns.clearAward({ data: { meetingId, category: op.category } });
			return;

		default: {
			// Exhaustiveness guard — a new op type must extend this switch.
			const _never: never = op;
			void _never;
		}
	}
}

/** Outcome of a drain pass. `remaining` is what is still queued afterwards. */
export type DrainResult = {
	/** How many ops were successfully replayed + removed this pass. */
	drainedCount: number;
	/** Ops still queued: empty on full success; the failed op onward on failure. */
	remaining: MinutesOp[];
	/** The error that stopped the drain, or undefined on full success. */
	error?: unknown;
};

/**
 * Replay `ops` to the server SEQUENTIALLY, in order (order matters for
 * move/remove — never `Promise.all`). After each successful `dispatch`, call
 * `onOpDrained(op.opId)` to remove just that op from the queue. On the FIRST
 * `dispatch` that throws, STOP (later ops may depend on the failed one) and
 * return the failed op + successors as `remaining` with the `error`; those are
 * NOT removed, so the next reconnect resumes from the failed op. Empty `ops` is
 * a no-op.
 */
export async function drainMinutesQueue(params: {
	meetingId: string;
	ops: MinutesOp[];
	/** Replay one op (typically `(op) => dispatchOp(op, meetingId, fns)`). */
	dispatch: (op: MinutesOp) => Promise<void>;
	/** Remove one drained op from the durable queue by its `opId`. */
	onOpDrained: (opId: string) => Promise<void>;
}): Promise<DrainResult> {
	const { ops, dispatch, onOpDrained } = params;
	let drainedCount = 0;

	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		try {
			await dispatch(op);
		} catch (error) {
			// Stop at the first failure: leave this op + all successors queued.
			return { drainedCount, remaining: ops.slice(i), error };
		}
		await onOpDrained(op.opId);
		drainedCount += 1;
	}

	return { drainedCount, remaining: [], error: undefined };
}
