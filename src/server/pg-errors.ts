/**
 * SQLSTATE predicates, in ONE place.
 *
 * These lived inline in `meeting-agenda-edit-logic.ts`, and `voting-logic.ts`
 * grew its own copy of the 23505 check independently — with its own comment
 * recording the same discovery, that reading only the top-level `code` silently
 * never matches. A predicate whose whole job is to be right about where the
 * driver hangs the code is the wrong thing to have three of.
 *
 * Deliberately NOT importing anything from `pg` or `drizzle-orm`: these are
 * shape checks over an unknown, so this module is a leaf and any server module
 * can import it without a cycle.
 */

/** SQLSTATE `code`, wherever the driver hung it: drizzle wraps a `pg` error as
 *  the `cause` of its own, and a bare `pg` error carries `code` itself. Walks
 *  the whole `cause` chain rather than one level, since a driver failure can be
 *  re-wrapped (`voting-logic.ts` found this the hard way — reading only the top
 *  level matched nothing and showed an officer the raw parameterised query). */
export function isSqlState(err: unknown, code: string): boolean {
	let seen = err;
	for (let depth = 0; seen != null && depth < 8; depth++) {
		if ((seen as { code?: unknown }).code === code) return true;
		const next = (seen as { cause?: unknown }).cause;
		if (next === seen) break;
		seen = next;
	}
	return false;
}

/** SQLSTATE 23505 — a unique index rejected an insert. */
export function isUniqueViolation(err: unknown): boolean {
	return isSqlState(err, "23505");
}

/** SQLSTATE 40P01 — Postgres chose this transaction as a deadlock victim. */
export function isDeadlock(err: unknown): boolean {
	return isSqlState(err, "40P01");
}
