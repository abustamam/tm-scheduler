import { describe, expect, it } from "vitest";
import {
	buildPlanPanel,
	type PanelRole,
	type PlanStatus,
	resolveEffectiveRung,
} from "#/lib/attendance-panel";
import { buildRollPanel } from "#/lib/roll-panel";

/**
 * #664: one answer to "who is coming?". The assumed-Coming inference used to
 * live inline in `buildPlanPanel`, so roll mode (and the seam) answered the same
 * question differently. These tests pin the rule once and then pin that BOTH
 * panel builders agree with it for every (stored rung × role) combination —
 * the parity is the thing that regressed, so it is what is asserted.
 */

const STORED: (PlanStatus | null)[] = [
	null,
	"reached_out",
	"coming",
	"not_coming",
];
const ROLES: (Pick<PanelRole, "confirmed"> | null)[] = [
	null,
	{ confirmed: false },
	{ confirmed: true },
];

describe("resolveEffectiveRung", () => {
	it("applies the precedence ladder in all twelve cells", () => {
		const table = STORED.flatMap((stored) =>
			ROLES.map((role) => ({
				stored,
				role: role === null ? "none" : role.confirmed ? "confirmed" : "held",
				...resolveEffectiveRung(stored, role),
			})),
		);
		expect(table).toEqual([
			// No answer: only a CONFIRMED slot infers Coming.
			{ stored: null, role: "none", status: null, assumed: false },
			{ stored: null, role: "held", status: null, assumed: false },
			{ stored: null, role: "confirmed", status: "coming", assumed: true },
			// An ask is not an answer, and a confirmed slot outranks it.
			{
				stored: "reached_out",
				role: "none",
				status: "reached_out",
				assumed: false,
			},
			{
				stored: "reached_out",
				role: "held",
				status: "reached_out",
				assumed: false,
			},
			{
				stored: "reached_out",
				role: "confirmed",
				status: "coming",
				assumed: true,
			},
			// Their own word wins, and is never flagged assumed.
			{ stored: "coming", role: "none", status: "coming", assumed: false },
			{ stored: "coming", role: "held", status: "coming", assumed: false },
			{
				stored: "coming",
				role: "confirmed",
				status: "coming",
				assumed: false,
			},
			{
				stored: "not_coming",
				role: "none",
				status: "not_coming",
				assumed: false,
			},
			{
				stored: "not_coming",
				role: "held",
				status: "not_coming",
				assumed: false,
			},
			{
				stored: "not_coming",
				role: "confirmed",
				status: "not_coming",
				assumed: false,
			},
		]);
	});

	it("treats an undefined role like no role", () => {
		expect(resolveEffectiveRung(null, undefined)).toEqual({
			status: null,
			assumed: false,
		});
	});
});

describe("plan mode and roll mode agree about who is coming", () => {
	const member = { id: "m-1", name: "Ada Obi", phone: null, email: null };

	for (const stored of STORED) {
		for (const role of ROLES) {
			const label = `stored=${stored ?? "none"}, role=${
				role === null ? "none" : role.confirmed ? "confirmed" : "held"
			}`;
			it(label, () => {
				const plan = stored ? [{ memberId: member.id, status: stored }] : [];
				const roleByMemberId: Record<string, PanelRole> = role
					? { [member.id]: { code: "TM", roleName: "Toastmaster", ...role } }
					: {};

				const planRow = buildPlanPanel({
					roster: [member],
					plan,
					roleByMemberId,
				}).rows[0];
				const rollRow = buildRollPanel({
					roster: [member],
					attendance: [],
					plan,
					roleByMemberId,
				}).rows[0];

				// Coming in the rail ⇔ Present? in roll; Not coming ⇔ Excused?.
				const expected =
					planRow?.status === "coming"
						? "present"
						: planRow?.status === "not_coming"
							? "excused"
							: null;
				expect(rollRow?.suggestion).toBe(expected);
				// And the qualifier survives the crossing.
				expect(rollRow?.suggestionAssumed).toBe(planRow?.assumed);
			});
		}
	}
});

describe("buildRollPanel's assumed suggestion", () => {
	const roster = [
		{ id: "m-tm", name: "Tomi Ade", phone: null, email: null },
		{ id: "m-said", name: "Sade Bello", phone: null, email: null },
	];
	const roleByMemberId: Record<string, PanelRole> = {
		"m-tm": { code: "TM", roleName: "Toastmaster", confirmed: true },
	};

	it("suggests Present? for a confirmed role-holder who never replied, flagged assumed", () => {
		const { rows } = buildRollPanel({
			roster,
			attendance: [],
			plan: [{ memberId: "m-said", status: "coming" }],
			roleByMemberId,
		});
		const by = (id: string) => rows.find((r) => r.id === id);
		expect(by("m-tm")).toMatchObject({
			status: null,
			suggestion: "present",
			suggestionAssumed: true,
		});
		// A real answer is a real suggestion, not an assumed one.
		expect(by("m-said")).toMatchObject({
			suggestion: "present",
			suggestionAssumed: false,
		});
	});

	it("never counts the assumed suggestion — it is still unmarked", () => {
		const { counts } = buildRollPanel({
			roster,
			attendance: [],
			plan: [],
			roleByMemberId,
		});
		expect(counts).toEqual({ present: 0, absent: 0, excused: 0, unmarked: 2 });
	});

	it("drops the suggestion AND the flag once a real row is recorded", () => {
		const { rows } = buildRollPanel({
			roster,
			attendance: [{ memberId: "m-tm", status: "absent" }],
			plan: [],
			roleByMemberId,
		});
		expect(rows.find((r) => r.id === "m-tm")).toMatchObject({
			status: "absent",
			suggestion: null,
			suggestionAssumed: false,
		});
	});
});
