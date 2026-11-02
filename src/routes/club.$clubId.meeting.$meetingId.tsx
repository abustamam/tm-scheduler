import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import {
	CalendarDays,
	CalendarX,
	ClipboardList,
	Clock,
	Loader2,
	Lock,
	MapPin,
	RotateCcw,
	Sparkles,
	Video,
	WifiOff,
} from "lucide-react";
import { useMemo } from "react";
import { MeetingAgenda } from "#/components/agenda/meeting-agenda";
import { MeetingAnnouncements } from "#/components/agenda/meeting-announcements";
import { MeetingMetaDialog } from "#/components/agenda/meeting-meta-dialog";
import { MeetingTemplateDialog } from "#/components/agenda/meeting-template-dialog";
import { MeetingWordOfTheDayDialog } from "#/components/agenda/meeting-word-of-the-day-dialog";
import { AbsentReleaseDialog } from "#/components/club/absent-release-dialog";
import { CoverChip } from "#/components/club/cover-chip";
import { CoverLandingCard } from "#/components/club/cover-landing-card";
import { CoverSheet } from "#/components/club/cover-sheet";
import { DeclineReleaseDialog } from "#/components/club/decline-release-dialog";
import { DigitalVotingSwitch } from "#/components/club/digital-voting-switch";
import { GuestResources } from "#/components/club/guest-resources";
import { useRequireIdentity } from "#/components/club/identity-gate";
import { LineupBlastSheet } from "#/components/club/lineup-blast-sheet";
import { MeetingAttendancePanel } from "#/components/club/meeting-attendance-panel";
import { MeetingCancellationSheet } from "#/components/club/meeting-cancellation-sheet";
import { MeetingFeedbackLink } from "#/components/club/meeting-feedback-link";
import { MeetingMinutes } from "#/components/club/meeting-minutes";
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
import { MeetingPersonalStrip } from "#/components/club/meeting-personal-strip";
import { MeetingReadinessPanel } from "#/components/club/meeting-readiness-panel";
import { MeetingRoomStrip } from "#/components/club/meeting-room-strip";
import {
	MeetingToolbar,
	stripIsPrimary,
} from "#/components/club/meeting-toolbar";
import { MeetingYourJobs } from "#/components/club/meeting-your-jobs";
import { OpenActionItems } from "#/components/club/open-action-items";
import { TableTopicsCapture } from "#/components/club/table-topics-capture";
import { useMeetingCover } from "#/components/club/use-meeting-cover";
import { useMeetingLifecycle } from "#/components/club/use-meeting-lifecycle";
import { useMeetingOutreach } from "#/components/club/use-meeting-outreach";
import { useMeetingRoll } from "#/components/club/use-meeting-roll";
import { useMeetingVotes } from "#/components/club/use-meeting-votes";
import { VoteCounterPanel } from "#/components/club/vote-counter-panel";
import { MeetingNotFound } from "#/components/meeting-not-found";
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
import { Label } from "#/components/ui/label";
import { WhatsNewBanner } from "#/components/whats-new-banner";
import { useOfflineMinutes } from "#/hooks/use-offline-minutes";
import { useOnlineStatus } from "#/hooks/use-online-status";
import { buildHeldRoleLines } from "#/lib/absent-release-roles";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { applyFlex, resolveAgendaRows } from "#/lib/agenda-runsheet";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { buildTemplateSlideDeck } from "#/lib/agenda-template-slides";
import { defaultAttendanceMode } from "#/lib/attendance-mode";
import {
	buildPanelRoleMap,
	publicComingCount,
	publicCountsLine,
} from "#/lib/attendance-panel";
import { clubLogoUrl } from "#/lib/club-logo-url";
import { ballotUrlFor } from "#/lib/digital-voting";
import { evaluatingByMember } from "#/lib/evaluator-form";
import { feedbackWindow } from "#/lib/feedback-window";
import {
	formatMeetingTime,
	formatMeetingTimeRange,
	meetingHeading,
} from "#/lib/format";
import { buildHeldRoleLabels } from "#/lib/held-role-labels";
import { rsvpPageUrl } from "#/lib/lineup-blast";
import { markedAbsentMemberIds } from "#/lib/marked-absent-member-ids";
import { MINUTES_ANCHOR_ID } from "#/lib/meeting-anchors";
import {
	holdersFromSlots,
	isCancellationNoticeRequested,
	isMeetingCancelled,
	MEETING_CANCELLED_MESSAGE,
	meetingHasStarted,
} from "#/lib/meeting-cancellation-notice";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import {
	isInRoom,
	MEETING_AGENDA_ANCHOR_ID,
	validateMeetingRoomSearch,
} from "#/lib/meeting-hub";
import {
	isMeetingLocked,
	isMeetingOver,
	lockedViewer,
	MEETING_LOCKED_MESSAGE,
	meetingDatePassed,
	meetingDateReached,
	meetingPhase,
	resolveMeetingViewer,
} from "#/lib/meeting-lifecycle";
import { deriveMeetingNavItems } from "#/lib/meeting-nav";
import {
	canSeeMeetingReadiness,
	meetingReadiness,
	showsMeetingReadiness,
} from "#/lib/meeting-readiness";
import { deriveMeetingRoleFlags } from "#/lib/meeting-roles";
import { useEffectiveMember } from "#/lib/member-identity";
import { outstandingDutiesByMember } from "#/lib/nudge";
import { meetingOgImage, OG_IMAGE_SIZE_META } from "#/lib/og-image-url";
import { normalizePresentationUrl } from "#/lib/presentation-url";
import { shareMeta } from "#/lib/share-meta";
import { footerDate } from "#/lib/slide-layout";
import { hasWordOfTheDay } from "#/lib/word-poster";
import { getOpenActionItems } from "#/server/action-items";
import { getClubLogoMeta } from "#/server/club-logo";
import {
	getMeetingByKey,
	getPublicMeetingByKey,
	listPastMeetings,
	listUpcomingMeetings,
} from "#/server/meetings";
import { listMembers } from "#/server/members";
import { getMinutes } from "#/server/minutes";
import { getMinutesRecipients } from "#/server/minutes-email";
import { getMeetingOgVersion } from "#/server/og-card";

// Anonymous (non-shell) visitors never load minutes — this hidden default keeps
// the loader's return shape uniform without a server call or any PII fetch.
const EMPTY_MINUTES = {
	visible: false,
	canEdit: false,
	data: null,
	program: [],
} as Awaited<ReturnType<typeof getMinutes>>;

export const Route = createFileRoute("/club/$clubId/meeting/$meetingId")({
	// `?room=1` — the printed agenda's QR (#913). Returns the parsed search
	// UNCHANGED, or SSR 307s every scan to a re-serialised URL; see
	// `validateMeetingRoomSearch`.
	validateSearch: validateMeetingRoomSearch,
	loader: async ({ params, context }) => {
		// PII boundary (#37): a signed-in member of this club (shell) loads the
		// session-aware getMeetingByKey — an admin regains management + contact; a
		// non-admin member gets canManage=false. An anonymous visitor loads
		// getPublicMeetingByKey (hard canManage=false, never any PII). Both resolve
		// the $meetingId key identically, so the loader shape matches either way
		// (#317). KEEP THIS FORK VERBATIM — public-meeting-contact.guard.test.ts
		// asserts it.
		const load = context.shell ? getMeetingByKey : getPublicMeetingByKey;
		const meetingPromise = load({
			data: { clubId: context.clubUuid, key: params.meetingId },
		}).catch((err) => {
			if (isMeetingNotFoundError(err)) throw notFound();
			throw err;
		});
		const upcomingPromise = listUpcomingMeetings({
			data: context.clubUuid,
		}).catch(() => [] as Awaited<ReturnType<typeof listUpcomingMeetings>>);
		// Needs only the club id, so it starts here alongside the other
		// non-fatal parallel loads. Degrades to no-logo rather than failing the
		// page — same treatment as `upcomingPromise` above.
		const logoPromise = getClubLogoMeta({
			data: { clubId: context.clubUuid },
		}).catch(() => null);

		// Only the preview image's cache-buster: a failure drops `?v=`, never the page.
		const ogVersionPromise = getMeetingOgVersion({
			data: { clubId: context.clubUuid, key: params.meetingId },
		}).catch(() => null);

		const data = await meetingPromise;
		// Guard against a meetingId that belongs to a different club than the URL.
		if (data.meeting.clubId !== context.clubUuid) throw notFound();

		// Nav strip backward paging (#375): the window of meetings immediately
		// BEFORE the one being viewed — anchored to THIS meeting rather than to
		// today, so paging back from a three-month-old meeting keeps going back
		// instead of jumping to last week. Public like `listUpcomingMeetings`, so
		// the anonymous visitor gets it too. Non-fatal: degrade to forward-only.
		//
		// The gap (#1158): past (`< now`) yet AFTER the viewed meeting, which
		// neither this window nor `listUpcomingMeetings` has. One `after` query
		// against the same archive loader rather than moving the split at now
		// (#393); nothing to fetch when the viewed meeting is not in the past.
		// Both are non-fatal and run in parallel.
		const viewedAt = new Date(data.meeting.scheduledAt);
		const [past, gap] = await Promise.all([
			listPastMeetings({
				data: {
					clubId: context.clubUuid,
					before: viewedAt.toISOString(),
					limit: 3,
				},
			}).catch(() => null),
			viewedAt.getTime() < Date.now()
				? listPastMeetings({
						data: {
							clubId: context.clubUuid,
							after: viewedAt.toISOString(),
						},
					}).catch(() => null)
				: null,
		]);

		const upcoming = await upcomingPromise;
		const navItems = deriveMeetingNavItems(
			data.meeting,
			data.urlKey,
			data.slots,
			upcoming,
			data.timezone,
			[...(past?.meetings ?? []), ...(gap?.meetings ?? [])],
		);

		// Minutes (ADR-0014 / #152) — ONLY for a signed-in member (shell); an anon
		// visitor never reaches getMinutes. Non-fatal: degrade to hidden. Keyed by
		// the resolved uuid (params.meetingId is the pretty key). The PII guard test
		// asserts this shell gate stays.
		const minutes = context.shell
			? await getMinutes({ data: data.meeting.id }).catch(() => EMPTY_MINUTES)
			: EMPTY_MINUTES;
		// Open action items (#529) for a signed-in member, loaded SEPARATELY from
		// the minutes on purpose.
		//
		// `getMinutes` hides everything behind `visible = canEdit || completed`, so
		// riding inside `MinutesData` would hide open items from a non-admin member
		// until after the meeting finished — exactly backwards, since an open item
		// is most useful BEFORE the meeting, and exactly the inherited completion
		// gate the issue told us not to inherit. Only fetched when the minutes
		// section will not already be showing its own pinned list, so the page
		// never renders two action-item lists or pays for two queries.
		//
		// Still member-only: anonymous visitors have `context.shell === false` and
		// never reach this call, the same gate the minutes use.
		const openActionItems =
			context.shell && !minutes.visible
				? await getOpenActionItems({
						data: { clubId: data.meeting.clubId },
					}).catch(() => ({ items: [], total: 0 }))
				: { items: [], total: 0 };
		// Default email recipients (#165) — admins on a completed meeting only.
		const minutesEmail =
			context.shell &&
			minutes.visible &&
			minutes.canEdit &&
			isMeetingLocked(data.meeting.status)
				? await getMinutesRecipients({
						data: { clubId: data.meeting.clubId, meetingId: data.meeting.id },
					}).catch(() => null)
				: null;

		const logoMeta = await logoPromise;
		return {
			...data,
			navItems,
			minutes,
			openActionItems,
			minutesEmail,
			logoUrl: clubLogoUrl(context.clubUuid, logoMeta?.updatedAt),
			ogVersion: await ogVersionPromise,
		};
	},
	component: MeetingView,
	notFoundComponent: MeetingRouteNotFound,
	// Link preview: club name, date and theme ONLY. The page is public but the
	// roll is members-only, so nothing roster-derived may reach a meta tag
	// (share-meta.head.test.ts).
	head: ({ match, params, loaderData }) => {
		const club = match.context.clubName;
		const meeting = loaderData?.meeting;
		const when = meeting
			? meetingHeading(meeting.theme, meeting.scheduledAt, loaderData.timezone)
			: null;
		const cancelled = meeting?.status === "cancelled";
		const title = when ? `${club} · ${when.title}` : club;
		const description = when?.detailDate
			? `${club} meeting on ${when.detailDate}. See the agenda and roles.`
			: `${club} meeting agenda and roles.`;
		return {
			meta: shareMeta({
				title: cancelled ? `Cancelled: ${title}` : title,
				description: cancelled
					? `This meeting is cancelled. ${description}`
					: description,
				path: `/club/${params.clubId}/meeting/${params.meetingId}`,
				image: meetingOgImage(
					match.context.clubUuid,
					params.meetingId,
					loaderData?.ogVersion,
				),
				extra: OG_IMAGE_SIZE_META,
			}),
		};
	},
});

function MeetingRouteNotFound() {
	const { clubId } = Route.useParams();
	return <MeetingNotFound clubId={clubId} />;
}

function MeetingView() {
	// `meetingKeyParam` is the key the URL actually carries (a club-local date
	// or the uuid); `canonicalUrlKey` below is the one the server resolved, and
	// `urlKey` the one this page links with. `doCancel` compares the first to
	// `urlKey` to know whether the page is already on the URL that keeps
	// reaching this meeting once it is cancelled (#1057).
	const { clubId, meetingId: meetingKeyParam } = Route.useParams();
	const { clubUuid, clubSlug, effectiveMemberId, authCtx, shell } =
		Route.useRouteContext();
	const {
		meeting,
		slots,
		canManage,
		timezone,
		unavailableMembers,
		roleRecency,
		navItems,
		clubName,
		clubNumber,
		clubDistrict,
		clubMeetingSchedule,
		tableTopicsMinSeconds,
		tableTopicsMaxSeconds,
		clubRoles,
		coverRequests,
		pairedRoleDefinitionIds,
		clubGuests,
		hasJoinLink,
		guestRsvpCount,
		guestRsvps,
		roster: loaderRoster,
		plan,
		answeredRungs,
		minutes,
		openActionItems,
		minutesEmail,
		meetingNumber,
		nextMeetingAt,
		urlKey: canonicalUrlKey,
		geIntroducesFunctionaries,
		template,
		templateKey,
		logoUrl,
		digitalVoting,
		clubDigitalVotingEnabled,
	} = Route.useLoaderData();
	// The key every link on this page is built from: Share, Present and the
	// export menu, the ballot QR, the nudge drafts and the feedback link. It is
	// the server's canonical key for live and cancelled meetings alike (#1396):
	// a cancelled meeting that shares its date with another gets a `-HHmm` key,
	// which reaches it, so the uuid is no longer needed here.
	const urlKey = canonicalUrlKey;
	const router = useRouter();
	const search = Route.useSearch();
	const online = useOnlineStatus();
	// #176 / DP3: ONE offline-write-queue instance per meeting, shared by
	// <MeetingMinutes> below and (PR 3) the attendance panel's roll-mode
	// writes — two instances would each own their own `draining` flag and race
	// the same persisted queue, replaying a stale status over a newer one.
	const offlineMinutes = useOfflineMinutes({
		meetingId: meeting.id,
		onMutated: async () => {
			await router.invalidate();
		},
		minutes: minutes.data,
	});

	// Shell-wrapped signed-in member → act as the session identity; anonymous
	// visitor → the localStorage-picked member (#317).
	const session =
		effectiveMemberId && authCtx?.user
			? { id: effectiveMemberId, name: authCtx.user.name || authCtx.user.email }
			: null;
	const { member, source } = useEffectiveMember(clubId, session);
	const { requireIdentity, promptIdentity } = useRequireIdentity();
	const myId = member?.id ?? null;
	const isSignedIn = session !== null;
	// The session member drives the manager action path (matches the old
	// /meetings/:id route's `currentMemberId`); null for an impersonating
	// superadmin (canManage without a linked member).
	const managerActorId = session?.id ?? null;

	// #320, made app-wide by #1113: the shell's "Preview as member" (a cookie, so it
	// survives navigation and reload) is what the page reads. `authCtx` is null for
	// an anonymous visitor, who has nothing to preview.
	const previewAsMember = authCtx?.viewAs === "member";
	// One club config drives both renderings of this meeting (#367).
	const flex = applyFlex(
		resolveAgendaRows({
			geIntroducesFunctionaries,
			tableTopicsLimits: {
				minSeconds: tableTopicsMinSeconds,
				maxSeconds: tableTopicsMaxSeconds,
			},
			template,
			slots,
		}),
		meeting.lengthMinutes,
	);
	const projectedEnd = new Date(
		new Date(meeting.scheduledAt).getTime() + flex.projectedMinutes * 60_000,
	);
	// Absolute so a QR built from it resolves without the app's own origin
	// (#510) — same relative-during-SSR/absolute-after-hydrate split as
	// `nudgeShareUrl` below, computed here because `buildSlideDeck` (unlike
	// that share link) needs it up front to stamp onto every vote slide.
	// Null when this meeting runs no digital vote (#770).
	const ballotUrl = ballotUrlFor(
		digitalVoting,
		{ clubKey: clubId, meetingKey: urlKey },
		typeof window === "undefined" ? "" : window.location.origin,
	);
	// Which BUILDER, not whether to build (#agenda-templates PR 2). A templated
	// meeting gets the beat-driven deck built from the printed run sheet's OWN
	// rows — `flex.rows` is that same array, POST-flex, so the deck and the sheet
	// cannot disagree about order or about a clamped duration. A standard meeting gets the standard deck,
	// whose slides bind to the seven standard role keys a template does not have.
	// Never a mix, and no longer ever empty: the export menu's deck actions gate
	// on length, and an empty deck used to be how a contest hid them.
	const deck = template
		? buildTemplateSlideDeck({
				meeting,
				club: {
					name: clubName,
					clubNumber,
					district: clubDistrict,
					timezone,
					meetingSchedule: clubMeetingSchedule,
					tableTopicsMinSeconds,
					tableTopicsMaxSeconds,
					logoUrl,
				},
				rows: flex.rows,
				nextMeetingAt,
				meetingNumber,
			})
		: buildSlideDeck({
				meeting,
				club: {
					name: clubName,
					clubNumber,
					district: clubDistrict,
					timezone,
					meetingSchedule: clubMeetingSchedule,
					tableTopicsMinSeconds,
					tableTopicsMaxSeconds,
					logoUrl,
				},
				slots,
				nextMeetingAt,
				meetingNumber,
				geIntroducesFunctionaries,
				ballotUrl,
			});

	const { isTmod, isGrammarian, isVoteCounter } = deriveMeetingRoleFlags(
		slots,
		myId,
	);
	// ONE clock for the whole render (spec D1): every phase/freeze/completability
	// consumer on this page reads the same instant, so a render can't straddle
	// midnight and show a "today" toolbar over an already-frozen agenda. There
	// is deliberately no timer re-deriving `now` on an interval: a tab left
	// open across club-local midnight keeps whatever phase it had until the
	// next render or navigation. That staleness is accepted, not a bug — it
	// self-heals on the next interaction, and a live timer would add
	// re-render churn to every open tab for a case (a meeting page open past
	// midnight, unattended) that is rare and low-stakes.
	const now = new Date();
	const phase = meetingPhase({
		status: meeting.status,
		scheduledAt: meeting.scheduledAt,
		timezone,
		now,
	});
	const locked = isMeetingLocked(meeting.status);
	// Cancelled (#1057): its own axis beside `locked`. A cancelled meeting is
	// not completed and not over, but every member-facing write on it is
	// refused server-side, so the page hides the claim, attendance and vote
	// controls and shows the banner; the server refusal is the real bound.
	const cancelled = isMeetingCancelled(meeting.status);
	// The in-room strip (#913): the QR's flag AND meeting day, off the same
	// frozen `phase` as everything else — so it cannot disappear mid-visit at
	// club-local midnight. Any other day, `?room=1` renders the normal page.
	// Never on a cancelled meeting (#1057): everything in the strip — Vote,
	// what I'm doing today, the guest book, feedback — is for a meeting that is
	// happening, and cancelling does not close vote sessions (a restore must
	// lose nothing), so without this a scanned QR on today's cancelled meeting
	// offered a Vote that `castVote` then refused.
	const inRoom = isInRoom(search) && phase === "today" && !cancelled;
	// Anonymous role feedback (#984): offered from the meeting's start until
	// three days after its scheduled end, off the same frozen `now`. The server
	// re-checks the window on every write, so this only decides the link. Never
	// on a cancelled meeting (#1057): `leaveFeedbackLogic` refuses every note on
	// one, and the feedback page says it is cancelled rather than listing names.
	const feedbackOpen = !cancelled && feedbackWindow(meeting, now).canWrite;
	const holdsRole = myId !== null && slots.some((s) => s.assigneeId === myId);
	// #731. Null unless the club set a join link AND it still normalizes to an
	// http(s) URL — see the render site in the header for why it is re-checked
	// here rather than read straight off the row.
	const joinUrl = normalizePresentationUrl(meeting.joinUrl);
	// #1049. Where roll mode's in person / online toggle starts: online for an
	// online-only meeting (join link, no location), in person otherwise. Read off
	// the NORMALIZED link, so a stored value the header would refuse to render
	// cannot make a meeting online-only either.
	const attendanceDefaultMode = defaultAttendanceMode({
		joinUrl,
		location: meeting.location,
	});
	// Its own fact, not a step toward `over`: it drives the "already taken place"
	// notice, which a manager (still editing) must not see.
	const datePassed = meetingDatePassed(meeting.scheduledAt, timezone, now);
	const heading = meetingHeading(meeting.theme, meeting.scheduledAt, timezone);
	// The one "is it over?" rule (#393) — shared with `resolveMeetingViewer` and
	// handed to <MeetingAgenda> rather than recomputed there.
	const over = isMeetingOver({
		status: meeting.status,
		scheduledAt: meeting.scheduledAt,
		timezone,
		now,
	});
	// #320: previewing-as-member drops management everywhere it gates admin UI.
	// `canManage` itself stays the server's real answer (#663,
	// `decline-release-wiring.guard.test.ts`): the server releases roles with the
	// session's real authority, so a downgraded flag would promise the wrong outcome.
	const effectiveCanManage = canManage && !previewAsMember;
	// The "Before the meeting" panel (#963): a club admin (`canManage`, so not an
	// elected officer who lacks the admin role) who is not previewing as a member
	// (#320), or this meeting's Toastmaster, on a meeting that is still to be got
	// ready. The three flags go in as themselves: `canManage` and not
	// `effectiveCanManage`, because the helper owns the preview rule, and
	// `isTmod` survives preview on purpose (the TMOD arm is the viewer's own
	// slot, which previewing does not change), and so does the TMOD arm of
	// `runsThisMeeting` below (#1113). `now` is this render's one clock;
	// the helpers read none of their own. `meeting-readiness-wiring.guard.test.ts`
	// holds all of it, since a component test injects its own props.
	const readiness =
		canSeeMeetingReadiness({ canManage, previewAsMember, isTmod }) &&
		showsMeetingReadiness({
			status: meeting.status,
			scheduledAt: meeting.scheduledAt,
			timezone,
			now,
		})
			? meetingReadiness({
					meeting,
					slots,
					coverRequests,
					now,
					timezone,
					scheduledAt: meeting.scheduledAt,
				})
			: null;
	const canComplete = meetingDateReached(meeting.scheduledAt, timezone, now);
	// Cancel is offered on a scheduled meeting that is not completed and has not
	// STARTED (#1057; the maintainer's rule on #1084): a meeting later today is
	// still cancellable, one that ran this evening is not. `meetingHasStarted`
	// is the rule `applyCancelMeeting` refuses by, read off this render's frozen
	// `now`, so Cancel goes once the meeting starts. Restore keeps the day rule
	// (`!datePassed`, in the banner). The server re-decides under the meeting
	// lock; this only decides what to show.
	const canCancel =
		!locked && !cancelled && !meetingHasStarted(meeting.scheduledAt, now);
	// Spec D2: plan mode is the EXISTING phase, reusing the route's frozen clock.
	// Roll mode (`today` / `completed`) shipped in v1.20.0.0 — see `panelMode`
	// below — so this predicate gates the PLAN half only, NOT whether the panel
	// renders at all. It read "the panel simply does not render outside
	// `upcoming` yet" until then, twenty lines above the line that falsifies it.
	//
	// The Toastmaster of the Day gets it too (#576). They already hold `canAssign`
	// through `runsMeeting`, so before this they could hand someone a role while
	// being unable to see whether that person had said they were coming — the
	// availability signal is the INPUT to the assignment they were already
	// trusted to make. `isTmod` is derived client-side from the slot rows and is
	// display authority only: every write re-verifies against the slot server-side
	// (`resolveActor`), and the ladder they render comes from `getTmodPanelData`,
	// which does its own check.
	// #1113: the TMOD arm is the viewer's OWN slot, which previewing does not
	// change, so a member in your seat sees these controls and so do you.
	const runsThisMeeting = effectiveCanManage || isTmod;
	// The ONE filled button in the action area (#1307): the rule is
	// `stripIsPrimary`, shared with the toolbar's own phase rules.
	const stripPrimary = stripIsPrimary({
		phase,
		cancelled,
		canManage: effectiveCanManage,
	});
	const showPlanPanel = runsThisMeeting && phase === "upcoming";
	// An officer already has `plan` on the payload; only the non-officer TMOD
	// needs the extra round trip, and only while the panel is actually shown.
	const needsTmodPlan = showPlanPanel && !effectiveCanManage && !!myId;
	// ONE derivation of the mode, off the route's existing frozen clock (D2) —
	// so the panel cannot straddle midnight against the agenda beside it.
	// `upcoming` is the pre-meeting outreach ladder; `today` and `completed`
	// both record what actually happened.
	const panelMode = phase === "upcoming" ? "plan" : "roll";
	// DP1: roll mode is signed-in-admin only, deliberately NARROWER than plan
	// mode. `setAttendance` runs `gateAdmin` (requireUser + requireClubRole
	// admin) and the rows it renders come from `getMinutes`, which returns the
	// empty shape without a session — so a Toastmaster who identified by roster
	// pick would get a panel with no recorded rows and every tap 403ing.
	// `minutes.canEdit` specifically, because that is the same signal the
	// Minutes card gates its own recorder on: the two surfaces can never
	// disagree about who may record attendance. The Toastmaster gap is
	// deliberate and filed as a follow-up rather than solved here.
	const showRollPanel = effectiveCanManage && minutes.canEdit;
	// Neither half on a cancelled meeting (#1057): the plan ladder's writes are
	// refused, and there is no roll to call.
	const showPanel =
		!cancelled && (panelMode === "plan" ? showPlanPanel : showRollPanel);

	// One viewer for all audiences: an admin keeps editing a past-but-open meeting
	// until Complete; a member/anon agenda freezes once the date passes; a locked
	// meeting is read-only for everyone. (Pure — unit-tested in Task 1.)
	const resolvedViewer = resolveMeetingViewer({
		status: meeting.status,
		scheduledAt: meeting.scheduledAt,
		timezone,
		currentMemberId: myId,
		canManage: effectiveCanManage,
		isTmod,
		isGrammarian,
		isSignedIn,
		now,
	});
	// A cancelled meeting is read-only for everyone (#1057), officers included:
	// every claim, assignment and availability write the viewer could enable is
	// refused server-side, so the capabilities go the way the lock takes them.
	// `lockedViewer` keeps the identity, so "mine" still highlights.
	const viewer = cancelled ? lockedViewer(resolvedViewer) : resolvedViewer;
	// The notice's holders (#1057), from the SAME slot rows the agenda renders,
	// in agenda order. An officer's rows carry each member holder's address
	// (`holderEmail`, null on the public payload), a guest is named only.
	const cancellationHolders = useMemo(() => holdersFromSlots(slots), [slots]);
	// Arriving with `?notice=1` (#1057): `doCancel` moves a bare-date URL to the
	// uuid URL after the write, and this is how the sheet opens on the far side.
	// Officers only, on a meeting that is actually cancelled — a stale link on
	// a restored meeting opens nothing.
	const noticeRequested = isCancellationNoticeRequested(search);

	// Roster for the assign picker: a manager already has it (with contact) from
	// the loader; a non-admin TMOD (public or signed-in) fetches the plain member
	// list client-side, since the public payload carries no roster.
	const { data: fetchedRoster = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
		// A non-admin TMOD fetches it for the self-serve assign picker (as before);
		// a non-admin Vote Counter needs the same list for the Ballot Counter
		// console's "+ Add speaker" picker (#510 Task 10).
		enabled: !canManage && (isTmod || isVoteCounter),
	});
	const roster = canManage ? loaderRoster : fetchedRoster;

	// The assign-slot roster above is `{ id, name, ... }`; the minutes-style
	// picker `TableTopicsCapture` uses (`AssigneePicker`) expects `{ memberId,
	// name }` — the same shape `MeetingMinutes` gets from `MinutesData["members"]`.
	// Mapped once here rather than changing either shape, since `roster` is also
	// handed to `<MeetingAgenda>` verbatim, unchanged.
	const voteCounterRoster = roster.map((r) => ({
		memberId: r.id,
		name: r.name,
		preferredName: r.preferredName ?? null,
	}));

	// The SERVER's answer, not a second derivation of it (#801). This used to be
	// `pairedRoleIds(clubRoles)`, which was right while `clubRoles` was the
	// meeting's own shape — it is the club's whole role bank now, so the
	// heuristic inside `pairedRoleIds` would answer for the CLUB and name the
	// standard Speaker on a contest. `loadMeetingDetail` resolves the pair
	// against the meeting's declared shape, which is the same set
	// `applyAddRoleSlot` and `applyRemoveRoleSlot` refuse on, so the picker below
	// and the agenda's own paired-slot affordances cannot disagree with the
	// server. An array on the wire because a `Set` does not survive the
	// server-fn boundary.
	const pairedIds = useMemo(
		() => new Set(pairedRoleDefinitionIds),
		[pairedRoleDefinitionIds],
	);
	const addableRoles = clubRoles.filter((r) => !pairedIds.has(r.id));
	// RELATIVE during SSR, absolute after hydration — `window` exists only on the
	// client, and `NudgeButtons` keeps its links off the server render entirely
	// so a draft can never carry the relative form.
	const nudgeOrigin =
		typeof window === "undefined" ? "" : window.location.origin;
	const nudgeShareUrl = `${nudgeOrigin}/club/${clubId}/meeting/${urlKey}`;
	// The pieces a ROLE draft's link is built from (#667): the recipient's own
	// meeting page, `?as=` appended per recipient by `personalNudgeUrl`. Kept as
	// the three parts rather than a finished URL because the member id is known
	// only at the row. `shareUrl` above stays what the role-less `attendance` and
	// `arriving` drafts link to — those ask about the MEETING, and the public
	// agenda is the page that answers.
	// The one-tap RSVP page (#1442), which the still-to-answer rows draft.
	const nudgeRsvpUrl = rsvpPageUrl(nudgeShareUrl);
	// The weekday the rsvp draft names, in the club's zone (as the blast does).
	const nudgeWeekday = new Intl.DateTimeFormat("en-US", {
		weekday: "long",
		timeZone: timezone,
	}).format(new Date(meeting.scheduledAt));
	const nudgePersonalBase = {
		origin: nudgeOrigin,
		clubId,
		meetingKey: urlKey,
	};
	const nudgeDate = footerDate(meeting.scheduledAt, timezone);
	// What each member's role still owes, for the rail's confirm drafts (#667).
	// Built from the SAME unfiltered `slots` array as `panelRoleByMemberId`
	// below — both take a double-booked member's first slot, so the role the
	// draft names and the duty it lists cannot come from different slots. A pure
	// function in `#/lib/nudge` rather than a loop here, for the reason
	// `buildPanelRoleMap` gives beneath it: this route cannot mount in vitest.
	const nudgeDutiesByMemberId = outstandingDutiesByMember(slots, meeting);
	// The speaker each Evaluator evaluates, for the rail's confirm drafts (#1163).
	// Same unfiltered `slots`, same first-slot-wins.
	const nudgeEvaluatingByMemberId = evaluatingByMember(slots);
	// Lifted from <MeetingAgenda> so the agenda and the panel share one map.
	const roleCounts = buildRoleCounts(slots);
	const roleByMemberId: Record<string, string> = {};
	for (const s of slots) {
		if (s.assigneeId) roleByMemberId[s.assigneeId] = slotLabel(s, roleCounts);
	}
	// The RAIL's own map, deliberately separate from `roleByMemberId` above.
	// That one is read as a plain string by four other consumers
	// (<MeetingAgenda>, <AssignSlotSheet>, <NudgeRecruitPicker>, buildPickerRows)
	// and widening its value type to serve one of them is how a shared map
	// becomes everyone's problem. Built by `buildPanelRoleMap` (`#/lib/attendance-panel`)
	// rather than inline here: this route cannot mount in vitest, so a derivation
	// living here is guarded only by source greps — and mutation review found two
	// bugs that pass every one of those greps and a clean typecheck. Keying the
	// lookup by slot instead of member would break the rail completely; numbering
	// codes off only the assigned slots would only silently renumber the badges as
	// the week's slots fill. As a pure function in `lib/`, both are unit-tested
	// directly instead.
	//
	// MUST be called with every slot, unfiltered — `buildShortCodes` numbers a
	// role off however many slots the ARGUMENT has, so `buildPanelRoleMap(slots)`,
	// never `buildPanelRoleMap(slots.filter(...))`. See `attendance-panel.test.ts`'s
	// "numbers a role off every slot it HAS" for what the filtered call produces.
	const panelRoleByMemberId = buildPanelRoleMap(slots);
	const comingCount = publicComingCount(answeredRungs, panelRoleByMemberId);
	// EVERY role a member holds, numbered, for the decline confirm (#663) — the
	// rail's badge map above is one role per member by design, and the officer
	// has to be told about all of them before all of them are freed. Also
	// unfiltered, for the numbering reason `buildPanelRoleMap` gives.
	const heldRolesByMember = buildHeldRoleLabels(slots);
	// The same roles as RECORDS (#1256): slot id, label and speech title together,
	// for the Absent dialog. Its ids are what the release sends.
	const heldRoleLinesByMember = buildHeldRoleLines(slots);
	// Derived here rather than carried as their own payload fields (#396 PR2
	// task 6): both are redundant with data the payload already ships.
	// `unavailableMembers` (public) already names who is `not_coming`;
	// `effectivePlan` already carries every rung including `reached_out` — the
	// payload's gated `plan` for an officer, the separately-verified
	// `getTmodPanelData` rows for this meeting's Toastmaster, and `[]` for everyone
	// else, which is what keeps the recruit picker's "already asked" marks off a
	// plain member's screen.
	const unavailableMemberIds = unavailableMembers.map((m) => m.id);

	// The page's wiring lives in five per-domain hooks (#1476). Each owns its
	// state, queries and writes; anything one domain reads from another comes in
	// as a parameter, and no hook calls another. Order matters only for the
	// values that flow forward: cover (`declineFreesRoles`) and roll (the ladder
	// and rail roster) feed outreach.
	const {
		actions,
		coverSlots,
		closeCoverSheet,
		onCoverChanged,
		onOwnLateRelease,
		coverView,
		coverOver,
		coverChipBySlotId,
		coverTakeBusy,
		takeCoveredRole,
		dismissCoverCard,
		declineFreesRoles,
	} = useMeetingCover({
		clubUuid,
		clubSlug,
		meeting,
		slots,
		coverRequests,
		meetingNumber,
		timezone,
		urlKey,
		search,
		now,
		over,
		roleCounts,
		canManage,
		effectiveCanManage,
		isSignedIn,
		myId,
		managerActorId,
		requireIdentity,
	});
	const {
		rollAttendance,
		rollGuests,
		tmodPlanKey,
		effectivePlan,
		panelRosterForMode,
		tmodPanelUnavailable,
		guestEdit,
		pendingAbsent,
		absentBusy,
		cancelAbsent,
		writeAttendance,
		writeAttendanceMode,
		confirmAbsent,
		addRollGuest,
		setRollGuestMode,
		removeRollGuest,
	} = useMeetingRoll({
		meetingId: meeting.id,
		clubUuid,
		timezone,
		online,
		myId,
		effectiveCanManage,
		minutes,
		offlineMinutes,
		loaderRoster,
		roster,
		plan,
		guestRsvps,
		clubGuests,
		needsTmodPlan,
		panelMode,
		showRollPanel,
		attendanceDefaultMode,
		heldRolesByMember,
		heldRoleLinesByMember,
	});
	const {
		rungOverride,
		myEffectiveStatus,
		myStatusBusy,
		pendingDecline,
		declineBusy,
		cancelDecline,
		setLineupOpen,
		lineupOpen,
		canLineupBlast,
		writeRung,
		markAsked,
		setMyStatus,
		confirmDecline,
		onContacted,
		onUncontacted,
	} = useMeetingOutreach({
		meetingId: meeting.id,
		meetingClubId: meeting.clubId,
		myId,
		isSignedIn,
		isTmod,
		holdsRole,
		cancelled,
		previewAsMember,
		effectiveCanManage,
		needsTmodPlan,
		tmodPlanKey,
		effectivePlan,
		answeredRungs,
		panelRosterForMode,
		heldRolesByMember,
		declineFreesRoles,
	});
	const {
		addRoleOpen,
		setAddRoleOpen,
		addRoleBusy,
		lifecycleAction,
		lifecycleBusy,
		cancelConfirmOpen,
		setCancelConfirmOpen,
		noticeOpen,
		setNoticeOpen,
		wodOpen,
		setWodOpen,
		metaOpen,
		setMetaOpen,
		templateOpen,
		setTemplateOpen,
		templates,
		doAddRole,
		doComplete,
		doReopen,
		doCancel,
		doRestore,
		openTemplateDialog,
		loadTemplatePreview,
		applyTemplate,
		onWodSaved,
		onMetaSaved,
	} = useMeetingLifecycle({
		meetingId: meeting.id,
		meetingClubId: meeting.clubId,
		clubKey: clubId,
		meetingKeyParam,
		urlKey,
		noticeRequested,
		cancelled,
		effectiveCanManage,
	});
	const {
		consoleSpeakers,
		voteConsoleBusy,
		digitalVotingBusy,
		handleAddTableTopicsSpeaker,
		handleRemoveTableTopicsSpeaker,
		handleMoveTableTopicsSpeaker,
		handleSetDigitalVotingDisabled,
		handleSetVoteWinner,
		handleClearVoteWinner,
	} = useMeetingVotes({
		meetingId: meeting.id,
		myId,
		isVoteCounter,
		effectiveCanManage,
		minutes,
	});
	// Derived here rather than carried as their own payload fields (#396 PR2
	// task 6): `effectivePlan` already carries every rung including `reached_out`
	// — the payload's gated `plan` for an officer, the separately-verified
	// `getTmodPanelData` rows for this meeting's Toastmaster, and `[]` for
	// everyone else, which is what keeps the recruit picker's "already asked"
	// marks off a plain member's screen.
	const contactedMemberIds = effectivePlan
		.filter((p) => p.status === "reached_out")
		.map((p) => p.memberId);

	// The agenda's internal claim/assign acts as this member: the session member
	// for a manager (null for an impersonator), the effective member otherwise.
	const agendaMemberId = effectiveCanManage ? managerActorId : myId;
	const publicCountsEl = (
		<p className="order-1 text-sm text-muted-foreground lg:order-2 lg:w-[340px] lg:shrink-0 xl:w-96">
			{publicCountsLine(comingCount, guestRsvpCount)}
		</p>
	);
	const containerClass = canManage
		? "max-w-workspace px-4 pt-5 pb-10 sm:px-7 sm:pt-7 space-y-5"
		: "mx-auto w-full max-w-reading p-4 pb-8 md:p-6 space-y-5";

	const coverChipUnderRow = (slot: { id: string }) => {
		const c = coverChipBySlotId.get(slot.id);
		return c ? (
			<CoverChip
				request={c.request}
				status={c.status}
				roleLabel={c.roleLabel}
				timeZone={timezone}
				meetingOver={coverOver}
			/>
		) : null;
	};

	return (
		<div className={containerClass}>
			{/* #947: one "What's new" line for a member who picked their name here
			    and has no account. Signed-in members get the header panel. */}
			<WhatsNewBanner
				clubId={clubUuid}
				show={source === "anon" && member !== null}
			/>
			{!online && shell ? (
				<div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm font-semibold text-warning-foreground">
					<WifiOff className="size-4 shrink-0" aria-hidden />
					You're offline — minutes edits are saved on this device and sync when
					you reconnect. Other changes (meeting details, roles) need a
					connection.
				</div>
			) : null}
			{cancelled ? (
				// FIRST in the chain (#1057): a cancelled meeting is never locked,
				// but a past one would otherwise show members "already taken place",
				// which is not what happened to it.
				<div
					data-testid="cancelled-banner"
					className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm font-semibold"
				>
					<span className="flex items-center gap-2">
						<CalendarX
							className="size-4 shrink-0 text-destructive"
							aria-hidden
						/>
						<span>
							<span className="font-semibold">{MEETING_CANCELLED_MESSAGE}</span>{" "}
							Everyone keeps their role.
						</span>
					</span>
					{/* Officers only: the notice to copy, and Restore while the date
					    has not passed. A past cancelled meeting shows the banner alone;
					    `applyRestoreMeeting` refuses it anyway. */}
					{effectiveCanManage ? (
						<span className="flex flex-wrap gap-2">
							<Button
								size="touch"
								variant="outline"
								onClick={() => setNoticeOpen(true)}
							>
								<ClipboardList className="size-4" aria-hidden />
								View notice
							</Button>
							{!datePassed ? (
								<Button
									size="touch"
									// The only filled action on a cancelled meeting (#1307).
									variant="default"
									onClick={doRestore}
									disabled={lifecycleBusy}
									aria-busy={lifecycleAction === "restore"}
								>
									{lifecycleAction === "restore" ? (
										<Loader2 className="size-4 animate-spin" />
									) : (
										<RotateCcw className="size-4" aria-hidden />
									)}
									Restore
								</Button>
							) : null}
						</span>
					) : null}
				</div>
			) : locked ? (
				<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-semibold text-muted-foreground">
					<Lock className="size-4" aria-hidden />
					{MEETING_LOCKED_MESSAGE}
				</div>
			) : datePassed && !effectiveCanManage ? (
				<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-semibold text-muted-foreground">
					<Lock className="size-4" aria-hidden />
					This meeting has already taken place.
				</div>
			) : null}
			<header className="space-y-2 pt-2">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					{heading.title}
				</h1>
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
					<span className="flex items-center gap-1.5">
						<CalendarDays className="size-4" aria-hidden />
						{heading.detailDate ? `${heading.detailDate} · ` : null}
						{formatMeetingTimeRange(
							meeting.scheduledAt,
							meeting.lengthMinutes,
							timezone,
						)}
					</span>
					{flex.status !== "exact" ? (
						<span
							className={
								flex.status === "over"
									? "flex items-center gap-1.5 font-semibold text-destructive"
									: "flex items-center gap-1.5 text-muted-foreground"
							}
						>
							<Clock className="size-4" aria-hidden />
							{flex.status === "over"
								? `Projected end ${formatMeetingTime(projectedEnd, timezone)} · runs ${flex.deltaMinutes} min long`
								: `Projected end ${formatMeetingTime(projectedEnd, timezone)} · ends ${-flex.deltaMinutes} min early`}
						</span>
					) : null}
					{meeting.location ? (
						<span className="flex items-center gap-1.5">
							<MapPin className="size-4" aria-hidden />
							{meeting.location}
						</span>
					) : null}
					{/* The video-call join link (#731). A SIBLING of the location
					    conditional above, never a child of it: an online-only club
					    leaves `location` blank, and that club is the entire audience
					    for this chip — nesting it would hide the link on exactly the
					    meetings that have one.

					    Re-normalized at render rather than trusted from the row. Every
					    write path already stores a clean http(s) URL, so this changes
					    nothing today; it means a value that reached the column some
					    other way (a hand-run SQL fix, a future importer) cannot put a
					    `javascript:` href on the page.

					    A bare `<a>`, sibling to the surrounding markup and never inside
					    a `<Link>` — a nested anchor is invalid HTML. `text-primary` is
					    all the colour it needs: the global `a` rule lives in
					    `@layer base`, so a component's own utility wins with no opt-out
					    (CODING_STANDARDS "the global text-link rule is LAYERED"). */}
					{joinUrl ? (
						<a
							href={joinUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-1.5 font-semibold text-primary underline-offset-4 hover:underline"
						>
							<Video className="size-4" aria-hidden />
							Join the video call
						</a>
					) : hasJoinLink && !cancelled && !over ? (
						/* #1444, D6. The link itself never reaches this viewer's payload
						   (`public-meeting-payload.ts`): the RSVP page hands it over once
						   they have said they are coming. */
						<Link
							to="/club/$clubId/meeting/$meetingId/rsvp"
							params={{ clubId, meetingId: urlKey }}
							className="flex min-h-11 items-center gap-1.5 font-semibold text-primary underline-offset-4 hover:underline sm:min-h-0"
						>
							<Video className="size-4" aria-hidden />
							RSVP to get the video link
						</Link>
					) : null}
				</div>
				<MeetingRoomStrip
					visible={inRoom}
					clubId={clubId}
					meetingKey={urlKey}
					dbMeetingId={meeting.id}
					member={member}
					holdsRole={holdsRole}
					wordOfTheDay={meeting.wordOfTheDay}
					feedbackOpen={feedbackOpen}
					promptIdentity={promptIdentity}
				/>
				<MeetingFeedbackLink
					open={feedbackOpen}
					inRoom={inRoom}
					clubId={clubId}
					meetingKey={urlKey}
				/>
				<MeetingNavStrip clubId={clubId} items={navItems} />
				{/* Same predicate the "Word poster" button below uses, so the chip
				    and the button agree about whether there is a word. Consistency,
				    not a fix: the write paths trim, so blank cannot be stored. */}
				{hasWordOfTheDay(meeting.wordOfTheDay) ? (
					<p className="flex items-center gap-1.5 text-sm">
						<Sparkles className="size-4 text-primary" aria-hidden />
						<span className="text-muted-foreground">Word of the day:</span>
						<span className="font-semibold">{meeting.wordOfTheDay}</span>
					</p>
				) : null}
				<MeetingPersonalStrip
					source={source}
					member={member}
					promptIdentity={promptIdentity}
					over={over}
					myStatus={myEffectiveStatus}
					// The RECORDED row, never the plan (#548). `undefined` for an
					// anonymous viewer: they cannot be told without shipping a public
					// array of everyone's attendance, which would widen "who was
					// absent" to any visitor (#574).
					myAttendance={
						isSignedIn && myId
							? (rollAttendance.find((a) => a.memberId === myId)?.status ??
								null)
							: undefined
					}
					availBusy={myStatusBusy}
					canToggleAvailability={viewer.canToggleAvailability}
					onSetStatus={setMyStatus}
					primary={stripPrimary}
				/>
				{/* #1376. Reads the page's resolved identity, never `?as=`. */}
				<MeetingYourJobs
					clubId={clubId}
					clubUuid={clubUuid}
					meetingKey={urlKey}
					memberId={myId}
					source={source}
				/>
				{/* The strip derives identity from `member !== null`; the TOOLBAR
				    still takes an explicit hasIdentity, because its gate is the
				    session-or-anon id the route resolved (#541 D2/D3). */}
				<MeetingToolbar
					phase={phase}
					clubSlug={clubId}
					meetingId={urlKey}
					dbMeetingId={meeting.id}
					sharePath={`/club/${clubId}/meeting/${urlKey}`}
					deck={deck}
					clubName={clubName}
					wordOfTheDay={meeting.wordOfTheDay}
					hasIdentity={!!myId}
					canManage={effectiveCanManage}
					locked={locked}
					canComplete={canComplete}
					hasAddableRoles={addableRoles.length > 0}
					lifecycleBusy={lifecycleBusy}
					busyAction={lifecycleAction}
					onAddRole={() => setAddRoleOpen(true)}
					onComplete={doComplete}
					onReopen={doReopen}
					cancelled={cancelled}
					canCancel={canCancel}
					onCancel={() => setCancelConfirmOpen(true)}
					canLineupBlast={canLineupBlast}
					onLineupBlast={() => setLineupOpen(true)}
					// Each gate is the `viewer` flag as is, not the toolbar's `canEdit`:
					// `viewer` is built from `effectiveCanManage` and `lockedViewer`
					// zeroes it on a completed or cancelled meeting, so these entries
					// vanish there exactly as the agenda's buttons did.
					canEditMeta={viewer.canEditMeetingMeta}
					onEditMeta={() => setMetaOpen(true)}
					canEditWod={viewer.canEditWod}
					onEditWod={() => setWodOpen(true)}
					canChangeType={viewer.canManage}
					onChangeType={openTemplateDialog}
					editAgendaParams={
						viewer.canManage && meeting.templateId
							? { clubId: meeting.clubId, meetingId: meeting.id }
							: null
					}
				/>
				{viewer.canEditWod ? (
					<MeetingWordOfTheDayDialog
						open={wodOpen}
						onOpenChange={setWodOpen}
						meeting={meeting}
						selfMemberId={agendaMemberId}
						onSaved={onWodSaved}
					/>
				) : null}
				{viewer.canManage ? (
					<MeetingTemplateDialog
						open={templateOpen}
						onOpenChange={setTemplateOpen}
						currentTemplateKey={templateKey}
						templates={templates}
						loadPreview={loadTemplatePreview}
						onApply={applyTemplate}
					/>
				) : null}
				{viewer.canEditMeetingMeta ? (
					<MeetingMetaDialog
						open={metaOpen}
						onOpenChange={setMetaOpen}
						meeting={meeting}
						hasJoinLink={hasJoinLink}
						timezone={timezone}
						selfMemberId={agendaMemberId}
						canReschedule={viewer.canManage}
						effectiveMeetingNumber={meetingNumber}
						onSaved={onMetaSaved}
					/>
				) : null}
				{/* Cancel confirm (#1057). It states the three things an officer
				    needs before saying yes: roles are kept, members stop seeing the
				    meeting, nothing is sent — and, truthfully, how long a restore
				    stays possible: `applyRestoreMeeting` refuses from the club-local
				    day after. The write is `doCancel`. Not dismissable while it
				    runs: closing it mid-write left the cancel landing anyway, with
				    the officer believing they had backed out. */}
				<Dialog
					open={cancelConfirmOpen}
					onOpenChange={(open) => {
						if (!lifecycleBusy) setCancelConfirmOpen(open);
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Cancel this meeting?</DialogTitle>
							<DialogDescription>
								Everyone keeps their role, and you can restore it exactly as it
								was until the end of the meeting's day. Members stop seeing it
								on the schedule and the sign-up sheet. Nothing is sent — you get
								a notice to copy and share.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<DialogClose asChild>
								<Button
									type="button"
									variant="outline"
									disabled={lifecycleBusy}
								>
									Keep meeting
								</Button>
							</DialogClose>
							<Button
								type="button"
								variant="destructive"
								onClick={doCancel}
								disabled={lifecycleBusy}
								aria-busy={lifecycleAction === "cancel"}
							>
								{lifecycleAction === "cancel" ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<CalendarX className="size-4" aria-hidden />
								)}
								Cancel meeting
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
				{/* The notice (#1057): officers, on a cancelled meeting. Mounted only
				    while open so the sheet reads the slot rows as they are after the
				    loader re-ran, not as they were when the confirm was clicked. */}
				{effectiveCanManage && cancelled && noticeOpen ? (
					<MeetingCancellationSheet
						open={noticeOpen}
						onOpenChange={setNoticeOpen}
						clubName={clubName}
						scheduledAt={meeting.scheduledAt}
						timezone={timezone}
						holders={cancellationHolders}
					/>
				) : null}
				{canLineupBlast && lineupOpen ? (
					<LineupBlastSheet
						open={lineupOpen}
						onOpenChange={setLineupOpen}
						meetingId={meeting.id}
						selfMemberId={myId}
					/>
				) : null}
			</header>

			<MeetingAnnouncements text={meeting.reminders} />

			{/* Spec D4: the banner/header/toolbar/announcements block above runs FULL
			    WIDTH above the two-column row on every viewport — it is a SIBLING of
			    this row, not nested inside the agenda column, so it can never be
			    pushed below the panel on desktop. Below `lg` the panel (order-1)
			    renders directly beneath the toolbar and ABOVE the agenda/roles list
			    (order-2); at `lg` and up the agenda takes the left column
			    (order-1) and the panel becomes a sticky right rail (order-2). Whole-
			    branch review I5: the panel used to be a sibling AFTER the whole left
			    column, so on mobile it landed below the agenda, action items,
			    Minutes and the ballot console instead of directly under the toolbar. */}
			<div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-6">
				<div className="order-2 min-w-0 flex-1 space-y-5 lg:order-1">
					{coverView.landing ? (
						<CoverLandingCard
							landing={coverView.landing}
							roleLabel={coverView.roleLabel}
							whenLine={coverView.whenLine}
							description={coverView.description}
							busy={coverTakeBusy}
							onTake={takeCoveredRole}
							onDecline={dismissCoverCard}
						/>
					) : null}

					{effectiveCanManage ? null : <GuestResources clubId={clubId} />}

					{readiness ? (
						<MeetingReadinessPanel
							readiness={readiness}
							clubId={clubId}
							meetingId={urlKey}
							timezone={timezone}
						/>
					) : null}

					{/* Keeps a shared `#agenda` link working on any day (the strip now
					    links to the digital agenda route). Always rendered. */}
					<section id={MEETING_AGENDA_ANCHOR_ID} className="scroll-mt-28">
						<MeetingAgenda
							slotExtra={coverChipUnderRow}
							slots={slots}
							viewer={viewer}
							actions={actions}
							roster={roster}
							roleRecency={roleRecency}
							roleByMemberId={roleByMemberId}
							unavailableMemberIds={unavailableMemberIds}
							markedAbsentMemberIds={markedAbsentMemberIds(
								unavailableMemberIds,
								answeredRungs,
							)}
							pairedRoleIds={effectiveCanManage ? pairedIds : undefined}
							clubGuests={effectiveCanManage ? clubGuests : undefined}
							shareUrl={effectiveCanManage ? nudgeShareUrl : ""}
							meetingDate={effectiveCanManage ? nudgeDate : ""}
							// Gated like `shareUrl` beside it: <MeetingAgenda> renders for
							// plain members too, and the draft affordances this feeds are
							// manager-only.
							personalNudgeBase={effectiveCanManage ? nudgePersonalBase : null}
							meeting={meeting}
							meetingUrlKey={urlKey}
							clubSlug={clubSlug}
							onOwnLateRelease={onOwnLateRelease}
							meetingOver={over}
							requireIdentity={requireIdentity}
							contactedMemberIds={contactedMemberIds}
							onContacted={onContacted}
							onUncontacted={onUncontacted}
						/>
					</section>

					<OpenActionItems
						items={openActionItems.items}
						total={openActionItems.total}
					/>

					{minutes.visible && minutes.data ? (
						// Anchor target for the toolbar's completed-phase primary (#541 D2).
						// The wrapper exists because <MeetingMinutes> renders a <Card> and
						// takes no id/className. `scroll-mt-28` (112px) clears the sticky header
						// at its TALLEST: 69px normally, but 105px while impersonating, because
						// `app-shell` stacks the 36px banner (h-9) above it and moves the header
						// to `top-9`. Measured in a browser, not derived — `scroll-mt-24` (96px)
						// was 9px short and tucked the card's top edge under the header.
						// NOT co-gated with the primary: the toolbar's CTA is gated on
						// `showsMinutesPrimary`, but the loader degrades ANY getMinutes
						// failure to EMPTY_MINUTES (visible=false) regardless of canManage —
						// so this branch alone left a completed-phase admin with a Minutes
						// primary and no `id` to scroll to on a transient load failure. The
						// degrade branch below keeps the anchor real in that case.
						<section id={MINUTES_ANCHOR_ID} className="scroll-mt-28">
							<MeetingMinutes
								meetingId={meeting.id}
								minutes={minutes.data}
								program={minutes.program}
								meetingPast={over}
								// Same fact as `canComplete`, deliberately the one computation:
								// recording the record and closing it sit on the same club-local
								// day axis, so "you can take roll" and "you can complete this"
								// turn on together. Passing `over` here would hide the recorder
								// for the whole of meeting day, which is when roll is taken.
								meetingDayReached={canComplete}
								// Read-only on a cancelled meeting (#1057): there are no
								// minutes for a meeting that did not happen, and a stray
								// edit would land in the record of one.
								canEdit={effectiveCanManage && minutes.canEdit && !cancelled}
								clubGuests={clubGuests}
								unavailableMemberIds={unavailableMemberIds}
								offline={offlineMinutes}
								email={
									minutesEmail
										? {
												clubId: meeting.clubId,
												clubName,
												meetingDate: meeting.scheduledAt,
												timezone,
												recipients: minutesEmail.recipients,
												skipped: minutesEmail.skipped,
											}
										: null
								}
							/>
						</section>
					) : effectiveCanManage ? (
						/* getMinutes degraded (loader `.catch(() => EMPTY_MINUTES)`) — say so
				   instead of silently deleting the card, and keep the toolbar's Minutes
				   primary pointing at something real (spec review of aa106b3).

				   Gated on `effectiveCanManage`, NOT on `showsMinutesPrimary`. Those
				   differ everywhere except the completed phase, and the difference is
				   the case that matters most: `getMinutes` returns `visible: true` for
				   an admin on ANY status (`canEdit || status === "completed"`), so an
				   officer on MEETING NIGHT normally has the full card — attendance,
				   awards, Table Topics capture. Keyed on showsMinutesPrimary, a
				   transient throw made all of that vanish with no message at the single
				   highest-stakes moment for it, and the page still looked intact because
				   the Ballot Counter console is gated separately (red-team review).

				   `effectiveCanManage` is a strict SUPERSET of the CTA's gate, so the
				   primary can never point at a section that is not here — and it is the
				   preview-aware flag, so the two still flip together in preview mode. */
						<section id={MINUTES_ANCHOR_ID} className="scroll-mt-28">
							<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-semibold text-muted-foreground">
								<ClipboardList className="size-4 shrink-0" aria-hidden />
								Minutes couldn't load — refresh to try again.
							</div>
						</section>
					) : null}

					{/* Never on a cancelled meeting (#1057): `castVote` refuses every
					    ballot on it, and a console for a vote nobody can cast invites
					    the Vote Counter to open one. */}
					{(isVoteCounter || effectiveCanManage) && !cancelled ? (
						<section className="space-y-4 rounded-xl border border-border bg-card p-4">
							<div>
								<h2 className="font-display font-semibold text-lg">
									Ballot Counter console
								</h2>
								<p className="text-muted-foreground text-sm">
									{digitalVoting
										? "Only visible to you. Add Table Topics speakers so they're eligible for Best Table Topics, then open a category, watch the count, and confirm the winner once it closes."
										: "Only visible to you. Add Table Topics speakers so they're recorded in the minutes."}
								</p>
							</div>
							{/* #770 — signed-in club admins only, matching the server fn.
							    `canManage`, not `effectiveCanManage`: the server keys off the
							    SESSION, so an admin previewing as a member still has it. */}
							{canManage ? (
								<DigitalVotingSwitch
									digitalVoting={digitalVoting}
									clubDigitalVotingEnabled={clubDigitalVotingEnabled}
									busy={digitalVotingBusy}
									onSetDisabled={handleSetDigitalVotingDisabled}
								/>
							) : null}
							<TableTopicsCapture
								speakers={consoleSpeakers}
								canEdit={true}
								busy={voteConsoleBusy}
								roster={voteCounterRoster}
								unavailableMemberIds={unavailableMemberIds}
								clubGuests={clubGuests}
								onAdd={handleAddTableTopicsSpeaker}
								onRemove={handleRemoveTableTopicsSpeaker}
								onMove={handleMoveTableTopicsSpeaker}
							/>
							{/* #770. Table Topics capture above stays either way — the
							    minutes and the guest pipeline read those speakers, and a
							    paper-ballot club still needs them. Only the digital vote
							    panel goes. */}
							{digitalVoting ? (
								<VoteCounterPanel
									meetingId={meeting.id}
									selfMemberId={myId}
									// #752. NOT `myId`, which is the localStorage name-pick and
									// is non-null for exactly the anonymous caller the ruling
									// gate refuses. `managerActorId` is `session?.id ?? null` —
									// the session's own membership id in this club — which is
									// the value the server-side seam resolves, so the console's
									// prediction and the gate's answer agree by construction.
									sessionMemberId={managerActorId}
									// The admin arm, predicted on its own. `canManage`, not
									// `effectiveCanManage` (the server keys off the SESSION, and
									// a previewing admin still carries one), and NOT folded into
									// the line above: an impersonating superadmin has full admin
									// parity server-side and no `effectiveMemberId`, so gating
									// on `managerActorId` alone would hide the ruling controls
									// from the one principal the gate allows outright — see
									// `declineFreesRoles` for the same bug caught once already.
									canManageClub={canManage}
									onSetWinner={handleSetVoteWinner}
									onClearWinner={handleClearVoteWinner}
								/>
							) : null}
						</section>
					) : null}

					<Dialog open={addRoleOpen} onOpenChange={setAddRoleOpen}>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Add a role</DialogTitle>
							</DialogHeader>
							<form
								onSubmit={(e) => {
									e.preventDefault();
									const roleId = String(
										new FormData(e.currentTarget).get("roleDefinitionId") ?? "",
									);
									if (roleId) void doAddRole(roleId);
								}}
								className="space-y-4"
							>
								<div className="space-y-2">
									<Label htmlFor="roleDefinitionId">Role</Label>
									<select
										id="roleDefinitionId"
										name="roleDefinitionId"
										required
										className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									>
										{addableRoles.map((r) => (
											<option key={r.id} value={r.id}>
												{r.name}
											</option>
										))}
									</select>
									<p className="text-xs text-muted-foreground">
										Picking a role already on this meeting adds another instance
										(e.g. “Timer 2”).
									</p>
								</div>
								<DialogFooter>
									<DialogClose asChild>
										<Button type="button" variant="outline">
											Cancel
										</Button>
									</DialogClose>
									<Button type="submit" disabled={addRoleBusy}>
										{addRoleBusy ? (
											<Loader2 className="size-4 animate-spin" />
										) : (
											"Add role"
										)}
									</Button>
								</DialogFooter>
							</form>
						</DialogContent>
					</Dialog>
				</div>
				{/* #1442: everyone who is not running the meeting sees the count and
				    nothing behind it. It is computed from `answeredRungs` and the
				    slots, both public, and names nobody. #1444 adds the guest count
				    and the guests-only case, in the one line. */}
				{!showPanel &&
				phase === "upcoming" &&
				!cancelled &&
				(comingCount > 0 || guestRsvpCount > 0)
					? publicCountsEl
					: null}
				{showPanel && !tmodPanelUnavailable ? (
					<aside
						// `sticky` pins this column, so its own height stops being the
						// page's problem and starts being a wall: rows are ~81px each
						// (they nearly doubled in this diff), so a 40-member club is a
						// ~3,240px rail. Pinned at `top-24` with no cap, only the first
						// ~10 rows are ever in view on a ~950px viewport and the rest are
						// unreachable — the page scrolls, the pinned rail does not —
						// unless the agenda column happens to be taller. Capping the
						// height and giving the rail its OWN scroller is what makes the
						// bottom rows reachable. The cap is the viewport less the pin
						// offset and 1rem of breathing room at the bottom edge.
						//
						// Both read `--shell-pinned-top`, which the app shell sets
						// (`shell-sticky-offset.ts`): 6rem under the header, plus the 2.25rem
						// impersonation banner when one is showing. A fixed `top-24` pinned
						// the rail under the header alone, so while impersonating the
						// header covered its top ~9px. The 6rem fallback is that old value,
						// for any host that sets nothing.
						//
						// The cap lives here and the SCROLLER does not. This `<aside>` is
						// the positioner — sticky, width, order, and the height ceiling
						// that the pinning makes necessary — and it is a flex column so
						// the panel's card can fill it. The card then puts the scroller on
						// its own body, which is what keeps the title, the counts line and
						// the sync status visible while the rows move; the scroller used to
						// be this element, and a reader 25 rows into a 40-member roster had
						// lost the summary they were reading the rail for.
						//
						// Both halves or neither: `lg:max-h-…` with nothing scrolling
						// inside it CLIPS the bottom rows outright, which is strictly worse
						// than the unreachable-but-present rail this replaced.
						//
						// And note the axis the scroller costs, wherever it sits:
						// `overflow-y: auto` with an `overflow-x` of `visible` computes
						// that `visible` to `auto` (CSS Overflow 3 §3), so the scrolling
						// element clips on BOTH axes. Nothing in the rail overhangs today —
						// the row wraps (`break-words`, `line-clamp-2`), the widest control
						// is the measured `w-36` track, and the row menu is a portalled
						// `DropdownMenuContent` — but a future popover that renders INLINE
						// would be cut off. Moving the scroller inward tightened that box
						// from the column to the card's body, so it is a smaller trap than
						// it was, not a new one.
						className="order-1 lg:order-2 lg:sticky lg:top-[var(--shell-pinned-top,6rem)] lg:flex lg:max-h-[calc(100vh_-_var(--shell-pinned-top,6rem)_-_1rem)] lg:w-[340px] lg:shrink-0 lg:flex-col xl:w-96"
					>
						<MeetingAttendancePanel
							// `upcoming` → the outreach ladder; meeting day and after → the
							// record of who turned up. One derivation, off the route's frozen
							// clock, so this cannot disagree with the agenda beside it.
							mode={panelMode}
							// #727. `effectiveCanManage`, never bare `canManage`: #320's
							// preview-as-member drops management everywhere it gates admin
							// UI, and a link to `/members/$id` is admin UI — it is the
							// affordance an officer previewing the member view is checking
							// the absence of. The target route is `_authed` and enforces its
							// own access either way; what this decides is whether a viewer
							// who cannot follow the link is shown one.
							//
							// KNOWN GAP, deliberately out of scope for #727: a superadmin
							// on a `read_write` impersonation session satisfies
							// `canManageClub` with no membership, but `publicShellDecision`
							// sets `activeClubId` only for `memberOfViewed` — and
							// `/members/$id` resolves the member out of
							// `context.activeClubId`. So for that one viewer the links
							// render and land on the empty shape. Not a leak (the profile
							// read is club-scoped, so the wrong club returns nothing), and
							// not this issue's to fix: the cause is how `activeClubId` is
							// resolved for impersonation, which the issue's Out of Scope
							// list rules out ("Changing how canManage … is resolved").
							// Recorded here rather than left silent.
							canViewMemberDetail={effectiveCanManage}
							// #762 / ADR-0026. "No answer" is the rung menu's only DELETE
							// (`clearPlannedAttendance`), and destroying an answer needs a
							// session this club's roster admits. `canManage` covers the
							// officer and the `read_write` impersonation that
							// `requireSessionActor` also admits; `isSignedIn` covers the
							// plain member and the signed-in Toastmaster. What it
							// deliberately excludes is the SELF-ASSERTED Toastmaster, who
							// reaches this rail through `needsTmodPlan` on an honour-system
							// claim (#576, retired by #747) and for whom every tap on that
							// item came back "you need to be signed in".
							//
							// `canManage`, not `effectiveCanManage`: this predicts the
							// SERVER, and an admin previewing as a member still carries the
							// session the server reads — the same distinction
							// `declineFreesRoles` makes two hundred lines up.
							canClearRung={canManage || isSignedIn}
							// Roll mode's guest edit (#727). `undefined` for everyone else,
							// so their guest names stay plain text with no disabled control
							// hinting at what they cannot do. Carries the stored fields with
							// the permission — see the derivation above for why the two
							// travel together and why this gate is `canManage`.
							guestEdit={guestEdit}
							// TWO sources, one name. An officer gets `loaderRoster` (the
							// payload's contact-bearing roster, populated only when the
							// server itself resolved `canManage`). This meeting's
							// Toastmaster gets the separately-verified roster from
							// `getTmodPanelData`, which returns it ONLY to a real session
							// that is the Toastmaster — an anonymous claim gets the rungs
							// and no contact, so their rows render "No contact on file"
							// rather than leaking PII behind an honour-system gate (#576
							// review). Never the route's `roster` local, which falls back
							// to the PUBLIC roster with no contact fields at all. Roll mode
							// widens that to the UNION with anyone holding a recorded row
							// (see `panelRosterForMode`); plan mode passes it through.
							roster={panelRosterForMode}
							plan={effectivePlan}
							// Roll mode only, and every one of these props is OPTIONAL on the
							// panel (a caller that has not wired guests renders nothing rather
							// than an empty group) — so dropping one is silent: it neither
							// type-errors nor fails a component test. `attendance-panel-wiring
							// .guard.test.ts` is what watches them.
							attendance={rollAttendance}
							guests={rollGuests}
							clubGuests={clubGuests}
							// RSVP'd guests (#1444): the officer's payload only. Here is the
							// roll's own guest add, so the offline queue and the once-per-guest
							// write are the ones `addRollGuest` already has.
							expectedGuests={guestRsvps}
							onGuestHere={(guestId) => addRollGuest({ guestId })}
							// Once the meeting is a historical record nobody is being chased
							// over it, so the rows drop their contact drafts.
							phaseCompleted={phase === "completed"}
							// The queue's refusal condition, verbatim: `mutate()` returns
							// immediately (no toast, no throw) while `busy || draining`, so
							// every control the panel offers has to be disabled for exactly
							// that window. The panel's own per-row `pending` covers one row;
							// this is the global half, and without it a tap on any OTHER row
							// during a write — the normal cadence of a roll call on club wifi
							// — was silently discarded.
							busy={offlineMinutes.busy || offlineMinutes.draining}
							rungOverride={rungOverride}
							roleByMemberId={panelRoleByMemberId}
							meetingDate={nudgeDate}
							shareUrl={nudgeShareUrl}
							// The BARE names, like the two above: the panel only ever mounts
							// for someone who runs the meeting, so the agenda's guarded form
							// would strip the duty clause and the personal link out of every
							// draft the rail sends.
							dutiesByMemberId={nudgeDutiesByMemberId}
							evaluatingByMemberId={nudgeEvaluatingByMemberId}
							personalNudgeBase={nudgePersonalBase}
							rsvpUrl={nudgeRsvpUrl}
							rsvpWeekday={nudgeWeekday}
							clubName={clubName}
							locked={locked}
							onWriteRung={writeRung}
							onContacted={markAsked}
							onSetAttendance={writeAttendance}
							onSetMode={writeAttendanceMode}
							onAddGuest={addRollGuest}
							onRemoveGuest={removeRollGuest}
							onSetGuestMode={setRollGuestMode}
							// The SAME hook instance the writes go through, never a second
							// one (`use-offline-minutes-instance.guard.test.ts`). Roll mode
							// is now the only surface that records attendance, so without
							// this the queue's only status display sat in the Minutes card
							// — read-only for attendance since PR 3, and at the other end
							// of the page on a phone. An officer took roll offline, watched
							// every chip move, closed the tab, and the drain only ever ran
							// if someone reopened THAT meeting in THAT browser: the PDF and
							// the emailed minutes went out with the roll missing, with
							// nothing they looked at saying so. The Minutes card KEEPS its
							// own indicator — it still queues its own non-attendance edits.
							sync={{
								online,
								queueCount: offlineMinutes.queue.length,
								draining: offlineMinutes.draining,
								syncError: offlineMinutes.syncError,
								justSynced: offlineMinutes.justSynced,
								onRetry: () => {
									void offlineMinutes.retryDrain();
								},
							}}
						/>
					</aside>
				) : null}
			</div>
			{/* #663. Outside the two columns because it is portalled anyway, and
			    because it serves BOTH of them — the rail's chips and the personal
			    strip both reach it through `writeRung`. Confirming calls
			    `commitRung`, the same write every other rung takes, so the
			    optimistic override, the rollback and the invalidate are unchanged. */}
			{/* #1256. Roll mode's Absent on a role-holder. Release roles frees them in
			    the same write; Keep roles records Absent alone; Cancel writes nothing. */}
			<CoverSheet
				slots={coverSlots}
				onClose={closeCoverSheet}
				onChanged={onCoverChanged}
			/>
			<AbsentReleaseDialog
				pending={pendingAbsent}
				offline={!online}
				busy={absentBusy || offlineMinutes.busy || offlineMinutes.draining}
				onCancel={cancelAbsent}
				onRelease={(p) => void confirmAbsent(p, true)}
				onKeep={(p) => void confirmAbsent(p, false)}
			/>
			<DeclineReleaseDialog
				pending={pendingDecline}
				busy={declineBusy}
				onCancel={cancelDecline}
				onConfirm={confirmDecline}
			/>
		</div>
	);
}
