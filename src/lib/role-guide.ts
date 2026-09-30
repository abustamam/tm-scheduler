/**
 * A role's "before and during the meeting" guide (#933) — pure and client-safe,
 * shared by the public roles guide, the member's own meeting page and the
 * guest variant of the `confirm` nudge.
 *
 * The text lives on `role_definitions.before_notes` / `during_notes`, seeded
 * from `ROLE_TEMPLATE` and club-editable. It is GUIDE text, never checklist
 * items: the three verifiable duties stay in `role-duties.ts`, and nothing
 * here can tick anything.
 */
import { ROLE_SHEETS, type RoleSheetInfo } from "#/data/role-sheets";

/** The fields a guide is built from — what `getPublicClubRoles` returns. */
export interface RoleGuideSource {
	name: string;
	key?: string | null;
	description: string | null;
	beforeNotes?: string | null;
	duringNotes?: string | null;
}

/**
 * What a surface renders for one role. `before` / `during` are null when the
 * club has written nothing for that half, and a surface renders NO header for
 * a null half. `description` is always carried: it is the one-line summary
 * above the guide, and the fallback when both halves are empty.
 */
export interface RoleGuide {
	description: string | null;
	before: string | null;
	during: string | null;
}

/**
 * Trimmed text, or null when blank or whitespace-only. The ONE blank-to-null
 * rule for a role's free text — `description` and both guide halves — used
 * both when a value is written (`role-definitions-logic.ts`) and when it is
 * read here, so a cleared field disappears rather than rendering an empty box.
 */
export function blankToNull(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/**
 * The longest a guide half may be. One constant for the server schema and the
 * admin form's `maxLength`, so the two cannot disagree. Room for a dozen
 * steps; the PUBLIC roles guide renders it, so it is bounded.
 */
export const ROLE_GUIDE_NOTES_MAX = 4000;

/** The two guide halves as a write: `undefined` means "leave it alone". */
export type RoleGuideNotesPatch = {
	beforeNotes?: string | null;
	duringNotes?: string | null;
};

/** The empty guide: nothing written for either half, and no description. */
export const EMPTY_ROLE_GUIDE: RoleGuide = Object.freeze({
	description: null,
	before: null,
	during: null,
});

export function roleGuide(source: RoleGuideSource): RoleGuide {
	return {
		description: blankToNull(source.description),
		before: blankToNull(source.beforeNotes),
		during: blankToNull(source.duringNotes),
	};
}

/** True when the role has any guide text at all, in either half. */
export function hasGuideText(guide: RoleGuide): boolean {
	return guide.before !== null || guide.during !== null;
}

/**
 * The stable in-page anchor for a role on `/club/$clubId/roles-guide`,
 * derived from the role's KEY (rename-proof, #368), so a nudge sent before a
 * club renamed "Timer" to "Timekeeper" still lands on the right card.
 * Underscores become hyphens so the fragment reads as a word
 * (`#ah-counter`), and anything that is not `[a-z0-9-]` is dropped so a
 * derived custom key can never break out of the fragment.
 */
export function roleGuideAnchor(key: string): string {
	return key
		.toLowerCase()
		.replace(/_/g, "-")
		.replace(/[^a-z0-9-]/g, "");
}

/**
 * Which printed role sheet (`src/data/role-sheets.ts`) belongs to a standard
 * role, by role KEY. The same six pairings `meeting-packet.ts` makes; a role
 * with no entry has no "Full script (PDF)" link. A `Map`, so a key we never
 * wrote (`constructor`, `__proto__`) resolves to nothing rather than to an
 * object property — the rule `DUTIES_BY_ROLE_KEY` states.
 */
const SHEET_BY_ROLE_KEY: ReadonlyMap<string, RoleSheetInfo["key"]> = new Map([
	["toastmaster_of_the_day", "toastmaster"],
	["timer", "timer"],
	["ah_counter", "ah-counter"],
	["grammarian", "grammarian"],
	["vote_counter", "ballot-counter"],
	["general_evaluator", "general-evaluator"],
]);

export function roleSheetForKey(
	key: string | null | undefined,
): RoleSheetInfo | undefined {
	if (!key) return undefined;
	const sheetKey = SHEET_BY_ROLE_KEY.get(key);
	return sheetKey ? ROLE_SHEETS.find((s) => s.key === sheetKey) : undefined;
}

/** The blank, public copy of a role sheet — what a guest can open. */
export function staticRoleSheetHref(sheet: RoleSheetInfo): string {
	return `/role-sheets/${sheet.file}`;
}

/** The meeting-aware copy (club name, date and speakers filled in), served
 *  publicly and archive-gated by `api/meetings.$id.role-sheets.$sheet.pdf.ts`.
 *  Takes the meeting's UUID: that route resolves no date keys. */
export function meetingRoleSheetHref(
	meetingUuid: string,
	sheet: RoleSheetInfo,
): string {
	return `/api/meetings/${encodeURIComponent(meetingUuid)}/role-sheets/${sheet.key}/pdf`;
}

/**
 * The guide row for a role a member holds: by KEY when the held role has
 * one, by exact name otherwise — the rule `matchesRole` and `clubRunsRole`
 * use, so a key-less custom role still finds its own row. Null when the club
 * no longer offers the role (a disabled role is not in the public list).
 */
export function findRoleGuideSource<T extends RoleGuideSource>(
	sources: readonly T[],
	role: { roleKey: string | null; roleName: string },
): T | null {
	if (role.roleKey) {
		return sources.find((s) => s.key === role.roleKey) ?? null;
	}
	return (
		sources.find((s) => (s.key ?? null) === null && s.name === role.roleName) ??
		null
	);
}

/**
 * The absolute roles-guide link for one role — the guest variant of the
 * `confirm` nudge (#933). A guest holder has no `?as=` identity, so their
 * draft cannot link the personal page; this sends them to the public guide,
 * scrolled to their role. A key-less role links the guide's top.
 */
export function rolesGuideUrl(args: {
	/** Absolute origin, or `""` during SSR. */
	origin: string;
	/** The club's URL segment (slug or uuid). */
	clubId: string;
	roleKey: string | null | undefined;
}): string {
	const base = `${args.origin}/club/${encodeURIComponent(args.clubId)}/roles-guide`;
	const anchor = args.roleKey ? roleGuideAnchor(args.roleKey) : "";
	return anchor ? `${base}#${anchor}` : base;
}
