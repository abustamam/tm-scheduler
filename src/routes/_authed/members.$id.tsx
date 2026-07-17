import {
	createFileRoute,
	Link,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import {
	Archive,
	ArchiveRestore,
	CalendarPlus,
	ChevronLeft,
	Mail,
	Phone,
	ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/club/member-avatar";
import { PageContainer } from "#/components/page-container";
import { PathwaysProgress } from "#/components/pathways/pathways-progress";
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
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { formatMeetingDate } from "#/lib/format";
import { formatTenure } from "#/lib/members";
import {
	OFFICER_POSITIONS,
	type OfficerPosition,
	officerPositionLabel,
} from "#/lib/officers";
import { getMemberProfile } from "#/server/club";
import {
	editMember,
	removeMember,
	setMemberRole,
	setMemberStatus,
} from "#/server/members";
import { getMemberPathways } from "#/server/pathways-read";
import { archiveSpeech, rescheduleSpeech } from "#/server/speeches";

export const Route = createFileRoute("/_authed/members/$id")({
	loader: async ({ params, context }) => {
		const clubId = context.activeClubId;
		if (!clubId) {
			return {
				member: null,
				speechLog: [],
				rolesServed: [],
				speeches: 0,
				pathways: [],
				unscheduledSpeeches: [],
				openSpeakerSlots: [],
			};
		}
		const [profile, pathways] = await Promise.all([
			getMemberProfile({ data: { clubId, memberId: params.id } }),
			getMemberPathways({ data: { clubId, memberId: params.id } }),
		]);
		return { ...profile, pathways };
	},
	component: MemberDetail,
});

function joinedLabel(value: Date | string) {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		year: "numeric",
	}).format(new Date(value));
}

function dayMon(value: Date | string) {
	const d = new Date(value);
	return {
		day: new Intl.DateTimeFormat(undefined, { day: "numeric" }).format(d),
		mon: new Intl.DateTimeFormat(undefined, { month: "short" })
			.format(d)
			.toUpperCase(),
	};
}

function MemberDetail() {
	const {
		member,
		speechLog,
		rolesServed,
		pathways,
		unscheduledSpeeches,
		openSpeakerSlots,
	} = Route.useLoaderData();
	const { currentMemberId, activeClubId, clubs, officerPositions } =
		Route.useRouteContext();
	const clubId = activeClubId;
	// Club-role management is admin-only: the viewer must be an effective admin
	// (stored admin OR an elected officer, #202) in the active club (#187).
	const viewerIsAdmin = !!effectiveAdminClub({
		clubs,
		activeClubId,
		officerPositions,
	});

	if (!member) {
		return (
			<PageContainer>
				<BackLink />
				<h1 className="mt-5 font-display text-3xl font-semibold">
					Member not found
				</h1>
			</PageContainer>
		);
	}

	// Identity, speech log, roles served and Pathways progress are all real.
	const joined = member.joinedAt ?? member.createdAt;
	const tenure = member.officerPositions.length
		? `${formatTenure(joined)} · ${member.officerPositions
				.map(officerPositionLabel)
				.join(", ")}`
		: formatTenure(joined);
	// Holding any open officer term makes this membership an effective admin
	// (#202 / #270): the club-admin guard treats any office as admin. Surface
	// that here — this is display only; the authorization model is unchanged.
	const holdsOffice = member.officerPositions.length > 0;

	return (
		<PageContainer>
			<BackLink />

			{/* Header */}
			<div className="mt-5 mb-6 flex flex-wrap items-center gap-5">
				<MemberAvatar
					tone={toneFromSeed(member.id)}
					initials={initialsOf(member.name)}
					size={66}
					className="shadow-[0_6px_16px_rgba(23,58,64,.18)]"
				/>
				<div className="min-w-[220px] flex-1">
					<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
						{member.name}
					</h1>
					<div className="mt-1.5 flex flex-wrap items-center gap-2.5">
						<span className="text-sm text-[var(--sea-ink-soft)]">
							{tenure} · joined {joinedLabel(joined)}
						</span>
						{holdsOffice ? (
							<Badge
								variant="secondary"
								title="Holding an officer term grants full club-admin access."
							>
								<ShieldCheck aria-hidden />
								Officer · full admin access
							</Badge>
						) : null}
						{member.status === "inactive" ? (
							<>
								<span className="size-1 rounded-full bg-[var(--sea-ink-soft)]" />
								<span className="inline-flex items-center rounded-full border border-[var(--line)] bg-[var(--sand)] px-2.5 py-0.5 text-xs font-bold tracking-[0.03em] text-[var(--sea-ink-soft)] uppercase">
									Inactive
								</span>
							</>
						) : null}
					</div>
					{member.email || member.phone ? (
						<div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--sea-ink-soft)]">
							{member.email ? (
								<a
									href={`mailto:${member.email}`}
									className="inline-flex items-center gap-1.5 hover:text-[var(--sea-ink)] hover:underline"
								>
									<Mail className="size-3.5" aria-hidden />
									{member.email}
								</a>
							) : null}
							{member.phone ? (
								<a
									href={`tel:${member.phone}`}
									className="inline-flex items-center gap-1.5 hover:text-[var(--sea-ink)] hover:underline"
								>
									<Phone className="size-3.5" aria-hidden />
									{member.phone}
								</a>
							) : null}
						</div>
					) : null}
				</div>
				<div className="flex flex-wrap gap-2">
					<Button asChild size="sm">
						<Link to="/next">Assign a role</Link>
					</Button>
					{clubId ? (
						<MemberActions
							member={member}
							clubId={clubId}
							currentMemberId={currentMemberId}
						/>
					) : null}
				</div>
			</div>

			{/* Speech log (real) + side cards */}
			<div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.5fr_1fr]">
				{/* Speech log */}
				<div className="min-w-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
					<div className="flex items-center justify-between px-5 pt-4 pb-3">
						<h2 className="text-sm font-bold">Speech log</h2>
						<span className="text-xs text-[var(--sea-ink-soft)]">
							most recent {speechLog.length}
						</span>
					</div>
					{speechLog.length === 0 ? (
						<p className="border-t border-[var(--line)] px-5 py-8 text-center text-sm text-[var(--sea-ink-soft)]">
							No speeches logged yet.
						</p>
					) : (
						speechLog.map((l) => {
							const { day, mon } = dayMon(l.scheduledAt);
							const scheduled = new Date(l.scheduledAt).getTime() > Date.now();
							const sub = [l.projectName, l.pathwayPath, l.projectLevel]
								.filter(Boolean)
								.join(" · ");
							return (
								<div
									key={l.slotId}
									className="grid grid-cols-[54px_1fr_auto] items-center gap-3 border-t border-[var(--line)] px-5 py-3 transition-colors hover:bg-[var(--foam)]"
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
											{l.speechTitle ?? l.roleName}
										</div>
										<div className="truncate text-xs text-[var(--sea-ink-soft)]">
											{sub ||
												(l.evaluatorName
													? `Evaluated by ${l.evaluatorName}`
													: l.roleName)}
										</div>
									</div>
									{scheduled ? (
										<span className="shrink-0 rounded-full bg-[rgba(79,184,178,.16)] px-2.5 py-1 text-xs font-bold text-[var(--lagoon-deep)]">
											Scheduled
										</span>
									) : (
										<span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--foam)] px-2.5 py-1 text-xs font-semibold text-[var(--palm)]">
											Completed
										</span>
									)}
								</div>
							);
						})
					)}
				</div>

				{/* Side cards */}
				<div className="flex min-w-0 flex-col gap-5">
					<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5 shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
						<h2 className="mb-3 text-sm font-bold">Roles served this year</h2>
						{rolesServed.length === 0 ? (
							<p className="text-xs text-[var(--sea-ink-soft)]">
								No roles served yet this year.
							</p>
						) : (
							<div className="flex flex-wrap gap-2">
								{rolesServed.map((r) => (
									<span
										key={r.name}
										className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--foam)] px-3 py-1.5 text-xs font-semibold"
									>
										{r.name}
										<span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--sand)] px-1 text-xs font-bold text-[var(--sea-ink-soft)]">
											{r.count}
										</span>
									</span>
								))}
							</div>
						)}
					</div>

					{clubId ? (
						<UnscheduledSpeeches
							speeches={unscheduledSpeeches}
							openSlots={openSpeakerSlots}
							clubId={clubId}
						/>
					) : null}

					{clubId && viewerIsAdmin ? (
						<ClubRoleControl
							member={member}
							clubId={clubId}
							currentMemberId={currentMemberId}
						/>
					) : null}
				</div>
			</div>

			{/* Pathways progress (real, synced from Base Camp) */}
			<div className="mt-5">
				<h2 className="mb-3 text-sm font-bold">Pathways</h2>
				<PathwaysProgress paths={pathways} />
			</div>
		</PageContainer>
	);
}

type UnscheduledSpeechRow = {
	id: string;
	title: string;
	pathwayPath: string | null;
	projectName: string | null;
	projectLevel: string | null;
	archived: boolean;
};

type OpenSlotRow = {
	slotId: string;
	scheduledAt: Date | string;
	roleName: string;
};

/**
 * A Person's unscheduled speeches (ADR-0009 / #102): drafts with no active slot.
 * Each can be scheduled into an open speaker slot (reschedule flow) or archived
 * to hide it. Archived rows aren't loaded by default — this only lists the live
 * pool.
 */
function UnscheduledSpeeches({
	speeches,
	openSlots,
	clubId,
}: {
	speeches: UnscheduledSpeechRow[];
	openSlots: OpenSlotRow[];
	clubId: string;
}) {
	const router = useRouter();
	const [busyId, setBusyId] = useState<string | null>(null);
	const [scheduling, setScheduling] = useState<UnscheduledSpeechRow | null>(
		null,
	);

	const live = speeches.filter((s) => !s.archived);
	const archived = speeches.filter((s) => s.archived);

	async function onSetArchived(speechId: string, next: boolean) {
		setBusyId(speechId);
		try {
			await archiveSpeech({ data: { speechId, clubId, archived: next } });
			toast.success(next ? "Speech archived." : "Speech restored.");
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusyId(null);
		}
	}

	async function onSchedule(speechId: string, slotId: string) {
		setBusyId(speechId);
		try {
			await rescheduleSpeech({ data: { speechId, slotId } });
			toast.success("Speech scheduled.");
			setScheduling(null);
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusyId(null);
		}
	}

	return (
		<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5 shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
			<h2 className="mb-3 text-sm font-bold">Unscheduled speeches</h2>
			{live.length === 0 ? (
				<p className="text-xs text-[var(--sea-ink-soft)]">
					No unscheduled speeches. Prepared speeches with no meeting slot show
					up here.
				</p>
			) : (
				<ul className="flex flex-col gap-2.5">
					{live.map((s) => {
						const sub = [s.projectName, s.pathwayPath, s.projectLevel]
							.filter(Boolean)
							.join(" · ");
						return (
							<li
								key={s.id}
								className="rounded-xl border border-[var(--line)] bg-[var(--foam)] px-3.5 py-2.5"
							>
								<div className="min-w-0">
									<div className="truncate text-sm font-bold">{s.title}</div>
									{sub ? (
										<div className="truncate text-xs text-[var(--sea-ink-soft)]">
											{sub}
										</div>
									) : null}
								</div>
								<div className="mt-2 flex flex-wrap gap-2">
									<Button
										size="sm"
										variant="outline"
										disabled={busyId === s.id || openSlots.length === 0}
										onClick={() => setScheduling(s)}
									>
										<CalendarPlus className="size-4" aria-hidden />
										Schedule
									</Button>
									<Button
										size="sm"
										variant="ghost"
										disabled={busyId === s.id}
										onClick={() => onSetArchived(s.id, true)}
									>
										<Archive className="size-4" aria-hidden />
										Archive
									</Button>
								</div>
								{openSlots.length === 0 ? (
									<p className="mt-1.5 text-xs text-[var(--sea-ink-soft)]">
										No open speaker slots to schedule into.
									</p>
								) : null}
							</li>
						);
					})}
				</ul>
			)}

			{archived.length > 0 ? (
				<details className="mt-3 border-t border-[var(--line)] pt-3">
					<summary className="cursor-pointer text-xs font-semibold text-[var(--sea-ink-soft)]">
						Archived ({archived.length})
					</summary>
					<ul className="mt-2 flex flex-col gap-2">
						{archived.map((s) => (
							<li
								key={s.id}
								className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-[var(--line)] px-3.5 py-2"
							>
								<span className="min-w-0 truncate text-xs text-[var(--sea-ink-soft)]">
									{s.title}
								</span>
								<Button
									size="sm"
									variant="ghost"
									disabled={busyId === s.id}
									onClick={() => onSetArchived(s.id, false)}
								>
									<ArchiveRestore className="size-4" aria-hidden />
									Restore
								</Button>
							</li>
						))}
					</ul>
				</details>
			) : null}

			<Dialog
				open={scheduling !== null}
				onOpenChange={(open) => !open && setScheduling(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Schedule "{scheduling?.title}"</DialogTitle>
						<DialogDescription>
							Pick an open speaker slot. This assigns the speaker and attaches
							the speech.
						</DialogDescription>
					</DialogHeader>
					<ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
						{openSlots.map((slot) => (
							<li key={slot.slotId}>
								<button
									type="button"
									disabled={busyId === scheduling?.id}
									onClick={() =>
										scheduling && onSchedule(scheduling.id, slot.slotId)
									}
									className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--foam)] disabled:opacity-60"
								>
									<span className="min-w-0">
										<span className="block truncate text-sm font-semibold">
											{formatMeetingDate(slot.scheduledAt)}
										</span>
										<span className="block truncate text-xs text-[var(--sea-ink-soft)]">
											{slot.roleName}
										</span>
									</span>
									<CalendarPlus
										className="size-4 shrink-0 text-[var(--sea-ink-soft)]"
										aria-hidden
									/>
								</button>
							</li>
						))}
					</ul>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline">
								Cancel
							</Button>
						</DialogClose>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

type ProfileMember = {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	officerPositions: OfficerPosition[];
	userId: string | null;
	status: "active" | "inactive";
	clubRole: "admin" | "member";
};

function MemberActions({
	member,
	clubId,
	currentMemberId,
}: {
	member: ProfileMember;
	clubId: string;
	currentMemberId: string | null;
}) {
	const router = useRouter();
	const navigate = useNavigate();
	const [editOpen, setEditOpen] = useState(false);
	const [removeOpen, setRemoveOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const isLinkedAccount = Boolean(member.userId);
	const isInactive = member.status === "inactive";

	async function onToggleStatus() {
		const next = isInactive ? "active" : "inactive";
		setBusy(true);
		try {
			await setMemberStatus({
				data: {
					clubId,
					memberId: member.id,
					status: next,
					actorMemberId: currentMemberId,
				},
			});
			toast.success(
				next === "inactive"
					? `${member.name} marked inactive.`
					: `${member.name} reactivated.`,
			);
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	async function onEditSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const name = String(form.get("name") ?? "").trim();
		if (!name) {
			toast.error("Name is required.");
			return;
		}
		// Checkboxes named "officerPositions" — the full desired office set (#100).
		const officerPositions = form.getAll(
			"officerPositions",
		) as OfficerPosition[];
		setBusy(true);
		try {
			await editMember({
				data: {
					clubId,
					memberId: member.id,
					actorMemberId: currentMemberId,
					name,
					email: String(form.get("email") ?? "").trim() || null,
					phone: String(form.get("phone") ?? "").trim() || null,
					officerPositions,
				},
			});
			toast.success("Member updated.");
			setEditOpen(false);
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	async function onRemove() {
		setBusy(true);
		try {
			await removeMember({
				data: { clubId, memberId: member.id, actorMemberId: currentMemberId },
			});
			toast.success(`${member.name} removed from the roster.`);
			setRemoveOpen(false);
			await navigate({ to: "/roster" });
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
				Edit
			</Button>
			{!isLinkedAccount ? (
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={onToggleStatus}
				>
					{isInactive ? "Reactivate" : "Mark inactive"}
				</Button>
			) : null}
			{!isLinkedAccount ? (
				<Button
					variant="outline"
					size="sm"
					className="border-[var(--line)] text-[var(--danger,#b4232a)] hover:bg-[rgba(180,35,42,.08)]"
					onClick={() => setRemoveOpen(true)}
				>
					Remove
				</Button>
			) : null}

			{/* Edit dialog */}
			<Dialog open={editOpen} onOpenChange={setEditOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Edit member</DialogTitle>
						<DialogDescription>
							Update {member.name}'s name and contact details.
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={onEditSubmit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="edit-name">Name</Label>
							<Input
								id="edit-name"
								name="name"
								required
								defaultValue={member.name}
								autoFocus
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="edit-email">Email</Label>
							<Input
								id="edit-email"
								name="email"
								type="email"
								defaultValue={member.email ?? ""}
								placeholder="name@example.com"
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="edit-phone">Phone</Label>
							<Input
								id="edit-phone"
								name="phone"
								type="tel"
								defaultValue={member.phone ?? ""}
							/>
						</div>
						<fieldset className="space-y-2">
							<legend className="font-medium text-sm">Offices held</legend>
							<p className="text-muted-foreground text-xs">
								A member can hold more than one office at once. Assigning any
								office grants full club-admin access.
							</p>
							<div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
								{OFFICER_POSITIONS.map((pos) => (
									<label
										key={pos}
										className="flex items-center gap-2 text-sm"
										htmlFor={`edit-office-${pos}`}
									>
										<input
											type="checkbox"
											id={`edit-office-${pos}`}
											name="officerPositions"
											value={pos}
											defaultChecked={member.officerPositions.includes(pos)}
											className="size-4 rounded border-input"
										/>
										{officerPositionLabel(pos)}
									</label>
								))}
							</div>
						</fieldset>
						<DialogFooter>
							<DialogClose asChild>
								<Button type="button" variant="outline" disabled={busy}>
									Cancel
								</Button>
							</DialogClose>
							<Button type="submit" disabled={busy}>
								{busy ? "Saving…" : "Save changes"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

			{/* Remove confirm dialog */}
			<Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Remove {member.name}?</DialogTitle>
						<DialogDescription>
							Their upcoming roles will be released. This can't be undone.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={busy}>
								Cancel
							</Button>
						</DialogClose>
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={onRemove}
						>
							{busy ? "Removing…" : "Remove member"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/**
 * Admin-only control to promote/demote a member's CLUB ROLE — the permission
 * that gates club management, distinct from officer position (#187). Promote is
 * one click; demote is behind a confirm. The server enforces the club-keeps-
 * ≥1-active-admin invariant, so a last-admin demote surfaces as an error toast.
 */
function ClubRoleControl({
	member,
	clubId,
	currentMemberId,
}: {
	member: ProfileMember;
	clubId: string;
	currentMemberId: string | null;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [demoteOpen, setDemoteOpen] = useState(false);
	const isAdmin = member.clubRole === "admin";

	async function setRole(next: "admin" | "member") {
		setBusy(true);
		try {
			await setMemberRole({
				data: {
					clubId,
					memberId: member.id,
					clubRole: next,
					actorMemberId: currentMemberId,
				},
			});
			toast.success(
				next === "admin"
					? `${member.name} is now a club admin.`
					: `${member.name} is now a member.`,
			);
			setDemoteOpen(false);
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5 shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
			<div className="mb-2 flex items-center justify-between gap-2">
				<h2 className="flex items-center gap-1.5 text-sm font-bold">
					<ShieldCheck
						className="size-4 text-[var(--sea-ink-soft)]"
						aria-hidden
					/>
					Club role
				</h2>
				<span className="inline-flex items-center rounded-full border border-[var(--line)] bg-[var(--foam)] px-2.5 py-0.5 text-xs font-bold tracking-[0.03em] uppercase">
					{isAdmin ? "Admin" : "Member"}
				</span>
			</div>
			<p className="mb-3 text-xs text-[var(--sea-ink-soft)]">
				Club role is a permission for managing the club — separate from officer
				position.
			</p>
			{isAdmin ? (
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => setDemoteOpen(true)}
				>
					Demote to member
				</Button>
			) : (
				<Button
					variant="outline"
					size="sm"
					disabled={busy}
					onClick={() => setRole("admin")}
				>
					Make admin
				</Button>
			)}

			<Dialog open={demoteOpen} onOpenChange={setDemoteOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Demote {member.name} to member?</DialogTitle>
						<DialogDescription>
							They'll lose admin permissions for this club. Their officer
							position (if any) is unchanged.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={busy}>
								Cancel
							</Button>
						</DialogClose>
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={() => setRole("member")}
						>
							{busy ? "Saving…" : "Demote to member"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function BackLink() {
	return (
		<Link
			to="/roster"
			className="group inline-flex items-center gap-2 text-sm font-semibold text-[var(--sea-ink-soft)] no-underline transition-colors hover:text-[var(--sea-ink)]"
		>
			<ChevronLeft
				className="size-4 transition-transform group-hover:-translate-x-0.5"
				aria-hidden
			/>
			Back to roster
		</Link>
	);
}
