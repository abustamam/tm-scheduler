import { describe, expect, it } from "vitest";
import type { PanelRole, PlanStatus } from "./attendance-panel";
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

	it("attaches the role a member holds, and an UNCONFIRMED one does not reorder", () => {
		// Holding a role is INFORMATION on the row (spec D2: "assigned members
		// included, with a role chip"), not a bucket. A member with an unconfirmed
		// role who has not answered is still someone to chase. A CONFIRMED role IS
		// a bucket now — see the precedence describe below.
		const { rows } = buildPlanPanel({
			roster,
			plan: [{ memberId: "a", status: "coming" }],
			roleByMemberId: {
				a: { code: "TMR", roleName: "Timer", confirmed: false },
				d: { code: "TD", roleName: "Toastmaster", confirmed: false },
			},
		});
		expect(rows[0]).toMatchObject({ id: "b", role: null });
		expect(rows.find((r) => r.id === "d")?.role).toMatchObject({
			code: "TD",
			roleName: "Toastmaster",
		});
		expect(rows.find((r) => r.id === "a")).toMatchObject({
			role: { code: "TMR", roleName: "Timer" },
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

const CONFIRMED: PanelRole = {
	code: "TD",
	roleName: "Toastmaster",
	confirmed: true,
};
const UNCONFIRMED: PanelRole = {
	code: "TD",
	roleName: "Toastmaster",
	confirmed: false,
};

describe("buildPlanPanel — status precedence", () => {
	// The whole table, so no combination is covered "by implication". The one
	// that matters most is `reached_out` + confirmed — see the `setPlanStatus` /
	// `demoteFrom` explanation on the `assumed` const inside `buildPlanPanel` in
	// attendance-panel.ts.
	const cases: {
		stored: PlanStatus | null;
		role: PanelRole | null;
		status: PlanStatus | null;
		assumed: boolean;
	}[] = [
		{ stored: null, role: null, status: null, assumed: false },
		{ stored: null, role: UNCONFIRMED, status: null, assumed: false },
		{ stored: null, role: CONFIRMED, status: "coming", assumed: true },

		{
			stored: "reached_out",
			role: null,
			status: "reached_out",
			assumed: false,
		},
		{
			stored: "reached_out",
			role: UNCONFIRMED,
			status: "reached_out",
			assumed: false,
		},
		{ stored: "reached_out", role: CONFIRMED, status: "coming", assumed: true },

		{ stored: "coming", role: null, status: "coming", assumed: false },
		{ stored: "coming", role: UNCONFIRMED, status: "coming", assumed: false },
		{ stored: "coming", role: CONFIRMED, status: "coming", assumed: false },

		{ stored: "not_coming", role: null, status: "not_coming", assumed: false },
		{
			stored: "not_coming",
			role: UNCONFIRMED,
			status: "not_coming",
			assumed: false,
		},
		// The member's own word beats the inference: a confirmed Toastmaster who
		// tells you the night before that they cannot come is NOT coming.
		{
			stored: "not_coming",
			role: CONFIRMED,
			status: "not_coming",
			assumed: false,
		},
	];

	for (const c of cases) {
		it(`stored=${c.stored ?? "none"} role=${
			c.role ? (c.role.confirmed ? "confirmed" : "unconfirmed") : "none"
		} → ${c.status ?? "none"}${c.assumed ? " (assumed)" : ""}`, () => {
			const { rows } = buildPlanPanel({
				roster: [roster[0]!],
				plan: c.stored ? [{ memberId: "d", status: c.stored }] : [],
				roleByMemberId: c.role ? { d: c.role } : {},
			});
			expect(rows[0]).toMatchObject({ status: c.status, assumed: c.assumed });
			// `assumed` is a convenience, not a second source of truth: it must
			// always AGREE with what (status, storedStatus) already say. This is the
			// property `role.confirmed` failed — it disagreed for a `not_coming`
			// member holding a confirmed slot, and nothing caught it.
			//
			// BE PRECISE ABOUT WHAT THIS CATCHES, because it is narrower than it
			// looks. Today all three fields are built from `assumed` and `stored` in
			// one return statement, so the equality is TAUTOLOGICAL: mutate the
			// role-confirmation condition and this line still passes — the
			// `toMatchObject` above is what fails. Verified by disabling that
			// assertion and re-running the mutation; all 12 cells went green.
			//
			// What it does guard is a STRUCTURAL decoupling: someone computing
			// `status` by a route other than `assumed ? "coming" : stored`, which is
			// exactly how the two forms would start disagreeing for consumers. The
			// CORRECTNESS of `assumed` is pinned by the table above, not here.
			expect(rows[0]?.assumed).toBe(
				rows[0]?.status === "coming" && rows[0]?.storedStatus !== "coming",
			);
		});
	}
});

describe("buildPlanPanel — an assumed Coming is a real Coming", () => {
	it("counts toward `coming`, not toward `noAnswer`", () => {
		const { counts, countsLine } = buildPlanPanel({
			roster: [roster[0]!, roster[1]!], // Dana, Ali
			plan: [],
			roleByMemberId: { a: CONFIRMED },
		});
		expect(counts).toEqual({
			coming: 1,
			notComing: 0,
			reachedOut: 0,
			noAnswer: 1,
		});
		expect(countsLine).toBe("1 coming · 1 no answer");
	});

	it("sorts into the coming bucket, not the chase-me-first bucket", () => {
		// The role goes to ALI on purpose. Ali sorts first alphabetically, so an
		// assumed Coming has to REVERSE the pair to pass — give the role to Dana
		// instead and the expected order is alphabetical either way, and the
		// assertion cannot fail. Dana has answered nothing and holds nothing, so
		// Dana is the one still to chase and sorts first.
		const { rows } = buildPlanPanel({
			roster: [roster[0]!, roster[1]!],
			plan: [],
			roleByMemberId: { a: CONFIRMED },
		});
		expect(rows.map((r) => r.id)).toEqual(["d", "a"]);
	});

	it("an UNCONFIRMED role still does not move anyone", () => {
		// Holding a role you have not confirmed is information, not an answer — so
		// the SAME fixture that reversed above must stay alphabetical here. This
		// pair is what makes either assertion able to fail.
		const { rows } = buildPlanPanel({
			roster: [roster[0]!, roster[1]!],
			plan: [],
			roleByMemberId: { a: UNCONFIRMED },
		});
		expect(rows.map((r) => r.id)).toEqual(["a", "d"]);
		expect(rows.every((r) => r.status === null)).toBe(true);
	});

	it("carries the STORED rung alongside the effective one", () => {
		// An assumed Coming can sit on top of a stored `reached_out` — the officer
		// messaged a confirmed Toastmaster. A caller asking "is there a row to
		// clear?" cannot get that from `status`, which reads "coming" either way.
		const { rows } = buildPlanPanel({
			roster: [roster[0]!],
			plan: [{ memberId: "d", status: "reached_out" }],
			roleByMemberId: { d: CONFIRMED },
		});
		expect(rows[0]).toMatchObject({
			status: "coming",
			assumed: true,
			storedStatus: "reached_out",
		});
	});

	it("distinguishes an assumed Coming with a stored rung from one with no row", () => {
		const { rows } = buildPlanPanel({
			roster: [roster[0]!],
			plan: [],
			roleByMemberId: { d: CONFIRMED },
		});
		expect(rows[0]).toMatchObject({
			status: "coming",
			assumed: true,
			storedStatus: null,
		});
	});

	it("does not put `confirmed` on the row's role", () => {
		// `toEqual`, not `toMatchObject`: the whole point is that the field is
		// ABSENT, and a partial match cannot see an extra key. This is the case
		// where the two answers disagree — `assumed` is false, the slot is
		// confirmed — so a downstream reader picking the wrong one is visible here.
		const { rows } = buildPlanPanel({
			roster: [roster[0]!],
			plan: [{ memberId: "d", status: "not_coming" }],
			roleByMemberId: { d: CONFIRMED },
		});
		expect(rows[0]?.assumed).toBe(false);
		expect(rows[0]?.role).toEqual({ code: "TD", roleName: "Toastmaster" });
	});
});
