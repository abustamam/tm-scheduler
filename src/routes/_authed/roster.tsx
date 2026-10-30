import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	CheckCircle2,
	ChevronRight,
	Download,
	Loader2,
	Mail,
	MailCheck,
	ShieldCheck,
	Upload,
	UserPlus,
} from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/club/member-avatar";
import { CONTACT_METHOD_ICONS } from "#/components/contact-method-icon";
import { RosterSkeleton } from "#/components/members/roster-skeleton";
import { PageContainer } from "#/components/page-container";
import {
	ROSTER_FILTER_ROW_CLASS,
	ROSTER_STATS_GRID_CLASS,
	ROSTER_TABLE_GRID,
} from "#/components/route-layout";
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
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { WhatsAppPhoneLink } from "#/components/whatsapp-phone-link";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { clubExportUrl, exportLinkAllowed } from "#/lib/club-export-url";
import { DEMO_INVITE_NOT_SENT } from "#/lib/demo-club-copy";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { formatCalendarDay } from "#/lib/format";
import { type InviteState, inviteStateOf } from "#/lib/invite-state";
import { formatTenure } from "#/lib/members";
import { foreignSkipSummary } from "#/lib/members-import-plan";
import { OFFICER_POSITION_LABELS, officerPositionLabel } from "#/lib/officers";
import { navPageTitle } from "#/lib/page-title";
import {
	CONTACT_METHOD_LABELS,
	type ContactMethod,
	hasDialablePhone,
} from "#/lib/preferred-contact";
import { INVITE_CONFLICT_COPY } from "#/lib/roster-conflict-copy";
import {
	buildImportPreview,
	type PreviewRow,
	parseRosterText,
	type RowIssue,
} from "#/lib/roster-import";
import {
	FORMER_MEMBER_LABEL,
	FORMER_MEMBER_MESSAGE,
	flagFormerMatches,
	type PreviewRowWithFormer,
} from "#/lib/roster-import-former";
import { cn } from "#/lib/utils";
import { inviteAllMembers, inviteMember } from "#/server/account-invite";
import { listClubMembers } from "#/server/club";
import { listUpcomingMeetings } from "#/server/meetings";
import {
	bulkImportMembers,
	listFormerMembers,
	mergeMembers,
	setMemberStatus,
} from "#/server/members";
import { listClubMemberPathways } from "#/server/pathways-read";
import type { PathViewModel } from "#/server/pathways-read-logic";
import {
	commitMemberUpload,
	previewMemberUpload,
} from "#/server/upload-members";

/** One row of `listFormerMembers` (#1239). */
type FormerMemberItem = { id: string; name: string; endedAt: string | null };

/** `?formerPathways=true`: an officer asked to see inactive members' Pathways (never former, #1342). */
type RosterSearch = { formerPathways?: true };

export const Route = createFileRoute("/_authed/roster")({
	validateSearch: (search: Record<string, unknown>): RosterSearch =>
		search.formerPathways === true || search.formerPathways === "true"
			? { formerPathways: true }
			: {},
	loaderDeps: ({ search }) => ({
		includeFormer: search.formerPathways === true,
	}),
	loader: async ({ context, deps }) => {
		const clubId = context.activeClubId;
		if (!clubId) {
			return {
				members: [],
				openRoles: 0,
				pathways: {},
				formerPathwaysRequested: false,
				formerMembers: [] as FormerMemberItem[],
				formerFailed: false,
				// Nothing is dated without a club, so any fixed zone will do.
				timezone: "UTC",
				now: Date.now(),
			};
		}
		// The admin the server fn will actually serve: an effective admin, minus
		// "View as this club" (a read-only session passes the client admin check
		// but `listFormerMembers` refuses it). The component uses the same test.
		const isAdmin =
			!!context.clubs &&
			!!effectiveAdminClub({
				clubs: context.clubs,
				activeClubId: clubId,
				officerPositions: context.officerPositions ?? [],
			}) &&
			exportLinkAllowed(context.impersonating, clubId);
		let formerFailed = false;
		const [members, upcoming, pathways, { timezone }, formerMembers] =
			await Promise.all([
				listClubMembers({ data: clubId }),
				listUpcomingMeetings({ data: clubId }),
				// A request only: the server returns inactive members' paths just to an
				// officer or admin, whatever the URL says.
				listClubMemberPathways({
					data: { clubId, includeFormer: deps.includeFormer },
				}),
				// Tenure is counted on the CLUB's calendar (#1017). Imported here, as
				// club-settings imports its promo template, so the route module does
				// not pull `#/server/clubs` (whose logic modules reach `#/db`) into
				// everything that imports this page.
				import("#/server/clubs").then(({ loadClubTimezoneSettings }) =>
					loadClubTimezoneSettings({ data: clubId }),
				),
				// Admin-only list (#1239): the server fn is the gate. Only a user who
				// will see the link asks, so a failure here is a real failure: it is
				// flagged and shown on the link, never rendered as "(0)".
				isAdmin
					? listFormerMembers({ data: { clubId } }).catch(() => {
							formerFailed = true;
							return [] as FormerMemberItem[];
						})
					: Promise.resolve([] as FormerMemberItem[]),
			]);
		return {
			members,
			openRoles: upcoming[0]?.openSlots ?? 0,
			pathways,
			formerPathwaysRequested: deps.includeFormer,
			formerMembers,
			formerFailed,
			timezone,
			// Pinned here, not sampled while rendering, so the SSR pass and the
			// hydration pass count tenure months from one instant (#1017).
			now: Date.now(),
		};
	},
	pendingMs: 150,
	pendingComponent: RosterSkeleton,
	component: Roster,
	head: ({ match }) => ({
		meta: [{ title: navPageTitle("/roster", match.context) }],
	}),
});

// Roster grid: on small screens only Member + chevron (tap through for the
// detail); Speeches/Pathway return at `sm`, Phone at `xl` — a fifth fixed column
// can only take width FROM the `1fr` Member one, which carries the member's
// NAME. Measured in the browser (manager grid, 18-member club), Member column
// width with Phone gated at `sm` vs. shipped without the column at all:
//
//   viewport   at `sm`   without Phone
//   640px        0px *      136px
//   768px      100px        264px
//   1024px     108px        272px
//   1280px     364px        528px
//
//   * zero, not merely narrow: the name is gone entirely and the avatar overlaps
//     the Speeches column. The four fixed columns also want 570px inside a 542px
//     content box, so the card's `overflow-hidden` clips the trailing chevron
//     and part of the invite button (32 of the Account column's 39 visible px
//     survive).
//
// `lg` is no better — the 248px app sidebar returns at exactly that tier and
// eats the viewport gain. `xl` is the first tier where the column is free: full
// names, no clipping, every width below it laid out as it was before.
// The string lives in `route-layout.ts` so the loading skeleton shares it.
const TABLE_GRID = ROSTER_TABLE_GRID;

// The same grid for a MANAGER, whose trailing Account column carries an invite
// button beside the chevron (64px vs 34px) and pays for it out of Speeches and
// Pathway. Named here rather than left inline at its use site 66 lines below, so
// the measurement table above governs both templates — the measurements were
// taken on THIS one, and the two have to grow a column together or the header
// and body grids fall out of alignment (`roster.test.tsx` pins that).
const MANAGER_TABLE_GRID =
	"grid-cols-[1fr_64px] sm:grid-cols-[1fr_140px_160px_64px] xl:grid-cols-[1fr_140px_160px_150px_64px]";

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
	/**
	 * Contact phone on file, server-coalesced: E.164 where it can be derived,
	 * otherwise the stored value VERBATIM. Not a guarantee of E.164 —
	 * `coalesceToE164` deliberately preserves a value it cannot normalize
	 * ("ask at church"), which `WhatsAppPhoneLink` then renders as plain text
	 * rather than a dead link. The cell's `pointer-events` keys off that same
	 * distinction, so treating this as always-dialable is what put a live-but-dead
	 * click box on those rows.
	 */
	phone: string | null;
	/**
	 * How they want to be reached (#1093), already the EFFECTIVE value from the
	 * server: null when there is no preference or its data has gone.
	 */
	preferredContact: ContactMethod | null;
	/** Account-invite state: none / invited (link sent) / joined (linked) (#266). */
	inviteState: InviteState;
	/** Roster membership status (renewal): active vs unrenewed/inactive. */
	membershipStatus: "active" | "inactive" | "former";
	/** A former member whose Pathways this view does not show (#958). */
	pathwayWithheld: boolean;
	/** Compact label for the member's first synced Pathway, or null if none synced. */
	pathwayLabel: string | null;
	/**
	 * Holds an open officer term ⇒ effective club-admin (#202 / #270). Display
	 * only — surfaces that any office confers full admin; the auth model is
	 * unchanged.
	 */
	holdsOffice: boolean;
}

/**
 * A small icon for a member's effective preferred contact method, or nothing.
 * `role="img"` with an `aria-label` ("Prefers SMS"), so it is announced.
 */
function PreferredContactIcon({ method }: { method: ContactMethod | null }) {
	if (!method) return null;
	const Icon = CONTACT_METHOD_ICONS[method];
	const label = `Prefers ${CONTACT_METHOD_LABELS[method]}`;
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			data-testid="preferred-contact-icon"
			className="inline-flex shrink-0 text-muted-foreground"
		>
			<Icon className="size-3.5" aria-hidden />
		</span>
	);
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
	const {
		members,
		openRoles,
		pathways,
		formerPathwaysRequested,
		formerMembers: formerList,
		formerFailed,
		timezone,
		now,
	} = Route.useLoaderData();
	const formerMembers = formerList ?? [];
	const clock = { now: new Date(now), timeZone: timezone };
	const { clubs, activeClubId, officerPositions, impersonating } =
		Route.useRouteContext();
	const clubId = activeClubId;
	const navigate = Route.useNavigate();
	// Effective admin (#202): stored admin OR any elected officer can manage.
	const canManage = !!effectiveAdminClub({
		clubs,
		activeClubId,
		officerPositions,
	});
	// An admin the admin-only server paths will actually serve: `canManage`,
	// minus "View as this club". That read-only session passes every client
	// admin check (`getAuthContext` surfaces it as `clubRole: "admin"`) while
	// the export route and `mayRevealFormerMembers` both refuse it. Gates the
	// export link and the "Show inactive members' Pathways" control alike; the
	// server enforces each on its own.
	const servedAsAdmin =
		!!clubId && canManage && exportLinkAllowed(impersonating, clubId);
	const showFormerPathways = servedAsAdmin && formerPathwaysRequested === true;
	const [seg, setSeg] = useState<SegKey>("all");
	const [mergeOpen, setMergeOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [csvOpen, setCsvOpen] = useState(false);
	const [inviteAllOpen, setInviteAllOpen] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	const [formerOpen, setFormerOpen] = useState(false);

	// The invite control adds a wider trailing column (icon button + chevron) for
	// managers; members see the original chevron-only layout. Fixed widths keep the
	// header and rows (independent grids) column-aligned.
	const gridCols = canManage ? MANAGER_TABLE_GRID : TABLE_GRID;

	// Identity, tenure, speeches, membership status and Pathways progress are all real.
	// A former member (#1239) is on no segment; the server already leaves them
	// out, and this keeps the view honest if one ever arrives.
	const rows: RosterRow[] = members
		.filter((m) => m.status !== "former")
		.map((m) => {
			const joined = m.joinedAt ?? m.createdAt;
			const pathwayWithheld = m.status === "inactive" && !showFormerPathways;
			const tenure = formatTenure(joined, clock);
			return {
				id: m.id,
				name: m.name,
				initials: initialsOf(m.name),
				tone: toneFromSeed(m.id),
				tenure: m.officerPositions.length
					? `${tenure} · ${m.officerPositions.map(officerPositionLabel).join(", ")}`
					: tenure,
				speeches: m.speeches,
				email: m.email,
				phone: m.phone,
				preferredContact: m.preferredContact,
				inviteState: inviteStateOf({
					userId: m.userId,
					invitedAt: m.invitedAt,
				}),
				membershipStatus: m.status,
				pathwayWithheld,
				// The server already leaves a former member's paths out unless an
				// officer opted in; this keeps the cell honest if it ever sends them.
				pathwayLabel: pathwayWithheld
					? null
					: pathwayLabelFor(pathways[m.id] ?? []),
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
			// The rows are current members only (#1328): a former member's speeches
			// are not in this sum, so the card must not say "all time".
			note: "current members",
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
					<p className="mt-1 text-sm text-muted-foreground">
						Every member of your club at a glance · Spring 2026 term
					</p>
				</div>
				{/* `flex-wrap` (#999): an officer sees up to six actions here, about
				    790px of buttons, and the column beside a 248px sidebar at 1024px is
				    narrower than that. Unwrapped, "+ Add member" ran past the edge. */}
				<div className="flex flex-wrap gap-2">
					{/* A plain link to the export route (#915), shown only to whoever
					    the route will serve (`servedAsAdmin`, above): the client half of
					    the route's `requireClubRole(…, ["admin"])`, minus "View as this
					    club", which that guard refuses. It replaced an "Export CSV" button with no action. */}
					{clubId && servedAsAdmin ? (
						<Button asChild variant="outline" size="sm">
							<a href={clubExportUrl(clubId)} download>
								<Download aria-hidden />
								Export club data
							</a>
						</Button>
					) : null}
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
					{clubId && canManage ? (
						<Button size="sm" onClick={() => setAddOpen(true)}>
							+ Add member
						</Button>
					) : null}
				</div>
			</div>

			{/* Stat cards */}
			<div className={ROSTER_STATS_GRID_CLASS}>
				{stats.map((s) => (
					<StatCard key={s.label} stat={s} />
				))}
			</div>

			{/* Segment filters (membership status) */}
			<div className={ROSTER_FILTER_ROW_CLASS}>
				{ROSTER_SEGMENTS.map((s) => (
					<SegmentChip
						key={s.key}
						segment={s}
						count={countFor(s.key)}
						active={seg === s.key}
						onSelect={() => setSeg(s.key)}
					/>
				))}
				{servedAsAdmin && (formerMembers.length > 0 || formerFailed) ? (
					<button
						type="button"
						className={cn(
							"inline-flex min-h-11 items-center rounded-full px-3 text-sm font-semibold underline-offset-4 hover:underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
							formerFailed ? "text-destructive" : "text-link",
						)}
						onClick={() => setFormerOpen(true)}
					>
						{formerFailed
							? "Former members (couldn't load)"
							: `Former members (${formerMembers.length})`}
					</button>
				) : null}
				{servedAsAdmin ? (
					<label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
						<input
							type="checkbox"
							className="size-4 accent-foreground"
							checked={showFormerPathways}
							onChange={(e) =>
								navigate({
									search: e.target.checked ? { formerPathways: true } : {},
									replace: true,
								})
							}
						/>
						Show inactive members' Pathways
					</label>
				) : null}
			</div>

			{/* Table */}
			<div className="overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-[0_14px_30px_rgba(23,58,64,.06)]">
				<div
					className={cn(
						"grid gap-3.5 border-b border-border bg-surface-soft px-5 py-3 text-xs font-bold tracking-[0.08em] text-muted-foreground uppercase",
						gridCols,
					)}
				>
					<div>Member</div>
					<div className="hidden sm:block">Speeches</div>
					<div className="hidden sm:block">Pathway</div>
					<div className="hidden xl:block">Phone</div>
					<div className="justify-self-end">{canManage ? "Account" : ""}</div>
				</div>

				{visible.length === 0 ? (
					rows.length === 0 ? (
						<div className="px-5 py-12 text-center">
							<p className="text-sm font-semibold text-foreground">
								No members yet
							</p>
							{canManage ? (
								<>
									<p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
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
								<p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
									Once an officer adds the club's roster, members will show up
									here.
								</p>
							)}
						</div>
					) : (
						<p className="px-5 py-10 text-center text-sm text-muted-foreground">
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
								"group relative grid items-center gap-3.5 border-b border-border px-5 py-3 transition-colors last:border-b-0 hover:bg-surface-soft",
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
										<PreferredContactIcon method={m.preferredContact} />
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
											<span className="shrink-0 rounded-full border border-border bg-surface-muted px-2 py-0.5 text-xs font-bold tracking-[0.03em] text-muted-foreground uppercase">
												Inactive
											</span>
										) : null}
									</div>
									<div className="text-xs text-muted-foreground">
										{m.tenure}
									</div>
								</div>
							</div>

							{/* Speeches */}
							<div className="pointer-events-none relative z-[1] hidden text-sm font-bold text-foreground sm:block">
								{m.speeches}
								<span className="text-xs font-semibold text-muted-foreground">
									{" "}
									given
								</span>
							</div>

							{/* Pathway */}
							<div className="pointer-events-none relative z-[1] hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
								{m.pathwayLabel ??
									// An officer is told the column is hidden, not empty; anyone
									// else sees the ordinary "no paths" dash. The explanation sits
									// on its own pointer-events-auto span: a title on the
									// pointer-events-none cell never shows, and a title alone is
									// invisible to assistive tech, hence the sr-only copy.
									(m.pathwayWithheld && servedAsAdmin ? (
										<span
											className="pointer-events-auto cursor-help"
											title={PATHWAYS_HIDDEN_NOTE}
										>
											Hidden
											<span className="sr-only">. {PATHWAYS_HIDDEN_NOTE}</span>
										</span>
									) : (
										"—"
									))}
							</div>

							{/* Phone. LIVE only when there is a link to click — the
							    live-ness has to follow the anchor, not the column.
							
							    `z-[2]` and no `pointer-events-none` is what lets a tap reach
							    the anchor at all: the row's overlay <Link> sits under every
							    cell and would otherwise swallow it and open the profile
							    instead of WhatsApp (same trick as the invite control below),
							    and `w-fit` keeps that live box to the number itself so the
							    rest of the column still falls through.
							
							    But TWO of the component's three branches render nothing
							    clickable — the `fallback` dash, and a digit-less value like
							    "ask at church" which renders as a plain <span>. Applied
							    unconditionally, those rows get a box that is live and dead:
							    the click is swallowed instead of falling through, so that
							    patch of the row silently stops opening the profile.
							
							    Keyed on DIGITS, not on `m.phone` being non-empty, because
							    `whatsappHref` returns null (⇒ no anchor) for anything with no
							    digits — a truthiness check would leave the digit-less branch
							    dead-but-live, which is the same bug on a narrower input. */}
							<div
								className={cn(
									"relative hidden min-w-0 truncate text-xs text-muted-foreground xl:block",
									hasDialablePhone(m.phone)
										? "z-[2] w-fit max-w-full"
										: "pointer-events-none",
								)}
							>
								<WhatsAppPhoneLink phone={m.phone} name={m.name} fallback="—" />
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
								<span className="pointer-events-none text-muted-foreground opacity-45 transition-[transform,opacity] group-hover:translate-x-0.5 group-hover:opacity-100">
									<ChevronRight className="size-4" aria-hidden />
								</span>
							</div>
						</div>
					))
				)}
			</div>

			<p className="mt-3.5 px-0.5 text-xs text-muted-foreground">
				Tip: click any member to open their profile, speech log and roles
				served.
			</p>

			{clubId && servedAsAdmin ? (
				<FormerMembersDialog
					open={formerOpen}
					onOpenChange={setFormerOpen}
					clubId={clubId}
					formerMembers={formerMembers}
					failed={formerFailed === true}
				/>
			) : null}

			{clubId ? (
				<MergeMembersDialog
					open={mergeOpen}
					onOpenChange={setMergeOpen}
					members={members}
					clubId={clubId}
				/>
			) : null}

			{clubId && canManage ? (
				<BulkImportDialog
					open={importOpen}
					onOpenChange={setImportOpen}
					existing={members}
					formerNames={formerMembers.map((m) => m.name)}
					clubId={clubId}
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

			{clubId && canManage ? (
				<AddMemberDialog
					open={addOpen}
					onOpenChange={setAddOpen}
					existing={members}
					formerNames={formerMembers.map((m) => m.name)}
					clubId={clubId}
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
				className="inline-flex items-center text-link"
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
			if (res.notSent === "demo") {
				toast.info(DEMO_INVITE_NOT_SENT);
			} else if (res.outcome === "no_email") {
				toast.error("Add an email for this member first.");
			} else if (res.outcome === "roster_conflict") {
				// The one refusal an unqualified success toast used to hide (#756
				// review): the link would be delivered, an account minted, and the
				// claim would then refuse — leaving this row showing "invited"
				// forever with nothing on any screen naming the reason.
				toast.error(
					res.obstacle
						? INVITE_CONFLICT_COPY[res.obstacle]
						: "No invite sent — this member's roster entries need sorting out first.",
				);
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
				"inline-flex size-7 items-center justify-center rounded-md border border-border bg-surface-raised text-muted-foreground transition-colors hover:border-link-fill hover:text-link disabled:cursor-not-allowed disabled:opacity-40",
				state === "invited" && "text-link",
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
			// The demo club sends no mail (#1200); say so instead of "Sent 0 invites.",
			// and keep the skip counts, which are still true there.
			const head =
				res.notSent === "demo"
					? DEMO_INVITE_NOT_SENT
					: `Sent ${res.sent} invite${res.sent === 1 ? "" : "s"}.`;
			const summary =
				head +
				(res.noEmail > 0 ? ` ${res.noEmail} skipped (no email).` : "") +
				(res.rosterConflict > 0
					? ` ${res.rosterConflict} skipped (another club's roster has a different email).`
					: "") +
				(res.recentlyInvited > 0
					? ` ${res.recentlyInvited} already invited recently.`
					: "") +
				(res.failed > 0
					? ` ${res.failed} couldn't be delivered — try those again tomorrow.`
					: "");
			// "Sent 0 invites." is not a success. Reporting it as one is how a bulk
			// send that reached nobody reads as a job done.
			if (res.sent === 0) toast.info(summary);
			else toast.success(summary);
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
	insert: { label: "New", className: "text-link" },
	update: { label: "Update", className: "text-foreground" },
	skip: { label: "Skip", className: "text-warning-strong" },
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
	const [selectedOfficers, setSelectedOfficers] = useState<string[]>([]);
	const [previewing, setPreviewing] = useState(false);
	const [committing, setCommitting] = useState(false);

	function reset() {
		setFileName(null);
		setCsv(null);
		setPreview(null);
		setSelectedOfficers([]);
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
		setSelectedOfficers([]);
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
			const result = await commitMemberUpload({
				data: { clubId, csv, officerApprovals: selectedOfficers },
			});
			const { membersCreated, membersUpdated } = result.stats;
			toast.success(
				`Imported ${membersCreated} new, updated ${membersUpdated} · ${result.officerGrants} officer grants · ${result.stats.skippedOfficerAssignments} officer assignments skipped` +
					(result.unpaidSkipped > 0
						? ` · ${result.unpaidSkipped} unpaid skipped`
						: "") +
					(result.stats.foreignSkipped > 0
						? ` · ${result.stats.foreignSkipped} not on this club's roster skipped`
						: "") +
					(result.stats.addressConflicts > 0
						? ` · ${result.stats.addressConflicts} with a shared email`
						: ""),
			);
			if (result.officerRefreshRequired.length) {
				toast.info(
					`Roster imported. ${result.officerRefreshRequired.join(" ")}`,
					{ duration: 15000 },
				);
			}
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
					<label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border bg-surface-soft px-4 py-3 text-sm transition-colors hover:border-link-fill">
						<Upload className="size-4 text-muted-foreground" aria-hidden />
						<span className="font-semibold text-foreground">
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
						<p className="text-sm text-muted-foreground">
							Reading and matching rows…
						</p>
					) : null}

					{preview ? (
						<>
							<div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
								<span>
									<span className="font-bold text-link">
										{preview.summary.toInsert}
									</span>{" "}
									new
								</span>
								<span>
									<span className="font-bold text-foreground">
										{preview.summary.toUpdate}
									</span>{" "}
									to update
								</span>
								{preview.summary.toSkip > 0 ? (
									<span>
										<span className="font-bold text-warning-strong">
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

							{/* Their own lines, never folded into "skipped" above: that
							    count means a blank name, and a foreign row is a
							    different reason the admin should be able to see
							    (#759, #855). Names no club and no person, and does not
							    say whether anyone else holds them — the importing
							    admin has no business learning either. */}
							{preview.summary.foreignSkipped > 0 ? (
								<p className="text-xs text-warning-strong">
									{foreignSkipSummary(preview.summary.foreignSkipped)}
								</p>
							) : null}
							{preview.summary.addressConflicts > 0 ? (
								<p className="text-xs text-warning-strong">
									{`${preview.summary.addressConflicts} row(s) will be imported with an email another member already has on their roster entry — neither can sign in until each has their own address.`}
								</p>
							) : null}

							{preview.summary.ambiguous > 0 ||
							preview.summary.unparseablePositions > 0 ? (
								<p className="text-xs text-warning-strong">
									{preview.summary.ambiguous > 0
										? `${preview.summary.ambiguous} row(s) share an email and were added as separate members. `
										: ""}
									{preview.summary.unparseablePositions > 0
										? `${preview.summary.unparseablePositions} office title(s) couldn't be recognized and were left blank.`
										: ""}
								</p>
							) : null}

							<section
								aria-label="Officer access changes"
								className="space-y-3 rounded-lg border border-border p-3"
							>
								<h3 className="font-semibold">Officer access changes</h3>
								<p className="text-sm text-muted-foreground">
									Each selected office grants full club-admin access. Leave
									unchecked to import the roster without granting access.
									Existing offices are kept.
								</p>
								{preview.officerAccessUnavailable && (
									<output>{preview.officerAccessUnavailable}</output>
								)}
								{preview.officerAccessChanges.length === 0 ? (
									<p className="text-sm">No officer grants proposed.</p>
								) : (
									preview.officerAccessChanges.map((change) => (
										<label
											key={change.rowIndex}
											className="flex items-start gap-3 text-sm"
										>
											<input
												type="checkbox"
												checked={selectedOfficers.includes(change.approval)}
												disabled={committing}
												onChange={(e) =>
													setSelectedOfficers((current) =>
														e.target.checked
															? [...current, change.approval]
															: current.filter(
																	(token) => token !== change.approval,
																),
													)
												}
											/>
											<span>
												<strong>
													{change.name} —{" "}
													{OFFICER_POSITION_LABELS[change.position]}
												</strong>
												<br />
												{change.email ?? "No email"}
												{change.customerId
													? ` · Customer ID ${change.customerId}`
													: ""}
												<br />
												<span className="text-xs text-muted-foreground">
													{change.personId ? "Existing person" : "New person"} ·
													Import row {change.rowIndex + 1}
												</span>
											</span>
										</label>
									))
								)}
							</section>

							{preview.rows.length > 0 ? (
								<div className="max-h-[300px] overflow-auto rounded-lg border border-border">
									<table className="w-full text-xs">
										<thead className="sticky top-0 bg-surface-soft text-xs font-bold tracking-[0.06em] text-muted-foreground uppercase">
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
															"border-t border-border",
															row.action === "skip" && "bg-warning-soft",
														)}
													>
														<td className="px-3 py-1.5 font-semibold">
															{row.name || (
																<span className="text-muted-foreground italic">
																	(blank)
																</span>
															)}
														</td>
														<td className="px-3 py-1.5 text-muted-foreground">
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
														<td className="px-3 py-1.5 text-muted-foreground">
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

// Friendlier, single-row phrasings of the shared import issues (ISSUE_LABELS is
// tuned for the dense bulk-preview table).
const ADD_ISSUE_MESSAGE: Record<RowIssue, string> = {
	"blank-name": "Enter a name.",
	"invalid-email": "That email doesn't look right.",
	duplicate: "Someone with that name is already on the roster.",
};

/**
 * Quick single-member add (VPE). A one-row wrapper over `bulkImportMembers`, so
 * it inherits the same server-side dedupe, email validation, E.164 phone
 * normalization as Bulk import — just a form instead of
 * a paste box. Only the name is required; officer access is assigned separately,
 * exactly like an imported row.
 */
function AddMemberDialog({
	open,
	onOpenChange,
	existing,
	formerNames,
	clubId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	existing: { name: string; email: string | null }[];
	/** Former members' names (an admin's list, #1328): previewed as blocked. */
	formerNames: string[];
	clubId: string;
}) {
	const router = useRouter();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [phone, setPhone] = useState("");
	const [busy, setBusy] = useState(false);

	// Validate the single row through the same preview builder Bulk import uses,
	// so a blank name / bad email / duplicate is caught before we ever submit.
	const preview: PreviewRowWithFormer | null = name.trim()
		? (flagFormerMatches(
				buildImportPreview([{ name, email, phone, office: "" }], existing),
				formerNames,
			)[0] ?? null)
		: null;
	const blockingIssue =
		preview && !preview.willImport ? preview.issues[0] : null;
	const canSubmit = !!preview?.willImport && !busy;

	function reset() {
		setName("");
		setEmail("");
		setPhone("");
	}

	async function onSubmit() {
		if (!canSubmit) return;
		setBusy(true);
		try {
			const result = await bulkImportMembers({
				data: {
					clubId,
					rows: [{ name, email, phone, office: "" }],
					// A newly joined member: starts the first-weeks checklist (#940).
					// The paste dialog below sends nothing, so a pasted roster does not.
					startOrientation: true,
				},
			});
			if (result.inserted === 1) {
				toast.success(`Added ${name.trim()}.`);
				onOpenChange(false);
				reset();
				await router.invalidate();
			} else {
				// The client preview cleared it, so a 0-insert means the roster
				// changed under us (e.g. a concurrent add of the same name).
				toast.error("Couldn't add them — they may already be on the roster.");
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[440px]">
				<DialogHeader>
					<DialogTitle>Add member</DialogTitle>
					<DialogDescription>
						Add one person to the roster. Only a name is required — email and
						phone are optional.
					</DialogDescription>
				</DialogHeader>

				<form
					onSubmit={(e) => {
						e.preventDefault();
						onSubmit();
					}}
					className="space-y-4"
				>
					<div className="space-y-3">
						<div className="space-y-1.5">
							<Label htmlFor="add-member-name">Name</Label>
							<Input
								id="add-member-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Jane Doe"
								autoFocus
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="add-member-email">
								Email{" "}
								<span className="font-normal text-muted-foreground">
									optional
								</span>
							</Label>
							<Input
								id="add-member-email"
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="jane@club.org"
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="add-member-phone">
								Phone{" "}
								<span className="font-normal text-muted-foreground">
									optional
								</span>
							</Label>
							<Input
								id="add-member-phone"
								type="tel"
								value={phone}
								onChange={(e) => setPhone(e.target.value)}
								placeholder="(555) 123-4567"
							/>
						</div>

						<p className="text-sm text-muted-foreground">
							Assign officer access from the member's profile after adding them.
						</p>

						{blockingIssue ? (
							<p className="text-sm font-semibold text-warning-strong">
								{preview?.former
									? FORMER_MEMBER_MESSAGE
									: ADD_ISSUE_MESSAGE[blockingIssue]}
							</p>
						) : null}
					</div>

					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={busy}>
								Cancel
							</Button>
						</DialogClose>
						<Button type="submit" disabled={!canSubmit}>
							{busy ? "Adding…" : "Add member"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function BulkImportDialog({
	open,
	onOpenChange,
	existing,
	formerNames,
	clubId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	existing: { name: string; email: string | null }[];
	/** Former members' names (an admin's list, #1328): previewed as blocked. */
	formerNames: string[];
	clubId: string;
}) {
	const router = useRouter();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);

	const preview = text.trim()
		? flagFormerMatches(
				buildImportPreview(parseRosterText(text), existing),
				formerNames,
			)
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
					(result.skipped > 0 ? ` Skipped ${result.skipped}.` : "") +
					` Officer assignments skipped: ${result.skippedOfficerAssignments}.`,
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
						spreadsheet (tab-separated). Officer columns are skipped; assign
						access from member profiles or Upload TM CSV. Review the preview,
						then import.
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
						className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2 font-mono text-xs text-foreground transition-colors hover:border-link-fill focus:outline-none"
					/>

					{preview.length > 0 ? (
						<>
							<div className="text-sm text-muted-foreground">
								<span className="font-bold text-foreground">
									{importable.length}
								</span>{" "}
								to import
								{skipped > 0 ? (
									<>
										{" · "}
										<span className="font-bold text-warning-strong">
											{skipped}
										</span>{" "}
										skipped
									</>
								) : null}
							</div>

							<div className="max-h-[260px] overflow-auto rounded-lg border border-border">
								<table className="w-full text-xs">
									<thead className="sticky top-0 bg-surface-soft text-xs font-bold tracking-[0.06em] text-muted-foreground uppercase">
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
													"border-t border-border",
													!row.willImport && "bg-warning-soft",
												)}
											>
												<td className="px-3 py-1.5 font-semibold">
													{row.name || (
														<span className="text-muted-foreground italic">
															(blank)
														</span>
													)}
												</td>
												<td className="px-3 py-1.5 text-muted-foreground">
													{row.email || "—"}
												</td>
												<td className="px-3 py-1.5 text-muted-foreground">
													{row.phone || "—"}
												</td>
												<td className="px-3 py-1.5 text-muted-foreground">
													{row.office || "—"}
												</td>
												<td className="px-3 py-1.5">
													{row.willImport ? (
														<span className="font-semibold text-link">OK</span>
													) : (
														<span className="font-semibold text-warning-strong">
															{row.former
																? FORMER_MEMBER_LABEL
																: row.issues
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
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	members: {
		id: string;
		name: string;
		userId: string | null;
	}[];
	clubId: string;
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
		"h-9 w-full rounded-lg border border-border bg-surface-raised px-3 text-sm font-semibold text-foreground transition-colors hover:border-link-fill";

	async function onMerge() {
		if (!keeper || !absorbed || sameMember) return;
		setBusy(true);
		try {
			await mergeMembers({
				data: { clubId, keeperId: keeper.id, absorbedId: absorbed.id },
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
							className="text-sm font-semibold text-foreground"
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
							className="text-sm font-semibold text-foreground"
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
						<p className="text-sm font-semibold text-warning-strong">
							Pick two different members.
						</p>
					) : keeper && absorbed ? (
						<p className="text-sm text-muted-foreground">
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
			<div className="text-xs font-bold tracking-[0.04em] text-muted-foreground uppercase">
				{stat.label}
			</div>
			<div className="mt-2 flex items-baseline gap-2">
				<span
					className={cn(
						"font-display text-3xl leading-none font-semibold",
						stat.amber && "text-warning-strong",
					)}
				>
					{stat.value}
				</span>
				<span className="text-xs text-muted-foreground">{stat.note}</span>
			</div>
		</>
	);

	const className = cn(
		"rounded-xl border bg-surface-raised px-4 py-4 shadow-[0_8px_20px_rgba(23,58,64,.05)] transition-transform hover:-translate-y-0.5",
		stat.amber ? "border-warning" : "border-border",
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
					? "border-foreground bg-foreground text-background"
					: "border-border bg-surface-raised text-muted-foreground",
			)}
		>
			{segment.label}
			<span
				className={cn(
					"inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-bold",
					active
						? "bg-white/20 text-current"
						: "bg-surface-muted text-muted-foreground",
				)}
			>
				{count}
			</span>
		</button>
	);
}

const PATHWAYS_HIDDEN_NOTE =
	"Pathways are hidden for inactive members. Use the checkbox above to show them.";

/** The admin's list of former members (#1239), each with Reactivate. */
function FormerMembersDialog({
	open,
	onOpenChange,
	clubId,
	formerMembers,
	failed,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	clubId: string;
	formerMembers: FormerMemberItem[];
	/** The list could not be loaded: say so here, with a retry. */
	failed: boolean;
}) {
	const router = useRouter();
	const [busyId, setBusyId] = useState<string | null>(null);
	const [retrying, setRetrying] = useState(false);
	const titleRef = useRef<HTMLHeadingElement>(null);
	const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
	// After a row leaves the list: the row that took its place, or null for
	// the heading. A row's own button unmounts with it, so focus would
	// otherwise drop to the dialog container.
	const [pendingFocus, setPendingFocus] = useState<{
		removedId: string;
		nextId: string | null;
	} | null>(null);

	useEffect(() => {
		if (!pendingFocus) return;
		if (formerMembers.some((m) => m.id === pendingFocus.removedId)) return;
		const next = pendingFocus.nextId
			? buttonRefs.current.get(pendingFocus.nextId)
			: null;
		(next ?? titleRef.current)?.focus();
		setPendingFocus(null);
	}, [formerMembers, pendingFocus]);

	async function reactivate(m: FormerMemberItem) {
		if (busyId !== null) return;
		const index = formerMembers.findIndex((f) => f.id === m.id);
		const neighbour = formerMembers[index + 1] ?? formerMembers[index - 1];
		setBusyId(m.id);
		try {
			await setMemberStatus({
				data: { clubId, memberId: m.id, status: "active" },
			});
			toast.success(`${m.name} reactivated as a member.`);
			setPendingFocus({ removedId: m.id, nextId: neighbour?.id ?? null });
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusyId(null);
		}
	}

	async function retry() {
		setRetrying(true);
		try {
			await router.invalidate();
		} finally {
			setRetrying(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle ref={titleRef} tabIndex={-1}>
						Former members
					</DialogTitle>
					<DialogDescription>
						People whose membership ended. Their history stays; they are off the
						roster.
					</DialogDescription>
				</DialogHeader>
				{failed ? (
					<div className="space-y-3">
						<p role="alert" className="text-sm text-destructive">
							Former members could not be loaded.
						</p>
						<Button
							type="button"
							variant="outline"
							disabled={retrying}
							onClick={retry}
						>
							{retrying ? "Retrying…" : "Retry"}
						</Button>
					</div>
				) : formerMembers.length === 0 ? (
					<p className="text-sm text-muted-foreground">No former members.</p>
				) : (
					<ul className="divide-y divide-border">
						{formerMembers.map((m) => {
							const busy = busyId === m.id;
							return (
								<li
									key={m.id}
									className="flex items-center justify-between gap-3 py-2"
								>
									<div className="min-w-0">
										<Link
											to="/members/$id"
											params={{ id: m.id }}
											className="font-semibold"
										>
											{m.name}
										</Link>
										<div className="text-xs text-muted-foreground">
											{m.endedAt
												? `Ended ${formatCalendarDay(m.endedAt, { withYear: true })}`
												: "End date unknown"}
										</div>
									</div>
									{/* aria-disabled, not disabled: a disabled button gives up
									    focus, and the busy row's button is the one focused. */}
									<Button
										ref={(el: HTMLButtonElement | null) => {
											if (el) buttonRefs.current.set(m.id, el);
											else buttonRefs.current.delete(m.id);
										}}
										type="button"
										variant="outline"
										size="sm"
										aria-disabled={busyId !== null}
										aria-label={
											busy ? `Reactivating ${m.name}` : `Reactivate ${m.name}`
										}
										className={cn(busyId !== null && "opacity-60")}
										onClick={() => reactivate(m)}
									>
										{busy ? "Reactivating…" : "Reactivate"}
									</Button>
								</li>
							);
						})}
					</ul>
				)}
				<DialogFooter>
					<DialogClose asChild>
						<Button type="button" variant="outline">
							Close
						</Button>
					</DialogClose>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
