// The digital agenda's page body (#1335): a read-only run of show for a phone,
// designed for a guest who has never seen a meeting.
//
// Rows come from the SAME three calls `/print` makes (`resolveAgendaRows` →
// `applyFlex` → `buildTimeline`), so the phone and the paper cannot disagree
// about what time a row starts. Nothing here is viewer-dependent at render
// time: the "You" badge is added after hydration, so every visitor is served
// byte-identical HTML.
//
// Never drawn, by decision: timing marks, slide links, claim buttons,
// attendance, the join link, organizer notes.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ClubLogo } from "#/components/agenda/club-logo";
import { CancelledMeetingNotice } from "#/components/club/cancelled-meeting-notice";
import { OPEN_LABEL, slotAssigneeDisplay } from "#/lib/agenda";
import {
	type AgendaSlot,
	applyFlex,
	resolveAgendaRows,
} from "#/lib/agenda-runsheet";
import { buildTimeline, type TimelineRow } from "#/lib/agenda-timing";
import { authClient } from "#/lib/auth-client";
import { APP_LOCALE } from "#/lib/format";

/** A slot as the public meeting payload carries it: the run-sheet shape plus
 *  who holds it, which "You" is decided from. */
export type RunOfShowSlot = AgendaSlot & { assigneeId?: string | null };

type Template = Parameters<typeof resolveAgendaRows>[0]["template"];

export type MeetingRunOfShowProps = {
	/** The club's URL segment, for the link to the meeting page. */
	clubParam: string;
	/** The meeting's URL segment. */
	meetingParam: string;
	meeting: {
		id: string;
		scheduledAt: string | Date;
		lengthMinutes: number;
		location?: string | null;
		theme?: string | null;
		wordOfTheDay?: string | null;
		wodDefinition?: string | null;
		wodExample?: string | null;
	};
	slots: RunOfShowSlot[];
	timezone: string;
	clubName: string;
	logoUrl: string | null;
	cancelled: boolean;
	/** Role description by role key, falling back to role name. */
	roleDescriptions: Record<string, string>;
	geIntroducesFunctionaries: boolean;
	tableTopicsMinSeconds: number | null;
	tableTopicsMaxSeconds: number | null;
	template: Template;
};

/** "6:45 – 7:45 PM": drop the meridiem from the start when it matches the end's. */
function timeRange(startsAt: Date, endsAt: Date, timeZone: string): string {
	const fmt = (d: Date) =>
		new Intl.DateTimeFormat(APP_LOCALE, {
			hour: "numeric",
			minute: "2-digit",
			timeZone,
		}).format(d);
	const start = fmt(startsAt);
	const end = fmt(endsAt);
	const meridiem = (s: string) => s.match(/\s?([AP]M)$/i)?.[1]?.toUpperCase();
	const startShort =
		meridiem(start) && meridiem(start) === meridiem(end)
			? start.replace(/\s?[AP]M$/i, "")
			: start;
	return `${startShort} – ${end}`;
}

/** The viewer's member id once the session resolves, or null. Client only:
 *  nothing about the viewer is in the loader or the server-rendered HTML. */
function useViewerMemberId(meetingId: string): string | null {
	const { data: session } = authClient.useSession();
	const userId = session?.user?.id ?? null;
	const voter = useQuery({
		queryKey: ["ballot-session-voter", meetingId, userId],
		enabled: userId !== null,
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		queryFn: async () => {
			// Lazy, as `/vote` does: only a signed-in phone ever needs it.
			const { getBallotSessionVoter } = await import(
				"#/server/ballot-session-voter"
			);
			return getBallotSessionVoter({ data: { meetingId } });
		},
	});
	return userId !== null ? (voter.data?.id ?? null) : null;
}

const UNFILLED = "—";

export function MeetingRunOfShow(props: MeetingRunOfShowProps) {
	const {
		clubParam,
		meetingParam,
		meeting,
		slots,
		timezone,
		clubName,
		logoUrl,
		cancelled,
		roleDescriptions,
	} = props;
	const viewerId = useViewerMemberId(meeting.id);

	// The print route's seam, called identically.
	const runRows = resolveAgendaRows({
		geIntroducesFunctionaries: props.geIntroducesFunctionaries,
		tableTopicsLimits: {
			minSeconds: props.tableTopicsMinSeconds,
			maxSeconds: props.tableTopicsMaxSeconds,
		},
		template: props.template,
		slots,
	});
	const flex = applyFlex(runRows, meeting.lengthMinutes);
	const rows = buildTimeline(flex.rows, meeting.scheduledAt, timezone);

	const startsAt = new Date(meeting.scheduledAt);
	const endsAt = new Date(startsAt.getTime() + flex.projectedMinutes * 60_000);
	const dateLong = new Intl.DateTimeFormat(APP_LOCALE, {
		weekday: "long",
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: timezone,
	}).format(startsAt);

	const slotById = new Map(slots.map((s) => [s.id, s]));

	return (
		<main className="mx-auto w-full max-w-xl px-4 pb-12 pt-6 text-foreground break-words">
			<header className="space-y-2 border-b border-border pb-4">
				<div className="flex items-center gap-3">
					<ClubLogo logoUrl={logoUrl} height={36} maxWidth={120} />
					<p className="min-w-0 text-sm font-semibold text-muted-foreground">
						{clubName}
					</p>
				</div>
				<h1 className="font-display text-2xl font-semibold leading-tight">
					{dateLong}
				</h1>
				<p className="text-base">{timeRange(startsAt, endsAt, timezone)}</p>
				{meeting.location ? (
					<p className="text-sm text-muted-foreground">{meeting.location}</p>
				) : null}
				{meeting.theme ? (
					<p className="text-sm">
						<span className="font-semibold">Theme:</span> {meeting.theme}
					</p>
				) : null}
				{meeting.wordOfTheDay ? (
					<div className="text-sm">
						<p>
							<span className="font-semibold">Word of the Day:</span>{" "}
							{meeting.wordOfTheDay}
						</p>
						{meeting.wodDefinition ? (
							<p className="text-muted-foreground">{meeting.wodDefinition}</p>
						) : null}
						{meeting.wodExample ? (
							<p className="italic text-muted-foreground">
								{meeting.wodExample}
							</p>
						) : null}
					</div>
				) : null}
				<Link
					to="/club/$clubId/meeting/$meetingId"
					params={{ clubId: clubParam, meetingId: meetingParam }}
					className="inline-block text-sm font-semibold text-primary underline-offset-4 hover:underline"
				>
					Meeting page
				</Link>
			</header>

			{cancelled ? (
				<div className="pt-6">
					<CancelledMeetingNotice
						clubId={clubParam}
						meetingId={meeting.id}
						detail="There is no agenda to follow for this meeting."
					/>
				</div>
			) : (
				<ol className="divide-y divide-border" data-testid="run-of-show">
					{rows.map((row, i) => (
						<RunRow
							// biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id, and the list is never reordered client-side
							key={i}
							row={row}
							slot={row.slotId ? slotById.get(row.slotId) : undefined}
							slots={slots}
							roleDescriptions={roleDescriptions}
							viewerId={viewerId}
						/>
					))}
				</ol>
			)}
		</main>
	);
}

function RunRow({
	row,
	slot,
	slots,
	roleDescriptions,
	viewerId,
}: {
	row: TimelineRow;
	slot: RunOfShowSlot | undefined;
	slots: RunOfShowSlot[];
	roleDescriptions: Record<string, string>;
	viewerId: string | null;
}) {
	if (row.section) {
		return (
			<li className="pb-1 pt-5">
				<h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					{row.who}
				</h2>
			</li>
		);
	}

	const isRole = row.roleLabel !== undefined;
	const title = row.roleLabel ?? row.who;
	const holders =
		row.holders && row.holders.length > 1 ? row.holders.join(", ") : null;
	const person = holders ?? holderText(row.holder);
	const isSpeaker = slot?.isSpeakerRole === true;
	const evaluator = isSpeaker
		? slots.find((s) => s.evaluatesSlotId === slot.id && s.assigneeName)
		: undefined;
	const isYou =
		viewerId !== null &&
		slot?.assigneeId != null &&
		slot.assigneeId === viewerId;

	const description =
		(row.roleKey ? roleDescriptions[row.roleKey] : undefined) ??
		(slot ? roleDescriptions[slot.roleName] : undefined);

	const body = (
		<div className="flex gap-3 py-3">
			<span className="w-12 shrink-0 text-sm font-semibold tabular-nums text-muted-foreground">
				{row.time}
			</span>
			<div className="min-w-0 flex-1 space-y-0.5">
				<p className="text-sm font-semibold">{title}</p>
				{isRole ? (
					<p className="text-base">
						{person}
						{isYou ? (
							<span className="ml-2 rounded-full bg-primary px-2 py-0.5 align-middle text-xs font-semibold text-primary-foreground">
								You
							</span>
						) : null}
					</p>
				) : null}
				{isSpeaker && slot ? (
					<SpeakerFacts slot={slot} evaluator={evaluator} />
				) : row.detail ? (
					<p className="text-sm text-muted-foreground">{row.detail}</p>
				) : null}
			</div>
		</div>
	);

	if (!description) return <li>{body}</li>;
	return (
		<li>
			<details className="group">
				<summary className="cursor-pointer list-none">{body}</summary>
				<p className="pb-3 pl-15 text-sm text-muted-foreground">
					{description}
				</p>
			</details>
		</li>
	);
}

/** "—" when the row has a role and nobody holds it (the run sheet's own
 *  placeholder is "— open —", which reads as an invitation on a read-only page). */
function holderText(holder: string | null | undefined): string {
	if (!holder) return UNFILLED;
	return holder === OPEN_LABEL ? UNFILLED : holder;
}

function SpeakerFacts({
	slot,
	evaluator,
}: {
	slot: RunOfShowSlot;
	evaluator: RunOfShowSlot | undefined;
}) {
	const timing =
		slot.minMinutes != null && slot.maxMinutes != null
			? `${slot.minMinutes}–${slot.maxMinutes} min`
			: null;
	return (
		<div className="space-y-0.5 text-sm text-muted-foreground">
			{slot.speechTitle ? (
				<p className="font-semibold text-foreground">“{slot.speechTitle}”</p>
			) : null}
			{slot.projectLevel ? <p>{slot.projectLevel}</p> : null}
			{timing ? <p>{timing}</p> : null}
			{evaluator ? <p>Evaluated by {slotAssigneeDisplay(evaluator)}</p> : null}
		</div>
	);
}
