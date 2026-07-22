/**
 * A Person considered as a merge/dedupe keeper. `historyCount` is speeches +
 * Pathways enrollments; `linked` is whether people.user_id is set.
 */
export interface KeeperCandidate {
	id: string;
	linked: boolean;
	historyCount: number;
	originalJoinDate: Date | null;
}

/**
 * The canonical "which Person is the real human" ordering, shared by create-club
 * dedupe (Part A) and the merge keeper default (Part B/C):
 *   login-linked  →  most history  →  oldest original join  →  id (stable).
 * Pure: returns the best candidate without mutating the input.
 */
export function pickKeeper<T extends KeeperCandidate>(
	candidates: T[],
): T | null {
	if (candidates.length === 0) return null;
	const rank = (x: KeeperCandidate) =>
		x.originalJoinDate?.getTime() ?? Infinity;
	return [...candidates].sort((a, b) => {
		if (a.linked !== b.linked) return a.linked ? -1 : 1;
		if (a.historyCount !== b.historyCount)
			return b.historyCount - a.historyCount;
		const ja = rank(a);
		const jb = rank(b);
		if (ja !== jb) return ja - jb; // older join (smaller time) first
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	})[0];
}

/**
 * The earlier of two nullable dates (null = unknown, treated as "no lower
 * bound"). Shared by `membership-collapse-logic.ts` (joined_at reconcile) and
 * `people-merge-logic.ts` (original_join_date reconcile) so the two byte-
 * identical local copies don't drift apart.
 */
export function earliestDate(a: Date | null, b: Date | null): Date | null {
	if (!a) return b;
	if (!b) return a;
	return a < b ? a : b;
}

/**
 * Does the absorbed person's enrollment survive as the keeper's on a shared
 * path? `keeper: null` means the keeper isn't enrolled in that path (the
 * absorbed's enrollment always moves in that case). Mirrors the merge's
 * keep-more-progressed rule: more approved levels wins, ties broken by the
 * fresher `lastSyncedAt`. Shared by `mergeEnrollments` (the write path in
 * `people-merge-logic.ts`) and `getMergePreview` (the read-only preview in
 * `people-logic.ts`) so the preview can never overstate what a merge will do.
 */
export function absorbedEnrollmentMoves(
	absorbed: { approved: number; lastSyncedAt: Date },
	keeper: { approved: number; lastSyncedAt: Date } | null,
): boolean {
	if (keeper === null) return true;
	return (
		absorbed.approved > keeper.approved ||
		(absorbed.approved === keeper.approved &&
			absorbed.lastSyncedAt > keeper.lastSyncedAt)
	);
}
