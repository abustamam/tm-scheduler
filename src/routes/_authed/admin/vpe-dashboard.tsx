import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { MemberAvatar } from "#/components/club/member-avatar";
import { PageContainer } from "#/components/page-container";
import {
	ATTENDANCE_LAPSE,
	type AttendanceLapseRow,
} from "#/lib/attendance-lapse";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { formatShortDate } from "#/lib/format";
import { formatTenure } from "#/lib/members";
import { cn } from "#/lib/utils";
import {
	getAttendanceLapse,
	getOverdueMembers,
	getSpeakerRotation,
} from "#/server/reporting";
import type {
	OverdueMemberRow,
	SpeakerRotationRow,
} from "#/server/reporting-logic";

export const Route = createFileRoute("/_authed/admin/vpe-dashboard")({
	beforeLoad: ({ context }) => {
		if (!effectiveAdminClub(context)) {
			throw redirect({ to: "/dashboard" });
		}
	},
	loader: async ({ context }) => {
		const club = effectiveAdminClub(context);
		if (!club) return { rotation: [], overdue: [], lapse: [], clubName: "" };
		const [rotation, overdue, lapse] = await Promise.all([
			getSpeakerRotation({ data: { clubId: club.clubId } }),
			getOverdueMembers({ data: { clubId: club.clubId } }),
			getAttendanceLapse({ data: { clubId: club.clubId } }),
		]);
		return { rotation, overdue, lapse, clubName: club.name };
	},
	component: VpeDashboard,
});

/** "Presentation Mastery · Ice Breaker · Level 1", skipping missing pieces. */
function pathwaySummary(row: SpeakerRotationRow): string | null {
	const parts = [
		row.latestPathwayPath,
		row.latestProjectName,
		row.latestProjectLevel,
	].filter((p): p is string => Boolean(p));
	return parts.length ? parts.join(" · ") : null;
}

function VpeDashboard() {
	const { rotation, overdue, lapse } = Route.useLoaderData();

	const overdueMembers = overdue.filter((m) => m.isOverdue);
	const neverSpoken = rotation.filter((r) => r.lastSpokenAt === null).length;
	const lapsed = lapse.filter((m) => m.isLapsed);

	const stats = [
		{ label: "Active members", value: String(rotation.length), note: "roster" },
		{
			label: "Stopped attending",
			value: String(lapsed.length),
			note: `${ATTENDANCE_LAPSE.streakThreshold}+ meetings missed`,
			amber: lapsed.length > 0,
		},
		{
			label: "Overdue members",
			value: String(overdueMembers.length),
			note: "no recent role",
			amber: overdueMembers.length > 0,
		},
		{
			label: "Never spoken",
			value: String(neverSpoken),
			note: "top of queue",
		},
	];

	return (
		<PageContainer className="space-y-6">
			{/* Header */}
			<div>
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					VP Education
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					Attendance, speaker rotation and role fairness at a glance — who has
					stopped coming, who's overdue for a role, and who's up next to speak.
				</p>
			</div>

			{/* Stat cards */}
			<div className="grid grid-cols-[repeat(auto-fit,minmax(168px,1fr))] gap-3">
				{stats.map((s) => (
					<div
						key={s.label}
						className={cn(
							"rounded-xl border bg-[var(--surface-strong)] px-4 py-4 shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)]",
							s.amber ? "border-[var(--warning)]" : "border-[var(--line)]",
						)}
					>
						<div className="text-xs font-bold tracking-[0.04em] text-[var(--sea-ink-soft)] uppercase">
							{s.label}
						</div>
						<div className="mt-2 flex items-baseline gap-2">
							<span
								className={cn(
									"font-display text-3xl leading-none font-semibold",
									s.amber && "text-[var(--warning-strong)]",
								)}
							>
								{s.value}
							</span>
							<span className="text-xs text-[var(--sea-ink-soft)]">
								{s.note}
							</span>
						</div>
					</div>
				))}
			</div>

			{/* Attendance lapse (#530). Sits ABOVE "Overdue for a role" on purpose:
			    the two look alike but mean different things, and this is the more
			    urgent one. A member who comes every week and never volunteers is
			    a nudge; a member who has stopped coming is a resignation in
			    progress. Both show as having no claimed role, so the section
			    below cannot tell them apart — only attendance can. */}
			<Section
				title="Stopped attending"
				subtitle={`Active members not recorded present at the last ${ATTENDANCE_LAPSE.streakThreshold}+ meetings — longest absence first. Excused meetings don't count against anyone.`}
			>
				{lapsed.length === 0 ? (
					<EmptyRow>Nobody has dropped off the radar. 🎉</EmptyRow>
				) : (
					lapsed.map((m) => <LapseRow key={m.memberId} member={m} />)
				)}
			</Section>

			{/* Overdue */}
			<Section
				title="Overdue for a role"
				subtitle="Active members with no claimed role in the last 60 days — longest wait first."
			>
				{overdueMembers.length === 0 ? (
					<EmptyRow>Everyone has had a role recently. 🎉</EmptyRow>
				) : (
					overdueMembers.map((m) => <OverdueRow key={m.memberId} member={m} />)
				)}
			</Section>

			{/* Speaker rotation */}
			<Section
				title="Speaker queue"
				subtitle="Active members ranked by how long since they last held a speaker role — never-spoken first."
			>
				{rotation.length === 0 ? (
					<EmptyRow>No active members yet.</EmptyRow>
				) : (
					rotation.map((r, i) => (
						<RotationRow key={r.memberId} row={r} rank={i + 1} />
					))
				)}
			</Section>
		</PageContainer>
	);
}

function Section({
	title,
	subtitle,
	children,
}: {
	title: string;
	subtitle: string;
	children: React.ReactNode;
}) {
	return (
		<div>
			<div className="mb-2.5">
				<h2 className="text-sm font-bold tracking-[-0.01em]">{title}</h2>
				<p className="text-xs text-[var(--sea-ink-soft)]">{subtitle}</p>
			</div>
			<div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_14px_30px_rgba(23,58,64,.06)]">
				{children}
			</div>
		</div>
	);
}

function EmptyRow({ children }: { children: React.ReactNode }) {
	return (
		<p className="px-5 py-10 text-center text-sm text-[var(--sea-ink-soft)]">
			{children}
		</p>
	);
}

/** Shared avatar + name + tenure identity cell, linking to the member profile. */
function MemberIdentity({
	memberId,
	name,
	joinedAt,
}: {
	memberId: string;
	name: string;
	joinedAt: Date | string | null;
}) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			<MemberAvatar
				tone={toneFromSeed(memberId)}
				initials={initialsOf(name)}
				size={38}
			/>
			<div className="min-w-0 leading-[1.25]">
				<div className="truncate text-sm font-bold">{name}</div>
				<div className="text-xs text-[var(--sea-ink-soft)]">
					{joinedAt ? formatTenure(joinedAt) : "Tenure unknown"}
				</div>
			</div>
		</div>
	);
}

const ROW_CLASS =
	"group grid cursor-pointer items-center gap-3.5 border-b border-[var(--line)] px-5 py-3 transition-colors last:border-b-0 hover:bg-[var(--foam)]";

function OverdueRow({ member }: { member: OverdueMemberRow }) {
	const wait =
		member.daysSinceLastRole === null
			? "Never held a role"
			: `${member.daysSinceLastRole} days ago`;
	return (
		<Link
			to="/members/$id"
			params={{ id: member.memberId }}
			className={cn(
				ROW_CLASS,
				// Narrower wait column below `sm` so the member name keeps room.
				"grid-cols-[1fr_112px_28px] sm:grid-cols-[1fr_150px_34px]",
			)}
		>
			<MemberIdentity
				memberId={member.memberId}
				name={member.name}
				joinedAt={member.joinedAt}
			/>
			<div className="text-sm">
				<span className="font-bold text-[var(--warning-strong)]">{wait}</span>
				<div className="text-xs text-[var(--sea-ink-soft)]">
					{member.lastAnyRoleAt
						? `last: ${formatShortDate(member.lastAnyRoleAt)}`
						: "no role history"}
				</div>
			</div>
			<Chevron />
		</Link>
	);
}

function LapseRow({ member }: { member: AttendanceLapseRow }) {
	// The rate is CONTEXT beside the streak, not a substitute for it — an
	// officer wants to know whether this is someone who was always patchy or
	// someone reliable who just stopped. Rendering it only when lastSeenAt is
	// null (the previous shape) made it dead: lastSeenAt is null exactly when
	// presentCount is 0, so the percentage could only ever print "0%".
	// Null rate means nothing in the window was eligible for them.
	const rate =
		member.rate === null ? null : `${Math.round(member.rate * 100)}% attended`;
	const seen = member.lastSeenAt
		? `last seen ${formatShortDate(member.lastSeenAt)}`
		: "never recorded present";
	return (
		<Link
			to="/members/$id"
			params={{ id: member.memberId }}
			className={cn(
				ROW_CLASS,
				"grid-cols-[1fr_112px_28px] sm:grid-cols-[1fr_150px_34px]",
			)}
		>
			<MemberIdentity
				memberId={member.memberId}
				name={member.name}
				joinedAt={member.joinedAt}
			/>
			<div className="text-sm">
				<span className="font-bold text-[var(--warning-strong)]">
					{member.streak} missed
				</span>
				<div className="text-xs text-[var(--sea-ink-soft)]">
					{rate ? `${seen} · ${rate}` : seen}
				</div>
			</div>
			<Chevron />
		</Link>
	);
}

function RotationRow({ row, rank }: { row: SpeakerRotationRow; rank: number }) {
	const pathway = pathwaySummary(row);
	return (
		<Link
			to="/members/$id"
			params={{ id: row.memberId }}
			className={cn(
				ROW_CLASS,
				// Below `sm`: rank + member + chevron only; last-spoken and pathway
				// return at `sm`. Tap through to the profile for the full picture.
				"grid-cols-[28px_1fr_34px] sm:grid-cols-[28px_1fr_130px_190px_34px]",
			)}
		>
			<div className="text-sm font-bold text-[var(--sea-ink-soft)] tabular-nums">
				{rank}
			</div>
			<MemberIdentity
				memberId={row.memberId}
				name={row.name}
				joinedAt={row.joinedAt}
			/>
			<div className="hidden text-sm sm:block">
				{row.lastSpokenAt ? (
					<>
						<span className="font-bold text-[var(--sea-ink)]">
							{formatShortDate(row.lastSpokenAt)}
						</span>
						<div className="text-xs text-[var(--sea-ink-soft)]">
							{row.timesSpoken} time{row.timesSpoken === 1 ? "" : "s"}
						</div>
					</>
				) : (
					<span className="font-bold text-[var(--lagoon-deep)]">
						Never spoken
					</span>
				)}
			</div>
			<div className="hidden min-w-0 truncate text-xs text-[var(--sea-ink-soft)] sm:block">
				{pathway ?? "—"}
			</div>
			<Chevron />
		</Link>
	);
}

function Chevron() {
	return (
		<div className="justify-self-end text-[var(--sea-ink-soft)] opacity-45 transition-all group-hover:translate-x-0.5 group-hover:opacity-100">
			<ChevronRight className="size-4" aria-hidden />
		</div>
	);
}
