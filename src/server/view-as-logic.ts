// The two server-side DATA downgrades "Preview as member" makes (#1113). Pure, and
// each takes an explicit `asMember` so it never reads the cookie: only the
// `createServerFn` wrappers do (`view-as-allowlist.guard.test.ts`). A preview
// can only REMOVE data here, so the wrappers apply it for any caller and any club.

/** Admin-only outreach data on the season grid: a member never gets it. */
export function seasonGridIncludesOutreach(
	isAdmin: boolean,
	asMember: boolean,
): boolean {
	return isAdmin && !asMember;
}

/**
 * What `getMinutes` shows a member of the club. `canEdit` is the stored admin
 * (or a read-write impersonation), and drops to false in a preview; with it goes
 * the admin's early look at the minutes of a meeting that is not completed.
 */
export function minutesAccess(input: {
	isAdmin: boolean;
	impersonatingReadWrite: boolean;
	asMember: boolean;
	status: string | null | undefined;
}): { canEdit: boolean; visible: boolean } {
	const canEdit =
		(input.isAdmin || input.impersonatingReadWrite) && !input.asMember;
	return { canEdit, visible: canEdit || input.status === "completed" };
}
