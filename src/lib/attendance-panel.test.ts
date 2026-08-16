import { describe, expect, it } from "vitest";
import { buildPlanPanel } from "./attendance-panel";

const roster = [
	{ id: "d", name: "Dana", preferredName: null, phone: null, email: null },
	{ id: "a", name: "Ali", preferredName: null, phone: null, email: null },
	{ id: "c", name: "Cleo", preferredName: null, phone: null, email: null },
	{ id: "b", name: "Bo", preferredName: null, phone: null, email: null },
];

describe("buildPlanPanel", () => {
	it("sorts by how much chasing is left, then alphabetically", () => {
		// Spec D2: no answer → reached out → coming → not coming. The people you
		// still have to do something about are at the top; the settled answers sink.
		const { rows } = buildPlanPanel({
			roster,
			plan: [
				{ memberId: "a", status: "coming" },
				{ memberId: "b", status: "not_coming" },
				{ memberId: "c", status: "reached_out" },
			],
			roleByMemberId: {},
		});
		expect(rows.map((r) => r.id)).toEqual(["d", "c", "a", "b"]);
	});

	it("orders alphabetically WITHIN a rung", () => {
		// Two members on the same rung, inserted in reverse alphabetical order —
		// the sort must be stable on name, not on input order.
		const { rows } = buildPlanPanel({
			roster: [
				{ id: "z", name: "Zoe", preferredName: null, phone: null, email: null },
				{ id: "a", name: "Ali", preferredName: null, phone: null, email: null },
			],
			plan: [],
			roleByMemberId: {},
		});
		expect(rows.map((r) => r.name)).toEqual(["Ali", "Zoe"]);
	});

	it("counts every member exactly once, including no-answer", () => {
		const { counts, countsLine } = buildPlanPanel({
			roster,
			plan: [
				{ memberId: "a", status: "coming" },
				{ memberId: "b", status: "not_coming" },
				{ memberId: "c", status: "reached_out" },
			],
			roleByMemberId: {},
		});
		expect(counts).toEqual({
			coming: 1,
			notComing: 1,
			reachedOut: 1,
			noAnswer: 1,
		});
		// The arithmetic check: a member cannot be dropped rather than bucketed.
		expect(
			counts.coming + counts.notComing + counts.reachedOut + counts.noAnswer,
		).toBe(roster.length);
		expect(countsLine).toBe("1 coming · 1 out · 1 asked · 1 no answer");
	});

	it("omits empty buckets from the counts line", () => {
		const { countsLine } = buildPlanPanel({
			roster: [roster[0]!],
			plan: [],
			roleByMemberId: {},
		});
		expect(countsLine).toBe("1 no answer");
	});

	it("attaches the role a member holds, and does not reorder for it", () => {
		// Holding a role is INFORMATION on the row (spec D2: "assigned members
		// included, with a role chip"), not a bucket. A member with a role who has
		// not answered is still someone to chase.
		const { rows } = buildPlanPanel({
			roster,
			plan: [{ memberId: "a", status: "coming" }],
			roleByMemberId: { a: "Timer", d: "Toastmaster" },
		});
		expect(rows[0]).toMatchObject({ id: "b", roleName: null });
		expect(rows.find((r) => r.id === "d")).toMatchObject({
			roleName: "Toastmaster",
		});
		expect(rows.find((r) => r.id === "a")).toMatchObject({
			roleName: "Timer",
			status: "coming",
		});
	});

	it("ignores a plan row for someone not on the roster", () => {
		// Inactive members are filtered out of the roster upstream, but their plan
		// rows survive in the table — a stale row must not resurrect a name.
		const { rows, counts } = buildPlanPanel({
			roster: [roster[0]!],
			plan: [{ memberId: "ghost", status: "coming" }],
			roleByMemberId: {},
		});
		expect(rows).toHaveLength(1);
		expect(counts.coming).toBe(0);
	});
});
