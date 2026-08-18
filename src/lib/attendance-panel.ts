// Pure derivation for the planned-attendance panel (spec D2). No React and no
// db, so the ORDER and the COUNTS — the two things a reviewer actually checks —
// are assertable directly. Through a rendered DOM neither is: two rows on the
// same rung render the same label, and a count can be right for the wrong
// reason.

import type { AttendancePlanStatus } from "#/server/attendance-plan-logic";

/** The three stored rungs. `null` (no row) means "no answer" and is not a
 *  fourth value — see CONTEXT.md's Planned attendance entry.
 *
 *  An ALIAS of the seam's type, which derives from the pgEnum — never a second
 *  hand-listed copy, for the reason `attendance-plan-logic.ts` and
 *  `attendance-plan.ts` both give: #510 shipped a literal union duplicating
 *  `activity_action` and it drifted from the database. `import type` erases at
 *  compile time, so this costs the client bundle nothing and does not drag
 *  `#/db` (and `pg`, and `Buffer`) into the browser — the same type-only route
 *  six other `src/lib` modules already take into `#/server/*-logic`. */
export type PlanStatus = AttendancePlanStatus;

export interface PanelMember {
	id: string;
	name: string;
	preferredName?: string | null;
	phone: string | null;
	email: string | null;
	status: PlanStatus | null;
	/** Non-null when they hold a slot on this meeting — renders a role chip.
	 *  Information, never a bucket: a Toastmaster who has not replied is still
	 *  someone to chase. */
	roleName: string | null;
	/**
	 * ROLL mode only, and set by exactly one place: `deriveRollRoster`, which
	 * appends members who hold a recorded attendance row for this meeting but are
	 * no longer on the club's roster. Absent/false everywhere else.
	 *
	 * It exists because those appended rows carry no phone and no email — a
	 * departed member is not on the officer's roster payload — and a row with both
	 * nulled lands on `NudgeButtons`' "No contact on file" copy. For an ACTIVE
	 * member that copy is true and useful: go add a phone number. For a departed
	 * one there is nothing to add and nobody to chase, so the row skips the
	 * affordance entirely. A null-check at the render site cannot tell those two
	 * apart, which is why this is a TAG rather than a check.
	 *
	 * Plan mode never sees one: `deriveRollRoster` is roll-only, and for an
	 * UPCOMING meeting a stale row must not resurrect a departed name.
	 */
	departed?: boolean;
}

export interface PlanPanelCounts {
	coming: number;
	notComing: number;
	reachedOut: number;
	noAnswer: number;
}

/** Chase-worthy first. `null` sorts before every rung because "no answer" is
 *  the only state where nobody has done anything at all. */
/** Keyed by `PlanStatus | "null"`, NOT by `string`: a `Record<string, number>`
 *  accepts any key, so a fourth rung added to the enum would fall through the
 *  `?? 0` below and sort silently alongside "no answer". Typed this way, `tsc`
 *  demands a rank for it — the same guarantee `RUNG_LABELS` already has six
 *  lines away in the panel. */
const RUNG_ORDER: Record<PlanStatus | "null", number> = {
	null: 0,
	reached_out: 1,
	coming: 2,
	not_coming: 3,
};

export function buildPlanPanel(input: {
	roster: Omit<PanelMember, "status" | "roleName">[];
	plan: { memberId: string; status: PlanStatus }[];
	roleByMemberId: Readonly<Record<string, string>>;
}): {
	rows: PanelMember[];
	counts: PlanPanelCounts;
	countsLine: string;
} {
	const byMember = new Map(input.plan.map((p) => [p.memberId, p.status]));

	// Built from the ROSTER, never from the plan rows: an inactive member is
	// filtered upstream but their plan row survives in the table, and iterating
	// the plan would resurrect the name.
	const rows: PanelMember[] = input.roster.map((m) => ({
		...m,
		status: byMember.get(m.id) ?? null,
		roleName: input.roleByMemberId[m.id] ?? null,
	}));

	// `?? "null"` rather than `String(...)`: the latter widens the key to
	// `string`, which is what let `RUNG_ORDER` be a `Record<string, number>` and
	// silently accept a rung it has no rank for.
	const rankOf = (s: PlanStatus | null) => RUNG_ORDER[s ?? "null"];

	rows.sort((a, b) => {
		const rung = rankOf(a.status) - rankOf(b.status);
		return rung !== 0 ? rung : a.name.localeCompare(b.name);
	});

	const counts: PlanPanelCounts = {
		coming: rows.filter((r) => r.status === "coming").length,
		notComing: rows.filter((r) => r.status === "not_coming").length,
		reachedOut: rows.filter((r) => r.status === "reached_out").length,
		noAnswer: rows.filter((r) => r.status === null).length,
	};

	// Empty buckets are omitted rather than rendered as "0 out" — the line is a
	// glance, and a zero is noise in a ~340px rail.
	const countsLine = (
		[
			[counts.coming, "coming"],
			[counts.notComing, "out"],
			[counts.reachedOut, "asked"],
			[counts.noAnswer, "no answer"],
		] as const
	)
		.filter(([n]) => n > 0)
		.map(([n, label]) => `${n} ${label}`)
		.join(" · ");

	return { rows, counts, countsLine };
}
