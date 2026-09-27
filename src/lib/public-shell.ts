/** The shell-wrap decision for a public route, from the auth-context result and
 *  the club whose URL is being viewed. Pure — the route acts on the result. */
export interface AuthContextLite {
	/** `name` / `email` are read only by `sessionMemberFor`, for the label. */
	user: { id: string; name?: string | null; email?: string | null } | null;
	clubs: readonly { clubId: string }[];
	currentMemberId: string | null;
	activeClubId: string | null;
}

export interface ShellDecision {
	/** Render <AppShell> (signed-in member of the viewed club, and it's active).
	 *  NOT a session flag — false for a signed-in non-member too. A gate asking
	 *  "is anyone signed in" wants `hasSession` off the `/club/$clubId` route
	 *  context instead (#769); reading this one loops them through /signin. */
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

/**
 * The signed-in member of the viewed club, as the identity a page acts as — or
 * null when there is none (signed out, a non-member, or a member whose active
 * club is another one and has not been switched yet).
 *
 * The club shell's `sessionMember` (`club.$clubId.tsx`) is this same
 * expression over `publicShellDecision`; it is stated here for the routes that
 * ESCAPE the shell and so never receive its route context — the digital ballot
 * first (#962), which resolves the session on the client rather than in its
 * loader. Built on `publicShellDecision` rather than beside it, so "who counts
 * as a signed-in member of this club" has one definition.
 */
export function sessionMemberFor(
	ctx: AuthContextLite,
	viewedClubId: string,
): { id: string; name: string } | null {
	const decision = publicShellDecision(ctx, viewedClubId);
	// `effectiveMemberId` is non-null only when `shell` is, so it is the whole
	// test; `ctx.user` is implied by it and checked for the type.
	if (!decision.effectiveMemberId || !ctx.user) return null;
	return {
		id: decision.effectiveMemberId,
		// `||`, not `??`: `user.name` is `""` in production for a magic-link user.
		name: ctx.user.name || ctx.user.email || "you",
	};
}
