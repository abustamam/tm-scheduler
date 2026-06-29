import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { MemberAvatar } from "#/components/club/member-avatar";
import { StatusPill } from "#/components/club/status-pill";
import { Button } from "#/components/ui/button";
import {
	type MemberStatus,
	mockPathway,
	type RosterSegment,
	rosterSegments,
} from "#/data/club";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { clubRoleLabel, formatTenure, isNewMember } from "#/lib/members";
import { cn } from "#/lib/utils";
import { listClubMembers } from "#/server/club";
import { listUpcomingMeetings } from "#/server/meetings";

export const Route = createFileRoute("/_authed/")({
	loader: async ({ context }) => {
		const clubId = context.clubs[0]?.clubId;
		if (!clubId) {
			return { members: [], openRoles: 0 };
		}
		const [members, upcoming] = await Promise.all([
			listClubMembers({ data: clubId }),
			listUpcomingMeetings({ data: clubId }),
		]);
		return { members, openRoles: upcoming[0]?.openSlots ?? 0 };
	},
	component: Roster,
});

const TABLE_COLS = "2.1fr 1.5fr 1.6fr 1fr 1.1fr 34px";

interface RosterRow {
	id: string;
	name: string;
	initials: string;
	tone: ReturnType<typeof toneFromSeed>;
	tenure: string;
	path: string;
	project: string;
	level: number;
	pct: number;
	speeches: number;
	status: MemberStatus;
}

function Roster() {
	const { members, openRoles } = Route.useLoaderData();
	const [seg, setSeg] = useState<RosterSegment["key"]>("all");

	// Identity + speeches are real; Pathway/level/% + status are mocked.
	const rows: RosterRow[] = members.map((m) => {
		const p = mockPathway(m.id);
		const role = clubRoleLabel(m.clubRole);
		return {
			id: m.id,
			name: m.name,
			initials: initialsOf(m.name),
			tone: toneFromSeed(m.id),
			tenure:
				m.clubRole === "member"
					? formatTenure(m.joinedAt)
					: `${formatTenure(m.joinedAt)} · ${role}`,
			path: p.path,
			project: p.project,
			level: p.level,
			pct: p.pct,
			speeches: m.speeches,
			status: isNewMember(m.joinedAt) ? "new" : p.status,
		};
	});

	const visible = seg === "all" ? rows : rows.filter((r) => r.status === seg);
	const countFor = (key: RosterSegment["key"]) =>
		key === "all" ? rows.length : rows.filter((r) => r.status === key).length;

	const stats = [
		{ label: "Active members", value: String(rows.length), note: "this term" },
		{
			label: "Speeches given",
			value: String(rows.reduce((n, r) => n + r.speeches, 0)),
			note: "all time",
		},
		{
			label: "Level completions",
			value: String(rows.reduce((n, r) => n + (r.level - 1), 0)),
			note: "this term",
		},
		{
			label: "Needs attention",
			value: String(rows.filter((r) => r.status === "behind").length),
			note: "behind on goals",
			amber: true,
		},
		{
			label: "Open roles",
			value: String(openRoles),
			note: "next meeting →",
			to: "/agenda" as const,
		},
	];

	return (
		<div className="max-w-[1180px] px-7 pt-[26px] pb-10">
			{/* Header */}
			<div className="mb-[22px] flex flex-wrap items-end gap-[18px]">
				<div className="min-w-[240px] flex-1">
					<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
						Club roster
					</h1>
					<p className="mt-[5px] text-sm text-[var(--sea-ink-soft)]">
						Where every member sits in their Pathways journey · Spring 2026 term
					</p>
				</div>
				<div className="flex gap-[9px]">
					<Button variant="outline" size="sm">
						Export CSV
					</Button>
					<Button size="sm">+ Add member</Button>
				</div>
			</div>

			{/* Stat cards */}
			<div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(168px,1fr))] gap-[13px]">
				{stats.map((s) => (
					<StatCard key={s.label} stat={s} />
				))}
			</div>

			{/* Segment filters */}
			<div className="mb-4 flex flex-wrap gap-2">
				{rosterSegments.map((s) => (
					<SegmentChip
						key={s.key}
						segment={s}
						count={countFor(s.key)}
						active={seg === s.key}
						onSelect={() => setSeg(s.key)}
					/>
				))}
			</div>

			{/* Table */}
			<div className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_14px_30px_rgba(23,58,64,.06)]">
				<div
					className="grid gap-3.5 border-b border-[var(--line)] bg-[var(--foam)] px-5 py-3 text-[10.5px] font-extrabold tracking-[0.08em] text-[var(--sea-ink-soft)] uppercase"
					style={{ gridTemplateColumns: TABLE_COLS }}
				>
					<div>Member</div>
					<div>Pathway</div>
					<div>Level progress</div>
					<div>Speeches</div>
					<div>Status</div>
					<div />
				</div>

				{visible.length === 0 ? (
					<p className="px-5 py-10 text-center text-sm text-[var(--sea-ink-soft)]">
						No members to show.
					</p>
				) : (
					visible.map((m) => (
						<Link
							key={m.id}
							to="/members/$id"
							params={{ id: m.id }}
							className="group grid cursor-pointer items-center gap-3.5 border-b border-[var(--line)] px-5 py-[13px] transition-colors last:border-b-0 hover:bg-[var(--foam)]"
							style={{ gridTemplateColumns: TABLE_COLS }}
						>
							{/* Member */}
							<div className="flex min-w-0 items-center gap-[11px]">
								<MemberAvatar tone={m.tone} initials={m.initials} size={38} />
								<div className="min-w-0 leading-[1.25]">
									<div className="truncate text-sm font-bold">{m.name}</div>
									<div className="text-[11.5px] text-[var(--sea-ink-soft)]">
										{m.tenure}
									</div>
								</div>
							</div>

							{/* Pathway */}
							<div className="min-w-0">
								<div className="truncate text-[13px] font-semibold">
									{m.path}
								</div>
								<div className="truncate text-[11.5px] text-[var(--sea-ink-soft)]">
									{m.project}
								</div>
							</div>

							{/* Level progress */}
							<div>
								<div className="mb-[5px] flex items-center gap-2">
									<span className="text-[11px] font-bold tracking-[0.03em] text-[var(--sea-ink-soft)]">
										LV {m.level}
									</span>
									<span className="text-[11.5px] text-[var(--sea-ink-soft)]">
										·
									</span>
									<span className="text-[11.5px] font-bold text-[var(--sea-ink)]">
										{m.pct}%
									</span>
								</div>
								<div className="h-[7px] overflow-hidden rounded-full bg-[var(--sand)]">
									<div
										className="h-full rounded-full"
										style={{
											width: `${m.pct}%`,
											background:
												"linear-gradient(90deg, var(--lagoon), var(--lagoon-deep))",
										}}
									/>
								</div>
							</div>

							{/* Speeches */}
							<div className="text-sm font-bold text-[var(--sea-ink)]">
								{m.speeches}
								<span className="text-[11px] font-medium text-[var(--sea-ink-soft)]">
									{" "}
									given
								</span>
							</div>

							{/* Status */}
							<StatusPill status={m.status} />

							{/* Chevron */}
							<div className="justify-self-end text-[var(--sea-ink-soft)] opacity-45 transition-all group-hover:translate-x-[3px] group-hover:opacity-100">
								<ChevronRight className="size-[17px]" aria-hidden />
							</div>
						</Link>
					))
				)}
			</div>

			<p className="mt-3.5 px-0.5 text-xs text-[var(--sea-ink-soft)]">
				Tip: click any member to open their full journey, speech log and award
				track.
			</p>
		</div>
	);
}

function StatCard({
	stat,
}: {
	stat: {
		label: string;
		value: string;
		note: string;
		amber?: boolean;
		to?: "/agenda";
	};
}) {
	const inner = (
		<>
			<div className="text-[11.5px] font-bold tracking-[0.04em] text-[var(--sea-ink-soft)] uppercase">
				{stat.label}
			</div>
			<div className="mt-[7px] flex items-baseline gap-2">
				<span
					className={cn(
						"font-display text-[30px] leading-none font-semibold",
						stat.amber && "text-[var(--warning-strong)]",
					)}
				>
					{stat.value}
				</span>
				<span className="text-xs text-[var(--sea-ink-soft)]">{stat.note}</span>
			</div>
		</>
	);

	const className = cn(
		"rounded-[14px] border bg-[var(--surface-strong)] px-4 py-[15px] shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)] transition-transform hover:-translate-y-0.5",
		stat.amber ? "border-[var(--warning)]" : "border-[var(--line)]",
	);

	if (stat.to) {
		return (
			<Link to={stat.to} className={className}>
				{inner}
			</Link>
		);
	}
	return <div className={className}>{inner}</div>;
}

function SegmentChip({
	segment,
	count,
	active,
	onSelect,
}: {
	segment: RosterSegment;
	count: number;
	active: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"inline-flex items-center gap-2 rounded-full border px-[13px] py-[7px] text-[13px] font-semibold transition-transform active:scale-[0.97]",
				active
					? "border-[var(--sea-ink)] bg-[var(--sea-ink)] text-[var(--background)]"
					: "border-[var(--line)] bg-[var(--surface-strong)] text-[var(--sea-ink-soft)]",
			)}
		>
			{segment.label}
			<span
				className={cn(
					"inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-[5px] text-[11px] font-bold",
					active
						? "bg-white/20 text-current"
						: "bg-[var(--sand)] text-[var(--sea-ink-soft)]",
				)}
			>
				{count}
			</span>
		</button>
	);
}
