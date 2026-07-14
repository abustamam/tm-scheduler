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
