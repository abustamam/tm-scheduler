import { describe, expect, it } from "vitest";
import type { MinutesData } from "#/server/minutes-logic";
import { deriveMinutes } from "./derive-minutes";
import type { MinutesOp } from "./offline-minutes-queue";

// A generated op id + timestamp; irrelevant to derive but required by the type.
let seq = 0;
function meta() {
	seq += 1;
	return { opId: `op-${seq}`, queuedAt: 1000 + seq };
}

/** A fresh, internally-consistent snapshot for each test. */
function makeSnapshot(): MinutesData {
	return {
		actionItems: { open: [], resolved: [], openTotal: 0, resolvedTotal: 0 },
		meetingId: "meeting-1",
		clubId: "club-1",
		members: [
			{ memberId: "m-alice", name: "Alice", status: null, hasRole: false },
			{ memberId: "m-bob", name: "Bob", status: "present", hasRole: true },
			{ memberId: "m-carol", name: "Carol", status: "absent", hasRole: false },
		],
		guests: [{ guestId: "g-rose", name: "Rose", fromRole: true }],
		tableTopicsSpeakers: [
			{
				id: "tt-1",
				memberId: "m-alice",
				guestId: null,
				name: "Alice",
				isGuest: false,
				topic: "Weather",
				sortOrder: 0,
			},
			{
				id: "tt-2",
				memberId: "m-carol",
				guestId: null,
				name: "Carol",
				isGuest: false,
				topic: null,
				sortOrder: 1,
			},
		],
		awards: [
			{
				category: "best_speaker",
				memberId: null,
				guestId: null,
				name: null,
				isGuest: false,
			},
			{
				category: "best_evaluator",
				memberId: "m-bob",
				guestId: null,
				name: "Bob",
				isGuest: false,
			},
			{
				category: "best_table_topics",
				memberId: null,
				guestId: null,
				name: null,
				isGuest: false,
			},
		],
		awardEligible: {
			best_speaker: { memberIds: ["m-bob"], guestIds: [] },
			best_evaluator: { memberIds: ["m-bob"], guestIds: [] },
			best_table_topics: { memberIds: ["m-alice", "m-carol"], guestIds: [] },
		},
		counts: { present: 1, absent: 1, excused: 0, unmarked: 1, guests: 1 },
	};
}

const ttOrder = (d: MinutesData) => d.tableTopicsSpeakers.map((t) => t.id);

/**
 * FOUR speakers, because the move-replay hazard needs four to be visible: with
 * two rows a doubled "move down" bounces back to the original order and reads as
 * correct, and with three the stepped row lands on the edge and the second apply
 * no-ops. `[A,B,C,D]` + a doubled "move B down" is the smallest fixture where the
 * bug produces a distinct wrong answer (`[A,C,D,B]` rather than `[A,C,B,D]`).
 */
function fourSpeakers(): MinutesData {
	const snap = makeSnapshot();
	snap.tableTopicsSpeakers = [
		["tt-1", "Alice"],
		["tt-2", "Bob"],
		["tt-3", "Carol"],
		["tt-4", "Dave"],
	].map(([id, name], i) => ({
		id,
		memberId: null,
		guestId: null,
		name,
		isGuest: false,
		topic: null,
		sortOrder: i,
	}));
	return snap;
}
const guestIds = (d: MinutesData) => d.guests.map((g) => g.guestId);

describe("deriveMinutes", () => {
	it("returns a structurally-equal copy for an empty queue", () => {
		const snap = makeSnapshot();
		expect(deriveMinutes(snap, [])).toEqual(snap);
	});

	it("does not mutate the input snapshot", () => {
		const snap = makeSnapshot();
		const before = structuredClone(snap);
		deriveMinutes(snap, [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-alice",
				status: "present",
			},
			{ type: "removeTableTopics", ...meta(), id: "tt-1" },
		]);
		expect(snap).toEqual(before);
	});

	// -- setAttendance -------------------------------------------------------

	it("sets a member's attendance and recomputes counts", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-alice",
				status: "present",
			},
		]);
		expect(d.members.find((m) => m.memberId === "m-alice")?.status).toBe(
			"present",
		);
		// Alice unmarked→present: present 1→2, unmarked 1→0.
		expect(d.counts).toEqual({
			present: 2,
			absent: 1,
			excused: 0,
			unmarked: 0,
			guests: 1,
		});
	});

	it("applies the last attendance write for a member (set then change)", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-bob",
				status: "excused",
			},
			{ type: "setAttendance", ...meta(), memberId: "m-bob", status: "absent" },
		]);
		expect(d.members.find((m) => m.memberId === "m-bob")?.status).toBe(
			"absent",
		);
		expect(d.counts).toEqual({
			present: 0,
			absent: 2,
			excused: 0,
			unmarked: 1,
			guests: 1,
		});
	});

	it("ignores attendance for an unknown member", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAttendance",
				...meta(),
				memberId: "ghost",
				status: "present",
			},
		]);
		expect(d.counts).toEqual(makeSnapshot().counts);
	});

	// -- guests --------------------------------------------------------------

	it("adds a new guest (client id) sorted by name and bumps the guest count", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "addGuest",
				...meta(),
				guestId: "g-new",
				name: "Aaron",
				newGuest: { name: "Aaron" },
			},
		]);
		// Aaron sorts before Rose.
		expect(guestIds(d)).toEqual(["g-new", "g-rose"]);
		expect(d.guests.find((g) => g.guestId === "g-new")).toEqual({
			guestId: "g-new",
			name: "Aaron",
			fromRole: false,
		});
		expect(d.counts.guests).toBe(2);
	});

	it("adds an existing club guest by id + resolved name", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "addGuest", ...meta(), guestId: "g-existing", name: "Zed" },
		]);
		expect(d.guests.find((g) => g.guestId === "g-existing")).toEqual({
			guestId: "g-existing",
			name: "Zed",
			fromRole: false,
		});
		expect(d.counts.guests).toBe(2);
	});

	it("adding a fromRole guest flips it to an explicit present guest", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "addGuest", ...meta(), guestId: "g-rose", name: "Rose" },
		]);
		expect(d.guests.filter((g) => g.guestId === "g-rose")).toHaveLength(1);
		expect(d.guests.find((g) => g.guestId === "g-rose")?.fromRole).toBe(false);
		expect(d.counts.guests).toBe(1);
	});

	it("de-dupes a repeated addGuest", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "addGuest", ...meta(), guestId: "g-new", name: "Aaron" },
			{ type: "addGuest", ...meta(), guestId: "g-new", name: "Aaron" },
		]);
		expect(d.guests.filter((g) => g.guestId === "g-new")).toHaveLength(1);
		expect(d.counts.guests).toBe(2);
	});

	it("removes an explicitly-present guest but keeps a fromRole guest", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "addGuest", ...meta(), guestId: "g-new", name: "Aaron" },
			{ type: "removeGuest", ...meta(), guestId: "g-new" },
			// Removing a fromRole guest is a no-op (its role slot still lists it).
			{ type: "removeGuest", ...meta(), guestId: "g-rose" },
		]);
		expect(guestIds(d)).toEqual(["g-rose"]);
		expect(d.counts.guests).toBe(1);
	});

	it("add guest then remove guest round-trips to the base", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "addGuest", ...meta(), guestId: "g-new", name: "Aaron" },
			{ type: "removeGuest", ...meta(), guestId: "g-new" },
		]);
		expect(guestIds(d)).toEqual(["g-rose"]);
		expect(d.counts.guests).toBe(1);
	});

	// -- Table Topics --------------------------------------------------------

	it("appends a member Table Topics speaker at sortOrder max+1", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "addTableTopics",
				...meta(),
				id: "tt-new",
				name: "Bob",
				isGuest: false,
				memberId: "m-bob",
				topic: "Improv",
			},
		]);
		expect(ttOrder(d)).toEqual(["tt-1", "tt-2", "tt-new"]);
		const added = d.tableTopicsSpeakers.find((t) => t.id === "tt-new");
		expect(added).toMatchObject({
			memberId: "m-bob",
			guestId: null,
			isGuest: false,
			topic: "Improv",
			sortOrder: 2,
		});
	});

	it("appends a new-guest Table Topics speaker (guestId null, isGuest true)", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "addTableTopics",
				...meta(),
				id: "tt-guest",
				name: "Newbie",
				isGuest: true,
				newGuest: { name: "Newbie" },
			},
		]);
		const added = d.tableTopicsSpeakers.find((t) => t.id === "tt-guest");
		expect(added).toMatchObject({
			memberId: null,
			guestId: null,
			isGuest: true,
			name: "Newbie",
			sortOrder: 2,
		});
		// No newGuestId (a pre-slice-5 op) ⇒ eligibility can't reference the guest.
		expect(d.awardEligible.best_table_topics.guestIds).toEqual([]);
	});

	it("a new-guest addTableTopics with newGuestId sets guestId + eligibility (#176 slice 5)", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "addTableTopics",
				...meta(),
				id: "tt-guest",
				name: "Newbie",
				isGuest: true,
				newGuest: { name: "Newbie" },
				newGuestId: "g-new-inline",
			},
		]);
		const added = d.tableTopicsSpeakers.find((t) => t.id === "tt-guest");
		expect(added).toMatchObject({
			memberId: null,
			// The inline guest's client PK is carried onto the optimistic row.
			guestId: "g-new-inline",
			isGuest: true,
			name: "Newbie",
			sortOrder: 2,
		});
		// Now best-TT eligibility can reference the new guest.
		expect(d.awardEligible.best_table_topics.guestIds).toEqual([
			"g-new-inline",
		]);
	});

	it("normalises a blank topic to null", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "addTableTopics",
				...meta(),
				id: "tt-blank",
				name: "Bob",
				isGuest: false,
				memberId: "m-bob",
				topic: "   ",
			},
		]);
		expect(
			d.tableTopicsSpeakers.find((t) => t.id === "tt-blank")?.topic,
		).toBeNull();
	});

	it("computes sortOrder 0 when adding to an empty Table Topics list", () => {
		const snap = makeSnapshot();
		snap.tableTopicsSpeakers = [];
		snap.awardEligible.best_table_topics = { memberIds: [], guestIds: [] };
		const d = deriveMinutes(snap, [
			{
				type: "addTableTopics",
				...meta(),
				id: "tt-first",
				name: "Alice",
				isGuest: false,
				memberId: "m-alice",
			},
		]);
		expect(d.tableTopicsSpeakers[0].sortOrder).toBe(0);
	});

	it("is idempotent for a repeated addTableTopics with the same id", () => {
		const op: MinutesOp = {
			type: "addTableTopics",
			...meta(),
			id: "tt-new",
			name: "Bob",
			isGuest: false,
			memberId: "m-bob",
		};
		const d = deriveMinutes(makeSnapshot(), [op, op]);
		expect(d.tableTopicsSpeakers.filter((t) => t.id === "tt-new")).toHaveLength(
			1,
		);
	});

	it("removes a Table Topics speaker by id", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "removeTableTopics", ...meta(), id: "tt-1" },
		]);
		expect(ttOrder(d)).toEqual(["tt-2"]);
		// best_table_topics eligibility drops the removed member.
		expect(d.awardEligible.best_table_topics.memberIds).toEqual(["m-carol"]);
	});

	it("moves a speaker down and back up (swap semantics)", () => {
		const down = deriveMinutes(makeSnapshot(), [
			{ type: "moveTableTopics", ...meta(), id: "tt-1", direction: "down" },
		]);
		expect(ttOrder(down)).toEqual(["tt-2", "tt-1"]);
		const upAgain = deriveMinutes(makeSnapshot(), [
			{ type: "moveTableTopics", ...meta(), id: "tt-1", direction: "down" },
			{ type: "moveTableTopics", ...meta(), id: "tt-1", direction: "up" },
		]);
		expect(ttOrder(upAgain)).toEqual(["tt-1", "tt-2"]);
	});

	it("CONVERGES on a replayed move that carries toIndex (G2)", () => {
		// The whole point of the absolute target. A write abandoned at its 8s
		// deadline may still land server-side, and the drain then re-dispatches the
		// op — so applying it twice must equal applying it once. With a bare
		// `direction` it does not: `[A,B,C,D]` + "move B down" gives `[A,C,B,D]`, and
		// a replay steps B again to `[A,C,D,B]`. That is the Table Topics speaking
		// order in the saved minutes, the PDF and the emailed minutes, silently wrong.
		const snap = fourSpeakers();
		// B is at index 1; "down" means index 2, resolved at the TAP by the call site.
		const op: MinutesOp = {
			type: "moveTableTopics",
			...meta(),
			id: "tt-2",
			direction: "down",
			toIndex: 2,
		};
		const once = deriveMinutes(fourSpeakers(), [op]);
		expect(ttOrder(once)).toEqual(["tt-1", "tt-3", "tt-2", "tt-4"]);
		// Twice, three times, ten times — all the same list.
		expect(ttOrder(deriveMinutes(snap, [op, op]))).toEqual(ttOrder(once));
		expect(ttOrder(deriveMinutes(snap, [op, op, op, op]))).toEqual(
			ttOrder(once),
		);
	});

	it("converges when G1 queues a SECOND move behind an op the server already applied (G1 x G2)", () => {
		// THE INTERACTION CELL. G1 changes the write path G2's replay runs through:
		// once a queue exists, every later tap is appended to it instead of going
		// online, so a move now routinely replays BEHIND another move rather than
		// alone. That only converges because each op carries an absolute target.
		//
		// The sequence is the one G1's fix creates. A slow "move tt-2 down" blows its
		// deadline and is queued — but it LANDS server-side. The officer then taps
		// "move tt-1 down", which G1 appends to the queue rather than sending. Its
		// `toIndex` is resolved from the PROJECTED list, which is what the officer is
		// looking at and what `projectMinutes` renders for a non-empty queue.
		const op1: MinutesOp = {
			type: "moveTableTopics",
			...meta(),
			id: "tt-2",
			direction: "down",
			toIndex: 2,
		};
		const afterOp1 = deriveMinutes(fourSpeakers(), [op1]);
		expect(ttOrder(afterOp1)).toEqual(["tt-1", "tt-3", "tt-2", "tt-4"]);
		// tt-1 sits at index 0 of THAT list, so "down" is index 1.
		const op2: MinutesOp = {
			type: "moveTableTopics",
			...meta(),
			id: "tt-1",
			direction: "down",
			toIndex: 1,
		};
		const projected = deriveMinutes(fourSpeakers(), [op1, op2]);
		expect(ttOrder(projected)).toEqual(["tt-3", "tt-1", "tt-2", "tt-4"]);

		// The SERVER already has op1. The drain replays the whole queue in order
		// against that state, and must land on exactly what the officer was shown.
		const server = deriveMinutes(deriveMinutes(fourSpeakers(), [op1]), [
			op1,
			op2,
		]);
		expect(ttOrder(server)).toEqual(ttOrder(projected));
	});

	it("DIVERGES on that same sequence without an absolute target (G1 x G2 control)", () => {
		// What the cell above would have been with G1 alone: op1's replay steps tt-2
		// a second position, and nothing downstream corrects it — the officer's screen
		// and the club's saved minutes end up different, with no error anywhere.
		const op1: MinutesOp = {
			type: "moveTableTopics",
			...meta(),
			id: "tt-2",
			direction: "down",
		};
		const op2: MinutesOp = {
			type: "moveTableTopics",
			...meta(),
			id: "tt-1",
			direction: "down",
		};
		const projected = deriveMinutes(fourSpeakers(), [op1, op2]);
		const server = deriveMinutes(deriveMinutes(fourSpeakers(), [op1]), [
			op1,
			op2,
		]);
		expect(ttOrder(projected)).toEqual(["tt-3", "tt-1", "tt-2", "tt-4"]);
		// tt-2 stepped a second position on its replay, so it ends up behind tt-4:
		// the officer's screen and the club's saved minutes disagree.
		expect(ttOrder(server)).toEqual(["tt-3", "tt-1", "tt-4", "tt-2"]);
		expect(ttOrder(server)).not.toEqual(ttOrder(projected));
	});

	it("STEPS a replayed move that carries only a direction — the hazard toIndex closes (G2 control)", () => {
		// The negative control, and it is what makes the test above able to fail:
		// without it, a mirror that ignored `toIndex` entirely would still satisfy
		// "twice equals once" if it had accidentally become a no-op. This pins the
		// OLD behaviour, which is still live for ops persisted before `toIndex`
		// existed — the server falls back to `direction` for those, so the mirror
		// must too, hazard included.
		const op: MinutesOp = {
			type: "moveTableTopics",
			...meta(),
			id: "tt-2",
			direction: "down",
		};
		expect(ttOrder(deriveMinutes(fourSpeakers(), [op]))).toEqual([
			"tt-1",
			"tt-3",
			"tt-2",
			"tt-4",
		]);
		expect(ttOrder(deriveMinutes(fourSpeakers(), [op, op]))).toEqual([
			"tt-1",
			"tt-3",
			"tt-4",
			"tt-2",
		]);
	});

	it("renumbers sortOrder dense and distinct after an absolute move (G2)", () => {
		// The server renumbers the whole list, which leaves `sortOrder` dense and
		// distinct so the `(sortOrder, id)` tie-break stops mattering. Asserting the
		// NUMBERS rather than only the order is what keeps this mirror from
		// diverging: `ttOrder` sorts, so it reads the same for [0,1,2,3] and for
		// [0,5,7,9] and could not see a mirror that stopped renumbering.
		const snap = fourSpeakers();
		// Sparse and duplicated on the way in — the shape a swap-only history leaves.
		snap.tableTopicsSpeakers[0].sortOrder = 0;
		snap.tableTopicsSpeakers[1].sortOrder = 5;
		snap.tableTopicsSpeakers[2].sortOrder = 5;
		snap.tableTopicsSpeakers[3].sortOrder = 9;
		const d = deriveMinutes(snap, [
			{
				type: "moveTableTopics",
				...meta(),
				id: "tt-1",
				direction: "down",
				toIndex: 3,
			},
		]);
		expect(ttOrder(d)).toEqual(["tt-2", "tt-3", "tt-4", "tt-1"]);
		expect(d.tableTopicsSpeakers.map((t) => t.sortOrder)).toEqual([0, 1, 2, 3]);
	});

	it("moves a speaker a NON-adjacent distance when toIndex says so (G2)", () => {
		// `direction` can only ever name an adjacent target, so this case is
		// unreachable through the current UI — but the payload now permits it and the
		// two sides must agree on it, or a future drag-to-reorder would silently
		// desync the projection from the server.
		const d = deriveMinutes(fourSpeakers(), [
			{
				type: "moveTableTopics",
				...meta(),
				id: "tt-4",
				direction: "up",
				toIndex: 0,
			},
		]);
		expect(ttOrder(d)).toEqual(["tt-4", "tt-1", "tt-2", "tt-3"]);
	});

	it("treats an out-of-range toIndex as a no-op (G2)", () => {
		for (const toIndex of [4, 99]) {
			const d = deriveMinutes(fourSpeakers(), [
				{
					type: "moveTableTopics",
					...meta(),
					id: "tt-2",
					direction: "down",
					toIndex,
				},
			]);
			expect(ttOrder(d)).toEqual(["tt-1", "tt-2", "tt-3", "tt-4"]);
		}
	});

	it("treats a move past the edge as a no-op", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "moveTableTopics", ...meta(), id: "tt-1", direction: "up" },
		]);
		expect(ttOrder(d)).toEqual(["tt-1", "tt-2"]);
	});

	it("orders three speakers correctly across successive moves (mirrors server)", () => {
		const snap = makeSnapshot();
		snap.tableTopicsSpeakers.push({
			id: "tt-3",
			memberId: "m-bob",
			guestId: null,
			name: "Bob",
			isGuest: false,
			topic: null,
			sortOrder: 2,
		});
		// A(0) B(1) C(2); move C up → A C B; move C up → C A B.
		const d = deriveMinutes(snap, [
			{ type: "moveTableTopics", ...meta(), id: "tt-3", direction: "up" },
			{ type: "moveTableTopics", ...meta(), id: "tt-3", direction: "up" },
		]);
		expect(ttOrder(d)).toEqual(["tt-3", "tt-1", "tt-2"]);
	});

	it("applies add → move → remove as a sequence", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "addTableTopics",
				...meta(),
				id: "tt-new",
				name: "Bob",
				isGuest: false,
				memberId: "m-bob",
			},
			// [tt-1, tt-2, tt-new] → move new up → [tt-1, tt-new, tt-2]
			{ type: "moveTableTopics", ...meta(), id: "tt-new", direction: "up" },
			// remove tt-1 → [tt-new, tt-2]
			{ type: "removeTableTopics", ...meta(), id: "tt-1" },
		]);
		expect(ttOrder(d)).toEqual(["tt-new", "tt-2"]);
	});

	it("recomputes best_table_topics eligibility as speakers change", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "removeTableTopics", ...meta(), id: "tt-1" },
			{
				type: "addTableTopics",
				...meta(),
				id: "tt-new",
				name: "Bob",
				isGuest: false,
				memberId: "m-bob",
			},
		]);
		expect(d.awardEligible.best_table_topics.memberIds).toEqual([
			"m-carol",
			"m-bob",
		]);
		// Speaker/Evaluator eligibility (role-slot derived) is untouched.
		expect(d.awardEligible.best_speaker.memberIds).toEqual(["m-bob"]);
		expect(d.awardEligible.best_evaluator.memberIds).toEqual(["m-bob"]);
	});

	// -- awards --------------------------------------------------------------

	it("sets an award to a member", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAward",
				...meta(),
				category: "best_speaker",
				name: "Alice",
				isGuest: false,
				memberId: "m-alice",
			},
		]);
		expect(d.awards.find((a) => a.category === "best_speaker")).toEqual({
			category: "best_speaker",
			memberId: "m-alice",
			guestId: null,
			name: "Alice",
			isGuest: false,
		});
	});

	it("sets an award to a new guest (guestId null, isGuest true)", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAward",
				...meta(),
				category: "best_speaker",
				name: "Guesty",
				isGuest: true,
				newGuest: { name: "Guesty" },
			},
		]);
		expect(d.awards.find((a) => a.category === "best_speaker")).toEqual({
			category: "best_speaker",
			memberId: null,
			guestId: null,
			name: "Guesty",
			isGuest: true,
		});
	});

	it("sets an award to a new guest with newGuestId (guestId = newGuestId, #176 slice 5)", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAward",
				...meta(),
				category: "best_speaker",
				name: "Guesty",
				isGuest: true,
				newGuest: { name: "Guesty" },
				newGuestId: "g-award-inline",
			},
		]);
		expect(d.awards.find((a) => a.category === "best_speaker")).toEqual({
			category: "best_speaker",
			memberId: null,
			// The inline guest's client PK is carried onto the optimistic award row.
			guestId: "g-award-inline",
			name: "Guesty",
			isGuest: true,
		});
	});

	it("overwrites an existing award (last write wins)", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAward",
				...meta(),
				category: "best_evaluator",
				name: "Alice",
				isGuest: false,
				memberId: "m-alice",
			},
		]);
		expect(d.awards.find((a) => a.category === "best_evaluator")).toMatchObject(
			{
				memberId: "m-alice",
				name: "Alice",
			},
		);
	});

	it("clears an award back to unset", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "clearAward", ...meta(), category: "best_evaluator" },
		]);
		expect(d.awards.find((a) => a.category === "best_evaluator")).toEqual({
			category: "best_evaluator",
			memberId: null,
			guestId: null,
			name: null,
			isGuest: false,
		});
	});

	it("applies set → clear as a sequence", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAward",
				...meta(),
				category: "best_speaker",
				name: "Alice",
				isGuest: false,
				memberId: "m-alice",
			},
			{ type: "clearAward", ...meta(), category: "best_speaker" },
		]);
		expect(
			d.awards.find((a) => a.category === "best_speaker")?.name,
		).toBeNull();
	});

	it("keeps all three award rows in order", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{ type: "clearAward", ...meta(), category: "best_evaluator" },
		]);
		expect(d.awards.map((a) => a.category)).toEqual([
			"best_speaker",
			"best_evaluator",
			"best_table_topics",
		]);
	});

	// -- a broad mixed sequence ---------------------------------------------

	it("applies a full mixed edit session", () => {
		const d = deriveMinutes(makeSnapshot(), [
			{
				type: "setAttendance",
				...meta(),
				memberId: "m-alice",
				status: "present",
			},
			{ type: "addGuest", ...meta(), guestId: "g-x", name: "Xena" },
			{
				type: "addTableTopics",
				...meta(),
				id: "tt-x",
				name: "Xena",
				isGuest: true,
				guestId: "g-x",
			},
			{ type: "moveTableTopics", ...meta(), id: "tt-x", direction: "up" },
			{
				type: "setAward",
				...meta(),
				category: "best_table_topics",
				name: "Xena",
				isGuest: true,
				guestId: "g-x",
			},
		]);
		expect(d.members.find((m) => m.memberId === "m-alice")?.status).toBe(
			"present",
		);
		expect(guestIds(d)).toEqual(["g-rose", "g-x"]); // sorted by name: Rose < Xena
		expect(ttOrder(d)).toEqual(["tt-1", "tt-x", "tt-2"]);
		expect(
			d.awards.find((a) => a.category === "best_table_topics"),
		).toMatchObject({ guestId: "g-x", name: "Xena", isGuest: true });
		expect(d.awardEligible.best_table_topics.guestIds).toEqual(["g-x"]);
		expect(d.counts).toEqual({
			present: 2,
			absent: 1,
			excused: 0,
			unmarked: 0,
			guests: 2,
		});
	});
});
