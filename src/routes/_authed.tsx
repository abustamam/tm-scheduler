import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { CalendarDays, ClipboardList, LogOut, PlusCircle } from "lucide-react";
import { Toaster } from "#/components/ui/sonner";
import { authClient } from "#/lib/auth-client";
import { cn } from "#/lib/utils";
import { getAuthContext } from "#/server/auth-context";

export const Route = createFileRoute("/_authed")({
	beforeLoad: async ({ location }) => {
		const ctx = await getAuthContext();
		if (!ctx.user) {
			throw redirect({
				to: "/signin",
				search: { redirect: location.href },
			});
		}
		return { authUser: ctx.user, clubs: ctx.clubs };
	},
	component: AuthedLayout,
});

function AuthedLayout() {
	const { authUser, clubs } = Route.useRouteContext();
	const router = useRouter();
	const isAdmin = clubs.some(
		(c) => c.clubRole === "admin" || c.clubRole === "vpe",
	);

	async function handleSignOut() {
		await authClient.signOut();
		await router.navigate({ to: "/signin", search: { redirect: "/" } });
	}

	return (
		<div className="flex min-h-svh flex-col bg-background">
			<header className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/95 px-4 py-3 backdrop-blur">
				<div className="min-w-0">
					<p className="text-xs text-muted-foreground">
						{clubs[0]?.name ?? "Toastmasters"}
					</p>
					<p className="truncate text-sm font-medium">
						{authUser.name || authUser.email}
					</p>
				</div>
				<button
					type="button"
					onClick={handleSignOut}
					className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground"
				>
					<LogOut className="size-4" aria-hidden />
					<span>Sign out</span>
				</button>
			</header>

			<main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-24 pt-4">
				<Outlet />
			</main>

			<nav
				aria-label="Primary"
				className="fixed inset-x-0 bottom-0 z-10 border-t bg-background/95 backdrop-blur"
			>
				<div className="mx-auto flex max-w-2xl items-stretch justify-around">
					<NavTab to="/" label="Schedule" icon={CalendarDays} />
					<NavTab to="/me" label="My roles" icon={ClipboardList} />
					{isAdmin ? (
						<NavTab to="/admin/meetings/new" label="New" icon={PlusCircle} />
					) : null}
				</div>
			</nav>
			<Toaster position="top-center" />
		</div>
	);
}

function NavTab({
	to,
	label,
	icon: Icon,
}: {
	to: string;
	label: string;
	icon: typeof CalendarDays;
}) {
	return (
		<Link
			to={to}
			activeOptions={{ exact: to === "/" }}
			className="flex flex-1 flex-col items-center gap-1 py-2.5 text-xs text-muted-foreground"
			activeProps={{ "data-active": "true" }}
		>
			{({ isActive }) => (
				<span
					className={cn(
						"flex flex-col items-center gap-1",
						isActive && "text-primary",
					)}
				>
					<Icon className="size-5" aria-hidden />
					<span className="font-medium">{label}</span>
				</span>
			)}
		</Link>
	);
}
