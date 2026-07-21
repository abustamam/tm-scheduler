import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { toast } from "sonner";
import { AppShell, shellPropsFromContext } from "#/components/app-shell";
import { BrandMark } from "#/components/brand-mark";
import { IdentityGateProvider } from "#/components/club/identity-gate";
import { ThemeToggle } from "#/components/club/theme-toggle";
import { Button } from "#/components/ui/button";
import { Toaster } from "#/components/ui/sonner";
import { authClient } from "#/lib/auth-client";
import { resolveClubOrRedirect } from "#/lib/club-route";
import { publicShellDecision } from "#/lib/public-shell";
import { getAuthContext, setActiveClub } from "#/server/auth-context";
import { endImpersonation } from "#/server/impersonation";

export const Route = createFileRoute("/club/$clubId")({
	beforeLoad: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		// Shell-wrap for a signed-in member of the viewed club (#317): keep the app
		// chrome + session identity instead of the anonymous name-pick.
		const ctx = await getAuthContext();
		const decision = publicShellDecision(ctx, club.id);
		if (decision.switchActiveTo) {
			// Member of the viewed club, but it isn't active — switch, then re-run
			// beforeLoad so `currentMemberId`/`shell` resolve for the viewed club.
			await setActiveClub({ data: { clubId: decision.switchActiveTo } });
			// Re-run beforeLoad on the SAME url (preserves any deep sub-route +
			// search); getAuthContext now sees the viewed club active, so the
			// decision resolves to `shell` with no further switch.
			throw redirect({ href: location.href });
		}
		return {
			clubUuid: club.id,
			clubSlug: club.slug,
			clubName: club.name,
			clubNumber: club.clubNumber,
			shell: decision.shell,
			effectiveMemberId: decision.effectiveMemberId,
			authCtx: decision.shell ? ctx : null,
		};
	},
	component: ClubShell,
	notFoundComponent: ClubNotFound,
	head: () => ({
		// Member-data pages are for people you share the link with, not search
		// discovery (spec decision #5). Covers the nested index + meeting agenda.
		meta: [{ name: "robots", content: "noindex, nofollow" }],
	}),
});

function ClubShell() {
	const { clubId } = Route.useParams();
	const { clubUuid, clubName, clubNumber, shell, authCtx, effectiveMemberId } =
		Route.useRouteContext();
	const router = useRouter();
	const sessionMember =
		effectiveMemberId && authCtx?.user
			? { id: effectiveMemberId, name: authCtx.user.name || authCtx.user.email }
			: null;

	async function handleSignOut() {
		await authClient.signOut();
		await router.navigate({ to: "/signin", search: { redirect: "/" } });
	}

	async function handleExitImpersonation() {
		try {
			await endImpersonation();
			await router.navigate({ to: "/superadmin" });
			await router.invalidate();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't exit the session.",
			);
		}
	}

	// Signed-in member of this club → the full app shell, session identity known
	// (no name-pick gate).
	if (shell && authCtx) {
		return (
			<AppShell
				{...shellPropsFromContext(authCtx)}
				onSignOut={handleSignOut}
				onExitImpersonation={handleExitImpersonation}
			>
				<IdentityGateProvider
					clubUuid={clubUuid}
					clubSlug={clubId}
					sessionMember={sessionMember}
				>
					<Outlet />
				</IdentityGateProvider>
			</AppShell>
		);
	}

	// Anonymous visitor → today's lightweight header + name-pick, unchanged.
	return (
		<div className="flex min-h-svh w-full flex-col bg-background">
			<header className="flex items-center gap-3 border-b border-[var(--line)] px-4 py-3 md:px-6">
				<BrandMark size="sm" />
				<span className="min-w-0 flex-1 truncate text-right text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
					{clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				</span>
				{/* Same per-browser preference as the authed shell — shared
				    `gavelup-theme` storage, applied pre-paint in `__root.tsx`. */}
				<ThemeToggle compact />
				{/* Bridge to the full signed-in workspace (dashboard, Pathways,
				    resources) — the sign-up sheet stays usable without it. */}
				<Link
					to="/signin"
					search={{ redirect: "/" }}
					className="shrink-0 text-xs font-semibold text-muted-foreground underline underline-offset-2 hover:text-foreground"
				>
					Sign in
				</Link>
			</header>
			<IdentityGateProvider
				clubUuid={clubUuid}
				clubSlug={clubId}
				sessionMember={null}
			>
				<Outlet />
			</IdentityGateProvider>
			<Toaster position="top-center" />
		</div>
	);
}

function ClubNotFound() {
	return (
		<div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
			<p className="font-semibold text-lg">Club not found</p>
			<p className="text-muted-foreground text-sm">
				This club doesn't exist, or the link is out of date.
			</p>
			<Button asChild variant="outline">
				<Link to="/">Go home</Link>
			</Button>
		</div>
	);
}
