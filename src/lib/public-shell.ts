/** The shell-wrap decision for a public route, from the auth-context result and
 *  the club whose URL is being viewed. Pure — the route acts on the result. */
export interface AuthContextLite {
	user: { id: string } | null;
	clubs: readonly { clubId: string }[];
	currentMemberId: string | null;
	activeClubId: string | null;
}

export interface ShellDecision {
	/** Render <AppShell> (signed-in member of the viewed club, and it's active). */
	shell: boolean;
	/** The session member id to act as (non-null only when `shell`). */
	effectiveMemberId: string | null;
	/** A club id to switch the active club to first, then re-resolve (a member of
	 *  a non-active viewed club); null when no switch is needed. */
	switchActiveTo: string | null;
}

export function publicShellDecision(
	ctx: AuthContextLite,
	viewedClubId: string,
): ShellDecision {
	const memberOfViewed =
		!!ctx.user && ctx.clubs.some((c) => c.clubId === viewedClubId);
	if (!memberOfViewed) {
		return { shell: false, effectiveMemberId: null, switchActiveTo: null };
	}
	if (ctx.activeClubId !== viewedClubId) {
		// Member of the viewed club, but it isn't active — switch, then the route
		// re-runs and currentMemberId resolves for the viewed club.
		return {
			shell: false,
			effectiveMemberId: null,
			switchActiveTo: viewedClubId,
		};
	}
	return {
		shell: true,
		effectiveMemberId: ctx.currentMemberId,
		switchActiveTo: null,
	};
}
