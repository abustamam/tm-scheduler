/**
 * Officer position — a Person's elected club job on a Membership (#63). A fixed
 * enum of the standard Toastmasters club officers, replacing the old free-text
 * `office`. Nullable everywhere (null = no office). This module is the single
 * source of truth for the enum values, their display labels, their canonical
 * ordering (President first, down to Immediate Past President), and the tolerant
 * free-text → enum parser used by the CSV import and the VPE bulk-paste import.
 *
 * No `#/db` import here — pure and safe in the client bundle.
 */

/**
 * Canonical Toastmasters club-officer line-up, in display order. This array's
 * order IS the sort order (President first). Kept in lockstep with the
 * `officer_position` pg enum in `src/db/schema.ts`.
 */
export const OFFICER_POSITIONS = [
	"president",
	"vp_education",
	"vp_membership",
	"vp_public_relations",
	"secretary",
	"treasurer",
	"sergeant_at_arms",
	"immediate_past_president",
] as const;

export type OfficerPosition = (typeof OFFICER_POSITIONS)[number];

/** Human-readable labels for each officer position. */
export const OFFICER_POSITION_LABELS: Record<OfficerPosition, string> = {
	president: "President",
	vp_education: "VP Education",
	vp_membership: "VP Membership",
	vp_public_relations: "VP Public Relations",
	secretary: "Secretary",
	treasurer: "Treasurer",
	sergeant_at_arms: "Sergeant at Arms",
	immediate_past_president: "Immediate Past President",
};

/** Type guard: is this string one of the officer-position enum values? */
export function isOfficerPosition(value: unknown): value is OfficerPosition {
	return (
		typeof value === "string" &&
		(OFFICER_POSITIONS as readonly string[]).includes(value)
	);
}

/** Display label for an officer position (or a stored enum value). */
export function officerPositionLabel(position: OfficerPosition): string {
	return OFFICER_POSITION_LABELS[position];
}

/**
 * Sort key for an officer position — its index in the canonical line-up. Lower
 * sorts earlier (President = 0). Used to order the printable agenda's officer
 * grid President → Immediate Past President.
 */
export function officerRank(position: OfficerPosition): number {
	return OFFICER_POSITIONS.indexOf(position);
}

/**
 * Offices that default a membership's `club_role` to `admin` (ADR-0008 Phase B /
 * #99). President and VP Education run the club's education program and manage
 * the schedule, so a membership holding either is an admin by default.
 */
const ADMIN_OFFICES: readonly OfficerPosition[] = ["president", "vp_education"];

/**
 * Default `club_role` for a membership given its current open offices. Returns
 * `"admin"` when the membership holds President or VP Education, else `"member"`.
 * This is the DEFAULT applied where an account/membership is created or linked;
 * the stored `club_role` is authoritative thereafter (not re-derived on read).
 */
export function defaultClubRoleForOffices(
	positions: readonly OfficerPosition[],
): "admin" | "member" {
	return positions.some((p) => ADMIN_OFFICES.includes(p)) ? "admin" : "member";
}

/**
 * Parse a free-text office string (CSV "Current Position", a pasted roster
 * column, or the old free-text `office`) into an officer-position enum value, or
 * `null` when blank or unrecognized. Case-insensitive and tolerant of the
 * Toastmasters export's "Club …" prefixes and common abbreviations
 * ("VPE", "VP PR", "SAA"). VP roles and Immediate Past President are matched
 * before the bare "President" rule so they aren't swallowed by it.
 *
 * A non-blank string that matches nothing returns `null` — callers treat that as
 * "unparseable" and log a warning (mirrors the import's ambiguous-name skip).
 */
export function parseOfficerPosition(
	value: string | null | undefined,
): OfficerPosition | null {
	const o = (value ?? "").trim().toLowerCase();
	if (o === "") return null;

	// Immediate Past President before the plain "president" rule.
	if (/past.?president|\bipp\b/.test(o)) return "immediate_past_president";

	// VP roles before the plain "president" rule (a VP is not the President).
	if (/vp.*edu|vice.?president.*edu|\bvpe\b/.test(o)) return "vp_education";
	if (/vp.*mem|vice.?president.*mem|\bvpm\b/.test(o)) return "vp_membership";
	if (/vp.*(pub|pr)|vice.?president.*(pub|rel)|\bvppr\b/.test(o)) {
		return "vp_public_relations";
	}

	// Plain President — only when it's not a VP / past-president variant.
	if (/president/.test(o) && !/vice|vp\b/.test(o)) return "president";

	if (/secretar/.test(o)) return "secretary";
	if (/treasur/.test(o)) return "treasurer";
	if (/sergeant|sgt|\barms\b|\bsaa\b/.test(o)) return "sergeant_at_arms";

	return null;
}
