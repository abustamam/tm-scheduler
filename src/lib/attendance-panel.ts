// Pure derivation for the planned-attendance panel (spec D2). No React and no
// db, so the ORDER and the COUNTS — the two things a reviewer actually checks —
// are assertable directly. Through a rendered DOM neither is: two rows on the
// same rung render the same label, and a count can be right for the wrong
// reason.

/** The three stored rungs. `null` (no row) means "no answer" and is not a
 *  fourth value — see CONTEXT.md's Planned attendance entry. */
export type PlanStatus = "reached_out" | "coming" | "not_coming";

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
}

export interface PlanPanelCounts {
	coming: number;
	notComing: number;
	reachedOut: number;
	noAnswer: number;
}

/** Chase-worthy first. `null` sorts before every rung because "no answer" is
 *  the only state where nobody has done anything at all. */
const RUNG_ORDER: Record<string, number> = {
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

	rows.sort((a, b) => {
		const rung =
			(RUNG_ORDER[String(a.status)] ?? 0) - (RUNG_ORDER[String(b.status)] ?? 0);
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
