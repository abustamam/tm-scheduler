import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpen, CalendarDays } from "lucide-react";
import { PageContainer } from "#/components/page-container";
import { PathwaysProgress } from "#/components/pathways/pathways-progress";
import { formatMeetingDate } from "#/lib/format";
import { listMySpeeches } from "#/server/club";
import { listMyCommitments } from "#/server/meetings";
import { getMyPathways } from "#/server/pathways-read";

export const Route = createFileRoute("/_authed/dashboard")({
	loader: async () => {
		const [commitments, speeches, pathways] = await Promise.all([
			listMyCommitments(),
			listMySpeeches(),
			getMyPathways(),
		]);
		return { commitments, speeches, pathways };
	},
	component: Dashboard,
});

function greeting(name: string) {
	const h = new Date().getHours();
	const period = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
	const first = name.trim().split(/\s+/)[0] || name;
	return `Good ${period}, ${first}`;
}

function dayMon(value: Date | string, timeZone?: string) {
	const d = new Date(value);
	return {
		day: new Intl.DateTimeFormat(undefined, {
			day: "numeric",
			timeZone,
		}).format(d),
		mon: new Intl.DateTimeFormat(undefined, { month: "short", timeZone })
			.format(d)
			.toUpperCase(),
	};
}

function Dashboard() {
	const { authUser } = Route.useRouteContext();
	const { commitments, speeches, pathways } = Route.useLoaderData();

	return (
		<PageContainer>
			<div className="mb-5">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					{greeting(authUser.name || authUser.email)}
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Here's where you stand and what's coming up.
				</p>
			</div>

			<div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.55fr_1fr]">
				{/* Left column */}
				<div className="flex min-w-0 flex-col gap-5">
					{/* Speech log (real) */}
					<div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
						<div className="flex items-center justify-between px-5 pt-4 pb-2.5">
							<h2 className="text-sm font-bold">My speech log</h2>
							<span className="text-xs text-[var(--sea-ink-soft)]">
								{speeches.length} recent
							</span>
						</div>
						{speeches.length === 0 ? (
							<p className="border-t border-[var(--line)] px-5 py-8 text-center text-sm text-[var(--sea-ink-soft)]">
								No speeches yet. Sign up for a speaking slot to get started.
							</p>
						) : (
							speeches.map((l) => {
								const { day, mon } = dayMon(l.scheduledAt);
								return (
									<div
										key={l.slotId}
										className="grid grid-cols-[64px_1fr_auto] items-center gap-3.5 border-t border-[var(--line)] px-5 py-3 transition-colors hover:bg-[var(--foam)]"
									>
										<div className="text-center leading-[1.1]">
											<div className="font-display text-lg font-semibold">
												{day}
											</div>
											<div className="text-xs font-bold tracking-[0.05em] text-[var(--sea-ink-soft)]">
												{mon}
											</div>
										</div>
										<div className="min-w-0">
											<div className="truncate text-sm font-bold">
												{l.speechTitle ?? l.roleName}
											</div>
											<div className="truncate text-xs text-[var(--sea-ink-soft)]">
												{[l.projectName, l.pathwayPath]
													.filter(Boolean)
													.join(" · ") || l.roleName}
												{l.evaluatorName
													? ` · evaluated by ${l.evaluatorName}`
													: ""}
											</div>
										</div>
										<CompletedPill />
									</div>
								);
							})
						)}
					</div>
				</div>

				{/* Right column */}
				<div className="flex min-w-0 flex-col gap-5">
					{/* Upcoming roles (real) */}
					<div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
						<div className="px-5 pt-4 pb-2.5">
							<h2 className="text-sm font-bold">My upcoming roles</h2>
						</div>
						{commitments.length === 0 ? (
							<Link
								to="/next"
								className="block border-t border-[var(--line)] px-5 py-5 text-sm text-[var(--sea-ink-soft)] no-underline transition-colors hover:bg-[var(--foam)]"
							>
								You haven't signed up for any upcoming roles. Sign up for a
								meeting role →
							</Link>
						) : (
							commitments.map((r) => {
								const confirmed = r.status === "confirmed";
								return (
									<Link
										key={r.slotId}
										to="/next"
										className="flex items-center gap-3 border-t border-[var(--line)] px-5 py-3 no-underline transition-colors hover:bg-[var(--foam)]"
									>
										<span
											className="size-2 shrink-0 rounded-full"
											style={{ background: "var(--palm)" }}
										/>
										<div className="min-w-0 flex-1 leading-[1.25]">
											<div className="text-sm font-bold text-[var(--sea-ink)]">
												{r.roleName}
											</div>
											<div className="text-xs text-[var(--sea-ink-soft)]">
												{formatMeetingDate(r.scheduledAt, r.timezone)} ·{" "}
												{r.speechTitle ?? r.theme ?? r.clubName}
											</div>
										</div>
										<span
											className={
												confirmed
													? "shrink-0 rounded-full border border-[var(--line)] bg-[var(--foam)] px-2.5 py-1 text-xs font-bold text-[var(--sea-ink-soft)]"
													: "shrink-0 rounded-full bg-[rgba(79,184,178,.16)] px-2.5 py-1 text-xs font-bold text-[var(--lagoon-deep)]"
											}
										>
											{confirmed ? "Confirmed" : "Signed up"}
										</span>
									</Link>
								);
							})
						)}
					</div>

					{/* My Pathways progress (real, synced from Base Camp) */}
					<div>
						<h2 className="mb-2.5 px-0.5 text-sm font-bold">My Pathways</h2>
						<PathwaysProgress paths={pathways} />
					</div>

					{/* Quick actions */}
					<div className="flex flex-col gap-2">
						<QuickAction to="/next" icon={CalendarDays}>
							Sign up for a meeting role
						</QuickAction>
						<QuickAction to="/resources" icon={BookOpen}>
							Find a resource or guide
						</QuickAction>
					</div>
				</div>
			</div>
		</PageContainer>
	);
}

function CompletedPill() {
	return (
		<span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--foam)] px-2.5 py-1 text-xs font-semibold text-[var(--palm)]">
			<span className="size-1.5 rounded-full bg-[var(--palm)]" />
			Completed
		</span>
	);
}

function QuickAction({
	to,
	icon: Icon,
	children,
}: {
	to: "/next" | "/resources";
	icon: typeof CalendarDays;
	children: React.ReactNode;
}) {
	return (
		<Link
			to={to}
			className="flex items-center gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3 text-sm font-semibold text-[var(--sea-ink)] no-underline transition-colors hover:border-[var(--lagoon-deep)] hover:bg-[var(--foam)]"
		>
			<Icon className="size-5 text-[var(--lagoon-deep)]" aria-hidden />
			{children}
		</Link>
	);
}
