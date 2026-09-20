/**
 * Client-safe registry of the six club role sheets (#310, #311, #719). Just the
 * keys and labels the UI and the download route need — NO `@react-pdf/renderer` and
 * NO `#/db`, so this is safe to import from client components (the visual PDF
 * layout lives in `src/server/role-sheet-layout.ts`, which pulls in react-pdf
 * and must never reach the browser bundle).
 */

/** The six role sheets, keyed by their `public/role-sheets/<key>.pdf` slug. */
export type RoleSheetKey =
	| "toastmaster"
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

/**
 * The six sheets in agenda order. `file` is the blank static PDF name.
 *
 * The Toastmaster leads, because agenda order is the order the holder first
 * speaks and the Toastmaster opens the meeting — and because this list is what
 * the printed packet collates in (`meeting-packet.ts`), so whoever is stapling
 * gets the sheet that runs the meeting off the top of the stack rather than
 * fished out of the middle. Same reasoning the poster's position already
 * carries there.
 */
export const ROLE_SHEETS: RoleSheetInfo[] = [
	{
		key: "toastmaster",
		file: "toastmaster.pdf",
		title: "Toastmaster's script",
	},
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
