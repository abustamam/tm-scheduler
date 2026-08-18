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

	it("maintains alphabetical order even when the first member is marked present", () => {
		// This test catches a status-ranked sort that the previous test cannot.
		// If the sort were {null:0, absent:1, excused:2, present:3}, Abe (present)
		// would move to the back, breaking this assertion. The previous test fails
		// to catch this because Cara (present, alphabetically last) ends up in the
		// same position either way.
		const { rows } = buildRollPanel({
			roster,
			attendance: [{ memberId: "m-abe", status: "present" }],
			plan: [],
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
			// `PanelRole`, not a bare string, since v1.19.0.0 (#594) gave the rail a
			// role model. `confirmed` is required on the INPUT and deliberately absent
			// from the row: it is a second answer to the question `assumed` answers,
			// and roll mode has no use for either.
			roleByMemberId: {
				"m-bea": { code: "TI", roleName: "Timer", confirmed: false },
			},
		});
		// The row carries BOTH halves of `PanelRowRole`. It carried `roleName` alone
		// until the F4 refit, and the badge therefore rendered the full role name —
		// an unshrinkable `whitespace-nowrap` block ~136px wide for "Toastmaster of
		// the Day" in a ~292px column. The rail's shared identity line renders the
		// 2-4 character `code`, so a row without it cannot be rendered correctly.
		expect(rows.find((r) => r.id === "m-bea")?.role).toEqual({
			code: "TI",
			roleName: "Timer",
		});
		expect(rows.find((r) => r.id === "m-abe")?.role).toBeNull();
	});

	it("carries preferredName from the roster through to each row", () => {
		const { rows } = buildRollPanel({
			roster: [
				{
					id: "m-cara",
					name: "Cara Diaz",
					phone: null,
					email: null,
					preferredName: "Cara",
				},
				{
					id: "m-abe",
					name: "Abe Nkemelu",
					phone: null,
					email: null,
					preferredName: null,
				},
				{ id: "m-bea", name: "Bea Osei", phone: null, email: null },
			],
			attendance: [],
			plan: [],
			roleByMemberId: {},
		});
		expect(rows.find((r) => r.id === "m-cara")?.preferredName).toBe("Cara");
		expect(rows.find((r) => r.id === "m-abe")?.preferredName).toBeNull();
		expect(rows.find((r) => r.id === "m-bea")?.preferredName).toBeNull();
	});
	it("carries the departed tag through, normalised to a boolean", () => {
		// The flag rides in on the roster (`deriveRollRoster` appends the row) and
		// the renderer reads it off the ROW, so a builder that dropped it would
		// silently put "No contact on file" back on a departed member — the copy two
		// other fixes went out of their way to avoid. Normalised, because the
		// roster's field is optional and a renderer reading `undefined` as anything
		// but false is a bug waiting for a strict comparison.
		const { rows } = buildRollPanel({
			roster: [
				{
					id: "m-gone",
					name: "Dee Gone",
					phone: null,
					email: null,
					departed: true,
				},
				{ id: "m-here", name: "Abe Nkemelu", phone: null, email: null },
			],
			attendance: [{ memberId: "m-gone", status: "present" }],
			plan: [],
			roleByMemberId: {},
		});
		expect(rows.find((r) => r.id === "m-gone")?.departed).toBe(true);
		expect(rows.find((r) => r.id === "m-here")?.departed).toBe(false);
	});
});
