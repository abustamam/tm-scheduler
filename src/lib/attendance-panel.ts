// Pure derivation for the planned-attendance panel (spec D2), in three stages:
// slots → a role map keyed by member (`buildPanelRoleMap`), plan + roster →
// rows under the assumed/precedence rule, and rows → counts/countsLine
// (`buildPlanPanel`). No React and no db, so the ROLE ASSIGNED, the PRECEDENCE
// applied, the ORDER, and the COUNTS — the things a reviewer actually
// checks — are all assertable directly. Through a rendered DOM none of them
// is: two rows on the same rung render the same label, a badge can carry the
// wrong number with no error, an assumed Coming looks identical to a real one,
// and a count can be right for the wrong reason.

import { buildShortCodes } from "#/lib/agenda";
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

/** The role slot a member holds on this meeting, as the rail needs it. */
export interface PanelRole {
	/** The sign-up sheet's short code — "TD", "GE", "SP1". Produced by
	 *  `buildShortCodes` (`#/lib/agenda`), the season grid's own function, so this
	 *  uses the SAME ABBREVIATION VOCABULARY as the sign-up sheet — never a second
	 *  hand-maintained list. That does NOT guarantee an identical numeric suffix:
	 *  `buildShortCodes` derives repeat-numbering ("SP1"/"SP2") and collision
	 *  suffixes ("#2") from the row set it is fed, and the grid feeds it a
	 *  user-selectable WINDOW of meetings (`?count=`) while the route that builds
	 *  this feeds it only the one meeting's slots — so the same role can render
	 *  "SP" here and "SP1" there. Deliberate: per-meeting numbering is the
	 *  meaningful answer on a meeting page, and the full role name stays
	 *  available via `roleName` below (the badge's `title` / sr-only text), so
	 *  nothing is lost when the suffix diverges. */
	code: string;
	/** The role's BASE name, for the outreach draft ("you're our Toastmaster")
	 *  and for the badge's tooltip. Deliberately NOT the numbered label: "you're
	 *  our Speaker 1" reads as a mail merge, and the agenda's own slot-card nudge
	 *  already uses the base name for the same reason. */
	roleName: string;
	/** The slot's status is `confirmed` — they said yes to the ROLE, which this
	 *  panel reads as saying yes to the meeting. */
	confirmed: boolean;
}

/**
 * The rail's role map for one meeting's slots, keyed by MEMBER id.
 *
 * Lives here rather than inline in the route for the reason this whole module
 * does: a route cannot be mounted in vitest, so a derivation there is guarded
 * only by source greps — and mutation review found two bugs that pass every
 * one of those greps and a clean typecheck. Keying by slot id instead of
 * member id would break the rail completely (no badge renders anywhere);
 * filtering `slots` before `buildShortCodes` would only silently renumber the
 * badges as the week's slots fill. As a seam both are directly assertable.
 */
export function buildPanelRoleMap(
	slots: readonly {
		// Deliberately omits `role_slots.id`: this map is keyed by member, and the
		// omission makes `byMember[s.id]` a compile error.
		roleDefinitionId: string;
		slotIndex: number;
		roleName: string;
		status: "open" | "claimed" | "confirmed";
		assigneeId: string | null;
	}[],
): Record<string, PanelRole> {
	// EVERY slot, assigned or not. `buildShortCodes` decides "SP" vs "SP1" from
	// how many slots a role definition HAS, so filtering to assigned slots would
	// renumber the badges as the week's slots fill.
	const shortCodes = buildShortCodes(
		slots.map((s) => ({
			roleDefinitionId: s.roleDefinitionId,
			slotIndex: s.slotIndex,
			name: s.roleName,
		})),
	);
	const byMember: Record<string, PanelRole> = {};
	for (const s of slots) {
		if (!s.assigneeId) continue;
		const existing = byMember[s.assigneeId];
		if (existing) {
			// Double-booking is deliberate product behaviour (see `agenda.ts`'s
			// "still assignable" note). The FIRST slot keeps the label — `slots`
			// arrives ordered by the role's `sortOrder`, so that is the more
			// prominent role — but `confirmed` is the OR across all of them,
			// because someone confirmed for ANY role on this meeting is attending
			// it. Plain last-write-wins cost only a wrong LABEL on the string map;
			// on this one it would drop a confirmed member out of the coming COUNT.
			byMember[s.assigneeId] = {
				...existing,
				confirmed: existing.confirmed || s.status === "confirmed",
			};
			continue;
		}
		byMember[s.assigneeId] = {
			// Unreachable — the same rows built the map. It is `Map.get`'s type
			// obligation, and is byte-identical to `season-grid-logic.ts`'s.
			code: shortCodes.get(`${s.roleDefinitionId}:${s.slotIndex}`) ?? "?",
			// The BASE role name, not `slotLabel` — the draft says "you're our
			// Speaker", never "you're our Speaker 1".
			roleName: s.roleName,
			confirmed: s.status === "confirmed",
		};
	}
	return byMember;
}

/** What a ROW carries. `confirmed` is deliberately absent: on the way out it is
 *  a second answer to the question `assumed` already answers, and the two
 *  disagree for a `not_coming` member holding a confirmed slot. Reading
 *  `role.confirmed` downstream would resurrect the bug this module closes. */
export type PanelRowRole = Omit<PanelRole, "confirmed">;

export interface PanelMember {
	id: string;
	name: string;
	preferredName?: string | null;
	phone: string | null;
	email: string | null;
	/** The EFFECTIVE rung after the precedence rule below — not necessarily the
	 *  stored one. Counts and sort both read this, which is what makes an assumed
	 *  Coming a real Coming everywhere without a second code path. */
	status: PlanStatus | null;
	/** The rung this member's plan row carries, as supplied in `plan`, before
	 *  precedence is applied. This function has no database view — it reports
	 *  whatever the caller passed. The production caller
	 *  (`meeting-attendance-panel.tsx`) builds `plan` from an OPTIMISTICALLY
	 *  OVERRIDDEN `rungOverride` before calling in, so during an in-flight write
	 *  this reflects the override rather than the committed row — which is the
	 *  intended value for the use below, the same reason the override is
	 *  applied before `buildPlanPanel` at all. `status` is the EFFECTIVE rung
	 *  and is what sort and counts read; this field is what a caller needs to
	 *  answer "is there a row to clear?". An assumed Coming can sit on top of a
	 *  stored `reached_out` — the officer messaged a confirmed Toastmaster —
	 *  and clearing that is a real write with a real activity-log entry even
	 *  though the EFFECTIVE status does not move. Its consumer is the rail's
	 *  status control, which renders the stored rung beside the inferred one
	 *  ("Coming · asked"); without that, picking "Asked" or "No answer" on such
	 *  a row round-tripped to an unchanged label and read as a failed save. */
	storedStatus: PlanStatus | null;
	/** True when `status` is "coming" because the member holds a CONFIRMED role
	 *  and nobody actually answered. An inference, not their word — the row has
	 *  to render it differently or the rail is lying about who replied. */
	assumed: boolean;
	/** Non-null when they hold a slot on this meeting. */
	role: PanelRowRole | null;
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
	roster: Omit<PanelMember, "status" | "storedStatus" | "assumed" | "role">[];
	plan: { memberId: string; status: PlanStatus }[];
	roleByMemberId: Readonly<Record<string, PanelRole>>;
}): {
	rows: PanelMember[];
	counts: PlanPanelCounts;
	countsLine: string;
} {
	const byMember = new Map(input.plan.map((p) => [p.memberId, p.status]));

	// Built from the ROSTER, never from the plan rows: an inactive member is
	// filtered upstream but their plan row survives in the table, and iterating
	// the plan would resurrect the name.
	const rows: PanelMember[] = input.roster.map((m) => {
		const stored = byMember.get(m.id) ?? null;
		const role = input.roleByMemberId[m.id] ?? null;
		// PRECEDENCE, in one expression:
		//
		//   explicit coming / not_coming  →  that answer   (their own word wins)
		//   role slot status = confirmed  →  "coming", assumed
		//   stored reached_out            →  "reached_out"
		//   nothing                       →  null
		//
		// A confirmed role outranking `reached_out` is not a style choice. A
		// member the VPE assigned and confirmed has no plan row, so tapping their
		// WhatsApp draft INSERTS `reached_out` — `setPlanStatus`'s
		// `demoteFrom: ["reached_out"]` guard is a `setWhere` on the conflict
		// branch, and with no existing row there is no conflict, so the insert
		// lands. Ranked the other way, an officer confirms a Toastmaster,
		// messages them, and watches them fall from Coming back to Asked.
		// Ordering it here fixes that with no write change, and keeps the
		// `reached_out` row, which is a true record of having messaged them.
		const answered = stored === "coming" || stored === "not_coming";
		const assumed = !answered && role?.confirmed === true;
		return {
			...m,
			status: assumed ? "coming" : stored,
			storedStatus: stored,
			assumed,
			role: role ? { code: role.code, roleName: role.roleName } : null,
		};
	});

	// `?? "null"` rather than `String(...)`: the latter widens the key to
	// `string`, which is what let `RUNG_ORDER` be a `Record<string, number>` and
	// silently accept a rung it has no rank for.
	const rankOf = (s: PlanStatus | null) => RUNG_ORDER[s ?? "null"];

	rows.sort((a, b) => {
		const rung = rankOf(a.status) - rankOf(b.status);
		return rung !== 0 ? rung : a.name.localeCompare(b.name);
	});

	// Both of these read the EFFECTIVE status, so an assumed Coming is a Coming
	// here too. That is the point of resolving precedence once, above.
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
