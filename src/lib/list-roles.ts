/**
 * "Grammarian", "Grammarian and Timer", "Grammarian, Timer, and Ah-Counter".
 *
 * `Intl.ListFormat`, not a hand-rolled join — the platform already does this and
 * three other places in this repo already use exactly these options
 * (`agenda-editor.tsx`'s `joinNames`, `meeting-template-dialog.tsx`'s
 * `joinNames`, `agenda-template-rows.ts`'s `joinHolders`). A hand-rolled version
 * shipped here first and DIVERGED: it emitted "Grammarian, Timer and Ah-Counter"
 * with no Oxford comma, so the same club's roles read one way on this page and
 * another on the agenda. Matching punctuation is the whole reason to reuse it.
 *
 * It lives in `lib/` rather than beside its one caller for the reason CLAUDE.md
 * gives: a function defined in a module that imports `#/db` at load is
 * unassertable, because a unit test importing it throws `DATABASE_URL is not
 * set`. Its first home was inside a route file, where its four cases could not
 * be tested at all.
 *
 * Deliberately NOT extracted into the three existing copies' modules:
 * `agenda-editor.tsx:54` records that the duplication is on purpose ("a shared
 * home would mean a new module for six lines that have never disagreed") and
 * counts the copies so the next person can weigh it. This module IS that shared
 * home now; folding the other three in is a separate, mechanical change.
 */
export function listRoles(names: string[]): string {
	return new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	}).format(names);
}
