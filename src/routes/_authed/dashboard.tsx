import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { BookOpen, CalendarDays } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { EvaluationResourceLinks } from "#/components/pathways/evaluation-resource-link";
import { PathEnrollmentManager } from "#/components/pathways/path-enrollment-manager";
import { PathwaysProgress } from "#/components/pathways/pathways-progress";
import { formatMeetingDate } from "#/lib/format";
import {
	SPEECH_SCHEDULE_STATE_LABELS,
	type SpeechScheduleState,
	speechLogHeadline,
	speechScheduleState,
} from "#/lib/speech-schedule-state";
import { listMySpeeches } from "#/server/club";
import { listMyCommitments } from "#/server/meetings";
import {
	addMyPath,
	getMyPathEnrollments,
	listPathwayOptions,
	removeMyPath,
} from "#/server/path-enrollment";
import { getMyPathways } from "#/server/pathways-read";
import { markMyProject, unmarkMyProject } from "#/server/progress-marks";

export const Route = createFileRoute("/_authed/dashboard")({
	loader: async () => {
		const [commitments, speeches, pathways, enrollments, pathOptions] =
			await Promise.all([
				listMyCommitments(),
				listMySpeeches(),
				getMyPathways(),
				getMyPathEnrollments(),
				listPathwayOptions(),
			]);
		return {
			commitments,
			speeches,
			pathways,
			enrollments,
			pathOptions,
			// The instant the speech log is read against, pinned HERE rather than
			// sampled while rendering. One value is dehydrated with the loader data,
			// so the SSR pass and the hydration pass classify every row identically
			// — the hydration hazard #608 records on this page's greeting, not
			// repeated. It is also the same clock `listMyCommitments` filtered its
			// own rows on above, which is what keeps the two cards from disagreeing
			// about one slot (#656).
			now: Date.now(),
		};
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
	const { authUser, activeClubId } = Route.useRouteContext();
	const { commitments, speeches, pathways, enrollments, pathOptions, now } =
		Route.useLoaderData();
	const router = useRouter();
	const [busyProjectId, setBusyProjectId] = useState<string | null>(null);

	// The server fns return the fresh list, but the Pathways panel above is
	// loader-driven and would go stale, so re-run the loader instead of holding
	// two sources of truth for the same thing.
	async function mutatePath(
		fn: (args: { data: { pathId: string } }) => Promise<unknown>,
		pathId: string,
	) {
		try {
			await fn({ data: { pathId } });
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		}
	}

	// Same reasoning as `mutatePath`: the mark fns return the fresh view models,
	// but the panel is loader-driven, so re-run the loader (#419).
	async function mutateMark(
		fn: (args: {
			data: { projectId: string; clubId?: string | null };
		}) => Promise<unknown>,
		projectId: string,
	) {
		setBusyProjectId(projectId);
		try {
			// `clubId` is attribution only — authz is person-level. Without it
			// every self-mark landed with a null `marked_by_member_id`, which made
			// the column dead weight on the surface that writes most of them.
			await fn({ data: { projectId, clubId: activeClubId } });
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusyProjectId(null);
		}
	}

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
							<Link
								to="/schedule"
								search={{ view: "members", count: 8 }}
								className="block border-t border-[var(--line)] px-5 py-8 text-center text-sm text-[var(--sea-ink-soft)] no-underline transition-colors hover:bg-[var(--foam)]"
							>
								No speeches yet. Sign up for a speaking slot to get started →
							</Link>
						) : (
							speeches.map((l) => {
								const { day, mon } = dayMon(l.scheduledAt);
								const state = speechScheduleState({
									scheduledAt: l.scheduledAt,
									now,
								});
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
												{speechLogHeadline({
													speechTitle: l.speechTitle,
													roleName: l.roleName,
												})}
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
										<SpeechStatePill state={state} />
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
									<div key={r.slotId}>
										<Link
											// The row's OWN meeting, not `/next` — that resolves the
											// ACTIVE club's soonest meeting, so once this list went
											// cross-club (#437) a club-B commitment navigated to
											// club-A's agenda. `meetingId` is already on the payload.
											to="/meetings/$id"
											params={{ id: r.meetingId }}
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
													{/* Club is unconditional, not the last fallback: as a
													    third fallback it showed up only on the sparsest
													    rows — never on the speech/theme rows most likely
													    to collide across clubs. */}
													{r.clubName} ·{" "}
													{formatMeetingDate(r.scheduledAt, r.timezone)}
													{(r.speechTitle ?? r.theme)
														? ` · ${r.speechTitle ?? r.theme}`
														: null}
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
										{/* Speakers and evaluators only — a functionary fills in no
										    evaluation form, and unconditionally this line appeared on
										    most rows of a typical agenda. Outside the <Link> above,
										    never inside it: nesting an <a> in an <a> is invalid and
										    browsers restructure the DOM around it. `pb-2.5` because
										    the next row's border-t is otherwise flush against this
										    line. */}
										{r.isSpeakerRole ||
										r.evaluatesSlotId !== null ||
										r.roleCategory === "evaluator" ? (
											<div className="pb-2.5 pl-10 pr-5">
												<EvaluationResourceLinks
													projectName={
														r.evaluatedProjectName ?? r.ownProjectName
													}
													// Generic form only for a TBA speech (no name at
													// all). A name that matched nothing renders no
													// link — spec §2. See me.tsx for the full note.
													fallback={
														!(r.evaluatedProjectName ?? r.ownProjectName)
													}
												/>
											</div>
										) : null}
									</div>
								);
							})
						)}
					</div>

					{/* My Pathways progress (real, synced from Base Camp) */}
					<div>
						<h2 className="mb-2.5 px-0.5 text-sm font-bold">My Pathways</h2>
						<PathwaysProgress
							paths={pathways}
							onMark={(id) => mutateMark(markMyProject, id)}
							onUnmark={(id) => mutateMark(unmarkMyProject, id)}
							busyId={busyProjectId}
						/>
						<div className="mt-3">
							<PathEnrollmentManager
								enrollments={enrollments}
								options={pathOptions}
								onAdd={(id) => mutatePath(addMyPath, id)}
								onRemove={(id) => mutatePath(removeMyPath, id)}
							/>
						</div>
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

/**
 * The speech-log badge. Which state a row is in is NOT decided here — the
 * decision is `speechScheduleState`, shared with the member profile's copy of
 * this list so the two surfaces cannot answer differently for one slot (#656).
 * The wording is shared too; a literal here is what let this card and that one
 * drift apart in the first place.
 */
function SpeechStatePill({ state }: { state: SpeechScheduleState }) {
	if (state === "scheduled") {
		return (
			<span className="shrink-0 rounded-full bg-[rgba(79,184,178,.16)] px-2.5 py-1 text-xs font-bold text-[var(--lagoon-deep)]">
				{SPEECH_SCHEDULE_STATE_LABELS.scheduled}
			</span>
		);
	}
	return (
		<span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--foam)] px-2.5 py-1 text-xs font-semibold text-[var(--palm)]">
			<span className="size-1.5 rounded-full bg-[var(--palm)]" />
			{SPEECH_SCHEDULE_STATE_LABELS.delivered}
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
