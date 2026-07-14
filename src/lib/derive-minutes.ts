// Optimistic minutes projection (issue #176 slice 3). PURE + CLIENT-ONLY.
//
// `deriveMinutes(snapshot, ops)` replays the offline write-queue over the last
// online `getMinutes` snapshot to produce the state the UI should show while
// offline. It MUST mirror the server's per-op semantics (see
// `src/server/minutes-logic.ts`) so the optimistic view matches what the server
// would eventually compute on drain.
//
// TYPE-ONLY imports keep `#/db` out of the client bundle.
import type {
	AwardCategory,
	MinutesData,
	MinutesTableTopicsRow,
} from "#/server/minutes-logic";
import type { MinutesOp } from "./offline-minutes-queue";

/**
 * Postgres orders Table Topics by `(sortOrder asc, id asc)`. `uuid` compares
 * byte-wise, which equals code-point order over the canonical lowercase hex —
 * so a plain string comparison of the id matches the server's tie-break.
 */
function bySortOrderThenId(
	a: MinutesTableTopicsRow,
	b: MinutesTableTopicsRow,
): number {
	if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
	if (a.id < b.id) return -1;
	if (a.id > b.id) return 1;
	return 0;
}

/**
 * Apply the queued ops, in order, to a copy of `snapshot`. The input is never
 * mutated. The result matches the shape (and ordering) of a fresh `loadMinutes`.
 */
export function deriveMinutes(
	snapshot: MinutesData,
	ops: MinutesOp[],
): MinutesData {
	const draft = structuredClone(snapshot);

	for (const op of ops) {
		switch (op.type) {
			case "setAttendance": {
				// Server: upsert the member's presence. Members can't be added
				// offline, so an unknown memberId is a no-op.
				const member = draft.members.find((m) => m.memberId === op.memberId);
				if (member) member.status = op.status;
				break;
			}

			case "addGuest": {
				// Server: insert the guest attendance row (idempotent per guest). A
				// guest that only held a role slot (fromRole) now has an explicit
				// present row, so it becomes fromRole:false.
				const existing = draft.guests.find((g) => g.guestId === op.guestId);
				if (existing) {
					existing.fromRole = false;
				} else {
					draft.guests.push({
						guestId: op.guestId,
						name: op.name,
						fromRole: false,
					});
				}
				// loadMinutes returns guests sorted by name.
				draft.guests.sort((a, b) => a.name.localeCompare(b.name));
				break;
			}

			case "removeGuest": {
				// Server: delete the guest's attendance row. A fromRole guest is still
				// listed by its role slot, so only explicitly-present guests disappear.
				draft.guests = draft.guests.filter(
					(g) => !(g.guestId === op.guestId && !g.fromRole),
				);
				break;
			}

			case "addTableTopics": {
				// Server: append with sortOrder = coalesce(max(sortOrder)+1, 0), keyed
				// by the client id with onConflictDoNothing (replay is a no-op).
				if (!draft.tableTopicsSpeakers.some((t) => t.id === op.id)) {
					const next =
						draft.tableTopicsSpeakers.reduce(
							(max, t) => Math.max(max, t.sortOrder),
							-1,
						) + 1;
					draft.tableTopicsSpeakers.push({
						id: op.id,
						memberId: op.memberId ?? null,
						// Existing guest → its id; a new inline guest → its client PK
						// (`newGuestId`, #176 slice 5) so the optimistic row is consistent
						// and best-table-topics eligibility can reference the new guest.
						// A pre-slice-5 op has neither → null (isGuest still drives the badge).
						guestId: op.guestId ?? op.newGuestId ?? null,
						name: op.name,
						isGuest: op.isGuest,
						topic: op.topic?.trim() ? op.topic.trim() : null,
						sortOrder: next,
					});
				}
				break;
			}

			case "removeTableTopics": {
				// Server: delete by id (no renumber of the remaining rows).
				draft.tableTopicsSpeakers = draft.tableTopicsSpeakers.filter(
					(t) => t.id !== op.id,
				);
				break;
			}

			case "moveTableTopics": {
				// Server: normalize to positional order, then swap the target with its
				// neighbour's sortOrder. Edge moves are a no-op.
				const ordered = [...draft.tableTopicsSpeakers].sort(bySortOrderThenId);
				const idx = ordered.findIndex((t) => t.id === op.id);
				if (idx !== -1) {
					const swapIdx = op.direction === "up" ? idx - 1 : idx + 1;
					if (swapIdx >= 0 && swapIdx < ordered.length) {
						// `ordered` holds references into draft.tableTopicsSpeakers.
						ordered[idx].sortOrder = swapIdx;
						ordered[swapIdx].sortOrder = idx;
					}
				}
				break;
			}

			case "setAward": {
				// Server: upsert the winner for the category (always one of the three
				// rows loadMinutes emits).
				const award = draft.awards.find((a) => a.category === op.category);
				if (award) {
					award.memberId = op.memberId ?? null;
					// Existing guest → its id; a new inline guest → its client PK
					// (`newGuestId`, #176 slice 5); pre-slice-5 op → null.
					award.guestId = op.guestId ?? op.newGuestId ?? null;
					award.name = op.name;
					award.isGuest = op.isGuest;
				}
				break;
			}

			case "clearAward": {
				// Server: delete the category → loadMinutes re-emits it unset.
				const award = draft.awards.find((a) => a.category === op.category);
				if (award) {
					award.memberId = null;
					award.guestId = null;
					award.name = null;
					award.isGuest = false;
				}
				break;
			}

			default: {
				// Exhaustiveness guard — a new op type must extend this switch.
				const _never: never = op;
				void _never;
			}
		}
	}

	// Match loadMinutes' final ordering + derived fields.
	draft.tableTopicsSpeakers.sort(bySortOrderThenId);
	recomputeCounts(draft);
	recomputeTableTopicsEligibility(draft);
	return draft;
}

/** Recompute the attendance/guest tallies from the derived rows. */
function recomputeCounts(draft: MinutesData): void {
	let present = 0;
	let absent = 0;
	let excused = 0;
	let unmarked = 0;
	for (const m of draft.members) {
		if (m.status === "present") present++;
		else if (m.status === "excused") excused++;
		else if (m.status === "absent") absent++;
		else unmarked++;
	}
	draft.counts = {
		present,
		absent,
		excused,
		unmarked,
		guests: draft.guests.length,
	};
}

/**
 * Best-Table-Topics eligibility follows the recorded speakers (#170), so it must
 * be recomputed after TT edits. Speaker/Evaluator eligibility comes from role
 * slots, which never change offline — those sets are carried through untouched.
 */
function recomputeTableTopicsEligibility(draft: MinutesData): void {
	const memberIds: string[] = [];
	const guestIds: string[] = [];
	const seenMembers = new Set<string>();
	const seenGuests = new Set<string>();
	for (const t of draft.tableTopicsSpeakers) {
		if (t.memberId && !seenMembers.has(t.memberId)) {
			seenMembers.add(t.memberId);
			memberIds.push(t.memberId);
		}
		if (t.guestId && !seenGuests.has(t.guestId)) {
			seenGuests.add(t.guestId);
			guestIds.push(t.guestId);
		}
	}
	const category: AwardCategory = "best_table_topics";
	draft.awardEligible[category] = { memberIds, guestIds };
}
