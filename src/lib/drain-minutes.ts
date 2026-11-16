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
// EVERY OP HERE MUST CONVERGE ON REPLAY, because the write deadline
// (`offline-write-deadline.ts`) abandons a request without cancelling it — so an
// op the server has already applied is routinely re-dispatched. Seven do so by
// construction: `setAttendance` / `setAward` are `onConflictDoUpdate` upserts
// (last-write-wins), `addGuest` / `addTableTopics` are `onConflictDoNothing` on a
// client-supplied id (an `addGuest` toggle, `replaceMode`, #1049, upserts its
// mode instead — last-write-wins again), and `removeGuest` / `removeTableTopics` / `clearAward` are
// deletes. `moveTableTopics` is the EXCEPTION and does not converge on its own:
// `direction` is a relative swap on both sides, so a replay steps the row a
// second position and the Table Topics speaking order in the saved minutes, the
// PDF and the emailed minutes is silently wrong. Its `toIndex` — an ABSOLUTE
// destination — is what fixes that, and a ninth op type has to be checked against
// this list rather than assumed into it.
//
// This module never imports `#/db` or the server-fn *modules* — it takes the
// thunks + queue-removal as injected params, so it stays out of the `pg` client
// bundle and is directly unit-testable. `MinutesOp` is imported TYPE-ONLY.
//
// Inline new guests are idempotent too (#176 slice 5): a brand-new guest
// embedded inline in an `addTableTopics` or `setAward` op carries its own client
// guest PK (`op.newGuestId`, distinct from the speaker-row `op.id`), threaded to
// the server-fn so the guest insert is `onConflictDoNothing` on that PK. A
// *lost-ack* retry (the op committed server-side yet the ack was lost, so the op
// re-drains) therefore reuses the same guest row instead of minting an orphan —
// closing the last correctness gap from slice 4. The online path never sets
// `newGuestId`, so it is unchanged (fresh server-side id per create).
//
// The literal-union types (`AttendanceStatus`/`AwardCategory`) are imported
// TYPE-ONLY (erased at build time, like the queue module) so the fn signatures
// match `MinutesOp`'s fields exactly — a plain `string` here would make the real
// server-fns (whose params carry the narrower unions) fail to assign to
// `MinutesServerFns` by parameter contravariance.
import { type AttendanceMode, withMode } from "#/lib/attendance-mode";
import type { AttendanceStatus, AwardCategory } from "#/server/minutes-logic";
import type { ExpectedHolderResult } from "#/server/slot-write-answers";
import type {
	HolderKey,
	NewGuestPayload,
	QueuedOp,
	RoleSlotOp,
} from "./offline-minutes-queue";

/**
 * The eight server-fn thunks the drain calls, named by OP (not by the
 * component's import names) so the op→fn mapping is explicit. Each takes the
 * `{ data }` envelope a `createServerFn` expects and resolves when the write
 * lands (or rejects to stop the drain).
 */
export type MinutesServerFns = {
	setAttendance: (args: {
		data: {
			meetingId: string;
			memberId: string;
			status: AttendanceStatus;
			mode?: AttendanceMode;
			releaseHeldRoles?: true;
			releaseSlotIds?: string[];
		};
	}) => Promise<{ released?: { label: string }[] } | null | undefined>;
	addGuest: (args: {
		data: {
			meetingId: string;
			id?: string;
			guestId?: string;
			newGuest?: NewGuestPayload;
			mode?: AttendanceMode;
			replaceMode?: boolean;
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
			/** Client guest PK for the inline new-guest path (idempotent replay). */
			newGuestId?: string;
			topic?: string;
		};
	}) => Promise<unknown>;
	removeTableTopics: (args: {
		data: { meetingId: string; id: string };
	}) => Promise<unknown>;
	moveTableTopics: (args: {
		data: {
			meetingId: string;
			id: string;
			direction: "up" | "down";
			/** Absolute 0-based destination — what makes a replayed move converge
			 *  instead of stepping the row a second position. */
			toIndex?: number;
		};
	}) => Promise<unknown>;
	setAward: (args: {
		data: {
			meetingId: string;
			category: AwardCategory;
			memberId?: string;
			guestId?: string;
			newGuest?: NewGuestPayload;
			/** Client guest PK for the inline new-guest path (idempotent replay). */
			newGuestId?: string;
		};
	}) => Promise<unknown>;
	clearAward: (args: {
		data: { meetingId: string; category: AwardCategory };
	}) => Promise<unknown>;
};

/** What a role write answers when it carries `expectedHolder` (#1638): the
 *  server's own type, so the two cannot drift. */
export type RoleWriteAnswer = ExpectedHolderResult;

/**
 * The three role writes the drain replays (#1638). Separate from
 * `MinutesServerFns` and optional on `dispatchOp`, so a caller that never
 * drains a role op does not have to supply them; a role op with no fn throws,
 * which stops the drain and leaves the op queued.
 */
export type RoleServerFns = {
	claimSlot: (args: {
		data: {
			slotId: string;
			memberId: string;
			actorMemberId: string;
			speakerDetails?: { speechTitle?: string };
			expectedHolder: HolderKey;
		};
	}) => Promise<RoleWriteAnswer>;
	reassignSlot: (args: {
		data: { slotId: string; memberId: string; expectedHolder: HolderKey };
	}) => Promise<RoleWriteAnswer>;
	releaseSlot: (args: {
		data: { slotId: string; expectedHolder: HolderKey };
	}) => Promise<RoleWriteAnswer>;
};

/** How a drained role op ended, for the toast and for the deck's overlay. An
 *  already-applied write counts as `applied`: the slot holds what the officer
 *  asked for. */
export type RoleDrainOutcome = {
	op: RoleSlotOp;
	outcome: "applied" | "skipped";
	reason?: "holder-changed" | "slot-gone" | "refused";
	currentHolderName: string | null;
	/** Whether anyone holds the slot now, for a `holder-changed` skip. */
	holderPresent?: boolean;
	/** The server's refusal text, for a `refused` skip. */
	message?: string;
};

/** The toast for a skipped role op (#1638). The online change is kept, and the
 *  officer is told which of their offline changes did not land. */
export function roleSkipMessage(o: RoleDrainOutcome): string {
	const { op } = o;
	const what =
		op.type === "assignSlot"
			? `Your offline change to ${op.memberDisplayName}`
			: "Your offline clear";
	if (o.reason === "refused") {
		const why = (o.message ?? "The server refused it").replace(/\.+$/, "");
		return `${op.roleName}: ${why}. Your offline change was not applied.`;
	}
	if (o.reason === "slot-gone") {
		return `${op.roleName}: that role was removed. Your offline change was not applied.`;
	}
	// `holderPresent` rather than the name: a holder whose name could not be
	// read is still a holder, and "was cleared online" would be false.
	const state = o.holderPresent
		? `kept ${o.currentHolderName ?? "the current holder"}`
		: "was cleared online";
	return `${op.roleName}: ${state}. ${what} was not applied.`;
}

/**
 * Replay one queued op to the server via `fns`. Builds the exact `{ data }`
 * payload each server schema accepts, threading client ids for idempotency:
 * `addGuest` (new path) passes `id: op.guestId`, `addTableTopics` passes
 * `id: op.id`. The `switch` is exhaustive (a `never` default) so a new op type
 * is a compile error here.
 */
export async function dispatchOp(
	op: QueuedOp,
	meetingId: string,
	fns: MinutesServerFns & Partial<RoleServerFns>,
	/** The member signed in NOW. A role op replays only for the member who
	 *  queued it (see `ROLE_OP_OTHER_USER_MESSAGE`); a minutes op ignores it. */
	session?: { memberId: string | null },
): Promise<DispatchOutcome | undefined> {
	switch (op.type) {
		case "assignSlot":
		case "releaseSlot":
			assertQueuedByCurrentUser(op, session);
			return { role: await dispatchRoleOp(op, fns) };

		case "setAttendance": {
			// `mode` forwarded as-is (#1049): `undefined` for an op queued before
			// it existed, which the server reads as "leave the stored mode alone".
			// An upsert either way, so the replay still converges.
			//
			// `releaseHeldRoles` (#1256) rides only when the op carries it, and the
			// server's answer is the ONE return value this function has: what the
			// release actually freed at replay time, which the drain toasts. A replay
			// of an already-applied op frees nothing and returns an empty list.
			const ids = op.releaseSlotIds ?? [];
			const releasing = op.releaseHeldRoles === true && ids.length > 0;
			const result = await fns.setAttendance({
				data: {
					meetingId,
					memberId: op.memberId,
					status: op.status,
					...withMode(op.mode),
					...(releasing
						? { releaseHeldRoles: true as const, releaseSlotIds: ids }
						: {}),
				},
			});
			if (!releasing) return undefined;
			return {
				released: {
					memberId: op.memberId,
					labels: (result?.released ?? []).map((r) => r.label),
				},
			};
		}

		case "addGuest":
			if (op.newGuest) {
				// New-guest create: pass the client id so the server row matches the
				// offline-derived guest and the replay is idempotent.
				await fns.addGuest({
					data: {
						meetingId,
						id: op.guestId,
						newGuest: op.newGuest,
						...withMode(op.mode),
					},
				});
			} else {
				// A toggle (`replaceMode`) upserts the mode onto the row (#1049), so
				// it converges on replay like the create does.
				await fns.addGuest({
					data: {
						meetingId,
						guestId: op.guestId,
						...withMode(op.mode),
						...(op.replaceMode ? { replaceMode: true } : {}),
					},
				});
			}
			return undefined;

		case "removeGuest":
			await fns.removeGuest({ data: { meetingId, guestId: op.guestId } });
			return undefined;

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
					// Client guest PK for an inline new guest — idempotent replay (#176
					// slice 5). Undefined for member/existing-guest ops (and pre-slice-5
					// ops), where the server keeps its fresh-id behaviour.
					newGuestId: op.newGuestId,
					topic: op.topic,
				},
			});
			return undefined;

		case "removeTableTopics":
			await fns.removeTableTopics({ data: { meetingId, id: op.id } });
			return undefined;

		case "moveTableTopics":
			// `toIndex` is the ABSOLUTE destination and it is what makes this the one
			// op that would otherwise corrupt on replay (see the header). Forwarded
			// as-is: `undefined` for an op persisted before it existed, which the
			// server then falls back to the old relative `direction` for.
			await fns.moveTableTopics({
				data: {
					meetingId,
					id: op.id,
					direction: op.direction,
					toIndex: op.toIndex,
				},
			});
			return undefined;

		case "setAward":
			await fns.setAward({
				data: {
					meetingId,
					category: op.category,
					memberId: op.memberId,
					guestId: op.guestId,
					newGuest: op.newGuest,
					// Client guest PK for an inline new guest — idempotent replay (#176
					// slice 5). Undefined otherwise (server keeps its fresh-id behaviour).
					newGuestId: op.newGuestId,
				},
			});
			return undefined;

		case "clearAward":
			await fns.clearAward({ data: { meetingId, category: op.category } });
			return undefined;

		default: {
			// Exhaustiveness guard — a new op type must extend this switch.
			const _never: never = op;
			void _never;
		}
	}
}

/** Thrown instead of replaying a role op under a different member (#1638). The
 *  queue is keyed by meeting, so without this an op queued by one officer would
 *  replay as whoever signs in next on the same laptop: `claimSlot` credits the
 *  session, so a "give the role to B" would become B claiming it for themselves
 *  (flipping their own decline, crediting them in the activity log). It stops
 *  the drain like any refusal: the op stays queued, `syncError` shows. */
export const ROLE_OP_OTHER_USER_MESSAGE =
	"Role changes queued on this device by another member are waiting. Sign in as them to sync.";

function assertQueuedByCurrentUser(
	op: RoleSlotOp,
	session: { memberId: string | null } | undefined,
): void {
	if ((op.queuedBy ?? null) !== (session?.memberId ?? null)) {
		throw new Error(ROLE_OP_OTHER_USER_MESSAGE);
	}
}

/** What replaying one op reports back, for the ops that report anything. */
export type DispatchOutcome = {
	/** What an Absent op freed (#1256). */
	released?: { memberId: string; labels: string[] };
	/** How a role op ended (#1638). */
	role?: RoleDrainOutcome;
};

/**
 * One role op, replayed with the holder the officer SAW. An open slot goes
 * through `claimSlot` (with the asserting actor, #747), a held one through
 * `reassignSlot`, a clear through `releaseSlot`: the calls the online path
 * makes. Each decides in a row lock on the server, so a replay whose first
 * attempt committed answers ok instead of a false conflict.
 */
async function dispatchRoleOp(
	op: RoleSlotOp,
	fns: Partial<RoleServerFns>,
): Promise<RoleDrainOutcome> {
	const need = <K extends keyof RoleServerFns>(k: K): RoleServerFns[K] => {
		const fn = fns[k];
		if (!fn) throw new Error(`The ${k} write is not available to drain.`);
		return fn;
	};
	let answer: RoleWriteAnswer;
	if (op.type === "releaseSlot") {
		answer = await need("releaseSlot")({
			data: { slotId: op.slotId, expectedHolder: op.expectedHolder },
		});
	} else if (op.expectedHolder === null) {
		// A claim needs its asserting actor; the queue refuses to hold an assign
		// without one for an open slot, so this is a corrupted op, not a case.
		if (!op.actorMemberId) {
			throw new Error("This queued change has no actor to claim with.");
		}
		answer = await need("claimSlot")({
			data: {
				slotId: op.slotId,
				memberId: op.memberId,
				actorMemberId: op.actorMemberId,
				...(op.speakerDetails ? { speakerDetails: op.speakerDetails } : {}),
				expectedHolder: null,
			},
		});
	} else {
		answer = await need("reassignSlot")({
			data: {
				slotId: op.slotId,
				memberId: op.memberId,
				expectedHolder: op.expectedHolder,
			},
		});
	}
	return answer.ok
		? { op, outcome: "applied", currentHolderName: null }
		: {
				op,
				outcome: "skipped",
				reason: answer.reason,
				currentHolderName: answer.currentHolderName,
				...(answer.reason === "holder-changed"
					? { holderPresent: answer.holderPresent }
					: {}),
				...(answer.reason === "refused" ? { message: answer.message } : {}),
			};
}

/** Only present when a role op ended, so a minutes-only result keeps its shape. */
const withRoles = (o: RoleDrainOutcome[]) =>
	o.length > 0 ? { roleOutcomes: o } : {};

/** Outcome of a drain pass. `remaining` is what is still queued afterwards. */
export type DrainResult<Op extends QueuedOp = QueuedOp> = {
	/** How many ops were successfully replayed + removed this pass. */
	drainedCount: number;
	/** Ops still queued: empty on full success; the failed op onward on failure. */
	remaining: Op[];
	/** The error that stopped the drain, or undefined on full success. */
	error?: unknown;
	/** Roles freed by the Absent ops that drained (#1256), one entry per op whose
	 *  release freed something, in drain order. Includes ops that drained BEFORE a
	 *  later one failed: those releases happened and the officer is told. */
	released: { memberId: string; labels: string[] }[];
	/** How each role op that left the queue ended (#1638), in drain order, the
	 *  skipped ones included. Includes ops that drained before a later one failed. */
	roleOutcomes?: RoleDrainOutcome[];
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
export async function drainMinutesQueue<
	Op extends QueuedOp = QueuedOp,
>(params: {
	meetingId: string;
	ops: Op[];
	/** Replay one op (typically `(op) => dispatchOp(op, meetingId, fns)`). */
	dispatch: (op: Op) => Promise<DispatchOutcome | undefined>;
	/** Remove one drained op from the durable queue by its `opId`. A role op
	 *  passes how it ended as a second argument (#1638), so the caller can tell
	 *  the deck AFTER the removal has committed. */
	onOpDrained: (opId: string, role?: RoleDrainOutcome) => Promise<void>;
}): Promise<DrainResult<Op>> {
	const { ops, dispatch, onOpDrained } = params;
	let drainedCount = 0;
	const released: DrainResult["released"] = [];
	const roleOutcomes: RoleDrainOutcome[] = [];

	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		let outcome: DispatchOutcome | undefined;
		try {
			outcome = await dispatch(op);
		} catch (error) {
			// Stop at the first failure: leave this op + all successors queued.
			return {
				drainedCount,
				remaining: ops.slice(i),
				error,
				released,
				...withRoles(roleOutcomes),
			};
		}
		// Recorded BEFORE the queue removal: the release has happened either way,
		// and a removal that throws must not swallow the officer's receipt for it.
		if (outcome?.released && outcome.released.labels.length > 0) {
			released.push(outcome.released);
		}
		if (outcome?.role) roleOutcomes.push(outcome.role);
		try {
			if (outcome?.role) await onOpDrained(op.opId, outcome.role);
			else await onOpDrained(op.opId);
		} catch (error) {
			// The write landed but the durable removal failed (IndexedDB): report
			// it as the drain's error WITH the receipts collected so far, so the
			// caller still toasts and refreshes. This op stays queued and replays
			// (an upsert, so harmlessly) on the next pass.
			return {
				drainedCount,
				remaining: ops.slice(i),
				error,
				released,
				...withRoles(roleOutcomes),
			};
		}
		drainedCount += 1;
	}

	return {
		drainedCount,
		remaining: [],
		error: undefined,
		released,
		...withRoles(roleOutcomes),
	};
}
