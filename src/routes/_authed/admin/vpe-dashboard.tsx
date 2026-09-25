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
import { LEVEL_PROXIMITY, proximityDetail } from "#/lib/level-proximity";
import { formatTenure } from "#/lib/members";
import { cn } from "#/lib/utils";
import {
	getAttendanceLapse,
	getEvaluatorPairings,
	getLevelProximity,
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
				timezone: undefined as string | undefined,
				clubName: "",
			};
		}
		const [rotation, overdue, lapse, pairings, proximity] = await Promise.all([
			getSpeakerRotation({ data: { clubId: club.clubId } }),
			getOverdueMembers({ data: { clubId: club.clubId } }),
			getAttendanceLapse({ data: { clubId: club.clubId } }),
			getEvaluatorPairings({ data: { clubId: club.clubId } }),
			getLevelProximity({ data: { clubId: club.clubId } }),
		]);
		return {
			rotation,
			overdue,
			lapse,
			pairings,
			proximity: proximity.rows,
			// The club's zone, for EVERY date on this page that names a day. The
			// Booked marker passed none and printed the server's day, so a
			// booking at 23:30 club time read as the next day (#898).
			timezone: proximity.timezone as string | undefined,
			clubName: club.name,
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
	// `proximity` defaults to empty only for the sibling component suites
	// (`vpe-upcoming-claim`, `vpe-evaluator-pairings`) that stub this loader
	// with the four keys that existed before #898. The loader always sets it.
	const {
		rotation,
		overdue,
		lapse,
		pairings,
		proximity = [],
		timezone,
	} = Route.useLoaderData();

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
					overdueMembers.map((m) => (
						<OverdueRow key={m.memberId} member={m} timezone={timezone} />
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
				title="Close to a level"
				subtitle={`Members with 1–${LEVEL_PROXIMITY.maxProjectsLeft} projects left in a level. Levels waiting on Base Camp approval come first.`}
			>
				{proximity.length === 0 ? (
					<EmptyRow>Nobody is within two projects of a level yet.</EmptyRow>
				) : (
					proximity.map((r) => (
						<ProximityRow
							key={`${r.memberId}:${r.pathName}:${r.kind}`}
							row={r}
							timezone={timezone}
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
					pairings.map((p) => <PairingRow key={p.memberId} row={p} />)
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
	upcomingRoleAt,
	timezone,
}: {
	memberId: string;
	name: string;
	joinedAt: Date | string | null;
	/** #543 — omitted by callers that have no upcoming-claim data (LapseRow). */
	upcomingRoleAt?: Date | string;
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
					{upcomingRoleAt ? (
						<BookedPill at={upcomingRoleAt} timezone={timezone} />
					) : null}
				</div>
				<div className="text-xs text-[var(--sea-ink-soft)]">
					{joinedAt ? formatTenure(joinedAt) : "Tenure unknown"}
				</div>
				{upcomingRoleAt ? (
					<BookedLine at={upcomingRoleAt} timezone={timezone} />
				) : null}
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
 * **"Booked", not "Up next".** This renders in the SPEAKER QUEUE as well as the
 * overdue list, and the claim behind it is for a role of ANY kind — which is
 * what the overdue list wants, since overdue means no claimed role at all. In a
 * list whose subtitle says "ranked by how long since they last held a speaker
 * role", "Up next" beside a member booked as Timer reads as "speaking Monday":
 * the VPE skips her and she goes another cycle without speaking. That is #543's
 * own contradiction pointing the other way. Role-neutral copy is true on both
 * surfaces; narrowing the marker to speaker roles was the alternative and
 * throws away the engagement signal the overdue list is asking for.
 * `reporting.integration.test.ts` pins the any-role half and the component
 * suite pins the wording, so neither can be changed alone.
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
}: {
	member: OverdueMemberRow;
	timezone?: string;
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
				upcomingRoleAt={member.upcomingRoleAt}
				timezone={timezone}
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

function RotationRow({
	row,
	rank,
	timezone,
}: {
	row: SpeakerRotationRow;
	rank: number;
	timezone?: string;
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
				upcomingRoleAt={row.upcomingRoleAt}
				timezone={timezone}
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

/**
 * One member close to a level, or with a level awaiting approval (#898).
 *
 * `RotationRow`'s shape, with one difference that matters later: the `<Link>`
 * to the member page wraps only the avatar and the name, NOT the row. The nudge
 * follow-up adds buttons to the right-hand cell, and a button inside an anchor
 * is invalid markup that swallows the click.
 *
 * The Speaking marker mirrors `BookedPill` / `BookedLine` exactly, for the same
 * width reasons: a pill from `sm` up, a wrapping line below it.
 */
function ProximityRow({
	row,
	timezone,
}: {
	row: LevelProximityRow;
	timezone?: string;
}) {
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
			<div className="justify-self-end">
				{row.upcomingSpeakerAt ? (
					<span className="hidden shrink-0 rounded-full bg-[rgba(79,184,178,.16)] px-2 py-0.5 text-[11px] font-bold whitespace-nowrap text-[var(--lagoon-deep)] sm:inline-block">
						Speaking · {formatMeetingDate(row.upcomingSpeakerAt, timezone)}
					</span>
				) : (
					<span className="text-xs text-[var(--sea-ink-soft)]">
						Not scheduled
					</span>
				)}
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
function PairingRow({ row }: { row: EvaluatorPairingRow }) {
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
				/>
				{/* Indented to clear the 38px avatar plus its 12px gap, so the chips
				    line up under the name rather than under the picture. */}
				<div className="mt-2 pl-[50px]">
					<div className="flex flex-wrap items-center gap-1.5">
						{row.recent.map((p) => (
							<PairingChip key={`${p.meetingId}:${p.evaluatorKey}`} pair={p} />
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
function PairingChip({ pair }: { pair: EvaluationPair }) {
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
				{formatHistoryDate(pair.scheduledAt)}
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
