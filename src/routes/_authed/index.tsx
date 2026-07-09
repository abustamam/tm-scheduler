import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/club/member-avatar";
import { PageContainer } from "#/components/page-container";
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
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { formatTenure } from "#/lib/members";
import { officerPositionLabel } from "#/lib/officers";
import {
	buildImportPreview,
	type PreviewRow,
	parseRosterText,
} from "#/lib/roster-import";
import { cn } from "#/lib/utils";
import { listClubMembers } from "#/server/club";
import { listUpcomingMeetings } from "#/server/meetings";
import { bulkImportMembers, mergeMembers } from "#/server/members";
import { listClubMemberPathways } from "#/server/pathways-read";
import type { PathViewModel } from "#/server/pathways-read-logic";

export const Route = createFileRoute("/_authed/")({
	loader: async ({ context }) => {
		const clubId = context.clubs[0]?.clubId;
		if (!clubId) {
			return { members: [], openRoles: 0, pathways: {} };
		}
		const [members, upcoming, pathways] = await Promise.all([
			listClubMembers({ data: clubId }),
			listUpcomingMeetings({ data: clubId }),
			listClubMemberPathways({ data: { clubId } }),
		]);
		return {
			members,
			openRoles: upcoming[0]?.openSlots ?? 0,
			pathways,
		};
	},
	component: Roster,
});

const TABLE_COLS = "1fr 150px 170px 34px";

type SegKey = "all" | "active" | "inactive";
const ROSTER_SEGMENTS: { key: SegKey; label: string }[] = [
	{ key: "all", label: "All members" },
	{ key: "active", label: "Active" },
	{ key: "inactive", label: "Inactive" },
];

interface RosterRow {
	id: string;
	name: string;
	initials: string;
	tone: ReturnType<typeof toneFromSeed>;
	tenure: string;
	speeches: number;
	/** Roster membership status (renewal): active vs unrenewed/inactive. */
	membershipStatus: "active" | "inactive";
	/** Compact label for the member's first synced Pathway, or null if none synced. */
	pathwayLabel: string | null;
}

/** "PathName · L2 3/5" (or "· Path complete"), compact for a one-line roster cell. */
function pathwayLabelFor(paths: PathViewModel[]): string | null {
	const path = paths[0];
	if (!path) return null;
	if (path.complete) return `${path.pathName} · Path complete`;
	const level = path.levels.find((l) => l.level === path.currentLevel);
	if (!level) return path.pathName;
	return `${path.pathName} · L${level.level} ${level.completed}/${level.total}`;
}

function Roster() {
	const { members, openRoles, pathways } = Route.useLoaderData();
	const { clubs, currentMemberId } = Route.useRouteContext();
	const clubId = clubs[0]?.clubId;
	const clubRole = clubs[0]?.clubRole;
	const canManage = clubRole === "admin";
	const [seg, setSeg] = useState<SegKey>("all");
	const [mergeOpen, setMergeOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);

	// Identity, tenure, speeches, membership status and Pathways progress are all real.
	const rows: RosterRow[] = members.map((m) => {
		const joined = m.joinedAt ?? m.createdAt;
		return {
			id: m.id,
			name: m.name,
			initials: initialsOf(m.name),
			tone: toneFromSeed(m.id),
			tenure: m.officerPositions.length
				? `${formatTenure(joined)} · ${m.officerPositions
						.map(officerPositionLabel)
						.join(", ")}`
				: formatTenure(joined),
			speeches: m.speeches,
			membershipStatus: m.status,
			pathwayLabel: pathwayLabelFor(pathways[m.id] ?? []),
		};
	});

	// Active members first; inactive (unrenewed) sink to the bottom, greyed.
	const sorted = [...rows].sort((a, b) => {
		const ai = a.membershipStatus === "inactive" ? 1 : 0;
		const bi = b.membershipStatus === "inactive" ? 1 : 0;
		return ai - bi;
	});
	const visible =
		seg === "all" ? sorted : sorted.filter((r) => r.membershipStatus === seg);
	const countFor = (key: SegKey) =>
		key === "all"
			? rows.length
			: rows.filter((r) => r.membershipStatus === key).length;

	const stats = [
		{
			label: "Active members",
			value: String(rows.filter((r) => r.membershipStatus === "active").length),
			note: "this term",
		},
		{
			label: "Speeches given",
			value: String(rows.reduce((n, r) => n + r.speeches, 0)),
			note: "all time",
		},
		{
			label: "Open roles",
			value: String(openRoles),
			note: "next meeting →",
			to: "/next" as const,
		},
	];

	return (
		<PageContainer>
			{/* Header */}
			<div className="mb-[22px] flex flex-wrap items-end gap-[18px]">
				<div className="min-w-[240px] flex-1">
					<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
						Club roster
					</h1>
					<p className="mt-[5px] text-sm text-[var(--sea-ink-soft)]">
						Every member of your club at a glance · Spring 2026 term
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
					{clubId && canManage ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setImportOpen(true)}
						>
							Bulk import
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

			{/* Segment filters (membership status) */}
			<div className="mb-4 flex flex-wrap gap-2">
				{ROSTER_SEGMENTS.map((s) => (
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
					<div>Speeches</div>
					<div>Pathway</div>
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
							className={cn(
								"group grid cursor-pointer items-center gap-3.5 border-b border-[var(--line)] px-5 py-[13px] transition-colors last:border-b-0 hover:bg-[var(--foam)]",
								m.membershipStatus === "inactive" && "opacity-55",
							)}
							style={{ gridTemplateColumns: TABLE_COLS }}
						>
							{/* Member */}
							<div className="flex min-w-0 items-center gap-[11px]">
								<MemberAvatar tone={m.tone} initials={m.initials} size={38} />
								<div className="min-w-0 leading-[1.25]">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-bold">{m.name}</span>
										{m.membershipStatus === "inactive" ? (
											<span className="shrink-0 rounded-full border border-[var(--line)] bg-[var(--sand)] px-2 py-0.5 text-[10px] font-bold tracking-[0.03em] text-[var(--sea-ink-soft)] uppercase">
												Inactive
											</span>
										) : null}
									</div>
									<div className="text-[11.5px] text-[var(--sea-ink-soft)]">
										{m.tenure}
									</div>
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

							{/* Pathway */}
							<div className="min-w-0 truncate text-xs text-[var(--sea-ink-soft)]">
								{m.pathwayLabel ?? "—"}
							</div>

							{/* Chevron */}
							<div className="justify-self-end text-[var(--sea-ink-soft)] opacity-45 transition-all group-hover:translate-x-[3px] group-hover:opacity-100">
								<ChevronRight className="size-[17px]" aria-hidden />
							</div>
						</Link>
					))
				)}
			</div>

			<p className="mt-3.5 px-0.5 text-xs text-[var(--sea-ink-soft)]">
				Tip: click any member to open their profile, speech log and roles
				served.
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

			{clubId && canManage ? (
				<BulkImportDialog
					open={importOpen}
					onOpenChange={setImportOpen}
					existing={members}
					clubId={clubId}
					currentMemberId={currentMemberId}
				/>
			) : null}
		</PageContainer>
	);
}

const ISSUE_LABELS: Record<PreviewRow["issues"][number], string> = {
	"blank-name": "Blank name",
	"invalid-email": "Bad email",
	duplicate: "Duplicate",
};

function BulkImportDialog({
	open,
	onOpenChange,
	existing,
	clubId,
	currentMemberId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	existing: { name: string; email: string | null }[];
	clubId: string;
	currentMemberId: string | null;
}) {
	const router = useRouter();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);

	const preview = text.trim()
		? buildImportPreview(parseRosterText(text), existing)
		: [];
	const importable = preview.filter((r) => r.willImport);
	const skipped = preview.length - importable.length;
	const canSubmit = importable.length > 0 && !busy;

	function reset() {
		setText("");
	}

	async function onCommit() {
		if (importable.length === 0) return;
		setBusy(true);
		try {
			const result = await bulkImportMembers({
				data: {
					clubId,
					actorMemberId: currentMemberId,
					rows: importable.map((r) => ({
						name: r.name,
						email: r.email,
						phone: r.phone,
						office: r.office,
					})),
				},
			});
			toast.success(
				`Imported ${result.inserted} member${result.inserted === 1 ? "" : "s"}.` +
					(result.skipped > 0 ? ` Skipped ${result.skipped}.` : ""),
			);
			onOpenChange(false);
			reset();
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[640px]">
				<DialogHeader>
					<DialogTitle>Bulk import members</DialogTitle>
					<DialogDescription>
						Paste rows as{" "}
						<span className="font-semibold">name, email, phone</span> (office
						optional) — one per line. Comma-separated or copy straight from a
						spreadsheet (tab-separated). Review the preview, then import.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						rows={5}
						placeholder={
							"Jane Doe, jane@club.org, 19165551234, President\nJohn Smith, john@club.org, 19165555678"
						}
						className="w-full rounded-[10px] border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 font-mono text-[12.5px] text-[var(--sea-ink)] transition-colors hover:border-[var(--lagoon-deep)] focus:outline-none"
					/>

					{preview.length > 0 ? (
						<>
							<div className="text-[13px] text-[var(--sea-ink-soft)]">
								<span className="font-bold text-[var(--sea-ink)]">
									{importable.length}
								</span>{" "}
								to import
								{skipped > 0 ? (
									<>
										{" · "}
										<span className="font-bold text-[var(--warning-strong)]">
											{skipped}
										</span>{" "}
										skipped
									</>
								) : null}
							</div>

							<div className="max-h-[260px] overflow-auto rounded-[10px] border border-[var(--line)]">
								<table className="w-full text-[12.5px]">
									<thead className="sticky top-0 bg-[var(--foam)] text-[10.5px] font-extrabold tracking-[0.06em] text-[var(--sea-ink-soft)] uppercase">
										<tr>
											<th className="px-3 py-2 text-left">Name</th>
											<th className="px-3 py-2 text-left">Email</th>
											<th className="px-3 py-2 text-left">Phone</th>
											<th className="px-3 py-2 text-left">Office</th>
											<th className="px-3 py-2 text-left">Status</th>
										</tr>
									</thead>
									<tbody>
										{preview.map((row, i) => (
											<tr
												// biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no stable id
												key={i}
												className={cn(
													"border-t border-[var(--line)]",
													!row.willImport && "bg-[var(--warning-soft,#fdf3e7)]",
												)}
											>
												<td className="px-3 py-1.5 font-medium">
													{row.name || (
														<span className="text-[var(--sea-ink-soft)] italic">
															(blank)
														</span>
													)}
												</td>
												<td className="px-3 py-1.5 text-[var(--sea-ink-soft)]">
													{row.email || "—"}
												</td>
												<td className="px-3 py-1.5 text-[var(--sea-ink-soft)]">
													{row.phone || "—"}
												</td>
												<td className="px-3 py-1.5 text-[var(--sea-ink-soft)]">
													{row.office || "—"}
												</td>
												<td className="px-3 py-1.5">
													{row.willImport ? (
														<span className="font-semibold text-[var(--lagoon-deep)]">
															OK
														</span>
													) : (
														<span className="font-semibold text-[var(--warning-strong)]">
															{row.issues
																.map((issue) => ISSUE_LABELS[issue])
																.join(", ")}
														</span>
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</>
					) : null}
				</div>

				<DialogFooter>
					<DialogClose asChild>
						<Button type="button" variant="outline" disabled={busy}>
							Cancel
						</Button>
					</DialogClose>
					<Button type="button" disabled={!canSubmit} onClick={onCommit}>
						{busy
							? "Importing…"
							: `Import ${importable.length} member${importable.length === 1 ? "" : "s"}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
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
		to?: "/next";
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
	segment: { key: SegKey; label: string };
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
