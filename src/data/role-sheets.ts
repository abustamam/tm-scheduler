/**
 * Client-safe registry of the five club role sheets (#310, #311). Just the keys
 * and labels the UI and the download route need — NO `@react-pdf/renderer` and
 * NO `#/db`, so this is safe to import from client components (the visual PDF
 * layout lives in `src/server/role-sheet-layout.ts`, which pulls in react-pdf
 * and must never reach the browser bundle).
 */

/** The five role sheets, keyed by their `public/role-sheets/<key>.pdf` slug. */
export type RoleSheetKey =
	| "timer"
	| "ah-counter"
	| "grammarian"
	| "ballot-counter"
	| "general-evaluator";

export interface RoleSheetInfo {
	key: RoleSheetKey;
	/** `public/role-sheets/<file>` for the blank static copy. */
	file: string;
	/** Sheet title (matches the on-page title and the resources download label). */
	title: string;
}

/** The five sheets in agenda order. `file` is the blank static PDF name. */
export const ROLE_SHEETS: RoleSheetInfo[] = [
	{ key: "timer", file: "timer.pdf", title: "Timer's log" },
	{ key: "ah-counter", file: "ah-counter.pdf", title: "Ah-Counter's log" },
	{ key: "grammarian", file: "grammarian.pdf", title: "Grammarian's log" },
	{
		key: "ballot-counter",
		file: "ballot-counter.pdf",
		title: "Ballot / Vote Counter tally",
	},
	{
		key: "general-evaluator",
		file: "general-evaluator.pdf",
		title: "General Evaluator notes",
	},
];

/** Look up a sheet by its key, or `undefined` for an unknown key. */
export function roleSheetByKey(key: string): RoleSheetInfo | undefined {
	return ROLE_SHEETS.find((r) => r.key === key);
}
