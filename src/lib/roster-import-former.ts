/**
 * Flag preview rows that name a FORMER member (#1328). Pure, db-free.
 *
 * `buildImportPreview` runs against the roster, which excludes former members,
 * so a former member's name previewed green and then failed on the server
 * (which dedupes against every membership). The roster page knows the former
 * list (an admin's), so it passes it here after building the preview: a row that
 * clears the roster check but matches a former member's name is blocked, with a
 * reason that says what to do instead.
 */
import type { PreviewRow } from "#/lib/roster-import";

export type PreviewRowWithFormer = PreviewRow & {
	/** True when the row's name matches a former member (and no current one). */
	former: boolean;
};

export const FORMER_MEMBER_LABEL = "Former member";
export const FORMER_MEMBER_MESSAGE =
	"A former member has that name: reactivate them from “Former members” instead.";

export function flagFormerMatches(
	preview: PreviewRow[],
	formerNames: string[],
): PreviewRowWithFormer[] {
	const former = new Set(
		formerNames.map((n) => n.trim().toLowerCase()).filter(Boolean),
	);
	return preview.map((row) => {
		const key = row.name.trim().toLowerCase();
		// A row already a duplicate of a current member or the batch keeps that
		// reason; only one that would have gone green is re-judged.
		if (!key || row.issues.includes("duplicate") || !former.has(key)) {
			return { ...row, former: false };
		}
		return {
			...row,
			issues: [...row.issues, "duplicate"],
			willImport: false,
			former: true,
		};
	});
}
