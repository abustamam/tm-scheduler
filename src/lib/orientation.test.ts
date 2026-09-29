import { describe, expect, it } from "vitest";
import {
	type OrientationFacts,
	type OrientationItemKey,
	type OrientationSlotFact,
	orientationItems,
	orientationView,
} from "./orientation";

const STARTED = new Date("2026-09-01T00:00:00Z");

function facts(over: Partial<OrientationFacts> = {}): OrientationFacts {
	return {
		startedAt: STARTED,
		dismissedAt: null,
		basecampSetupAt: null,
		activePathCount: 0,
		slots: [],
		...over,
	};
}

function doneOf(f: OrientationFacts, key: OrientationItemKey): boolean {
	const item = orientationItems(f).find((i) => i.key === key);
	if (!item) throw new Error(`no item ${key}`);
	return item.done;
}

const speaker = (
	meetingStatus: OrientationSlotFact["meetingStatus"],
): OrientationSlotFact => ({ isSpeakerRole: true, meetingStatus });
const supporting = (
	meetingStatus: OrientationSlotFact["meetingStatus"],
): OrientationSlotFact => ({ isSpeakerRole: false, meetingStatus });

describe("orientation items (#940)", () => {
	it("lists the four items in order, with Base Camp the only self-tick", () => {
		const items = orientationItems(facts());
		expect(items.map((i) => i.key)).toEqual([
			"choose-path",
			"ice-breaker",
			"supporting-role",
			"base-camp",
		]);
		expect(items.filter((i) => i.selfTick).map((i) => i.key)).toEqual([
			"base-camp",
		]);
		expect(items.every((i) => !i.done)).toBe(true);
	});

	describe("Choose a path", () => {
		it("is done with any live path enrollment", () => {
			expect(doneOf(facts({ activePathCount: 1 }), "choose-path")).toBe(true);
			expect(doneOf(facts({ activePathCount: 3 }), "choose-path")).toBe(true);
		});
		it("is not done with none", () => {
			expect(doneOf(facts({ activePathCount: 0 }), "choose-path")).toBe(false);
		});
		it("is not ticked by a slot or by Base Camp", () => {
			expect(
				doneOf(
					facts({
						slots: [speaker("scheduled"), supporting("scheduled")],
						basecampSetupAt: STARTED,
					}),
					"choose-path",
				),
			).toBe(false);
		});
	});

	describe("Schedule your Ice Breaker", () => {
		it("is done with a speaker slot in a scheduled (future) meeting", () => {
			expect(
				doneOf(facts({ slots: [speaker("scheduled")] }), "ice-breaker"),
			).toBe(true);
		});
		it("is done with a speaker slot in a completed (past) meeting", () => {
			expect(
				doneOf(facts({ slots: [speaker("completed")] }), "ice-breaker"),
			).toBe(true);
		});
		it("is NOT done by a speaker slot in a cancelled meeting", () => {
			expect(
				doneOf(facts({ slots: [speaker("cancelled")] }), "ice-breaker"),
			).toBe(false);
		});
		it("is NOT done by a non-speaker slot", () => {
			expect(
				doneOf(facts({ slots: [supporting("scheduled")] }), "ice-breaker"),
			).toBe(false);
		});
		it("counts a live speaker slot beside a cancelled one", () => {
			expect(
				doneOf(
					facts({ slots: [speaker("cancelled"), speaker("scheduled")] }),
					"ice-breaker",
				),
			).toBe(true);
		});
	});

	describe("Take a supporting role", () => {
		it("is done with a non-speaker slot in a scheduled meeting", () => {
			expect(
				doneOf(facts({ slots: [supporting("scheduled")] }), "supporting-role"),
			).toBe(true);
		});
		it("is done with a non-speaker slot in a completed meeting", () => {
			expect(
				doneOf(facts({ slots: [supporting("completed")] }), "supporting-role"),
			).toBe(true);
		});
		it("is NOT done by a non-speaker slot in a cancelled meeting", () => {
			expect(
				doneOf(facts({ slots: [supporting("cancelled")] }), "supporting-role"),
			).toBe(false);
		});
		it("is NOT done by a speaker slot", () => {
			expect(
				doneOf(facts({ slots: [speaker("completed")] }), "supporting-role"),
			).toBe(false);
		});
	});

	describe("Set up Base Camp (the self-tick)", () => {
		it("is done exactly when basecamp_setup_at is set", () => {
			expect(doneOf(facts({ basecampSetupAt: STARTED }), "base-camp")).toBe(
				true,
			);
			expect(doneOf(facts({ basecampSetupAt: null }), "base-camp")).toBe(false);
		});
		it("is not ticked by any derived fact", () => {
			expect(
				doneOf(
					facts({
						activePathCount: 2,
						slots: [speaker("completed"), supporting("completed")],
					}),
					"base-camp",
				),
			).toBe(false);
		});
	});
});

describe("orientationView (#940)", () => {
	const allDone = facts({
		activePathCount: 1,
		basecampSetupAt: STARTED,
		slots: [speaker("completed"), supporting("scheduled")],
	});

	it("is invisible when orientation never started (a veteran)", () => {
		const v = orientationView(facts({ startedAt: null }));
		expect(v.inOrientation).toBe(false);
		expect(v.visible).toBe(false);
	});

	it("is visible when started, not dismissed and incomplete", () => {
		const v = orientationView(facts({ activePathCount: 1 }));
		expect(v).toMatchObject({
			inOrientation: true,
			dismissed: false,
			doneCount: 1,
			total: 4,
			complete: false,
			visible: true,
		});
	});

	it("disappears on its own when all four items are done", () => {
		const v = orientationView(allDone);
		expect(v.doneCount).toBe(4);
		expect(v.complete).toBe(true);
		expect(v.visible).toBe(false);
	});

	it("three of four done is still visible", () => {
		const v = orientationView({ ...allDone, basecampSetupAt: null });
		expect(v.doneCount).toBe(3);
		expect(v.visible).toBe(true);
	});

	it("a cancelled meeting can keep the checklist open", () => {
		const v = orientationView({
			...allDone,
			slots: [speaker("cancelled"), supporting("scheduled")],
		});
		expect(v.complete).toBe(false);
		expect(v.visible).toBe(true);
	});

	it("dismissing hides it for good, whatever is done", () => {
		const v = orientationView(facts({ dismissedAt: STARTED }));
		expect(v.dismissed).toBe(true);
		expect(v.visible).toBe(false);
	});
});
