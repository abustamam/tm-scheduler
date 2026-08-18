import { describe, expect, it } from "vitest";
import type { PanelRole, PlanStatus } from "./attendance-panel";
import { buildPanelRoleMap, buildPlanPanel } from "./attendance-panel";

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

// A real seam, not a route-inline derivation guarded only by source greps: two
// bugs found under mutation review passed a five-assertion grep and a clean
// typecheck. One would break the rail completely — keying the lookup by the
// slot's own id instead of the member's, so no badge renders on any row. The
// other would silently renumber the badges as the week's slots fill — filtering
// to assigned slots before `buildShortCodes` counts them turns "SP" into "SP1"
// with no error, just a wrong, drifting label. Both are real assertions here
// instead.
type PanelSlotInput = Parameters<typeof buildPanelRoleMap>[0][number];

describe("buildPanelRoleMap", () => {
	it("keys the map by the MEMBER id, not by any other id on the slot", () => {
		// `roleDefinitionId` and `assigneeId` (the member) are both plausible
		// `string` ids on the same object. Keying on the former is the bug that
		// renders no badge on any row at all: this member id would never appear
		// as a key, so `input.roleByMemberId[m.id]` in `buildPlanPanel` misses for
		// every single row. (`role_slots.id`, a second plausible wrong key, is
		// deliberately absent from this function's parameter type — see the
		// comment on `buildPanelRoleMap`'s parameter — so THAT mistake is a
		// compile error rather than something this test needs to catch.)
		const slots: PanelSlotInput[] = [
			{
				roleDefinitionId: "role-td",
				slotIndex: 0,
				roleName: "Toastmaster of the Day",
				status: "confirmed",
				assigneeId: "member-1",
			},
		];
		expect(Object.keys(buildPanelRoleMap(slots))).toEqual(["member-1"]);
	});

	it("numbers a role off every slot it HAS, not just the assigned ones", () => {
		// Three Speaker slots, one filled. `buildShortCodes` numbers a role once
		// it has more than one slot — full stop, regardless of how many are
		// assigned — so the filled one must read "SP1", not the singleton "SP".
		const threeSlots: PanelSlotInput[] = [
			{
				roleDefinitionId: "role-sp",
				slotIndex: 0,
				roleName: "Speaker",
				status: "confirmed",
				assigneeId: "member-1",
			},
			{
				roleDefinitionId: "role-sp",
				slotIndex: 1,
				roleName: "Speaker",
				status: "open",
				assigneeId: null,
			},
			{
				roleDefinitionId: "role-sp",
				slotIndex: 2,
				roleName: "Speaker",
				status: "open",
				assigneeId: null,
			},
		];
		expect(buildPanelRoleMap(threeSlots)["member-1"]?.code).toBe("SP1");

		// The bug: filtering to assigned slots BEFORE counting. With only the one
		// filled slot in the row set, `buildShortCodes` sees a singleton role and
		// drops the number — a different, WRONG answer from the same meeting,
		// changing as the week's slots fill. Proven here by passing the filtered
		// set straight through the same function, not by editing the source.
		const onlyAssigned = threeSlots.filter((s) => s.assigneeId);
		expect(buildPanelRoleMap(onlyAssigned)["member-1"]?.code).toBe("SP");
	});

	it("reads `confirmed` from the slot status, with the right polarity", () => {
		const claimed: PanelSlotInput[] = [
			{
				roleDefinitionId: "role-td",
				slotIndex: 0,
				roleName: "Toastmaster of the Day",
				status: "claimed",
				assigneeId: "member-1",
			},
		];
		expect(buildPanelRoleMap(claimed)["member-1"]?.confirmed).toBe(false);

		const confirmed: PanelSlotInput[] = [
			{
				roleDefinitionId: "role-td",
				slotIndex: 0,
				roleName: "Toastmaster of the Day",
				status: "confirmed",
				assigneeId: "member-1",
			},
		];
		expect(buildPanelRoleMap(confirmed)["member-1"]?.confirmed).toBe(true);
	});

	it("carries the BASE role name, not the numbered label", () => {
		const slots: PanelSlotInput[] = [
			{
				roleDefinitionId: "role-sp",
				slotIndex: 0,
				roleName: "Speaker",
				status: "confirmed",
				assigneeId: "member-1",
			},
			{
				roleDefinitionId: "role-sp",
				slotIndex: 1,
				roleName: "Speaker",
				status: "open",
				assigneeId: null,
			},
		];
		const role = buildPanelRoleMap(slots)["member-1"];
		// The CODE is numbered ("SP1") — the base name deliberately is not.
		expect(role?.code).toBe("SP1");
		expect(role?.roleName).toBe("Speaker");
	});

	it("resolves a double-booked member to confirmed-if-ANY, labeled by the FIRST slot", () => {
		// `role-template.ts` orders Toastmaster of the Day at sortOrder 10 and
		// Speaker at 30, and `meetings.ts` selects slots
		// `.orderBy(asc(roleDefinitions.sortOrder), ...)` — so for a member
		// holding both, Toastmaster arrives first. Confirmed as Toastmaster but
		// only claimed as Speaker must not read as unconfirmed just because
		// Speaker was iterated second: plain last-write-wins would silently drop
		// this member out of the rail's "coming" count.
		const slots: PanelSlotInput[] = [
			{
				roleDefinitionId: "role-td",
				slotIndex: 0,
				roleName: "Toastmaster of the Day",
				status: "confirmed",
				assigneeId: "member-1",
			},
			{
				roleDefinitionId: "role-sp",
				slotIndex: 0,
				roleName: "Speaker",
				status: "claimed",
				assigneeId: "member-1",
			},
		];
		expect(buildPanelRoleMap(slots)["member-1"]).toEqual({
			code: "TD",
			roleName: "Toastmaster of the Day",
			confirmed: true,
		});
	});

	it("stays confirmed-if-ANY when the LATER slot is the confirmed one", () => {
		// Same pair, reversed which slot is confirmed. The label still comes from
		// the FIRST slot by iteration order regardless of which one is confirmed
		// — `confirmed` is an OR across all of a member's slots, not "whichever
		// slot happens to be confirmed" and not "whichever slot is last".
		const slots: PanelSlotInput[] = [
			{
				roleDefinitionId: "role-td",
				slotIndex: 0,
				roleName: "Toastmaster of the Day",
				status: "claimed",
				assigneeId: "member-1",
			},
			{
				roleDefinitionId: "role-sp",
				slotIndex: 0,
				roleName: "Speaker",
				status: "confirmed",
				assigneeId: "member-1",
			},
		];
		expect(buildPanelRoleMap(slots)["member-1"]).toEqual({
			code: "TD",
			roleName: "Toastmaster of the Day",
			confirmed: true,
		});
	});

	it("contributes no key for an open (unassigned) slot", () => {
		const slots: PanelSlotInput[] = [
			{
				roleDefinitionId: "role-td",
				slotIndex: 0,
				roleName: "Toastmaster of the Day",
				status: "open",
				assigneeId: null,
			},
		];
		expect(Object.keys(buildPanelRoleMap(slots))).toEqual([]);
	});
});
