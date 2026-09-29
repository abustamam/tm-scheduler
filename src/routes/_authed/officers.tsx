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
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
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
			className="group block space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-4 shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)] transition-all hover:border-[var(--lagoon-deep)]"
		>
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<div className="text-sm font-bold text-[var(--sea-ink)]">
						{CHARTER_DASHBOARD_COPY.title}
					</div>
					<div className="text-xs text-[var(--sea-ink-soft)]">
						{summary.periodPicked
							? `Paid members toward charter. Checklist: ${summary.stepsDone} of ${summary.stepsTotal} done.`
							: CHARTER_DASHBOARD_COPY.pickPeriod}
					</div>
				</div>
				<ChevronRight
					className="size-4 shrink-0 text-[var(--sea-ink-soft)] opacity-45 transition-all group-hover:translate-x-0.5 group-hover:opacity-100"
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
			<h2 className="text-xs font-extrabold tracking-[0.12em] text-[var(--sea-ink-soft)] uppercase">
				{title}
			</h2>
			<div className="grid gap-3 sm:grid-cols-2">
				{tasks.map((task) => (
					<Link
						key={`${title}:${task.to}`}
						to={task.to}
						className="group flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3.5 shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)] transition-all hover:-translate-y-0.5 hover:border-[var(--lagoon-deep)]"
					>
						<div className="min-w-0 flex-1">
							<div className="text-sm font-bold text-[var(--sea-ink)]">
								{officerTaskTitle(task)}
							</div>
							<div className="truncate text-xs text-[var(--sea-ink-soft)]">
								{task.description}
							</div>
						</div>
						<ChevronRight
							className="size-4 shrink-0 text-[var(--sea-ink-soft)] opacity-45 transition-all group-hover:translate-x-0.5 group-hover:opacity-100"
							aria-hidden
						/>
					</Link>
				))}
			</div>
		</section>
	);
}
