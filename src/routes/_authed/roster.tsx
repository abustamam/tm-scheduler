import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	CheckCircle2,
	ChevronRight,
	Loader2,
	Mail,
	MailCheck,
	ShieldCheck,
	Upload,
	UserPlus,
} from "lucide-react";
import { type ChangeEvent, useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/club/member-avatar";
import { PageContainer } from "#/components/page-container";
import { Badge } from "#/components/ui/badge";
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
import { effectiveAdminClub } from "#/lib/effective-admin";
import { type InviteState, inviteStateOf } from "#/lib/invite-state";
import { formatTenure } from "#/lib/members";
import { officerPositionLabel } from "#/lib/officers";
import {
	buildImportPreview,
	type PreviewRow,
	parseRosterText,
} from "#/lib/roster-import";
import { cn } from "#/lib/utils";
import { inviteAllMembers, inviteMember } from "#/server/account-invite";
import { listClubMembers } from "#/server/club";
import { listUpcomingMeetings } from "#/server/meetings";
import { bulkImportMembers, mergeMembers } from "#/server/members";
import { listClubMemberPathways } from "#/server/pathways-read";
import type { PathViewModel } from "#/server/pathways-read-logic";
import {
	commitMemberUpload,
	previewMemberUpload,
} from "#/server/upload-members";

export const Route = createFileRoute("/_authed/roster")({
	loader: async ({ context }) => {
		const clubId = context.activeClubId;
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

// Roster grid: on small screens only Member + chevron; Speeches/Pathway
// (also hidden below) return at `sm`. Members can tap through for the detail.
const TABLE_GRID = "grid-cols-[1fr_34px] sm:grid-cols-[1fr_150px_170px_34px]";

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
	/** Contact email on file — gates whether an invite can be sent (#266). */
	email: string | null;
	/** Account-invite state: none / invited (link sent) / joined (linked) (#266). */
	inviteState: InviteState;
	/** Roster membership status (renewal): active vs unrenewed/inactive. */
	membershipStatus: "active" | "inactive";
	/** Compact label for the member's first synced Pathway, or null if none synced. */
	pathwayLabel: string | null;
	/**
	 * Holds an open officer term ⇒ effective club-admin (#202 / #270). Display
	 * only — surfaces that any office confers full admin; the auth model is
	 * unchanged.
	 */
	holdsOffice: boolean;
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
	const { clubs, currentMemberId, activeClubId, officerPositions } =
		Route.useRouteContext();
	const clubId = activeClubId;
	// Effective admin (#202): stored admin OR any elected officer can manage.
	const canManage = !!effectiveAdminClub({
		clubs,
		activeClubId,
		officerPositions,
	});
	const [seg, setSeg] = useState<SegKey>("all");
	const [mergeOpen, setMergeOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [csvOpen, setCsvOpen] = useState(false);
	const [inviteAllOpen, setInviteAllOpen] = useState(false);

	// The invite control adds a wider trailing column (icon button + chevron) for
	// managers; members see the original chevron-only layout. Fixed widths keep the
	// header and rows (independent grids) column-aligned.
	const gridCols = canManage
		? "grid-cols-[1fr_64px] sm:grid-cols-[1fr_140px_160px_64px]"
		: TABLE_GRID;

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
			email: m.email,
			inviteState: inviteStateOf({ userId: m.userId, invitedAt: m.invitedAt }),
			membershipStatus: m.status,
			pathwayLabel: pathwayLabelFor(pathways[m.id] ?? []),
			holdsOffice: m.officerPositions.length > 0,
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

	// How many not-yet-joined members with an email could be invited in bulk (#266).
	const invitableCount = rows.filter(
		(r) => r.inviteState !== "joined" && r.email,
	).length;

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
			<div className="mb-5 flex flex-wrap items-end gap-5">
				<div className="min-w-[240px] flex-1">
					<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
						Club roster
					</h1>
					<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
						Every member of your club at a glance · Spring 2026 term
					</p>
				</div>
				<div className="flex gap-2">
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
					{clubId && canManage && invitableCount > 0 ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setInviteAllOpen(true)}
						>
							<UserPlus aria-hidden />
							Invite all
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
					{clubId && canManage ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setCsvOpen(true)}
						>
							<Upload aria-hidden />
							Upload TM CSV
						</Button>
					) : null}
					<Button size="sm">+ Add member</Button>
				</div>
			</div>

			{/* Stat cards */}
			<div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(168px,1fr))] gap-3">
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
					className={cn(
						"grid gap-3.5 border-b border-[var(--line)] bg-[var(--foam)] px-5 py-3 text-xs font-extrabold tracking-[0.08em] text-[var(--sea-ink-soft)] uppercase",
						gridCols,
					)}
				>
					<div>Member</div>
					<div className="hidden sm:block">Speeches</div>
					<div className="hidden sm:block">Pathway</div>
					<div className="justify-self-end">{canManage ? "Account" : ""}</div>
				</div>

				{visible.length === 0 ? (
					rows.length === 0 ? (
						<div className="px-5 py-12 text-center">
							<p className="text-sm font-semibold text-[var(--sea-ink)]">
								No members yet
							</p>
							{canManage ? (
								<>
									<p className="mx-auto mt-1.5 max-w-sm text-sm text-[var(--sea-ink-soft)]">
										Import your club's roster to get everyone set up — paste
										names and emails, or add them one at a time.
									</p>
									<Button
										size="sm"
										className="mt-4"
										onClick={() => setImportOpen(true)}
									>
										Import your roster
									</Button>
								</>
							) : (
								<p className="mx-auto mt-1.5 max-w-sm text-sm text-[var(--sea-ink-soft)]">
									Once an officer adds the club's roster, members will show up
									here.
								</p>
							)}
						</div>
					) : (
						<p className="px-5 py-10 text-center text-sm text-[var(--sea-ink-soft)]">
							No members match this filter.
						</p>
					)
				) : (
					visible.map((m) => (
						// Overlay-link row: the profile Link fills the row (absolute inset)
						// as the click target while the invite button sits above it, so the
						// button never nests inside an anchor. Content cells are
						// pointer-events-none so clicks fall through to the Link.
						<div
							key={m.id}
							className={cn(
								"group relative grid items-center gap-3.5 border-b border-[var(--line)] px-5 py-3 transition-colors last:border-b-0 hover:bg-[var(--foam)]",
								gridCols,
								m.membershipStatus === "inactive" && "opacity-55",
							)}
						>
							<Link
								to="/members/$id"
								params={{ id: m.id }}
								aria-label={`Open ${m.name}'s profile`}
								className="absolute inset-0 z-0 cursor-pointer"
							/>

							{/* Member */}
							<div className="pointer-events-none relative z-[1] flex min-w-0 items-center gap-3">
								<MemberAvatar tone={m.tone} initials={m.initials} size={38} />
								<div className="min-w-0 leading-[1.25]">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-bold">{m.name}</span>
										{m.holdsOffice ? (
											<Badge
												variant="secondary"
												className="hidden sm:inline-flex"
												title="Holding an officer term grants full club-admin access."
											>
												<ShieldCheck aria-hidden />
												Officer · full admin
											</Badge>
										) : null}
										{m.membershipStatus === "inactive" ? (
											<span className="shrink-0 rounded-full border border-[var(--line)] bg-[var(--sand)] px-2 py-0.5 text-xs font-bold tracking-[0.03em] text-[var(--sea-ink-soft)] uppercase">
												Inactive
											</span>
										) : null}
									</div>
									<div className="text-xs text-[var(--sea-ink-soft)]">
										{m.tenure}
									</div>
								</div>
							</div>

							{/* Speeches */}
							<div className="pointer-events-none relative z-[1] hidden text-sm font-bold text-[var(--sea-ink)] sm:block">
								{m.speeches}
								<span className="text-xs font-medium text-[var(--sea-ink-soft)]">
									{" "}
									given
								</span>
							</div>

							{/* Pathway */}
							<div className="pointer-events-none relative z-[1] hidden min-w-0 truncate text-xs text-[var(--sea-ink-soft)] sm:block">
								{m.pathwayLabel ?? "—"}
							</div>

							{/* Invite control (managers) + chevron */}
							<div className="relative z-[2] flex items-center justify-self-end gap-1.5">
								{canManage && clubId ? (
									<RowInviteControl
										clubId={clubId}
										memberId={m.id}
										email={m.email}
										state={m.inviteState}
									/>
								) : null}
								<span className="pointer-events-none text-[var(--sea-ink-soft)] opacity-45 transition-all group-hover:translate-x-0.5 group-hover:opacity-100">
									<ChevronRight className="size-4" aria-hidden />
								</span>
							</div>
						</div>
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

			{clubId && canManage ? (
				<CsvUploadDialog
					open={csvOpen}
					onOpenChange={setCsvOpen}
					clubId={clubId}
				/>
			) : null}

			{clubId && canManage ? (
				<InviteAllDialog
					open={inviteAllOpen}
					onOpenChange={setInviteAllOpen}
					clubId={clubId}
					invitableCount={invitableCount}
				/>
			) : null}
		</PageContainer>
	);
}

/**
 * Per-row account-invite control (#266). "Joined" members show a static badge;
 * everyone else gets a one-tap invite (resend when already invited). Disabled
 * with a hint when there's no email on file — invites only ever go to the
 * member's own address (the server enforces this too).
 */
function RowInviteControl({
	clubId,
	memberId,
	email,
	state,
}: {
	clubId: string;
	memberId: string;
	email: string | null;
	state: InviteState;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	if (state === "joined") {
		return (
			<span
				title="This member has an account"
				className="inline-flex items-center text-[var(--lagoon-deep)]"
			>
				<CheckCircle2 className="size-4" aria-hidden />
				<span className="sr-only">Joined</span>
			</span>
		);
	}

	const noEmail = !email;

	async function onInvite() {
		if (busy || noEmail) return;
		setBusy(true);
		try {
			const res = await inviteMember({ data: { clubId, memberId } });
			if (res.outcome === "no_email") {
				toast.error("Add an email for this member first.");
			} else if (res.outcome === "already_joined") {
				toast.info("They already have an account.");
			} else {
				toast.success("Invite sent.");
			}
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't send invite.");
		} finally {
			setBusy(false);
		}
	}

	const label = noEmail
		? "Add an email to invite this member"
		: state === "invited"
			? "Resend account invite"
			: "Send account invite";

	return (
		<button
			type="button"
			onClick={onInvite}
			disabled={busy || noEmail}
			title={label}
			aria-label={label}
			className={cn(
				"inline-flex size-7 items-center justify-center rounded-md border border-[var(--line)] bg-[var(--surface-strong)] text-[var(--sea-ink-soft)] transition-colors hover:border-[var(--lagoon-deep)] hover:text-[var(--lagoon-deep)] disabled:cursor-not-allowed disabled:opacity-40",
				state === "invited" && "text-[var(--lagoon-deep)]",
			)}
		>
			{busy ? (
				<Loader2 className="size-4 animate-spin" aria-hidden />
			) : state === "invited" ? (
				<MailCheck className="size-4" aria-hidden />
			) : (
				<Mail className="size-4" aria-hidden />
			)}
		</button>
	);
}

/** Confirm + send account invites to every not-yet-joined member with an email
 *  in one action (#266). Summarizes the send afterward (sent / already joined /
 *  skipped-no-email). */
function InviteAllDialog({
	open,
	onOpenChange,
	clubId,
	invitableCount,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	clubId: string;
	invitableCount: number;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	async function onSend() {
		setBusy(true);
		try {
			const res = await inviteAllMembers({ data: { clubId } });
			toast.success(
				`Sent ${res.sent} invite${res.sent === 1 ? "" : "s"}.` +
					(res.noEmail > 0 ? ` ${res.noEmail} skipped (no email).` : ""),
			);
			onOpenChange(false);
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
					<DialogTitle>Invite everyone to claim their account</DialogTitle>
					<DialogDescription>
						We'll email a magic-link account invite to{" "}
						<span className="font-semibold">{invitableCount}</span> member
						{invitableCount === 1 ? "" : "s"} who haven't joined yet and have an
						email on file. Members already signed in are skipped.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<DialogClose asChild>
						<Button type="button" variant="outline" disabled={busy}>
							Cancel
						</Button>
					</DialogClose>
					<Button type="button" onClick={onSend} disabled={busy}>
						{busy
							? "Sending…"
							: `Send ${invitableCount} invite${invitableCount === 1 ? "" : "s"}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

type CsvPreview = Awaited<ReturnType<typeof previewMemberUpload>>;

const CSV_ACTION_META: Record<
	CsvPreview["rows"][number]["action"],
	{ label: string; className: string }
> = {
	insert: { label: "New", className: "text-[var(--lagoon-deep)]" },
	update: { label: "Update", className: "text-[var(--sea-ink)]" },
	skip: { label: "Skip", className: "text-[var(--warning-strong)]" },
};

/**
 * VPE-only upload of the official Toastmasters membership CSV export (#62).
 * Reads the file, shows a server-computed insert/update/skip diff (the shared
 * parse/match/fill-only logic — never trusting the client), then commits.
 */
function CsvUploadDialog({
	open,
	onOpenChange,
	clubId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	clubId: string;
}) {
	const router = useRouter();
	const [fileName, setFileName] = useState<string | null>(null);
	const [csv, setCsv] = useState<string | null>(null);
	const [preview, setPreview] = useState<CsvPreview | null>(null);
	const [previewing, setPreviewing] = useState(false);
	const [committing, setCommitting] = useState(false);

	function reset() {
		setFileName(null);
		setCsv(null);
		setPreview(null);
		setPreviewing(false);
		setCommitting(false);
	}

	async function onFile(e: ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		// Allow re-selecting the same file later (onChange won't fire otherwise).
		e.target.value = "";
		if (!file) return;
		setFileName(file.name);
		setPreview(null);
		setCsv(null);
		setPreviewing(true);
		try {
			const text = await file.text();
			const p = await previewMemberUpload({ data: { clubId, csv: text } });
			setCsv(text);
			setPreview(p);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't read that file.",
			);
			setFileName(null);
		} finally {
			setPreviewing(false);
		}
	}

	async function onCommit() {
		if (!csv || !preview) return;
		setCommitting(true);
		try {
			const result = await commitMemberUpload({ data: { clubId, csv } });
			const { membersCreated, membersUpdated } = result.stats;
			toast.success(
				`Imported ${membersCreated} new, updated ${membersUpdated}` +
					(result.unpaidSkipped > 0
						? ` · ${result.unpaidSkipped} unpaid skipped`
						: ""),
			);
			onOpenChange(false);
			reset();
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setCommitting(false);
		}
	}

	const changes = preview
		? preview.summary.toInsert + preview.summary.toUpdate
		: 0;
	const canCommit = changes > 0 && !committing && !previewing;

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				onOpenChange(o);
				if (!o) reset();
			}}
		>
			<DialogContent className="sm:max-w-[680px]">
				<DialogHeader>
					<DialogTitle>Upload Toastmasters membership CSV</DialogTitle>
					<DialogDescription>
						Upload the official membership export from Toastmasters. Only{" "}
						<span className="font-semibold">paid members</span> are imported;
						real join dates fill in, and existing names, emails and phones are
						never overwritten. Review the preview, then confirm.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-[var(--line)] bg-[var(--foam)] px-4 py-3 text-sm transition-colors hover:border-[var(--lagoon-deep)]">
						<Upload className="size-4 text-[var(--sea-ink-soft)]" aria-hidden />
						<span className="font-semibold text-[var(--sea-ink)]">
							{fileName ?? "Choose a .csv file…"}
						</span>
						<input
							type="file"
							accept=".csv,text/csv"
							className="sr-only"
							onChange={onFile}
						/>
					</label>

					{previewing ? (
						<p className="text-sm text-[var(--sea-ink-soft)]">
							Reading and matching rows…
						</p>
					) : null}

					{preview ? (
						<>
							<div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--sea-ink-soft)]">
								<span>
									<span className="font-bold text-[var(--lagoon-deep)]">
										{preview.summary.toInsert}
									</span>{" "}
									new
								</span>
								<span>
									<span className="font-bold text-[var(--sea-ink)]">
										{preview.summary.toUpdate}
									</span>{" "}
									to update
								</span>
								{preview.summary.toSkip > 0 ? (
									<span>
										<span className="font-bold text-[var(--warning-strong)]">
											{preview.summary.toSkip}
										</span>{" "}
										skipped
									</span>
								) : null}
								{preview.unpaidSkipped > 0 ? (
									<span>
										<span className="font-bold">{preview.unpaidSkipped}</span>{" "}
										unpaid (not imported)
									</span>
								) : null}
							</div>

							{preview.summary.ambiguous > 0 ||
							preview.summary.unparseablePositions > 0 ? (
								<p className="text-xs text-[var(--warning-strong)]">
									{preview.summary.ambiguous > 0
										? `${preview.summary.ambiguous} row(s) share an email and were added as separate members. `
										: ""}
									{preview.summary.unparseablePositions > 0
										? `${preview.summary.unparseablePositions} office title(s) couldn't be recognized and were left blank.`
										: ""}
								</p>
							) : null}

							{preview.rows.length > 0 ? (
								<div className="max-h-[300px] overflow-auto rounded-lg border border-[var(--line)]">
									<table className="w-full text-xs">
										<thead className="sticky top-0 bg-[var(--foam)] text-xs font-extrabold tracking-[0.06em] text-[var(--sea-ink-soft)] uppercase">
											<tr>
												<th className="px-3 py-2 text-left">Member</th>
												<th className="px-3 py-2 text-left">Email</th>
												<th className="px-3 py-2 text-left">Action</th>
												<th className="px-3 py-2 text-left">Details</th>
											</tr>
										</thead>
										<tbody>
											{preview.rows.map((row, i) => {
												const meta = CSV_ACTION_META[row.action];
												return (
													<tr
														// biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no stable id
														key={i}
														className={cn(
															"border-t border-[var(--line)]",
															row.action === "skip" &&
																"bg-[var(--warning-soft,#fdf3e7)]",
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
														<td
															className={cn(
																"px-3 py-1.5 font-semibold",
																meta.className,
															)}
														>
															{meta.label}
														</td>
														<td className="px-3 py-1.5 text-[var(--sea-ink-soft)]">
															{row.note ?? "—"}
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
							) : null}
						</>
					) : null}
				</div>

				<DialogFooter>
					<DialogClose asChild>
						<Button type="button" variant="outline" disabled={committing}>
							Cancel
						</Button>
					</DialogClose>
					<Button type="button" disabled={!canCommit} onClick={onCommit}>
						{committing
							? "Importing…"
							: changes > 0
								? `Import ${changes} member${changes === 1 ? "" : "s"}`
								: "Import"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
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
						className="w-full rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 font-mono text-xs text-[var(--sea-ink)] transition-colors hover:border-[var(--lagoon-deep)] focus:outline-none"
					/>

					{preview.length > 0 ? (
						<>
							<div className="text-sm text-[var(--sea-ink-soft)]">
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

							<div className="max-h-[260px] overflow-auto rounded-lg border border-[var(--line)]">
								<table className="w-full text-xs">
									<thead className="sticky top-0 bg-[var(--foam)] text-xs font-extrabold tracking-[0.06em] text-[var(--sea-ink-soft)] uppercase">
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
		"h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-3 text-sm font-medium text-[var(--sea-ink)] transition-colors hover:border-[var(--lagoon-deep)]";

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
						<p className="text-sm font-medium text-[var(--warning-strong)]">
							Pick two different members.
						</p>
					) : keeper && absorbed ? (
						<p className="text-sm text-[var(--sea-ink-soft)]">
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
			<div className="text-xs font-bold tracking-[0.04em] text-[var(--sea-ink-soft)] uppercase">
				{stat.label}
			</div>
			<div className="mt-2 flex items-baseline gap-2">
				<span
					className={cn(
						"font-display text-3xl leading-none font-semibold",
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
		"rounded-xl border bg-[var(--surface-strong)] px-4 py-4 shadow-[0_1px_0_var(--inset-glint)_inset,0_8px_20px_rgba(23,58,64,.05)] transition-transform hover:-translate-y-0.5",
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
				"inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-semibold transition-transform active:scale-[0.97]",
				active
					? "border-[var(--sea-ink)] bg-[var(--sea-ink)] text-[var(--background)]"
					: "border-[var(--line)] bg-[var(--surface-strong)] text-[var(--sea-ink-soft)]",
			)}
		>
			{segment.label}
			<span
				className={cn(
					"inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-bold",
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
