import { describe, expect, it } from "vitest";
import type { MinutesData } from "#/server/minutes-logic";
import {
	createOfflineMinutesQueue,
	type MinutesOp,
	memoryStore,
} from "./offline-minutes-queue";

const M = "meeting-1";
const OTHER = "meeting-2";

function op(overrides: Partial<MinutesOp> & { opId: string }): MinutesOp {
	return {
		type: "setAttendance",
		queuedAt: 1,
		memberId: "m-1",
		status: "present",
		...overrides,
	} as MinutesOp;
}

function makeSnapshot(): MinutesData {
	return {
		meetingId: M,
		clubId: "club-1",
		members: [{ memberId: "m-1", name: "Alice", status: null, hasRole: false }],
		guests: [],
		tableTopicsSpeakers: [],
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
				memberId: null,
				guestId: null,
				name: null,
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
			best_speaker: { memberIds: [], guestIds: [] },
			best_evaluator: { memberIds: [], guestIds: [] },
			best_table_topics: { memberIds: [], guestIds: [] },
		},
		counts: { present: 0, absent: 0, excused: 0, unmarked: 1, guests: 0 },
	};
}

describe("offline minutes queue", () => {
	it("starts empty and returns [] for an unknown meeting", async () => {
		const q = createOfflineMinutesQueue(memoryStore());
		expect(await q.readQueue(M)).toEqual([]);
		expect(await q.readSnapshot(M)).toBeNull();
	});

	it("enqueues ops in insertion order", async () => {
		const q = createOfflineMinutesQueue(memoryStore());
		await q.enqueue(M, op({ opId: "a" }));
		await q.enqueue(M, op({ opId: "b" }));
		await q.enqueue(M, op({ opId: "c" }));
		expect((await q.readQueue(M)).map((o) => o.opId)).toEqual(["a", "b", "c"]);
	});

	it("isolates queues per meeting", async () => {
		const q = createOfflineMinutesQueue(memoryStore());
		await q.enqueue(M, op({ opId: "a" }));
		await q.enqueue(OTHER, op({ opId: "z" }));
		expect((await q.readQueue(M)).map((o) => o.opId)).toEqual(["a"]);
		expect((await q.readQueue(OTHER)).map((o) => o.opId)).toEqual(["z"]);
	});

	it("clears a meeting's queue without touching others", async () => {
		const q = createOfflineMinutesQueue(memoryStore());
		await q.enqueue(M, op({ opId: "a" }));
		await q.enqueue(OTHER, op({ opId: "z" }));
		await q.clearQueue(M);
		expect(await q.readQueue(M)).toEqual([]);
		expect((await q.readQueue(OTHER)).map((o) => o.opId)).toEqual(["z"]);
	});

	it("removes a single op by opId, preserving order", async () => {
		const q = createOfflineMinutesQueue(memoryStore());
		await q.enqueue(M, op({ opId: "a" }));
		await q.enqueue(M, op({ opId: "b" }));
		await q.enqueue(M, op({ opId: "c" }));
		await q.removeOp(M, "b");
		expect((await q.readQueue(M)).map((o) => o.opId)).toEqual(["a", "c"]);
	});

	it("round-trips a snapshot", async () => {
		const q = createOfflineMinutesQueue(memoryStore());
		const snap = makeSnapshot();
		await q.saveSnapshot(M, snap);
		expect(await q.readSnapshot(M)).toEqual(snap);
	});

	it("overwrites a snapshot on re-save", async () => {
		const q = createOfflineMinutesQueue(memoryStore());
		await q.saveSnapshot(M, makeSnapshot());
		const updated = makeSnapshot();
		updated.counts.present = 5;
		await q.saveSnapshot(M, updated);
		expect((await q.readSnapshot(M))?.counts.present).toBe(5);
	});

	it("persists across queue instances sharing a store (reload survival)", async () => {
		const store = memoryStore();
		const first = createOfflineMinutesQueue(store);
		await first.enqueue(M, op({ opId: "a" }));
		await first.saveSnapshot(M, makeSnapshot());

		// A fresh queue over the same durable store (simulates a page reload).
		const second = createOfflineMinutesQueue(store);
		expect((await second.readQueue(M)).map((o) => o.opId)).toEqual(["a"]);
		expect(await second.readSnapshot(M)).not.toBeNull();
	});

	it("stores a structural copy (no aliasing back into the store)", async () => {
		const store = memoryStore();
		const q = createOfflineMinutesQueue(store);
		const mutable = op({ opId: "a" });
		await q.enqueue(M, mutable);
		// Mutating the caller's object must not change what was stored.
		mutable.opId = "mutated";
		expect((await q.readQueue(M)).map((o) => o.opId)).toEqual(["a"]);
	});
});
