import { describe, expect, it } from "vitest";
import { buildRollPanel } from "#/lib/roll-panel";

const roster = [
	{ id: "m-cara", name: "Cara Diaz", phone: null, email: null },
	{ id: "m-abe", name: "Abe Nkemelu", phone: null, email: null },
	{ id: "m-bea", name: "Bea Osei", phone: null, email: null },
];

describe("buildRollPanel", () => {
	it("sorts alphabetically, NOT by the plan ladder", () => {
		// Plan mode sorts chase-worthy-first. Roll mode is a register being read
		// down, so a row must not move because someone tapped it.
		const { rows } = buildRollPanel({
			roster,
			attendance: [{ memberId: "m-cara", status: "present" }],
			plan: [{ memberId: "m-abe", status: "not_coming" }],
			roleByMemberId: {},
		});
		expect(rows.map((r) => r.name)).toEqual([
			"Abe Nkemelu",
			"Bea Osei",
			"Cara Diaz",
		]);
	});

	it("maps a plan rung to a SUGGESTION when no attendance row exists", () => {
		const { rows } = buildRollPanel({
			roster,
			attendance: [],
			plan: [
				{ memberId: "m-abe", status: "coming" },
				{ memberId: "m-bea", status: "not_coming" },
				{ memberId: "m-cara", status: "reached_out" },
			],
			roleByMemberId: {},
		});
		const by = (id: string) => rows.find((r) => r.id === id);
		expect(by("m-abe")).toMatchObject({
			status: null,
			suggestion: "present",
		});
		expect(by("m-bea")).toMatchObject({
			status: null,
			suggestion: "excused",
		});
		// `reached_out` is an ask, not an answer — it suggests nothing.
		expect(by("m-cara")).toMatchObject({ status: null, suggestion: null });
	});

	it("a real row WINS over the plan and renders solid", () => {
		// The whole point of D3: a plan can never be mistaken for a record.
		const { rows } = buildRollPanel({
			roster,
			attendance: [{ memberId: "m-abe", status: "absent" }],
			plan: [{ memberId: "m-abe", status: "coming" }],
			roleByMemberId: {},
		});
		expect(rows.find((r) => r.id === "m-abe")).toMatchObject({
			status: "absent",
			suggestion: null,
		});
	});

	it("counts REAL rows only — a suggestion is never counted", () => {
		// The assertion this module exists for. Counting suggestions would report
		// "12 present" for a room nobody had checked, which is worse than no count.
		const { counts, countsLine } = buildRollPanel({
			roster,
			attendance: [{ memberId: "m-cara", status: "present" }],
			// Two members carry `coming`, so a suggestion-counting bug reads 3.
			plan: [
				{ memberId: "m-abe", status: "coming" },
				{ memberId: "m-bea", status: "coming" },
			],
			roleByMemberId: {},
		});
		expect(counts).toEqual({ present: 1, absent: 0, excused: 0, unmarked: 2 });
		expect(countsLine).toBe("1 present · 2 unmarked");
	});

	it("sums every bucket to the roster size", () => {
		const { counts } = buildRollPanel({
			roster,
			attendance: [
				{ memberId: "m-abe", status: "present" },
				{ memberId: "m-bea", status: "excused" },
				{ memberId: "m-cara", status: "absent" },
			],
			plan: [],
			roleByMemberId: {},
		});
		const total =
			counts.present + counts.absent + counts.excused + counts.unmarked;
		expect(total).toBe(roster.length);
	});

	it("omits empty buckets from the counts line", () => {
		const { countsLine } = buildRollPanel({
			roster,
			attendance: [],
			plan: [],
			roleByMemberId: {},
		});
		expect(countsLine).toBe("3 unmarked");
	});

	it("builds rows from the ROSTER, so a stale attendance row cannot resurrect a name", () => {
		// An inactive member is filtered upstream but their attendance row survives
		// in the table. Iterating attendance would put them back on screen.
		const { rows } = buildRollPanel({
			roster,
			attendance: [{ memberId: "m-ghost", status: "present" }],
			plan: [],
			roleByMemberId: {},
		});
		expect(rows).toHaveLength(3);
		expect(rows.find((r) => r.id === "m-ghost")).toBeUndefined();
	});

	it("carries the role chip as information, never as a bucket", () => {
		const { rows } = buildRollPanel({
			roster,
			attendance: [],
			plan: [],
			roleByMemberId: { "m-bea": "Timer" },
		});
		expect(rows.find((r) => r.id === "m-bea")?.roleName).toBe("Timer");
		expect(rows.find((r) => r.id === "m-abe")?.roleName).toBeNull();
	});
});
