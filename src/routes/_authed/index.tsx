import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/club/member-avatar";
import { StatusPill } from "#/components/club/status-pill";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	type MemberStatus,
	mockPathway,
	type RosterSegment,
	rosterSegments,
} from "#/data/club";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { formatTenure, isNewMember } from "#/lib/members";
import { cn } from "#/lib/utils";
import { listClubMembers } from "#/server/club";
import { listUpcomingMeetings } from "#/server/meetings";
import { mergeMembers } from "#/server/members";

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
	const { clubs, currentMemberId } = Route.useRouteContext();
	const clubId = clubs[0]?.clubId;
	const [seg, setSeg] = useState<RosterSegment["key"]>("all");
	const [mergeOpen, setMergeOpen] = useState(false);

	// Identity + speeches are real; Pathway/level/% + status are mocked.
	const rows: RosterRow[] = members.map((m) => {
		const p = mockPathway(m.id);
		return {
			id: m.id,
			name: m.name,
			initials: initialsOf(m.name),
			tone: toneFromSeed(m.id),
			tenure: m.office
				? `${formatTenure(m.createdAt)} · ${m.office}`
				: formatTenure(m.createdAt),
			path: p.path,
			project: p.project,
			level: p.level,
			pct: p.pct,
			speeches: m.speeches,
			status: isNewMember(m.createdAt) ? "new" : p.status,
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
					{clubId && members.length > 1 ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setMergeOpen(true)}
						>
							Merge duplicates
						</Button>
					) : null}
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

			{clubId ? (
				<MergeMembersDialog
					open={mergeOpen}
					onOpenChange={setMergeOpen}
					members={members}
					clubId={clubId}
					currentMemberId={currentMemberId}
				/>
			) : null}
		</div>
	);
}

function MergeMembersDialog({
	open,
	onOpenChange,
	members,
	clubId,
	currentMemberId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	members: {
		id: string;
		name: string;
		userId: string | null;
	}[];
	clubId: string;
	currentMemberId: string | null;
}) {
	const router = useRouter();
	const [keeperId, setKeeperId] = useState("");
	const [absorbedId, setAbsorbedId] = useState("");
	const [busy, setBusy] = useState(false);

	const keeper = members.find((m) => m.id === keeperId);
	const absorbed = members.find((m) => m.id === absorbedId);
	const sameMember = Boolean(keeperId && absorbedId && keeperId === absorbedId);
	const canSubmit = Boolean(keeper && absorbed) && !sameMember && !busy;

	const selectClass =
		"h-9 w-full rounded-[10px] border border-[var(--line)] bg-[var(--surface-strong)] px-3 text-[13px] font-medium text-[var(--sea-ink)] transition-colors hover:border-[var(--lagoon-deep)]";

	async function onMerge() {
		if (!keeper || !absorbed || sameMember) return;
		setBusy(true);
		try {
			await mergeMembers({
				data: {
					clubId,
					keeperId: keeper.id,
					absorbedId: absorbed.id,
					actorMemberId: currentMemberId,
				},
			});
			toast.success(`Merged ${absorbed.name} into ${keeper.name}.`);
			onOpenChange(false);
			setKeeperId("");
			setAbsorbedId("");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Merge duplicate members</DialogTitle>
					<DialogDescription>
						Pick the member to keep and the duplicate to absorb. The duplicate's
						roles and history move to the keeper, then it's removed.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<label
							htmlFor="merge-keeper"
							className="text-sm font-medium text-[var(--sea-ink)]"
						>
							Keep
						</label>
						<select
							id="merge-keeper"
							className={selectClass}
							value={keeperId}
							onChange={(e) => setKeeperId(e.target.value)}
						>
							<option value="">Select a member…</option>
							{members.map((m) => (
								<option key={m.id} value={m.id}>
									{m.name}
								</option>
							))}
						</select>
					</div>

					<div className="space-y-2">
						<label
							htmlFor="merge-absorbed"
							className="text-sm font-medium text-[var(--sea-ink)]"
						>
							Absorb (this duplicate is removed)
						</label>
						<select
							id="merge-absorbed"
							className={selectClass}
							value={absorbedId}
							onChange={(e) => setAbsorbedId(e.target.value)}
						>
							<option value="">Select a member…</option>
							{members.map((m) => (
								<option key={m.id} value={m.id} disabled={Boolean(m.userId)}>
									{m.name}
									{m.userId ? " (signed-in account)" : ""}
								</option>
							))}
						</select>
					</div>

					{sameMember ? (
						<p className="text-[13px] font-medium text-[var(--warning-strong)]">
							Pick two different members.
						</p>
					) : keeper && absorbed ? (
						<p className="text-[13px] text-[var(--sea-ink-soft)]">
							Merge <span className="font-bold">{absorbed.name}</span> into{" "}
							<span className="font-bold">{keeper.name}</span>? {absorbed.name}
							's roles and history move to {keeper.name}, then {absorbed.name}{" "}
							is removed.
						</p>
					) : null}
				</div>

				<DialogFooter>
					<DialogClose asChild>
						<Button type="button" variant="outline" disabled={busy}>
							Cancel
						</Button>
					</DialogClose>
					<Button type="button" disabled={!canSubmit} onClick={onMerge}>
						{busy ? "Merging…" : "Merge members"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
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
