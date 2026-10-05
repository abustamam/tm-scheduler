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
	Compass,
	Mail,
	ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MemberAvatar } from "#/components/club/member-avatar";
import {
	type MemberMentorshipsView,
	MentorshipAdminPanel,
} from "#/components/members/mentorship-cards";
import { PageContainer } from "#/components/page-container";
import { PathEnrollmentManager } from "#/components/pathways/path-enrollment-manager";
import { PathwaysProgress } from "#/components/pathways/pathways-progress";
import { SpeechLogToggle } from "#/components/speech-log-toggle";
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
import { exportLinkAllowed } from "#/lib/club-export-url";
import { effectiveAdminClub } from "#/lib/effective-admin";
import { APP_LOCALE, formatDayMonth, formatMeetingDate } from "#/lib/format";
import { mailtoHref } from "#/lib/mailto";
import { phoneEditPayload } from "#/lib/member-edit-phone";
import { formatTenure } from "#/lib/members";
import {
	OFFICER_POSITIONS,
	type OfficerPosition,
	officerPositionLabel,
} from "#/lib/officers";
import type { OrientationView } from "#/lib/orientation";
import { firstNameOf } from "#/lib/person-name";
import { ROSTER_CONFLICT_COPY } from "#/lib/roster-conflict-copy";
import {
	speechLogEvaluatorLabel,
	validateSpeechLogSearch,
} from "#/lib/speech-log";
import {
	SPEECH_SCHEDULE_STATE_LABELS,
	type SpeechScheduleState,
	speechLogHeadline,
	speechScheduleState,
} from "#/lib/speech-schedule-state";
import { getMemberProfile } from "#/server/club";
import {
	editMember,
	removeMember,
	setMemberRole,
	setMemberStatus,
} from "#/server/members";
import {
	createMentorship,
	endMentorship,
	getMemberMentorships,
	setMentorshipFocus,
} from "#/server/mentorship";
import { getMemberOrientation, startOrientation } from "#/server/orientation";
import {
	addMemberPath,
	type EnrollablePath,
	getMemberEnrollments,
	listPathwayOptions,
	type MemberEnrollment,
	removeMemberPath,
} from "#/server/path-enrollment";
import { getMemberPathways } from "#/server/pathways-read";
import type { PathViewModel } from "#/server/pathways-read-logic";
import {
	markMemberProject,
	unmarkMemberProject,
} from "#/server/progress-marks";
import { archiveSpeech, rescheduleSpeech } from "#/server/speeches";

export const Route = createFileRoute("/_authed/members/$id")({
	// `?speeches=all` lifts the speech log's 6-row default (#681).
	validateSearch: validateSpeechLogSearch,
	loaderDeps: ({ search }) => ({ allSpeeches: search.speeches === "all" }),
	loader: async ({ params, context, deps }) => {
		const clubId = context.activeClubId;
		if (!clubId) {
			return {
				member: null,
				speechLog: [],
				speechLogTruncated: false,
				allSpeeches: deps.allSpeeches,
				rolesServed: [],
				speeches: 0,
				pathways: [],
				unscheduledSpeeches: [],
				openSpeakerSlots: [],
				pathOptions: [] as EnrollablePath[],
				enrollments: [] as MemberEnrollment[],
				orientation: null as OrientationView | null,
				mentorship: null as MemberMentorshipsView | null,
				now: Date.now(),
				// Nothing is dated without a club, so any fixed zone will do.
				timezone: "UTC",
			};
		}
		const [
			profile,
			pathways,
			pathOptions,
			enrollments,
			orientation,
			mentorship,
			{ timezone },
		] = await Promise.all([
			getMemberProfile({
				data: {
					clubId,
					memberId: params.id,
					allSpeeches: deps.allSpeeches,
				},
			}),
			getMemberPathways({ data: { clubId, memberId: params.id } }),
			// Both are gated on "self or club admin", so a plain member viewing
			// someone else's page gets a throw. That's the correct authz, not an
			// error worth failing the whole page over — swallow to empty and let
			// the admin gate below decide whether to render the control at all.
			listPathwayOptions().catch(() => []),
			getMemberEnrollments({ data: { clubId, memberId: params.id } }).catch(
				() => [],
			),
			// New-member orientation (#940): admin view only. A plain member gets a
			// throw, swallowed to null, and the card below is not rendered for them.
			getMemberOrientation({ data: { clubId, memberId: params.id } }).catch(
				() => null,
			),
			// Mentorship (#939): admin view only, same shape as orientation.
			getMemberMentorships({ data: { clubId, memberId: params.id } }).catch(
				() => null,
			),
			// Every date and the tenure on this page are the CLUB's calendar
			// (#1017). Left to the runtime, the UTC server and the browser printed
			// different days, and across a month boundary different tenures.
			// Imported here, as club-settings imports its promo template, so the
			// route module does not pull `#/server/clubs` (whose logic modules
			// reach `#/db`) into everything that imports this page.
			import("#/server/clubs").then(({ loadClubTimezoneSettings }) =>
				loadClubTimezoneSettings({ data: clubId }),
			),
		]);
		return {
			...profile,
			allSpeeches: deps.allSpeeches,
			pathways,
			pathOptions,
			enrollments,
			orientation,
			mentorship,
			timezone,
			// Pinned in the loader, not sampled while rendering: one value is
			// dehydrated with the loader data, so the SSR pass and the hydration
			// pass classify every speech-log row identically. See #656 / #608.
			now: Date.now(),
		};
	},
	component: MemberDetail,
});

function joinedLabel(value: Date | string, timeZone: string) {
	return new Intl.DateTimeFormat(APP_LOCALE, {
		month: "short",
		year: "numeric",
		timeZone,
	}).format(new Date(value));
}

/**
 * The speech-log badge. The decision it renders belongs to
 * `speechScheduleState`, shared with the dashboard's copy of this list so the
 * two surfaces cannot answer differently for one slot (#656); the wording comes
 * from the same module for the same reason.
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
			{SPEECH_SCHEDULE_STATE_LABELS.delivered}
		</span>
	);
}

function MemberDetail() {
	const {
		member,
		speechLog,
		speechLogTruncated,
		allSpeeches,
		rolesServed,
		pathways,
		unscheduledSpeeches,
		openSpeakerSlots,
		pathOptions,
		enrollments,
		orientation,
		mentorship,
		now,
		timezone,
	} = Route.useLoaderData();
	const { activeClubId, clubs, officerPositions, impersonating } =
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

	// A former member's Pathways are served only to an admin or officer, never
	// under "View as this club" (`mayRevealFormerMembers`); anyone else gets
	// none from the server. Say so quietly rather than showing the "no path set
	// yet" empty state, which would be a claim about their record.
	const pathwaysWithheld =
		member.status === "inactive" &&
		!(clubId && viewerIsAdmin && exportLinkAllowed(impersonating, clubId));

	// Identity, speech log, roles served and Pathways progress are all real.
	const joined = member.joinedAt ?? member.createdAt;
	// The loader's `now`, not the render's: both passes count the same months.
	const tenureText = formatTenure(joined, {
		now: new Date(now),
		timeZone: timezone,
	});
	const tenure = member.officerPositions.length
		? `${tenureText} · ${member.officerPositions
				.map(officerPositionLabel)
				.join(", ")}`
		: tenureText;
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
							{tenure} · joined {joinedLabel(joined, timezone)}
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
								// `mailtoHref`, not raw interpolation: a stored
								// "a@b.com?cc=x&subject=y" would otherwise become live mailto
								// HEADERS. `bulkImportSchema` still validates member email as a
								// plain string, so this is not only a legacy-row concern.
								//
								// `data-slot="wa-email"` + `text-primary` mirrors the phone link
								// beside it exactly, and both halves are required. The unlayered
								// `a { color }` rule in styles.css beats any layered utility, so
								// this anchor rendered --lagoon-deep (#328f97, 3.81:1) — under AA
								// — next to a phone link at --lagoon-ink (5.82:1): one Contact
								// pair in two colours, one of them failing. The `hover:text-[var
								// (--sea-ink)]` that used to sit here was inert for the same
								// reason and is gone rather than revived: it would now WORK, and
								// send the two halves back to different colours on hover.
								<a
									href={mailtoHref(member.email)}
									data-slot="wa-email"
									className="inline-flex items-center gap-1.5 text-primary hover:underline"
								>
									<Mail className="size-3.5" aria-hidden />
									{member.email}
								</a>
							) : null}
							{/* WhatsApp, not the dialer. The component supplies its own icon,
							    layout, `hover:underline` and colour — including the
							    `data-slot` that lets that colour survive the unlayered
							    `a { color }` rule — so this passes no styling at all. */}
							{member.phone ? (
								<WhatsAppPhoneLink phone={member.phone} name={member.name} />
							) : null}
						</div>
					) : null}
				</div>
				<div className="flex flex-wrap gap-2">
					<Button asChild size="sm">
						<Link to="/next">Assign a role</Link>
					</Button>
					{clubId ? <MemberActions member={member} clubId={clubId} /> : null}
				</div>
			</div>

			{/* Speech log (real) + side cards */}
			<div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.5fr_1fr]">
				{/* Speech log */}
				<div className="min-w-0 overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
					<div className="flex items-center justify-between px-5 pt-4 pb-3">
						<h2 className="text-sm font-bold">Speech log</h2>
						<span className="text-xs text-[var(--sea-ink-soft)]">
							{allSpeeches ? "all" : "most recent"} {speechLog.length}
						</span>
					</div>
					{speechLog.length === 0 ? (
						<p className="border-t border-[var(--line)] px-5 py-8 text-center text-sm text-[var(--sea-ink-soft)]">
							No speeches logged yet.
						</p>
					) : (
						speechLog.map((l) => {
							const { day, mon } = formatDayMonth(l.scheduledAt, timezone);
							const state = speechScheduleState({
								scheduledAt: l.scheduledAt,
								now,
							});
							const sub = [l.projectName, l.pathwayPath, l.projectLevel]
								.filter(Boolean)
								.join(" · ");
							// Shown on EVERY row now (#681) — it used to appear only when the
							// speech had no project, path or level, i.e. never on a Pathways
							// speech, which is most of them.
							const evaluatorLabel = speechLogEvaluatorLabel({
								evaluators: l.evaluators,
								hasEvaluatorSlot: l.hasEvaluatorSlot,
								isUpcoming: state === "scheduled",
							});
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
											{speechLogHeadline({
												speechTitle: l.speechTitle,
												roleName: l.roleName,
											})}
										</div>
										<div className="truncate text-xs text-[var(--sea-ink-soft)]">
											{[sub || l.roleName, evaluatorLabel]
												.filter(Boolean)
												.join(" · ")}
										</div>
									</div>
									<SpeechStatePill state={state} />
								</div>
							);
						})
					)}
					<SpeechLogToggle
						truncated={speechLogTruncated}
						allSpeeches={allSpeeches}
					/>
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
							timezone={timezone}
						/>
					) : null}

					{clubId && viewerIsAdmin ? (
						<ClubRoleControl member={member} clubId={clubId} />
					) : null}

					{clubId && viewerIsAdmin && orientation ? (
						<OrientationControl
							member={member}
							clubId={clubId}
							orientation={orientation}
						/>
					) : null}

					{clubId && viewerIsAdmin && mentorship ? (
						<MentorshipControl
							member={member}
							clubId={clubId}
							mentorship={mentorship}
						/>
					) : null}
				</div>
			</div>

			{/* Pathways progress: Base Camp where synced, explicit marks otherwise. */}
			<div className="mt-5">
				<h2 className="mb-3 text-sm font-bold">Pathways</h2>
				{/* Admins may mark progress for anyone on their roster (#419) — a
				    club can then be kept current without every member signing in.
				    A plain member viewing this page gets the read-only panel and
				    marks their own from the dashboard. */}
				{pathwaysWithheld ? (
					<p className="text-sm text-muted-foreground">
						Pathways progress isn't shown for former members.
					</p>
				) : clubId && viewerIsAdmin ? (
					<MemberProgressPanel
						clubId={clubId}
						memberId={member.id}
						pathways={pathways}
						timezone={timezone}
					/>
				) : (
					<PathwaysProgress paths={pathways} timeZone={timezone} />
				)}
				{/* Admin-only here. A member manages their OWN paths from the
				    dashboard, which needs no club context; this surface exists so a
				    club can be set up without waiting for everyone to sign in. */}
				{clubId && viewerIsAdmin ? (
					<div className="mt-3">
						<MemberPathControl
							clubId={clubId}
							memberId={member.id}
							enrollments={enrollments}
							options={pathOptions}
						/>
					</div>
				) : null}
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
	timezone,
}: {
	speeches: UnscheduledSpeechRow[];
	openSlots: OpenSlotRow[];
	clubId: string;
	timezone: string;
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
											{formatMeetingDate(slot.scheduledAt, timezone)}
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

/** Why an officer could not change a member's email (#907, ADR-0029). */
function emailRefusedCopy(
	reason: "bound" | "multi_club",
	name: string,
): string {
	return reason === "bound"
		? `This is ${name}'s sign-in address. Only they can change it, from Account settings.`
		: `${name} is also on another club's roster, so their email can't be changed here. Contact GavelUp support.`;
}

type ProfileMember = {
	id: string;
	name: string;
	preferredName: string | null;
	email: string | null;
	/** Coalesced for DISPLAY — the WhatsApp link. Never a form prefill. */
	phone: string | null;
	/** The stored column verbatim — what the edit dialog prefills, so a save
	 *  round-trips the bytes instead of the country-code guess. */
	phoneRaw: string | null;
	officerPositions: OfficerPosition[];
	userId: string | null;
	status: "active" | "inactive";
	clubRole: "admin" | "member";
};

function MemberActions({
	member,
	clubId,
}: {
	member: ProfileMember;
	clubId: string;
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
				data: { clubId, memberId: member.id, status: next },
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
			const res = await editMember({
				data: {
					clubId,
					memberId: member.id,
					name,
					preferredName: String(form.get("preferredName") ?? "").trim() || null,
					// A bound member's address is theirs (#907): the field is read-only
					// and not sent at all, so a save cannot even ask to change it.
					...(isLinkedAccount
						? {}
						: { email: String(form.get("email") ?? "").trim() || null }),
					// Only when the officer changed it (#906): the phone is the
					// Person's, so a stale prefill must not overwrite another club's.
					...phoneEditPayload(String(form.get("phone") ?? ""), member.phoneRaw),
					officerPositions,
				},
			});
			// The rest of the edit always LANDS. The email is the Person's (#907):
			// it is refused when another club holds them too (or they signed in
			// since this page loaded), and the officer is told why. Otherwise the
			// save can still leave the member — or SOMEONE ELSE — unable to sign in:
			// an address another member already carries refuses both of them.
			if (res.emailRefused) {
				toast.warning(emailRefusedCopy(res.emailRefused, member.name));
			} else if (res.rosterConflict) {
				toast.warning(ROSTER_CONFLICT_COPY[res.rosterConflict]);
			} else {
				toast.success("Member updated.");
			}
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
				data: { clubId, memberId: member.id },
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
							<Label htmlFor="edit-preferred-name">Goes by</Label>
							<Input
								id="edit-preferred-name"
								name="preferredName"
								defaultValue={member.preferredName ?? ""}
								placeholder={firstNameOf(member.name)}
								aria-describedby="edit-preferred-name-hint"
							/>
							<p
								id="edit-preferred-name-hint"
								className="text-xs text-[var(--sea-ink-soft)]"
							>
								Used to greet them in WhatsApp and email drafts. Leave blank to
								use their first name.
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="edit-email">Email</Label>
							<Input
								id="edit-email"
								name="email"
								type="email"
								defaultValue={member.email ?? ""}
								placeholder="name@example.com"
								aria-describedby="edit-email-hint"
								readOnly={isLinkedAccount}
							/>
							{/* The one place the app says what this field is (#907): the
							    member's own address in every club, and what they sign in
							    with. Once they have signed in it is theirs. */}
							<p
								id="edit-email-hint"
								className="text-xs text-[var(--sea-ink-soft)]"
							>
								{isLinkedAccount
									? emailRefusedCopy("bound", member.name)
									: "Their sign-in address, and where an account invite is sent. Every club they belong to shares it."}
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="edit-phone">Phone</Label>
							{/* `phoneRaw`, NOT `phone`. `phone` is coalesced for display — a
							    country-code guess prepended to whatever is stored — so
							    "415-555-2671 x12" would show here as "+1415555267112", a
							    number nobody typed, on the one screen that shows what is on
							    file. See `loadMemberProfile` for why the write path's
							    re-normalization does not make that harmless. */}
							<Input
								id="edit-phone"
								name="phone"
								type="tel"
								defaultValue={member.phoneRaw ?? ""}
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
}: {
	member: ProfileMember;
	clubId: string;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [demoteOpen, setDemoteOpen] = useState(false);
	const isAdmin = member.clubRole === "admin";

	async function setRole(next: "admin" | "member") {
		setBusy(true);
		try {
			await setMemberRole({
				data: { clubId, memberId: member.id, clubRole: next },
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

/**
 * New-member orientation for this member (#940): where they are, and "Start
 * orientation" for someone who joined before it existed or came in with a
 * roster import (which starts nobody). Admin-only; the server gates the write
 * with `requireClubRole(…, ["admin"])`. The member ticks and dismisses their
 * own checklist; nothing here can do either for them.
 */
function OrientationControl({
	member,
	clubId,
	orientation,
}: {
	member: ProfileMember;
	clubId: string;
	orientation: OrientationView;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	async function start() {
		setBusy(true);
		try {
			await startOrientation({ data: { clubId, memberId: member.id } });
			toast.success(
				`${firstNameOf(member.name)} will see the first-weeks checklist on their dashboard.`,
			);
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusy(false);
		}
	}

	const status = !orientation.inOrientation
		? "Not started"
		: orientation.complete
			? "Complete"
			: orientation.dismissed
				? "Dismissed"
				: `${orientation.doneCount} of ${orientation.total} done`;
	// Offer the start when there is no checklist on their dashboard to show:
	// never started, or dismissed before it was finished.
	const canStart =
		member.status === "active" &&
		(!orientation.inOrientation ||
			(orientation.dismissed && !orientation.complete));

	return (
		<div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] p-5 shadow-[0_1px_0_var(--inset-glint)_inset,0_10px_24px_rgba(23,58,64,.05)]">
			<div className="mb-2 flex items-center justify-between gap-2">
				<h2 className="flex items-center gap-1.5 text-sm font-bold">
					<Compass className="size-4 text-[var(--sea-ink-soft)]" aria-hidden />
					New-member orientation
				</h2>
				<span className="inline-flex items-center rounded-full border border-[var(--line)] bg-[var(--foam)] px-2.5 py-0.5 text-xs font-bold tracking-[0.03em]">
					{status}
				</span>
			</div>
			{orientation.inOrientation ? (
				<ul className="mb-3 flex flex-col gap-1 text-xs text-[var(--sea-ink-soft)]">
					{orientation.items.map((item) => (
						<li key={item.key}>
							{item.done ? "✓" : "○"} {item.label}
						</li>
					))}
				</ul>
			) : (
				<p className="mb-3 text-xs text-[var(--sea-ink-soft)]">
					A first-weeks checklist on their dashboard: choose a path, schedule an
					Ice Breaker, take a supporting role, set up Base Camp, get a mentor.
				</p>
			)}
			{canStart ? (
				<Button variant="outline" size="sm" disabled={busy} onClick={start}>
					Start orientation
				</Button>
			) : null}
		</div>
	);
}

/**
 * Mentorship for this member (#939): their active mentors and mentees, and
 * "Pair with mentor". Admin-only; the server gates every write with
 * `requireClubRole(…, ["admin"])` and refuses an inactive member, a member of
 * another club, a self-pairing and a duplicate active pairing.
 */
function MentorshipControl({
	member,
	clubId,
	mentorship,
}: {
	member: ProfileMember;
	clubId: string;
	mentorship: MemberMentorshipsView;
}) {
	const router = useRouter();

	async function run(fn: () => Promise<unknown>, success: string) {
		try {
			await fn();
			toast.success(success);
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		}
	}

	return (
		<MentorshipAdminPanel
			memberName={firstNameOf(member.name)}
			memberActive={member.status === "active"}
			view={mentorship}
			onAdd={(p) =>
				run(
					() =>
						createMentorship({
							data: { clubId, menteeMemberId: member.id, ...p },
						}),
					"Mentor paired.",
				)
			}
			onEnd={(mentorshipId) =>
				run(
					() => endMentorship({ data: { clubId, mentorshipId } }),
					"Mentorship ended.",
				)
			}
			onFocus={(mentorshipId, focus, focusOther) =>
				run(
					() =>
						setMentorshipFocus({
							data: { clubId, mentorshipId, focus, focusOther },
						}),
					"Focus updated.",
				)
			}
		/>
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

function MemberPathControl({
	clubId,
	memberId,
	enrollments,
	options,
}: {
	clubId: string;
	memberId: string;
	enrollments: MemberEnrollment[];
	options: EnrollablePath[];
}) {
	const router = useRouter();

	async function mutate(
		fn: (args: {
			data: { clubId: string; memberId: string; pathId: string };
		}) => Promise<unknown>,
		pathId: string,
	) {
		try {
			await fn({ data: { clubId, memberId, pathId } });
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		}
	}

	return (
		<PathEnrollmentManager
			enrollments={enrollments}
			options={options}
			onAdd={(id) => mutate(addMemberPath, id)}
			onRemove={(id) => mutate(removeMemberPath, id)}
		/>
	);
}

/** The Pathways panel with admin mark/un-mark controls wired in (#419). */
function MemberProgressPanel({
	clubId,
	memberId,
	pathways,
	timezone,
}: {
	clubId: string;
	memberId: string;
	pathways: PathViewModel[];
	timezone: string;
}) {
	const router = useRouter();
	const [busyId, setBusyId] = useState<string | null>(null);

	async function mutate(
		fn: (args: {
			data: { clubId: string; memberId: string; projectId: string };
		}) => Promise<unknown>,
		projectId: string,
	) {
		setBusyId(projectId);
		try {
			await fn({ data: { clubId, memberId, projectId } });
			await router.invalidate();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Something went wrong.");
		} finally {
			setBusyId(null);
		}
	}

	return (
		<PathwaysProgress
			paths={pathways}
			timeZone={timezone}
			onMark={(id) => mutate(markMemberProject, id)}
			onUnmark={(id) => mutate(unmarkMemberProject, id)}
			busyId={busyId}
		/>
	);
}
