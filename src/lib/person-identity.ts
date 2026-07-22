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
