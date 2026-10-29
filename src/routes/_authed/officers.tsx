import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import {
	CHARTER_DASHBOARD_COPY,
	CharterProgress,
} from "#/components/club/charter-dashboard";
import { OnboardingChecklist } from "#/components/club/onboarding-checklist";
import { PageContainer } from "#/components/page-container";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { navDestination } from "#/lib/nav-destinations";
import {
	buildOfficerHome,
	type OfficerTask,
	officerTaskTitle,
} from "#/lib/officer-tasks";
import { firstNameOf } from "#/lib/person-name";
import { getCharterSummary } from "#/server/charter";
import type { CharterSummary } from "#/server/charter-logic";
import { getOnboardingChecklist } from "#/server/onboarding-checklist";

export const Route = createFileRoute("/_authed/officers")({
	// Officer home is for effective admins (#202): a stored `admin` club role OR
	// anyone holding an elected office — mirrors `isOfficer` in `_authed.tsx` and
	// `homeRedirectTarget` (`#/lib/home-route`). A freshly-provisioned first admin
	// has no elected office yet, so gating on `officerPositions` alone bounced
	// them straight back out before they ever saw the setup checklist
	// (#265) — `effectiveAdminClub` is the fix, consistent with every other
	// admin-gated route (club-settings, schedule, …). Non-officers go to their
	// dashboard (#542), the member home — this is also the default post-sign-in
	// path (signin.tsx sends everyone here first).
	beforeLoad: ({ context }) => {
		const adminClub = effectiveAdminClub(context);
		if (!adminClub) {
			throw redirect({ to: "/dashboard" });
		}
		return { adminClub };
	},
	loader: async ({ context }) => {
		const [checklist, charter] = await Promise.all([
			getOnboardingChecklist({ data: context.adminClub.clubId }),
			// The charter card (#943) is null for a chartered club, and a failure
			// here must not blank the officer home, so it degrades to no card.
			getCharterSummary({ data: { clubId: context.adminClub.clubId } }).catch(
				() => null,
			),
		]);
		return { checklist, charter };
	},
	component: OfficerHome,
});

function OfficerHome() {
	const { authUser, officerPositions, adminClub } = Route.useRouteContext();
	const { checklist, charter } = Route.useLoaderData();
	const { common, sections } = buildOfficerHome([...officerPositions]);
	const firstName = firstNameOf(authUser.name || authUser.email);

	return (
		<PageContainer className="space-y-8">
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					{navDestination("officer-home").label}
				</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Hi {firstName} — here's where to go to run the club.
				</p>
			</div>

			<OnboardingChecklist clubId={adminClub.clubId} status={checklist} />

			{charter ? <CharterCard summary={charter} /> : null}

			<TaskSection title="Everyday" tasks={common} />

			{sections.map((s) => (
				<TaskSection key={s.position} title={`As ${s.label}`} tasks={s.tasks} />
			))}
		</PageContainer>
	);
}

/** Shown only while the club is chartering (#943); links to the dashboard. */
function CharterCard({ summary }: { summary: CharterSummary }) {
	return (
		<Link
			to="/admin/charter"
			data-testid="charter-card"
			className="group block space-y-3 rounded-xl border border-border bg-surface-raised px-4 py-4 shadow-[0_8px_20px_rgba(23,58,64,.05)] outline-none transition-colors hover:border-link-fill focus-visible:ring-[3px] focus-visible:ring-ring/50"
		>
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<div className="text-sm font-bold text-foreground">
						{CHARTER_DASHBOARD_COPY.title}
					</div>
					<div className="text-xs text-muted-foreground">
						{summary.periodPicked
							? `Paid members toward charter. Checklist: ${summary.stepsDone} of ${summary.stepsTotal} done.`
							: CHARTER_DASHBOARD_COPY.pickPeriod}
					</div>
				</div>
				<ChevronRight
					className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
					aria-hidden
				/>
			</div>
			<CharterProgress
				paid={summary.paidCount}
				needed={summary.membersNeeded}
			/>
		</Link>
	);
}

function TaskSection({
	title,
	tasks,
}: {
	title: string;
	tasks: OfficerTask[];
}) {
	return (
		<section className="space-y-3">
			<h2 className="text-xs font-bold tracking-[0.12em] text-muted-foreground uppercase">
				{title}
			</h2>
			{/* One grouped list with dividers, not a grid of cards (DESIGN.md,
			    Layout): these are navigation items, and the sidebar beside them
			    already carries the same destinations. */}
			<ul className="overflow-hidden rounded-xl border border-border bg-surface-raised shadow-[0_8px_20px_rgba(23,58,64,.05)]">
				{tasks.map((task) => (
					<li
						key={`${title}:${task.to}`}
						className="border-b border-border last:border-b-0"
					>
						<Link
							to={task.to}
							className="group flex items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-surface-soft focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
						>
							<div className="min-w-0 flex-1">
								<div className="text-sm font-bold text-foreground">
									{officerTaskTitle(task)}
								</div>
								<div className="truncate text-xs text-muted-foreground">
									{task.description}
								</div>
							</div>
							<ChevronRight
								className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
								aria-hidden
							/>
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
