// The slot list as it WILL be once the queued role edits drain (#1638). PURE.
//
// A queued `assignSlot` / `releaseSlot` has not reached the server, but the
// meeting page and the projected deck must already show it. `projectSlots`
// applies the queue, in order, on top of the newest server copy. Queued ops
// always sit on top of that copy until they drain and leave the queue: whether
// the browser is "online" never decides precedence, which is what covers the
// online-but-timing-out case.
//
// Each op MIRRORS the server core it will be replayed through
// (`claimSlotCore` for an open slot, `reassignSlotCore` for a held one,
// `releaseSlotCore` for a clear, all in `src/server/slots-logic.ts`), field by
// field, so the projected slot is what the server would write:
//
//   claim    assignee = the member, guest cleared, status "claimed",
//            claimedAt stamped. A claim without speaker details creates no
//            speech, so the speech fields are not touched.
//   reassign assignee = the member, guest cleared, status back to "claimed"
//            (a confirmation does not carry over), claimedAt kept. A speaker
//            slot moving to a different holder unlinks its speech.
//   release  assignee and guest cleared, status "open", claimedAt null, speech
//            unlinked.
//
// Fields outside the server's write set that describe the HOLDER (the contact
// block the page reads for confirm nudges) are cleared where they exist, since
// they belong to whoever held the slot before.
//
// Client-safe: this file imports nothing from the server.
import type {
	HolderKey,
	QueuedOp,
	RoleSlotOp,
} from "#/lib/offline-minutes-queue";
import { isRoleSlotOp } from "#/lib/offline-minutes-queue";

/** The slot fields a projection reads and writes. Every real slot shape (the
 *  meeting loader's, the deck's) satisfies it; the rest rides along untouched. */
export type ProjectableSlot = {
	id: string;
	status: string;
	assigneeName: string | null;
	assigneeId?: string | null;
	assigneeGuestId?: string | null;
	assigneeIsGuest?: boolean;
	assigneeIsVisitingToastmaster?: boolean;
};

/** The speech columns `releaseSlotCore` / `reassignSlotSpeech` unlink. */
const SPEECH_FIELDS = [
	"speechTitle",
	"pathwayPath",
	"projectName",
	"projectLevel",
	"projectId",
	"minMinutes",
	"maxMinutes",
	"presentationUrl",
] as const;

/** The previous holder's contact block, which `loadMeetingDetail` joins onto
 *  each slot. */
const HOLDER_FIELDS = [
	"holderPhone",
	"holderEmail",
	"holderPreferredName",
	"holderPreferredContact",
] as const;

/** `"m:<id>"` for a member, `"g:<id>"` for a guest, null for an open slot. */
export function holderKeyOf(
	slot: Pick<ProjectableSlot, "assigneeId" | "assigneeGuestId">,
): HolderKey {
	if (slot.assigneeGuestId) return `g:${slot.assigneeGuestId}`;
	if (slot.assigneeId) return `m:${slot.assigneeId}`;
	return null;
}

function setNulls<S extends object>(
	slot: S,
	fields: readonly string[],
): Record<string, null> {
	const out: Record<string, null> = {};
	for (const f of fields) if (f in slot) out[f] = null;
	return out;
}

function applyOp<S extends ProjectableSlot>(slot: S, op: RoleSlotOp): S {
	if (slot.id !== op.slotId) return slot;
	const current = holderKeyOf(slot);

	if (op.type === "releaseSlot") {
		// Already open: the server would write nothing either.
		if (current === null) return slot;
		return {
			...slot,
			assigneeName: null,
			assigneeId: null,
			assigneeGuestId: null,
			assigneeIsGuest: false,
			assigneeIsVisitingToastmaster: false,
			status: "open",
			...("claimedAt" in slot ? { claimedAt: null } : {}),
			...setNulls(slot, SPEECH_FIELDS),
			...setNulls(slot, HOLDER_FIELDS),
		};
	}

	// Already held by the target: the drain reports it already applied.
	if (current === `m:${op.memberId}`) return slot;
	const wasOpen = current === null;
	return {
		...slot,
		assigneeName: op.memberDisplayName,
		assigneeId: op.memberId,
		assigneeGuestId: null,
		assigneeIsGuest: false,
		assigneeIsVisitingToastmaster: false,
		status: "claimed",
		// `claimSlotCore` stamps it; `reassignSlotCore` leaves the old stamp.
		...(wasOpen && "claimedAt" in slot
			? { claimedAt: new Date(op.queuedAt) }
			: {}),
		// A held slot moving to another holder unlinks the speech.
		...(wasOpen ? {} : setNulls(slot, SPEECH_FIELDS)),
		...setNulls(slot, HOLDER_FIELDS),
	};
}

/**
 * `slots` with every queued role op applied, in queue order. An op for a slot
 * that is not in the list is ignored. Returns `slots` itself when the queue
 * holds no role op, so a caller's memo keeps its identity.
 */
export function projectSlots<S extends ProjectableSlot>(
	slots: S[],
	ops: readonly QueuedOp[],
): S[] {
	const roleOps = ops.filter(isRoleSlotOp);
	if (roleOps.length === 0) return slots;
	let out = slots;
	for (const op of roleOps) {
		out = out.map((s) => applyOp(s, op));
	}
	return out;
}

/** A drained role op the deck keeps showing until a read catches up (#1638). */
export type DrainedRoleOp = {
	op: RoleSlotOp;
	outcome: "applied" | "skipped";
	/** Who holds the slot now, from the server's answer to a skipped op. */
	currentHolderName: string | null;
};

/**
 * Drained ops over a server copy that may predate them. An applied op keeps
 * projecting. A skipped op projects what the server said holds the slot: the
 * name, or open when the answer was nobody.
 */
export function projectDrained<S extends ProjectableSlot>(
	slots: S[],
	drained: readonly DrainedRoleOp[],
): S[] {
	if (drained.length === 0) return slots;
	let out = slots;
	for (const d of drained) {
		if (d.outcome === "applied") {
			out = out.map((s) => applyOp(s, d.op));
			continue;
		}
		out = out.map((s) => {
			if (s.id !== d.op.slotId) return s;
			if (d.currentHolderName === null) {
				return applyOp(s, {
					type: "releaseSlot",
					opId: d.op.opId,
					queuedAt: d.op.queuedAt,
					slotId: d.op.slotId,
					roleName: d.op.roleName,
					expectedHolder: holderKeyOf(s),
					expectedHolderName: null,
				});
			}
			return {
				...s,
				assigneeName: d.currentHolderName,
				status: s.status === "open" ? "claimed" : s.status,
			};
		});
	}
	return out;
}
