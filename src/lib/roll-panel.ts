// Pure derivation for the attendance panel in ROLL mode (spec D2/D3). No React
// and no db, so the sort, the suggestion mapping and the counts are assertable
// directly — through a rendered DOM none of them are, because two rows on the
// same status render the same chip and a count can be right for the wrong
// reason.
//
// Sibling to `attendance-panel.ts` rather than a mode flag inside it: the two
// modes share no sort, no counts and no row shape, so one function with a flag
// would be two functions wearing one name.

import {
	type PanelRole,
	type PanelRowRole,
	type PlanStatus,
	resolveEffectiveRung,
} from "#/lib/attendance-panel";
import type { AttendanceStatus } from "#/server/minutes-logic";

/** What the plan SUGGESTS for a member with no attendance row yet. `null` means
 *  the plan says nothing useful — `reached_out` is an ask, not an answer. */
export type RollSuggestion = Extract<AttendanceStatus, "present" | "excused">;

export interface RollRow {
	id: string;
	name: string;
	phone: string | null;
	email: string | null;
	/** A member's goes-by name — "Abdul-Rasheed Bustamam" who goes by Rasheed
	 *  cannot be greeted right by splitting the stored name. Rendered instead of
	 *  `name` when present (#486). */
	preferredName: string | null;
	/** The RECORDED status, or null when nobody has recorded one. */
	status: AttendanceStatus | null;
	/** Non-null only when `status` is null. Renders dashed; tapping it writes the
	 *  real row. A row can never carry both — that is what makes a plan
	 *  physically unmistakable for a record (D3, the guard against #548). */
	suggestion: RollSuggestion | null;
	/** True when `suggestion` comes from an INFERENCE rather than an answer: the
	 *  member holds a confirmed role on this meeting and never replied, so the rail
	 *  reads them `Coming · assumed` and roll mode suggests `Present?` from the
	 *  same rule (`resolveEffectiveRung`, #664). Always false when `suggestion` is
	 *  null. The renderer must not announce this as "the plan suggests" — nobody
	 *  planned anything — which is what this flag exists to let it say. */
	suggestionAssumed: boolean;
	/** Information, never a bucket: the Timer still needs marking present.
	 *
	 *  The ROW carries the short code as well as the name, because the rail's
	 *  shared identity line renders the code (`PanelIdentityLine`). It was
	 *  `roleName: string | null` and the badge rendered the full name — a
	 *  `shrink-0 whitespace-nowrap` block ~136px wide for "Toastmaster of the Day"
	 *  in a ~292px column, which is what pushed the rest of the row out. Same
	 *  `PanelRowRole` plan mode's rows carry, so `confirmed` stays stripped: it is
	 *  a second answer to a question `assumed` already answers — and roll mode's
	 *  copy of that answer is `suggestionAssumed`, resolved once from the map's
	 *  value before the row is built. */
	role: PanelRowRole | null;
	/** True for a row appended by `deriveRollRoster`: someone with a recorded
	 *  attendance row who has since left the roster. Their row skips the contact
	 *  affordance — see `PanelMember.departed` for why that is a tag and not a
	 *  `phone === null && email === null` check. NORMALISED to a boolean here (the
	 *  roster's field is optional) so the renderer has one thing to read. */
	departed: boolean;
}

export interface RollCounts {
	present: number;
	absent: number;
	excused: number;
	unmarked: number;
}

/** D3's mapping, in one place. `coming → Present?`, `not_coming → Excused?`,
 *  anything else → no suggestion. */
function suggest(plan: PlanStatus | null): RollSuggestion | null {
	if (plan === "coming") return "present";
	if (plan === "not_coming") return "excused";
	return null;
}

/** `PanelRole` → what a ROW carries. Drops `confirmed` rather than spreading the
 *  map's value through, for the reason `PanelRowRole`'s own docstring gives. */
function roleRow(role: PanelRole | undefined): PanelRowRole | null {
	return role ? { code: role.code, roleName: role.roleName } : null;
}

export function buildRollPanel(input: {
	roster: {
		id: string;
		name: string;
		phone: string | null;
		email: string | null;
		preferredName?: string | null;
		departed?: boolean;
	}[];
	attendance: { memberId: string; status: AttendanceStatus }[];
	plan: { memberId: string; status: PlanStatus }[];
	roleByMemberId: Readonly<Record<string, PanelRole>>;
}): { rows: RollRow[]; counts: RollCounts; countsLine: string } {
	const recorded = new Map(input.attendance.map((a) => [a.memberId, a.status]));
	const planned = new Map(input.plan.map((p) => [p.memberId, p.status]));

	// Built from the ROSTER, never from the attendance rows: an inactive member is
	// filtered upstream but their row survives in the table, and iterating
	// attendance would resurrect the name.
	const rows: RollRow[] = input.roster.map((m) => {
		const status = recorded.get(m.id) ?? null;
		const role = input.roleByMemberId[m.id];
		// The EFFECTIVE rung, from the same rule the rail uses, so a confirmed
		// role-holder who never replied reads `Coming · assumed` on Monday and gets
		// a dashed `Present?` on Wednesday (#664). Before, this read the raw rung
		// and roll mode disagreed with plan mode about the same word. It is still
		// only a SUGGESTION — nothing is written until the officer taps it, and the
		// counts below never include it.
		const effective = resolveEffectiveRung(planned.get(m.id) ?? null, role);
		// Mutually exclusive by construction, not by convention.
		const suggestion = status === null ? suggest(effective.status) : null;
		return {
			...m,
			preferredName: m.preferredName ?? null,
			departed: m.departed ?? false,
			status,
			suggestion,
			suggestionAssumed: suggestion !== null && effective.assumed,
			role: roleRow(role),
		};
	});

	// Alphabetical, so a row does not move because someone tapped it. Roll call is
	// read down a register; plan mode's chase-worthy-first order would make the
	// list reorder under the officer's finger.
	rows.sort((a, b) => a.name.localeCompare(b.name));

	// REAL rows only. A suggestion is not a record, so it counts as unmarked.
	const counts: RollCounts = {
		present: rows.filter((r) => r.status === "present").length,
		absent: rows.filter((r) => r.status === "absent").length,
		excused: rows.filter((r) => r.status === "excused").length,
		unmarked: rows.filter((r) => r.status === null).length,
	};

	const countsLine = (
		[
			[counts.present, "present"],
			[counts.absent, "absent"],
			[counts.excused, "excused"],
			[counts.unmarked, "unmarked"],
		] as const
	)
		.filter(([n]) => n > 0)
		.map(([n, label]) => `${n} ${label}`)
		.join(" · ");

	return { rows, counts, countsLine };
}
