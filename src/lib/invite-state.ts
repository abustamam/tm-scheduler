// Pure, client-safe derivation of a roster member's account-invite state (#266).
// No `#/db` import so it is safe to use in client route components (the roster
// grid) AND in server code. The two facts it reads both live on the Person
// (ADR-0008): `userId` (the auth link) and `invitedAt` (a sent account invite).

export type InviteState = "none" | "invited" | "joined";

/**
 * Derive the invite state shown per roster row:
 *  - "joined"  — the person is linked to a sign-in account (`userId` set). This
 *                supersedes any earlier invite.
 *  - "invited" — an account invite was sent (`invitedAt` set) but not yet
 *                accepted (still no `userId`).
 *  - "none"    — neither; the person has never been invited.
 */
export function inviteStateOf(person: {
	userId: string | null;
	invitedAt: Date | string | null;
}): InviteState {
	if (person.userId) return "joined";
	if (person.invitedAt) return "invited";
	return "none";
}
