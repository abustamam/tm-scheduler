import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { PageContainer } from "#/components/page-container";
import { buildOfficerHome, type OfficerTask } from "#/lib/officer-tasks";

export const Route = createFileRoute("/_authed/officers")({
	// Officer home is only for people who hold an office; everyone else lands on
	// the roster (the default workspace home).
	beforeLoad: ({ context }) => {
		if (!context.officerPositions?.length) {
			throw redirect({ to: "/" });
		}
	},
	component: OfficerHome,
});

function OfficerHome() {
	const { authUser, officerPositions } = Route.useRouteContext();
	const { common, sections } = buildOfficerHome([...officerPositions]);
	const firstName = (authUser.name || authUser.email).split(/\s+/)[0];

	return (
		<PageContainer className="space-y-8">
			<div>
				<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
					Officer home
				</h1>
				<p className="mt-[5px] text-sm text-[var(--sea-ink-soft)]">
					Hi {firstName} — here's where to go to run the club.
				</p>
			</div>

			<TaskSection title="Everyday" tasks={common} />

			{sections.map((s) => (
				<TaskSection key={s.position} title={`As ${s.label}`} tasks={s.tasks} />
			))}
		</PageContainer>
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
			<h2 className="text-[11px] font-extrabold tracking-[0.12em] text-[var(--sea-ink-soft)] uppercase">
				{title}
			</h2>
			<div className="grid gap-3 sm:grid-cols-2">
				{tasks.map((task) => (
					<Link
						key={`${title}:${task.label}`}
						to={task.to}
						className="group flex items-center gap-3 rounded-[14px] border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3.5 shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)] transition-all hover:-translate-y-0.5 hover:border-[var(--lagoon-deep)]"
					>
						<div className="min-w-0 flex-1">
							<div className="text-sm font-bold text-[var(--sea-ink)]">
								{task.label}
							</div>
							<div className="truncate text-[12.5px] text-[var(--sea-ink-soft)]">
								{task.description}
							</div>
						</div>
						<ChevronRight
							className="size-[17px] shrink-0 text-[var(--sea-ink-soft)] opacity-45 transition-all group-hover:translate-x-[3px] group-hover:opacity-100"
							aria-hidden
						/>
					</Link>
				))}
			</div>
		</section>
	);
}
