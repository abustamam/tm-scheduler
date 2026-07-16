// Where a signed-in visitor to the public landing (`/`) should be sent. Client-
// safe (no `#/db`) so the landing route's beforeLoad and tests can share it.

/** The two in-app "home" destinations a signed-in user is routed to. */
export type HomePath = "/officers" | "/roster";

/**
 * Role-aware home for a signed-in user hitting `/`. Officers (a stored `admin`
 * club role OR any elected office) get the Officer home; everyone else lands on
 * the roster. Mirrors the `isOfficer` rule in the authed shell (`_authed.tsx`).
 */
export function homeRedirectTarget(input: {
	clubRole: string | null | undefined;
	officerCount: number;
}): HomePath {
	const isOfficer = input.clubRole === "admin" || input.officerCount > 0;
	return isOfficer ? "/officers" : "/roster";
}
