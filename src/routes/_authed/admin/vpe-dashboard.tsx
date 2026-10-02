import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Check, ChevronRight, Circle } from "lucide-react";
import { useEffect, useState } from "react";
import { MemberAvatar } from "#/components/club/member-avatar";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import { PageContainer } from "#/components/page-container";
import {
	ATTENDANCE_LAPSE,
	type AttendanceLapseRow,
} from "#/lib/attendance-lapse";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import { effectiveAdminClub } from "#/lib/effective-admin";
import {
	EVALUATOR_PAIRING,
	type EvaluationPair,
	type EvaluatorPairingRow,
} from "#/lib/evaluator-pairing";
import {
	formatHistoryDate,
	formatMeetingDate,
	formatShortDate,
} from "#/lib/format";
import {
	LEVEL_PROXIMITY,
	type LevelNudgeMeeting,
	proximityDetail,
	showsLevelNudge,
} from "#/lib/level-proximity";
import { formatTenure } from "#/lib/members";
import { signupUrlFor } from "#/lib/next-meeting-summary";
import { orientationNudgeAvailable } from "#/lib/nudge";
import {
	isStalledInOrientation,
	ORIENTATION_STALLED_AFTER_DAYS,
	ORIENTATION_TICK_LABELS,
	type OrientationRosterRow,
	orientationDayLabel,
} from "#/lib/orientation-roster";
import { cn } from "#/lib/utils";
import {
	getAttendanceLapse,
	getEvaluatorPairings,
	getLevelProximity,
	getOrientationRoster,
	getOverdueMembers,
	getSpeakerRotation,
} from "#/server/reporting";
import type {
	LevelProximityRow,
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
		if (!club) {
			return {
				rotation: [],
				overdue: [],
				lapse: [],
				pairings: [],
				proximity: [] as LevelProximityRow[],
				orientation: [] as OrientationRosterRow[],
				timezone: undefined as string | undefined,
				now: Date.now(),
				clubName: "",
				clubId: "",
				clubSlug: null as string | null,
				nextMeeting: null as LevelNudgeMeeting | null,
			};
		}
		const [rotation, overdue, lapse, pairings, proximity, orientation] =
			await Promise.all([
				getSpeakerRotation({ data: { clubId: club.clubId } }),
				getOverdueMembers({ data: { clubId: club.clubId } }),
				getAttendanceLapse({ data: { clubId: club.clubId } }),
				getEvaluatorPairings({ data: { clubId: club.clubId } }),
				getLevelProximity({ data: { clubId: club.clubId } }),
				getOrientationRoster({ data: { clubId: club.clubId } }),
			]);
		return {
			rotation,
			overdue,
			lapse,
			pairings,
			proximity: proximity.rows,
			// New members in orientation (#942), longest first.
			orientation,
			// The club's zone, for EVERY date on this page that names a day. The
			// Booked marker passed none and printed the server's day, so a
			// booking at 23:30 club time read as the next day (#898).
			timezone: proximity.timezone as string | undefined,
			// Pinned here, not sampled while rendering, so the SSR pass and the
			// hydration pass count tenure months from one instant (#1017). A
			// render-time `new Date()` either side of midnight on a month's last
			// day printed "11 mo" on the server and "1 yr" in the browser.
			now: Date.now(),
			clubName: club.name,
			// For the "Close to a level" nudge draft (#900): the next meeting's
			// public page. Slim summary only, never a `join_url`.
			clubId: club.clubId,
			clubSlug: proximity.clubSlug,
			nextMeeting: proximity.nextMeeting,
		};
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
	const {
		rotation,
		overdue,
		lapse,
		pairings,
		proximity,
		orientation,
		timezone,
		now,
		clubId,
		clubSlug,
		nextMeeting,
	} = Route.useLoaderData();
	// Every row's tenure, counted on the club's calendar from the loader's
	// instant (#1017). The no-club branch has no zone and renders no rows.
	const clock: TenureClock = {
		now: new Date(now),
		timeZone: timezone ?? "UTC",
	};

	// The next meeting's PUBLIC agenda, for the level nudge draft (#900). The
	// origin exists only in the browser, and `signupUrlFor` is null until it
	// does, so no nudge renders on the server pass. That costs no markup only
	// because `showsLevelNudge` requires `hasNudgeContact`: a row that shows a
	// nudge always has a channel, so `NudgeButtons` would render nothing before
	// mount anyway, and its server-rendered "No contact on file" branch is
	// unreachable here. Drop that requirement and this gating hides that text
	// on the server pass. The no-contact cases in `vpe-dashboard.test.tsx` pin it.
	const [origin, setOrigin] = useState("");
	useEffect(() => setOrigin(window.location.origin), []);
	const shareUrl = signupUrlFor(clubSlug ?? clubId, nextMeeting, origin);
	const nudge: LevelNudgeContext | null =
		nextMeeting && shareUrl
			? {
					meeting: nextMeeting,
					meetingDate: formatMeetingDate(nextMeeting.scheduledAt, timezone),
					shareUrl,
				}
			: null;

	const overdueMembers = overdue.filter((m) => m.isOverdue);
	const neverSpoken = rotation.filter((r) => r.lastSpokenAt === null).length;
	const lapsed = lapse.filter((m) => m.isLapsed);
	// SPEAKERS, not pairings and not evaluators — one row per speaker, kept if
	// some evaluator appears twice in that speaker's shown window. A speaker
	// repeated by two different evaluators is one entry here, not two, so the
	// tile below has to say "speakers" or it is reporting a number it does not
	// hold. It said "Repeat evaluators / same pairing twice" over exactly this
	// count until the units were checked.
	const speakersWithRepeat = pairings.filter((p) => p.hasRepeat);

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
		{
			label: "Speakers with a repeat",
			value: String(speakersWithRepeat.length),
			note: "same evaluator twice",
			amber: speakersWithRepeat.length > 0,
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
					lapsed.map((m) => (
						<LapseRow
							key={m.memberId}
							member={m}
							timezone={timezone}
							clock={clock}
						/>
					))
				)}
			</Section>

			{/* New members in orientation (#942). ABOVE "Overdue for a role" for
			    the reason "Stopped attending" sits above it: onboarding a new
			    member is the more time-sensitive job. A new member has usually
			    held no role yet, so they would ALSO appear below as overdue, and
			    this section is the one that says why. */}
			<Section
				id="new-members-in-orientation"
				title="New members in orientation"
				subtitle={`Everyone working through their first-weeks checklist — longest first. Past ${ORIENTATION_STALLED_AFTER_DAYS} days is highlighted.`}
			>
				{orientation.length === 0 ? (
					<EmptyRow>No new members in orientation right now.</EmptyRow>
				) : (
					orientation.map((r) => (
						<OrientationRow
							key={r.memberId}
							row={r}
							nudge={nudge}
							origin={origin}
						/>
					))
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
					overdueMembers.map((m) => (
						<OverdueRow
							key={m.memberId}
							member={m}
							timezone={timezone}
							clock={clock}
						/>
					))
				)}
			</Section>

			{/* Close to a level (#898). Between "Overdue" and the speaker queue
			    because it answers the queue's question with a reason: a member
			    this close needs one speaker slot, and every finished level feeds
			    a DCP education goal. PROJECTS, never speeches — Level 1's
			    Evaluation and Feedback is three assignments, and later levels
			    hold projects that are not speeches at all. */}
			<Section
				id="close-to-a-level"
				title="Close to a level"
				subtitle={`Members with 1–${LEVEL_PROXIMITY.maxProjectsLeft} projects left in a level. Levels waiting on Base Camp approval come first.`}
			>
				{proximity.length === 0 ? (
					<EmptyRow>
						Nobody is within {NUMBER_WORDS[LEVEL_PROXIMITY.maxProjectsLeft]}{" "}
						projects of a level yet.
					</EmptyRow>
				) : (
					proximity.map((r) => (
						<ProximityRow
							key={`${r.memberId}:${r.pathName}:${r.kind}`}
							row={r}
							timezone={timezone}
							nudge={nudge}
						/>
					))
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
						<RotationRow
							key={r.memberId}
							row={r}
							rank={i + 1}
							timezone={timezone}
							clock={clock}
						/>
					))
				)}
			</Section>

			{/* Evaluator pairings (#709). Here rather than in a standalone view, and
			    that is a direct instruction: #154 was closed wontfix because a
			    per-role scheduling view would fragment the VPE surface across three
			    places, and said any further breakdown should fold into THIS
			    dashboard. It sits last because it is a lookup the assigner reaches
			    for while assigning, not an alert — unlike the three above it, an
			    empty result here is not good news, it is just no history. */}
			<Section
				title="Evaluator pairings"
				subtitle={`Who has evaluated whom — the last ${EVALUATOR_PAIRING.recentPerSpeaker} evaluations of each speaker, repeats first. Guests who evaluated are included.`}
			>
				{pairings.length === 0 ? (
					<EmptyRow>No evaluations recorded yet.</EmptyRow>
				) : (
					pairings.map((p) => (
						<PairingRow
							key={p.memberId}
							row={p}
							timezone={timezone}
							clock={clock}
						/>
					))
				)}
			</Section>
		</PageContainer>
	);
}

/** Small counts in words, for copy that reads "within two projects". */
const NUMBER_WORDS: Record<number, string> = {
	1: "one",
	2: "two",
	3: "three",
	4: "four",
	5: "five",
};

function Section({
	id,
	title,
	subtitle,
	children,
}: {
	/** A fragment target. `/tour`'s screenshot capture (#901) links to one;
	 *  `scroll-mt-24` lands it below the sticky top bar, not under it. */
	id?: string;
	title: string;
	subtitle: string;
	children: React.ReactNode;
}) {
	return (
		<div id={id} className={id ? "scroll-mt-24" : undefined}>
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

/** What a tenure is counted against: the loader's instant, on the club's
 *  calendar (#1017). */
type TenureClock = { now: Date; timeZone: string };

/** Shared avatar + name + tenure identity cell, linking to the member profile. */
function MemberIdentity({
	memberId,
	name,
	joinedAt,
	clock,
	bookedAt,
	timezone,
}: {
	memberId: string;
	name: string;
	joinedAt: Date | string | null;
	clock: TenureClock;
	/** #543 — omitted by callers that have no upcoming-claim data (LapseRow). */
	/** The date the Booked marker shows; which slots count is the caller's call. */
	bookedAt?: Date | string;
	/** The club's zone, for the Booked marker's day (#898). */
	timezone?: string;
}) {
	return (
		<div className="flex min-w-0 items-center gap-3">
			<MemberAvatar
				tone={toneFromSeed(memberId)}
				initials={initialsOf(name)}
				size={38}
			/>
			<div className="min-w-0 leading-[1.25]">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate text-sm font-bold">{name}</span>
					{/* The pill is `sm`-and-up ONLY — see BookedMarker's note. */}
					{bookedAt ? <BookedPill at={bookedAt} timezone={timezone} /> : null}
				</div>
				<div className="text-xs text-[var(--sea-ink-soft)]">
					{joinedAt ? formatTenure(joinedAt, clock) : "Tenure unknown"}
				</div>
				{bookedAt ? <BookedLine at={bookedAt} timezone={timezone} /> : null}
			</div>
		</div>
	);
}

/**
 * The upcoming-claim marker (#543). Both lists it sits in rank members by PAST
 * participation, so without it Monday's Toastmaster reads "Never held a role"
 * on the officer's own dashboard while the club's sign-up sheet has her name on
 * it. It does not change the rank or the overdue count — it says "already
 * booked, no outreach needed today" beside a number that is still honest about
 * history.
 *
 * **What feeds it differs by list**: any claimed role in the overdue list, a
 * speaker slot only in the speaker queue (`SpeakerRotationRow.upcomingSpeakerAt`
 * says why). The copy stays role-neutral so the one component is true in both.
 *
 * **Two forms, because below `sm` there is no room for a pill.** At 375px the
 * page's `px-4`, the row's `px-5`, the 112px wait column and the gaps leave the
 * identity text block ~85px, against ~146px for the pill. A
 * `whitespace-nowrap shrink-0` pill there takes that width from the `truncate`
 * NAME — collapsing it to an ellipsis, defeating the wait column's whole reason
 * for narrowing below `sm` — and is then clipped by `Section`'s
 * `overflow-hidden` anyway. So below `sm` the marker becomes a plain line under
 * the tenure that is allowed to WRAP, and drops the weekday. The weekday is not
 * the problem by itself: "Booked · Aug 10" is still ~109px as a pill, so
 * shortening the label alone does not rescue it, and hiding the marker outright
 * would drop the fix for a VPE doing outreach from a phone. jsdom has no layout
 * and can see none of this, which is why the component suite pins the two class
 * strings instead.
 */
function BookedPill({
	at,
	timezone,
}: {
	at: Date | string;
	timezone?: string;
}) {
	return (
		// Teal (the token the member dashboard's "Signed up" pill uses) rather
		// than the amber the wait column carries: these two mean opposite things
		// and must not look alike.
		<span className="hidden shrink-0 rounded-full bg-[rgba(79,184,178,.16)] px-2 py-0.5 text-[11px] font-bold whitespace-nowrap text-[var(--lagoon-deep)] sm:inline-block">
			Booked · {formatMeetingDate(at, timezone)}
		</span>
	);
}

/** The below-`sm` form of {@link BookedPill} — wrapping text, no weekday. */
function BookedLine({
	at,
	timezone,
}: {
	at: Date | string;
	timezone?: string;
}) {
	return (
		<div className="text-xs font-bold text-[var(--lagoon-deep)] sm:hidden">
			Booked {formatShortDate(at, timezone)}
		</div>
	);
}

const ROW_CLASS =
	"group grid cursor-pointer items-center gap-3.5 border-b border-[var(--line)] px-5 py-3 transition-colors last:border-b-0 hover:bg-[var(--foam)]";

function OverdueRow({
	member,
	timezone,
	clock,
}: {
	member: OverdueMemberRow;
	timezone?: string;
	clock: TenureClock;
}) {
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
				clock={clock}
				bookedAt={member.upcomingRoleAt}
				timezone={timezone}
			/>
			<div className="text-sm">
				<span className="font-bold text-[var(--warning-strong)]">{wait}</span>
				<div className="text-xs text-[var(--sea-ink-soft)]">
					{member.lastAnyRoleAt
						? `last: ${formatShortDate(member.lastAnyRoleAt, timezone)}`
						: "no role history"}
				</div>
			</div>
			<Chevron />
		</Link>
	);
}

function LapseRow({
	member,
	timezone,
	clock,
}: {
	member: AttendanceLapseRow;
	timezone: string | undefined;
	clock: TenureClock;
}) {
	// The rate is CONTEXT beside the streak, not a substitute for it — an
	// officer wants to know whether this is someone who was always patchy or
	// someone reliable who just stopped. Rendering it only when lastSeenAt is
	// null (the previous shape) made it dead: lastSeenAt is null exactly when
	// presentCount is 0, so the percentage could only ever print "0%".
	// Null rate means nothing in the window was eligible for them.
	const rate =
		member.rate === null ? null : `${Math.round(member.rate * 100)}% attended`;
	const seen = member.lastSeenAt
		? `last seen ${formatShortDate(member.lastSeenAt, timezone)}`
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
				clock={clock}
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

function RotationRow({
	row,
	rank,
	timezone,
	clock,
}: {
	row: SpeakerRotationRow;
	rank: number;
	timezone?: string;
	clock: TenureClock;
}) {
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
				clock={clock}
				bookedAt={row.upcomingSpeakerAt}
				timezone={timezone}
			/>
			<div className="hidden text-sm sm:block">
				{row.lastSpokenAt ? (
					<>
						<span className="font-bold text-[var(--sea-ink)]">
							{formatShortDate(row.lastSpokenAt, timezone)}
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

/** What every row's level nudge shares: the one meeting it asks about. */
interface LevelNudgeContext {
	meeting: LevelNudgeMeeting;
	/** Already formatted in the club's timezone. */
	meetingDate: string;
	/** The meeting's absolute public URL. */
	shareUrl: string;
}

/**
 * One member close to a level, or with a level awaiting approval (#898).
 *
 * `RotationRow`'s shape, with one difference: the `<Link>` to the member page
 * wraps only the avatar and the name, NOT the row, because the right-hand cell
 * holds the level nudge's draft links (#900), and an anchor inside an anchor
 * is invalid markup that swallows the click.
 *
 * The Speaking marker mirrors `BookedPill` / `BookedLine` exactly, for the same
 * width reasons: a pill from `sm` up, a wrapping line below it.
 */
function ProximityRow({
	row,
	timezone,
	nudge,
}: {
	row: LevelProximityRow;
	timezone?: string;
	nudge: LevelNudgeContext | null;
}) {
	// No control at all when it cannot apply, never a disabled one: the
	// "Not scheduled" / "Speaking" badge beside it already tells the story.
	const showNudge = nudge !== null && showsLevelNudge(row, nudge.meeting);
	return (
		<div
			className={cn(
				"grid items-center gap-3.5 border-b border-[var(--line)] px-5 py-3 last:border-b-0",
				"grid-cols-[1fr_auto]",
			)}
		>
			<div className="min-w-0">
				<Link
					to="/members/$id"
					params={{ id: row.memberId }}
					className="flex min-w-0 items-center gap-3"
				>
					<MemberAvatar
						tone={toneFromSeed(row.memberId)}
						initials={initialsOf(row.name)}
						size={38}
					/>
					<span className="truncate text-sm font-bold">{row.name}</span>
				</Link>
				{/* Indented to clear the avatar, like PairingRow's chips. */}
				<div className="mt-1 pl-[50px] text-xs text-[var(--sea-ink-soft)]">
					{proximityDetail(row)}
				</div>
				{row.upcomingSpeakerAt ? (
					<div className="pl-[50px] text-xs font-bold text-[var(--lagoon-deep)] sm:hidden">
						Speaking {formatShortDate(row.upcomingSpeakerAt, timezone)}
					</div>
				) : null}
			</div>
			<div className="flex items-center gap-2 justify-self-end">
				{row.upcomingSpeakerAt ? (
					<span className="hidden shrink-0 rounded-full bg-[rgba(79,184,178,.16)] px-2 py-0.5 text-[11px] font-bold whitespace-nowrap text-[var(--lagoon-deep)] sm:inline-block">
						Speaking · {formatMeetingDate(row.upcomingSpeakerAt, timezone)}
					</span>
				) : (
					<span className="text-xs text-[var(--sea-ink-soft)]">
						Not scheduled
					</span>
				)}
				{/* OUTSIDE the member-page link above, so opening a draft never
				    navigates to the profile (#900). Icon-only: the row's right
				    cell is narrow at 375px, and the accessible names carry the
				    words. GavelUp drafts; the VPE sends from their own app. */}
				{showNudge ? (
					<NudgeButtons
						mode="level"
						iconOnly
						name={row.name}
						preferredName={row.preferredName}
						phone={row.phone}
						email={row.email}
						meetingDate={nudge.meetingDate}
						shareUrl={nudge.shareUrl}
						pathName={row.pathName}
						level={row.level}
						projectsLeft={row.projectsLeft}
						projectNames={row.projectNames}
						electivesToChoose={row.electivesToChoose}
					/>
				) : null}
			</div>
		</div>
	);
}

/**
 * One member in orientation (#942).
 *
 * `ProximityRow`'s shape: the member-page `<Link>` wraps only the avatar and
 * the name, because the right-hand cell holds the nudge's draft links and an
 * anchor inside an anchor swallows the click. The ticks and the mentor line sit
 * under the name, indented to clear the avatar, and WRAP, so the row still says
 * everything at 375px.
 *
 * "Stalled" (more than `ORIENTATION_STALLED_AFTER_DAYS` days) is said in TEXT
 * as well as amber, for the reason `PairingRow` gives: colour alone carries
 * nothing for a screen reader.
 */
function OrientationRow({
	row,
	nudge,
	origin,
}: {
	row: OrientationRosterRow;
	nudge: LevelNudgeContext | null;
	origin: string;
}) {
	const stalled = isStalledInOrientation(row.days);
	return (
		<div
			data-testid="orientation-row"
			className="grid grid-cols-[1fr_auto] items-center gap-3.5 border-b border-[var(--line)] px-5 py-3 last:border-b-0"
		>
			<div className="min-w-0">
				<Link
					to="/members/$id"
					params={{ id: row.memberId }}
					className="flex min-w-0 items-center gap-3"
				>
					<MemberAvatar
						tone={toneFromSeed(row.memberId)}
						initials={initialsOf(row.name)}
						size={38}
					/>
					<span className="truncate text-sm font-bold">{row.name}</span>
				</Link>
				<ul className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 pl-[50px] text-xs">
					{row.items.map((item) => (
						<li
							key={item.key}
							className={cn(
								"inline-flex items-center gap-1",
								item.done
									? "text-[var(--lagoon-deep)]"
									: "text-[var(--sea-ink-soft)]",
							)}
						>
							{item.done ? (
								<Check className="size-3" aria-hidden />
							) : (
								<Circle className="size-3" aria-hidden />
							)}
							{ORIENTATION_TICK_LABELS[item.key]}
							<span className="sr-only">{item.done ? " done" : " to do"}</span>
						</li>
					))}
				</ul>
				<div className="pl-[50px] text-xs text-[var(--sea-ink-soft)]">
					{row.mentorNames.length > 0
						? `Mentor: ${row.mentorNames.join(", ")}`
						: "No mentor"}
				</div>
			</div>
			<div className="flex items-center gap-2 justify-self-end">
				<div className="text-right text-sm">
					<span
						className={cn(
							"font-bold whitespace-nowrap",
							stalled
								? "text-[var(--warning-strong)]"
								: "text-[var(--sea-ink)]",
						)}
					>
						{orientationDayLabel(row.days)}
					</span>
					{stalled ? (
						<div className="text-xs font-bold whitespace-nowrap text-[var(--warning-strong)]">
							Over {ORIENTATION_STALLED_AFTER_DAYS} days
						</div>
					) : null}
				</div>
				{/* The draft names the member's next open item. GavelUp drafts;
				    the VPE sends from their own app (ADR-0028). With no next
				    meeting the path, Base Camp and mentor drafts are still
				    offered, without a meeting in them; the two slot items need
				    one and get no draft. `origin` is empty on the server pass,
				    so no link renders before mount. */}
				{origin && orientationNudgeAvailable(row.items, nudge !== null) ? (
					<NudgeButtons
						mode="orientation"
						iconOnly
						name={row.name}
						preferredName={row.preferredName}
						phone={row.phone}
						email={row.email}
						meetingDate={nudge?.meetingDate}
						shareUrl={nudge?.shareUrl}
						items={row.items}
						origin={origin}
					/>
				) : null}
			</div>
		</div>
	);
}

/**
 * One speaker and the people who have evaluated them (#709).
 *
 * Laid out as identity-then-chips INSIDE one grid cell rather than as its own
 * column, unlike the three rows above. Those hide their extra columns below
 * `sm` and send the officer to the member profile for the rest; here the
 * evaluator list IS the row, so hiding it would leave a row that says nothing
 * on the phone a VPE actually assigns roles from. Wrapping chips cost nothing
 * at desktop width and stay readable at 375px.
 */
function PairingRow({
	row,
	timezone,
	clock,
}: {
	row: EvaluatorPairingRow;
	timezone: string | undefined;
	clock: TenureClock;
}) {
	return (
		<Link
			to="/members/$id"
			params={{ id: row.memberId }}
			className={cn(ROW_CLASS, "grid-cols-[1fr_28px] sm:grid-cols-[1fr_34px]")}
		>
			<div className="min-w-0">
				<MemberIdentity
					memberId={row.memberId}
					name={row.name}
					joinedAt={row.joinedAt}
					clock={clock}
				/>
				{/* Indented to clear the 38px avatar plus its 12px gap, so the chips
				    line up under the name rather than under the picture. */}
				<div className="mt-2 pl-[50px]">
					<div className="flex flex-wrap items-center gap-1.5">
						{row.recent.map((p) => (
							<PairingChip
								key={`${p.meetingId}:${p.evaluatorKey}`}
								pair={p}
								timezone={timezone}
							/>
						))}
					</div>
					{/* The repeat statement is TEXT, not just the amber chips. Colour
					    alone carries nothing for a screen reader and little for the
					    ~8% of men who cannot separate these two swatches, and this
					    line is the only thing on the row that says what to DO. */}
					<div
						className={cn(
							"mt-1 text-xs",
							row.hasRepeat
								? "font-bold text-[var(--warning-foreground)]"
								: "text-[var(--sea-ink-soft)]",
						)}
					>
						{row.hasRepeat
							? "Repeated evaluator — vary the next one"
							: `${row.distinctEvaluators} different evaluator${
									row.distinctEvaluators === 1 ? "" : "s"
								}`}
					</div>
				</div>
			</div>
			<Chevron />
		</Link>
	);
}

/**
 * One past evaluation: who, and when.
 *
 * The guest suffix is spelled out rather than implied by styling, for the
 * reason #709 lists it as an acceptance criterion: an evaluator who is not on
 * the roster is exactly the pairing an assigner would otherwise not think to
 * count, and a chip that looks like every other one hides that.
 */
function PairingChip({
	pair,
	timezone,
}: {
	pair: EvaluationPair;
	timezone: string | undefined;
}) {
	return (
		<span
			className={cn(
				"inline-flex max-w-full items-baseline gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold",
				pair.repeat
					? "border-[var(--warning)] bg-[var(--warning-soft)] text-[var(--warning-foreground)]"
					: "border-[var(--line)] text-[var(--sea-ink)]",
			)}
		>
			{/* The NAME wraps and the date does not: a long name in a
			    `whitespace-nowrap` chip overflows the row, and `Section`'s
			    `overflow-hidden` then clips it away entirely at 375px. */}
			<span className="min-w-0 break-words">
				{pair.evaluatorName}
				{pair.isGuest ? " (guest)" : ""}
			</span>
			{/* Year shown when it is not this year. The window is the last FIVE
			    evaluations, not the last N months, so a rare speaker's chips can
			    be years old — and a year-less date reads exactly like this
			    year's, letting a stale repeat drive "vary the next one". */}
			<span className="whitespace-nowrap text-[var(--sea-ink-soft)]">
				{formatHistoryDate(pair.scheduledAt, { timeZone: timezone })}
			</span>
		</span>
	);
}

function Chevron() {
	return (
		<div className="justify-self-end text-[var(--sea-ink-soft)] opacity-45 transition-all group-hover:translate-x-0.5 group-hover:opacity-100">
			<ChevronRight className="size-4" aria-hidden />
		</div>
	);
}
