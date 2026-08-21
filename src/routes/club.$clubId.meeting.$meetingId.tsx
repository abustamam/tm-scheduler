import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import {
	CalendarDays,
	ClipboardList,
	Clock,
	Eye,
	Loader2,
	Lock,
	MapPin,
	Sparkles,
	WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	MeetingAgenda,
	type MeetingAgendaActions,
} from "#/components/agenda/meeting-agenda";
import { MeetingAnnouncements } from "#/components/agenda/meeting-announcements";
import { GuestResources } from "#/components/club/guest-resources";
import { useRequireIdentity } from "#/components/club/identity-gate";
import { MeetingAttendancePanel } from "#/components/club/meeting-attendance-panel";
import { MeetingMinutes } from "#/components/club/meeting-minutes";
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
import { MeetingPersonalStrip } from "#/components/club/meeting-personal-strip";
import { MeetingToolbar } from "#/components/club/meeting-toolbar";
import { OpenActionItems } from "#/components/club/open-action-items";
import { TableTopicsCapture } from "#/components/club/table-topics-capture";
import { VoteCounterPanel } from "#/components/club/vote-counter-panel";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Label } from "#/components/ui/label";
import { useOfflineMinutes } from "#/hooks/use-offline-minutes";
import { useOnlineStatus } from "#/hooks/use-online-status";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import { applyFlex, resolveAgendaRows } from "#/lib/agenda-runsheet";
import { buildSlideDeck } from "#/lib/agenda-slides";
import { buildTemplateSlideDeck } from "#/lib/agenda-template-slides";
import { buildPanelRoleMap, type PlanStatus } from "#/lib/attendance-panel";
import { clubLogoUrl } from "#/lib/club-logo-url";
import {
	formatMeetingDate,
	formatMeetingTime,
	formatMeetingTimeRange,
} from "#/lib/format";
import { MINUTES_ANCHOR_ID } from "#/lib/meeting-anchors";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import {
	isMeetingLocked,
	isMeetingOver,
	MEETING_LOCKED_MESSAGE,
	meetingDatePassed,
	meetingDateReached,
	meetingPhase,
	resolveMeetingViewer,
} from "#/lib/meeting-lifecycle";
import { deriveMeetingNavItems } from "#/lib/meeting-nav";
import { deriveMeetingRoleFlags, pairedRoleIds } from "#/lib/meeting-roles";
import { useEffectiveMember } from "#/lib/member-identity";
import {
	deriveRollAttendance,
	deriveRollGuests,
	deriveRollRoster,
} from "#/lib/roll-attendance";
import { footerDate } from "#/lib/slide-layout";
import { hasWordOfTheDay } from "#/lib/word-poster";
import { getOpenActionItems } from "#/server/action-items";
import {
	clearPlannedAttendance,
	setPlannedAttendance,
} from "#/server/attendance-plan";
import { getClubLogoMeta } from "#/server/club-logo";
import {
	completeMeeting,
	getMeetingByKey,
	getPublicMeetingByKey,
	getTmodPanelData,
	listPastMeetings,
	listUpcomingMeetings,
	reopenMeeting,
} from "#/server/meetings";
import { listMembers } from "#/server/members";
import {
	addMinutesGuest,
	addTableTopics,
	clearMinutesAward,
	getMinutes,
	moveTableTopics,
	removeMinutesGuest,
	removeTableTopics,
	setAttendance,
	setMinutesAward,
} from "#/server/minutes";
import { getMinutesRecipients } from "#/server/minutes-email";
import type { AttendanceStatus, AwardCategory } from "#/server/minutes-logic";
import { clearContacted, setContacted } from "#/server/outreach";
import {
	addRoleSlot,
	addSpeakerSlot,
	claimSlot,
	confirmSlot,
	moveSpeakerSlot,
	reassignSlot,
	releaseSlot,
	removeRoleSlot,
	removeSpeakerSlot,
	unconfirmSlot,
} from "#/server/slots";
import { getVoteTally } from "#/server/voting";

// Anonymous (non-shell) visitors never load minutes — this hidden default keeps
// the loader's return shape uniform without a server call or any PII fetch.
const EMPTY_MINUTES = {
	visible: false,
	canEdit: false,
	data: null,
	program: [],
} as Awaited<ReturnType<typeof getMinutes>>;

export const Route = createFileRoute("/club/$clubId/meeting/$meetingId")({
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

		const data = await meetingPromise;
		// Guard against a meetingId that belongs to a different club than the URL.
		if (data.meeting.clubId !== context.clubUuid) throw notFound();

		// Nav strip backward paging (#375): the window of meetings immediately
		// BEFORE the one being viewed — anchored to THIS meeting rather than to
		// today, so paging back from a three-month-old meeting keeps going back
		// instead of jumping to last week. Public like `listUpcomingMeetings`, so
		// the anonymous visitor gets it too. Non-fatal: degrade to forward-only.
		const past = await listPastMeetings({
			data: {
				clubId: context.clubUuid,
				before: new Date(data.meeting.scheduledAt).toISOString(),
				limit: 3,
			},
		}).catch(() => null);

		const upcoming = await upcomingPromise;
		const navItems = deriveMeetingNavItems(
			data.meeting,
			data.slots,
			upcoming,
			data.timezone,
			past?.meetings ?? [],
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
		};
	},
	component: MeetingView,
	notFoundComponent: MeetingNotFound,
});

function MeetingNotFound() {
	const { clubId } = Route.useParams();
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
			<p className="font-semibold text-lg">Meeting not found</p>
			<p className="text-muted-foreground text-sm">
				This meeting doesn't exist for this club, or the link is out of date.
			</p>
			<Button asChild variant="outline">
				<Link
					to="/club/$clubId"
					params={{ clubId }}
					search={{ view: "roles", count: 8 }}
				>
					Back to meetings
				</Link>
			</Button>
		</div>
	);
}

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

function MeetingView() {
	const { clubId } = Route.useParams();
	const { clubUuid, effectiveMemberId, authCtx, shell } =
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
		clubRoles,
		clubGuests,
		roster: loaderRoster,
		plan,
		answeredRungs,
		minutes,
		openActionItems,
		minutesEmail,
		meetingNumber,
		nextMeetingAt,
		urlKey,
		geIntroducesFunctionaries,
		template,
		logoUrl,
	} = Route.useLoaderData();
	const router = useRouter();
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

	const [addRoleOpen, setAddRoleOpen] = useState(false);
	const [addRoleBusy, setAddRoleBusy] = useState(false);
	const [lifecycleBusy, setLifecycleBusy] = useState(false);
	// #320: an admin can preview the page as a non-admin member sees it.
	const [previewAsMember, setPreviewAsMember] = useState(false);
	// Ballot Counter console (#510 Task 10) — its own Table Topics edits, kept
	// separate from `MeetingMinutes`'s offline queue: the console is reachable
	// even when `minutes.visible` is false (a non-admin Vote Counter on a
	// not-yet-completed meeting), so it cannot ride that component's queue.
	const [voteConsoleBusy, setVoteConsoleBusy] = useState(false);
	// Optimistic rung overrides, keyed by member. `undefined` = no override, so
	// a member can be optimistically cleared to `null` and still be
	// distinguishable from "not touched" — which `??` alone cannot express.
	const [rungOverride, setRungOverride] = useState<
		Record<string, PlanStatus | null>
	>({});
	// Members with a plan write currently in flight — a ref, not state, since
	// only `writeRung` and the reconciling effect below touch it and neither
	// should re-render on it. The effect drops any override for a member NOT in
	// this map the moment `plan` changes, so a write that is still pending
	// cannot be evicted by a payload that hasn't caught up to it yet (whole-branch
	// review I2).
	//
	// REFCOUNTED, not a `Set`: two writes can be outstanding for the SAME member
	// at once, because an officer's own row carries two independent controls with
	// two independent busy flags that cannot see each other — the panel's chip
	// (`pendingId`) and the personal strip's ("I'll be there"/`myStatusBusy`).
	// With a `Set` the second `add` is a no-op and the FIRST write's release
	// clears the entry while the second is still outstanding, which hands the
	// effect an override it is free to evict before its write has landed.
	const pendingWritesRef = useRef<Map<string, number>>(new Map());
	function retainPending(memberId: string) {
		const m = pendingWritesRef.current;
		m.set(memberId, (m.get(memberId) ?? 0) + 1);
	}
	function releasePending(memberId: string) {
		const m = pendingWritesRef.current;
		const left = (m.get(memberId) ?? 1) - 1;
		if (left > 0) m.set(memberId, left);
		else m.delete(memberId);
	}
	// Busy guard against a rapid double-tap on the strip's OWN write — the same
	// class of race the panel's per-row `pendingId` already guards
	// (meeting-attendance-panel.tsx:136, 174-181). Without this, tapping "I'll
	// be there" then "undo" before the first request resolves fires
	// `setPlannedAttendance` and `clearPlannedAttendance` concurrently with no
	// ordering guarantee, and an out-of-order resolution leaves the persisted
	// rung disagreeing with the member's last tap.
	const [myStatusBusy, setMyStatusBusy] = useState(false);

	// One club config drives both renderings of this meeting (#367).
	const flex = applyFlex(
		resolveAgendaRows({ geIntroducesFunctionaries, template, slots }),
		meeting.lengthMinutes,
	);
	const projectedEnd = new Date(
		new Date(meeting.scheduledAt).getTime() + flex.projectedMinutes * 60_000,
	);
	// Absolute so a QR built from it resolves without the app's own origin
	// (#510) — same relative-during-SSR/absolute-after-hydrate split as
	// `nudgeShareUrl` below, computed here because `buildSlideDeck` (unlike
	// that share link) needs it up front to stamp onto every vote slide.
	const ballotUrl =
		typeof window === "undefined"
			? `/club/${clubId}/meeting/${urlKey}/vote`
			: `${window.location.origin}/club/${clubId}/meeting/${urlKey}/vote`;
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
	// Its own fact, not a step toward `over`: it drives the "already taken place"
	// notice, which a manager (still editing) must not see.
	const datePassed = meetingDatePassed(meeting.scheduledAt, timezone, now);
	// The one "is it over?" rule (#393) — shared with `resolveMeetingViewer` and
	// handed to <MeetingAgenda> rather than recomputed there.
	const over = isMeetingOver({
		status: meeting.status,
		scheduledAt: meeting.scheduledAt,
		timezone,
		now,
	});
	// #320: previewing-as-member drops management everywhere it gates admin UI.
	const effectiveCanManage = canManage && !previewAsMember;
	const canComplete = meetingDateReached(meeting.scheduledAt, timezone, now);
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
	const runsThisMeeting = effectiveCanManage || (isTmod && !previewAsMember);
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
	const showPanel = panelMode === "plan" ? showPlanPanel : showRollPanel;
	// Recorded rows ONLY, projected through the SAME offline queue the writes go
	// into (#176). Online this is just the loader's rows — the server stays the
	// source of truth and the chip moves on the refetch `offlineMinutes.mutate`
	// triggers. Offline no refetch will ever land, so without replaying the queue
	// an officer on dead club wifi taps "Present", nothing moves, and they tap
	// again — on the one surface #176's queue exists for. `deriveRollAttendance`
	// is the seam (`#/lib/roll-attendance`) because this route cannot mount in
	// jsdom, so an inline expression here would be testable by nothing but a
	// source grep; it also owns dropping `status: null`, which `buildRollPanel`
	// needs absent so it can render the plan's answer as a dashed suggestion.
	// `useMemo` for the same reason `meeting-minutes.tsx` uses one: `deriveMinutes`
	// structuredClones the whole snapshot.
	const rollAttendance = useMemo(
		() =>
			deriveRollAttendance({
				online,
				minutes: minutes.data,
				snapshot: offlineMinutes.snapshot,
				queue: offlineMinutes.queue,
			}),
		[online, minutes.data, offlineMinutes.snapshot, offlineMinutes.queue],
	);
	// The guests go through the SAME projection, for the same reason and one
	// control to the right (fix round 2). Raw loader rows left an offline
	// "+ Add guest" invisible AND kept the guest in the picker, since
	// `AttendanceGuestsGroup` builds its already-present filter from this very
	// list and holds no optimism of its own. Stays possibly-`undefined` — the prop
	// is optional precisely so a caller with no guests wired renders nothing
	// instead of an empty group.
	const rollGuests = useMemo(
		() =>
			deriveRollGuests({
				online,
				minutes: minutes.data,
				snapshot: offlineMinutes.snapshot,
				queue: offlineMinutes.queue,
			}),
		[online, minutes.data, offlineMinutes.snapshot, offlineMinutes.queue],
	);

	// One viewer for all audiences: an admin keeps editing a past-but-open meeting
	// until Complete; a member/anon agenda freezes once the date passes; a locked
	// meeting is read-only for everyone. (Pure — unit-tested in Task 1.)
	const viewer = resolveMeetingViewer({
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

	// The non-officer TMOD's ladder (#576). Mirrors `fetchedRoster` directly
	// above: an officer gets it on the payload, everyone else who needs it
	// fetches it behind a server-side check. `getTmodPanelData` verifies the claim
	// against the slot and returns [] otherwise, so a stale `enabled` here can
	// only under-fetch — it can never hand the confidential rung to a non-TMOD.
	const queryClient = useQueryClient();
	const tmodPlanKey = ["tmod-plan", meeting.id, myId] as const;
	const {
		data: tmodPanelData,
		isPending: tmodPanelPending,
		isError: tmodPanelFailed,
	} = useQuery({
		queryKey: tmodPlanKey,
		queryFn: () =>
			getTmodPanelData({
				data: { meetingId: meeting.id, memberId: myId as string },
			}),
		enabled: needsTmodPlan,
	});
	// Evict the contact roster when the viewer changes. Keying on `myId` makes a
	// switch READ a different key; it does not remove the old one, and the default
	// gcTime keeps it in memory for five minutes. That matters on the shared club
	// laptop that gets passed around at a meeting: "not you? re-pick" would
	// otherwise leave the previous Toastmaster's copy of every member's phone and
	// email sitting in the cache (#576 review).
	// biome-ignore lint/correctness/useExhaustiveDependencies: myId is the TRIGGER, not a value the body reads — a change of viewer is exactly when the previous viewer's cached contact roster must be dropped
	useEffect(() => {
		return () => {
			queryClient.removeQueries({ queryKey: ["tmod-plan", meeting.id] });
		};
	}, [queryClient, meeting.id, myId]);
	const fetchedPlan = tmodPanelData?.plan ?? [];
	// The panel needs the CONTACT-bearing roster (`loaderRoster`), not the public
	// one the assign picker falls back to — without phone and email every row
	// renders "No contact on file" and the drafts the panel exists for are gone.
	// `loaderRoster` is `[]` for a non-officer, which is why a TMOD's copy comes
	// from the same verified call as their ladder.
	const panelRoster = effectiveCanManage
		? loaderRoster
		: (tmodPanelData?.roster ?? []);
	// ROLL mode's roster is the UNION of the active roster and anyone carrying a
	// recorded attendance row for this meeting — exactly the list `loadMinutes`
	// builds and `minutes.counts` is computed over. Without it a member marked
	// present in March who left the club in April is missing from May's reopened
	// minutes: uncorrectable (the Minutes card's own recorder is gone) and, worse,
	// counted by the PDF and the emailed minutes but not by the panel, so one
	// meeting showed two different numbers. `#/lib/roll-attendance` owns it for the
	// same reason it owns the other two projections — this route cannot mount in
	// jsdom — and `buildRollPanel` is deliberately untouched: it builds from
	// whatever roster it is handed, and this is what hands it one.
	const rollRoster = useMemo(
		() =>
			deriveRollRoster({
				roster: panelRoster,
				online,
				minutes: minutes.data,
				snapshot: offlineMinutes.snapshot,
				queue: offlineMinutes.queue,
			}),
		[
			panelRoster,
			online,
			minutes.data,
			offlineMinutes.snapshot,
			offlineMinutes.queue,
		],
	);
	// ONE name for the roster the panel renders, so the two modes cannot diverge
	// at the call site. PLAN mode keeps the active roster only — for an UPCOMING
	// meeting a stale row must not resurrect a departed name onto a ladder nobody
	// has answered, which is the property `roll-panel.test.ts` pins.
	const panelRosterForMode = panelMode === "roll" ? rollRoster : panelRoster;
	// A panel built from an EMPTY roster renders its header and a counts line of
	// zeros — indistinguishable from "this club has no members" and from "you are
	// no longer the Toastmaster". This page gets used mid-meeting on club wifi, so
	// a failed fetch must not produce a confident lie about who is coming (#576
	// review). Officers are unaffected: their data is on the payload, never here.
	const tmodPanelUnavailable =
		needsTmodPlan && (tmodPanelPending || tmodPanelFailed);
	// ONE name for "the ladder this viewer may see", so the panel, the optimistic
	// rollback, `markAsked` and `contactedMemberIds` cannot disagree about which
	// array they are reading — the officer path and the TMOD path differ only in
	// where the rows came from.
	const effectivePlan = effectiveCanManage ? plan : fetchedPlan;
	// The assign-slot roster above is `{ id, name, ... }`; the minutes-style
	// picker `TableTopicsCapture` uses (`AssigneePicker`) expects `{ memberId,
	// name }` — the same shape `MeetingMinutes` gets from `MinutesData["members"]`.
	// Mapped once here rather than changing either shape, since `roster` is also
	// handed to `<MeetingAgenda>` verbatim, unchanged.
	const voteCounterRoster = roster.map((r) => ({
		memberId: r.id,
		name: r.name,
	}));

	// The Ballot Counter console's Table Topics list (#510). `getMinutes`'
	// visibility gate is `canEdit || completed`, so it hands back `data: null` —
	// and this list along with it — to a non-admin Vote Counter on any meeting
	// that has not been completed yet. `getVoteTally` is already gated to
	// admin-or-Vote-Counter and now carries the same speaker list (names only,
	// no topic), so that is the source for anyone who cannot read the full
	// minutes. Shares its query key with `VoteCounterPanel`'s own poll below —
	// mounting both costs one request, not two.
	const { data: voteTally } = useQuery({
		queryKey: ["vote-tally", meeting.id],
		queryFn: () =>
			getVoteTally({ data: { meetingId: meeting.id, selfMemberId: myId } }),
		enabled: isVoteCounter || effectiveCanManage,
		refetchInterval: 5000,
	});
	// Same predicate `<MeetingMinutes>` uses for its own `canEdit` prop below —
	// true exactly when `minutes.data` is populated and carries the full,
	// topic-included row (including while an admin is "previewing as member",
	// so the preview reflects what a non-admin Vote Counter would actually see).
	const canReadFullMinutesSpeakers = effectiveCanManage && minutes.canEdit;
	const consoleSpeakers = canReadFullMinutesSpeakers
		? (minutes.data?.tableTopicsSpeakers ?? [])
		: (voteTally?.tableTopicsSpeakers ?? []).map((s) => ({
				id: s.id,
				name: s.name,
				isGuest: s.kind === "guest",
				topic: null,
			}));

	const pairedIds = pairedRoleIds(clubRoles);
	const addableRoles = clubRoles.filter((r) => !pairedIds.has(r.id));
	const nudgeShareUrl =
		typeof window === "undefined"
			? `/club/${clubId}/meeting/${urlKey}`
			: `${window.location.origin}/club/${clubId}/meeting/${urlKey}`;
	const nudgeDate = footerDate(meeting.scheduledAt, timezone);
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
	// Derived here rather than carried as their own payload fields (#396 PR2
	// task 6): both are redundant with data the payload already ships.
	// `unavailableMembers` (public) already names who is `not_coming`;
	// `effectivePlan` already carries every rung including `reached_out` — the
	// payload's gated `plan` for an officer, the separately-verified
	// `getTmodPanelData` rows for this meeting's Toastmaster, and `[]` for everyone
	// else, which is what keeps the recruit picker's "already asked" marks off a
	// plain member's screen.
	const unavailableMemberIds = unavailableMembers.map((m) => m.id);
	const contactedMemberIds = effectivePlan
		.filter((p) => p.status === "reached_out")
		.map((p) => p.memberId);

	// What the caller asserts about THEMSELVES, so the server can check it against
	// the meeting's Toastmaster slot (#576). Sent only on the non-officer path:
	// an officer is identified by their session and `resolveWriteActor` ignores
	// any claim from them anyway, so including it would be noise that reads like
	// it matters. Omitted entirely when there is no identity, which leaves the
	// server's self-only arm exactly as it was.
	//
	// This is an ASSERTION, never proof — the server club-scopes it and compares
	// it to the slot before granting anything. Sending it cannot elevate a member
	// who is not the TMOD.
	const actorClaim = !effectiveCanManage && myId ? { actorMemberId: myId } : {};

	async function writeRung(
		memberId: string,
		next: PlanStatus | null,
		via: "nudge" | "manual" = "manual",
	) {
		// Roll back to what the UI was ACTUALLY showing, not the loader's
		// snapshot: nothing here awaits an invalidate before this runs, and for a
		// plain member `effectivePlan` is ALWAYS `[]` — so a lookup in it alone
		// would restore the very value the failed write already overwrote, every
		// time (whole-branch review I1). Check the override first (a second write
		// racing the same row), then `effectivePlan` (the ladder an officer or
		// this meeting's TMOD can see), then `answeredRungs` (the public array a
		// plain member's own row lives on).
		const previous =
			rungOverride[memberId] !== undefined
				? rungOverride[memberId]
				: (effectivePlan.find((p) => p.memberId === memberId)?.status ??
					answeredRungs.find((r) => r.memberId === memberId)?.status ??
					null);
		setRungOverride((o) => ({ ...o, [memberId]: next }));
		retainPending(memberId);
		try {
			await (next === null
				? clearPlannedAttendance({
						data: { memberId, meetingId: meeting.id, ...actorClaim },
					})
				: setPlannedAttendance({
						data: {
							memberId,
							meetingId: meeting.id,
							status: next,
							via,
							...actorClaim,
						},
					}));
			// Fire-and-forget, NOT awaited: the override already holds the value
			// this write just committed, so nothing on screen is waiting on this
			// resolving. But SOME invalidate has to fire, or `contactedMemberIds` /
			// `unavailableMemberIds` (both derived from loader values — `plan` /
			// `unavailableMembers`) go stale for the recruit picker and the assign
			// sheet after this tap (whole-branch review I3). This also feeds the
			// reconciling effect below its own trigger, rather than relying on some
			// unrelated action to refresh `plan`.
			//
			// The pending mark is released when this INVALIDATE settles, not when
			// the write above resolved. Those are different moments, and between
			// them the reconciling effect would happily evict this override: `plan`
			// gets a fresh identity on every loader run, and this route has ~15
			// other `router.invalidate()` call sites (meta save, minutes, add-role,
			// lifecycle, every vote action). A loader request that started before
			// this write committed, landing in that window, reverts a chip the
			// officer just tapped — which reads as "it didn't save", so they tap
			// again.
			// The TMOD's ladder lives in a QUERY, not loader data, so
			// `router.invalidate()` alone would leave it stale — and the
			// reconciling effect below, seeing a fresh payload, would then drop the
			// override back onto that stale row and visibly undo the officer's own
			// tap. No-op for an officer, whose ladder is on the payload.
			if (needsTmodPlan) {
				void queryClient.invalidateQueries({ queryKey: tmodPlanKey });
			}
			void router
				.invalidate()
				// A failed refetch does NOT undo the write: the override still holds
				// the committed value, so the panel stays correct. What goes stale is
				// `contactedMemberIds` / `unavailableMemberIds` elsewhere on the page,
				// and the next invalidate from any other action repairs it. Caught so
				// it is not an unhandled rejection, but deliberately not toasted — a
				// "couldn't save" here would be a lie about a write that succeeded.
				.catch(() => undefined)
				.finally(() => releasePending(memberId));
		} catch (e) {
			// Roll back to what the UI was actually displaying, not to `null` —
			// reverting to empty would silently erase a rung the officer did not
			// touch.
			setRungOverride((o) => ({ ...o, [memberId]: previous }));
			toast.error(e instanceof Error ? e.message : "Couldn't save that.");
			// Released HERE rather than in a `finally`, because the success path
			// hands the release to the invalidate above; a `finally` would release
			// a second time and drop another concurrent write's refcount.
			releasePending(memberId);
		}
	}

	// Drop a stale override once a fresh payload arrives — but drop it
	// UNCONDITIONALLY (any member with no write still in flight), not only when
	// it agrees with the server. The old effect deleted an override only
	// `if (server === value)`, which is backwards: agreement is the harmless
	// case, and an override that DISAGREES with the server — the one case that
	// matters — was pinned forever, masking every later payload for the rest of
	// the session (whole-branch review I2). `pendingWritesRef` is what keeps
	// this from evicting an override whose own write hasn't resolved yet.
	// biome-ignore lint/correctness/useExhaustiveDependencies: plan is the trigger (a fresh payload), not a value read in the body — including rungOverride would re-run on every write.
	useEffect(() => {
		setRungOverride((o) => {
			const next = { ...o };
			let changed = false;
			for (const memberId of Object.keys(o)) {
				if (pendingWritesRef.current.has(memberId)) continue;
				delete next[memberId];
				changed = true;
			}
			return changed ? next : o;
		});
	}, [effectivePlan]);

	// Advances no-answer → reached out; must NOT touch a member who already
	// answered (spec D5). Read through the override so a chip set a moment ago
	// counts.
	async function markAsked(memberId: string) {
		const current =
			rungOverride[memberId] !== undefined
				? rungOverride[memberId]
				: (effectivePlan.find((p) => p.memberId === memberId)?.status ?? null);
		if (current !== null) return;
		// Same event as the recruit picker's own `onContacted={"nudge"}` below —
		// tagging it "manual" (the default) here would log the identical action
		// under two different `via` spellings in activity_log (whole-branch
		// review M1).
		await writeRung(memberId, "reached_out", "nudge");
	}

	// Roll-mode writes. Every one goes through the route's SINGLE
	// `useOfflineMinutes` instance (#176 / DP3) rather than calling the server fn
	// directly: a direct call works online and silently vanishes offline, which
	// is precisely the condition this page is used in — a phone on club wifi,
	// mid-meeting. Reusing `offlineMinutes` rather than instantiating a second
	// hook is what keeps one `draining` flag over one persisted queue; two would
	// race it and replay a stale status over a newer one with no error.
	async function writeAttendance(memberId: string, status: AttendanceStatus) {
		await offlineMinutes.mutate(
			() =>
				setAttendance({ data: { meetingId: meeting.id, memberId, status } }),
			() => ({
				type: "setAttendance",
				...offlineMinutes.opMeta(),
				memberId,
				status,
			}),
		);
	}

	// The two guest handlers are lifted from <MeetingMinutes>'s AttendanceSection
	// wiring (meeting-minutes.tsx), whose copy Task 6 deletes — same bodies, not
	// new ones, so nothing about the behaviour changes inside that deletion. The
	// `crypto.randomUUID()` client-side guest PK is load-bearing: it is what makes
	// a queued new-guest op replay idempotently instead of creating a second guest
	// row on reconnect (#176 slice 5). `name` is resolved here because the queued
	// op has to render an optimistic row offline, with no round trip to name it.
	const guestName = (guestId: string) =>
		clubGuests.find((g) => g.id === guestId)?.name ?? "Guest";

	async function addRollGuest(payload: {
		guestId?: string;
		newGuest?: { name: string; email?: string; phone?: string };
	}) {
		await offlineMinutes.mutate(
			() => addMinutesGuest({ data: { meetingId: meeting.id, ...payload } }),
			() =>
				payload.newGuest
					? {
							type: "addGuest",
							...offlineMinutes.opMeta(),
							guestId: crypto.randomUUID(),
							name: payload.newGuest.name,
							newGuest: payload.newGuest,
						}
					: {
							type: "addGuest",
							...offlineMinutes.opMeta(),
							guestId: payload.guestId as string,
							name: guestName(payload.guestId as string),
						},
		);
	}

	async function removeRollGuest(guestId: string) {
		await offlineMinutes.mutate(
			() => removeMinutesGuest({ data: { meetingId: meeting.id, guestId } }),
			() => ({ type: "removeGuest", ...offlineMinutes.opMeta(), guestId }),
		);
	}

	// The agenda's internal claim/assign acts as this member: the session member
	// for a manager (null for an impersonator), the effective member otherwise.
	const agendaMemberId = effectiveCanManage ? managerActorId : myId;
	const containerClass = canManage
		? "max-w-workspace px-4 pt-5 pb-10 sm:px-7 sm:pt-7 space-y-5"
		: "mx-auto w-full max-w-reading p-4 pb-8 md:p-6 space-y-5";

	// The strip's own answer, read from the PUBLIC `answeredRungs` array — NEVER
	// from `plan`, which is admin-only ([] whenever `!canManage`) and would read
	// `null` forever for a plain member: they'd answer, the page would reload,
	// and the strip would ask again. Mirrors `unavailableMemberIds` above: a
	// public array filtered by the client-known `myId`, because the server
	// cannot resolve "my" for an anonymous roster pick.
	const myStatus = myId
		? (answeredRungs.find((r) => r.memberId === myId)?.status ?? null)
		: null;
	// Same override the panel's chips apply, so the member's own tap is instant
	// — but clamped off `reached_out`. `rungOverride` is shared with the
	// officer panel, so an OFFICER setting their own row to `reached_out` from
	// the panel would otherwise mislabel their own strip as "can't make this
	// one — undo?", and tapping that "undo" actually DELETES the row: an
	// officer's clear is unrestricted (`onlyFrom` is lifted for them in
	// `clearPlannedAttendance`), so it would erase the very outreach record the
	// clamp exists to protect (whole-branch review M8). `answeredRungs` can
	// never itself produce `reached_out` — it is filtered server-side — so this
	// only ever intercepts the override.
	let myEffectiveStatus =
		myId && rungOverride[myId] !== undefined ? rungOverride[myId] : myStatus;
	myEffectiveStatus =
		myEffectiveStatus === "reached_out" ? null : myEffectiveStatus;

	// Wraps the shared `writeRung` with the busy guard above — still ONE write
	// path (the panel's chips call `writeRung` directly), just with the strip's
	// own in-flight flag set first and cleared in `finally` so a rejected write
	// never leaves the control stuck disabled.
	async function setMyStatus(next: PlanStatus | null) {
		if (!myId) return;
		setMyStatusBusy(true);
		try {
			await writeRung(myId, next);
		} finally {
			setMyStatusBusy(false);
		}
	}

	// Manager (admin) actions: act as the session member; exposes the manager-only
	// confirm/unconfirm/moveSpeaker/removeRole set.
	const managerActions: MeetingAgendaActions = {
		claim: async (slot, speakerDetails) => {
			if (!managerActorId) {
				throw new Error("Your account isn't linked to a club member yet.");
			}
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: managerActorId,
					actorMemberId: managerActorId,
					speakerDetails,
				},
			});
		},
		release: async (slot) => {
			await releaseSlot({
				data: { slotId: slot.id, actorMemberId: managerActorId },
			});
		},
		takeover: async (slot) => {
			if (!managerActorId) {
				throw new Error("Your account isn't linked to a club member yet.");
			}
			await reassignSlot({
				data: {
					slotId: slot.id,
					memberId: managerActorId,
					actorMemberId: managerActorId,
				},
			});
		},
		confirm: async (slot) => {
			await confirmSlot({ data: { slotId: slot.id } });
		},
		unconfirm: async (slot) => {
			await unconfirmSlot({ data: { slotId: slot.id } });
		},
		moveSpeaker: async (slot, direction) => {
			await moveSpeakerSlot({ data: { slotId: slot.id, direction } });
		},
		removeRole: async (slot) => {
			await removeRoleSlot({ data: { slotId: slot.id } });
		},
		addSpeaker: async () => {
			await addSpeakerSlot({
				data: { meetingId: meeting.id, selfMemberId: managerActorId },
			});
		},
		removeSpeaker: async () => {
			await removeSpeakerSlot({
				data: { meetingId: meeting.id, selfMemberId: managerActorId },
			});
		},
		onMutated: () => router.invalidate(),
	};

	// Self-serve (member / anon) actions: resolve identity first (a signed-in
	// member resolves without a prompt; an anon visitor identifies at click) and
	// carry `selfMemberId`, so the server takes the ADR-0010 self-serve path.
	const selfActions: MeetingAgendaActions = {
		claim: async (slot, speakerDetails) => {
			const me = await requireIdentity();
			if (!me) return;
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: me.id,
					actorMemberId: me.id,
					speakerDetails,
				},
			});
		},
		release: async (slot) => {
			const me = await requireIdentity();
			if (!me) return;
			await releaseSlot({ data: { slotId: slot.id, actorMemberId: me.id } });
		},
		takeover: async (slot) => {
			const me = await requireIdentity();
			if (!me) return;
			await reassignSlot({
				data: { slotId: slot.id, memberId: me.id, actorMemberId: me.id },
			});
		},
		addSpeaker: async () => {
			const me = await requireIdentity();
			if (!me) return;
			await addSpeakerSlot({
				data: { meetingId: meeting.id, selfMemberId: me.id },
			});
			toast.success("Speaker added.");
		},
		removeSpeaker: async () => {
			const me = await requireIdentity();
			if (!me) return;
			await removeSpeakerSlot({
				data: { meetingId: meeting.id, selfMemberId: me.id },
			});
			toast.success("Speaker removed.");
		},
		onMutated: () => router.invalidate(),
	};

	const actions = effectiveCanManage ? managerActions : selfActions;

	async function doAddRole(roleDefinitionId: string) {
		setAddRoleBusy(true);
		try {
			await addRoleSlot({ data: { meetingId: meeting.id, roleDefinitionId } });
			toast.success("Role added.");
			setAddRoleOpen(false);
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setAddRoleBusy(false);
		}
	}

	async function doComplete() {
		setLifecycleBusy(true);
		try {
			await completeMeeting({ data: { meetingId: meeting.id } });
			toast.success("Meeting closed out and locked.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setLifecycleBusy(false);
		}
	}

	async function doReopen() {
		setLifecycleBusy(true);
		try {
			await reopenMeeting({ data: { meetingId: meeting.id } });
			toast.success("Meeting reopened for edits.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setLifecycleBusy(false);
		}
	}

	// Ballot Counter console handlers (#510 Task 10). These call the SAME
	// server fns the minutes-edit UI uses (`addTableTopics` / `removeTableTopics`
	// / `moveTableTopics` / `setMinutesAward` / `clearMinutesAward`) — there is
	// no separate voting-aware write path for Table Topics speakers or award
	// winners; only the vote open/close/tally calls (inside `VoteCounterPanel`)
	// go through `voting.ts`. Each now carries `selfMemberId: myId` so a
	// non-admin Vote Counter — who may not even be signed in, per the design's
	// "pick your name" self-assert — reaches `requireVoteCounterCapability`'s
	// self-assert path instead of the admin-only `gateAdmin` these five used to
	// share with `setAttendance` / `addMinutesGuest` / `removeMinutesGuest`
	// (still admin-only, unchanged). Harmless for an admin: their session grants
	// first, before `selfMemberId` is even consulted.
	async function handleAddTableTopicsSpeaker(payload: {
		memberId?: string;
		guestId?: string;
		newGuest?: { name: string };
		topic?: string;
	}) {
		setVoteConsoleBusy(true);
		try {
			await addTableTopics({
				data: { meetingId: meeting.id, selfMemberId: myId, ...payload },
			});
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setVoteConsoleBusy(false);
		}
	}

	async function handleRemoveTableTopicsSpeaker(id: string) {
		setVoteConsoleBusy(true);
		try {
			await removeTableTopics({
				data: { meetingId: meeting.id, id, selfMemberId: myId },
			});
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setVoteConsoleBusy(false);
		}
	}

	async function handleMoveTableTopicsSpeaker(
		id: string,
		direction: "up" | "down",
	) {
		setVoteConsoleBusy(true);
		try {
			await moveTableTopics({
				data: { meetingId: meeting.id, id, direction, selfMemberId: myId },
			});
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setVoteConsoleBusy(false);
		}
	}

	async function handleSetVoteWinner(
		category: AwardCategory,
		winner:
			| { kind: "member" | "guest"; id: string }
			| { kind: "writeIn"; name: string },
	) {
		try {
			await setMinutesAward({
				data: {
					meetingId: meeting.id,
					category,
					memberId: winner.kind === "member" ? winner.id : undefined,
					guestId: winner.kind === "guest" ? winner.id : undefined,
					writeInName: winner.kind === "writeIn" ? winner.name : undefined,
					selfMemberId: myId,
				},
			});
			toast.success("Winner set.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		}
	}

	async function handleClearVoteWinner(category: AwardCategory) {
		try {
			await clearMinutesAward({
				data: { meetingId: meeting.id, category, selfMemberId: myId },
			});
			toast.success("Winner cleared.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		}
	}

	return (
		<div className={containerClass}>
			{previewAsMember ? (
				<div className="flex items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm font-medium text-primary">
					<span className="flex items-center gap-2">
						<Eye className="size-4 shrink-0" aria-hidden />
						Previewing as a member — management controls are hidden.
					</span>
					<Button
						size="sm"
						variant="outline"
						onClick={() => setPreviewAsMember(false)}
					>
						Exit preview
					</Button>
				</div>
			) : null}
			{!online && shell ? (
				<div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm font-medium text-warning-foreground">
					<WifiOff className="size-4 shrink-0" aria-hidden />
					You're offline — minutes edits are saved on this device and sync when
					you reconnect. Other changes (meeting details, roles) need a
					connection.
				</div>
			) : null}
			{locked ? (
				<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-medium text-muted-foreground">
					<Lock className="size-4" aria-hidden />
					{MEETING_LOCKED_MESSAGE}
				</div>
			) : datePassed && !effectiveCanManage ? (
				<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-medium text-muted-foreground">
					<Lock className="size-4" aria-hidden />
					This meeting has already taken place.
				</div>
			) : null}
			<header className="space-y-2 pt-2">
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					{meeting.theme ?? "Meeting"}
				</h1>
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
					<span className="flex items-center gap-1.5">
						<CalendarDays className="size-4" aria-hidden />
						{formatMeetingDate(meeting.scheduledAt, timezone)} ·{" "}
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
									? "flex items-center gap-1.5 font-medium text-destructive"
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
				</div>
				<MeetingNavStrip clubId={clubId} items={navItems} />
				{/* Same predicate the "Word poster" button below uses, so the chip
				    and the button agree about whether there is a word. Consistency,
				    not a fix: the write paths trim, so blank cannot be stored. */}
				{hasWordOfTheDay(meeting.wordOfTheDay) ? (
					<p className="flex items-center gap-1.5 text-sm">
						<Sparkles className="size-4 text-primary" aria-hidden />
						<span className="text-muted-foreground">Word of the day:</span>
						<span className="font-medium">{meeting.wordOfTheDay}</span>
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
					onAddRole={() => setAddRoleOpen(true)}
					onComplete={doComplete}
					onReopen={doReopen}
				/>
				{/* Preview-as-member survives as a SIBLING of the toolbar (review
				    decision): capability preserved, not folded into the toolbar's
				    props — PR 2 reshapes the officer surface and will revisit.
				    Gated on `effectiveCanManage`, the same flag the toolbar gets, so
				    the toggle hides itself once preview is on — the way back out is
				    the "Exit preview" control in the banner above (line ~726), not
				    this button. This used to spell the condition out as
				    `canManage && !previewAsMember` under a comment claiming it was
				    deliberately NOT effectiveCanManage; that is the verbatim
				    definition of effectiveCanManage (line 374), so the comment
				    described a distinction the code never made. */}
				{effectiveCanManage ? (
					<div className="flex flex-wrap items-center gap-2 pt-1">
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setPreviewAsMember(true)}
						>
							<Eye className="size-4" />
							Preview as member
						</Button>
					</div>
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
					{effectiveCanManage ? null : <GuestResources clubId={clubId} />}

					<MeetingAgenda
						slots={slots}
						effectiveMeetingNumber={meetingNumber}
						viewer={viewer}
						actions={actions}
						roster={roster}
						roleRecency={roleRecency}
						roleByMemberId={roleByMemberId}
						unavailableMemberIds={unavailableMemberIds}
						pairedRoleIds={effectiveCanManage ? pairedIds : undefined}
						clubGuests={effectiveCanManage ? clubGuests : undefined}
						shareUrl={effectiveCanManage ? nudgeShareUrl : ""}
						meetingDate={effectiveCanManage ? nudgeDate : ""}
						meeting={meeting}
						timezone={timezone}
						selfMemberId={agendaMemberId}
						onMetaSaved={async () => {
							await router.invalidate();
						}}
						requireIdentity={requireIdentity}
						contactedMemberIds={contactedMemberIds}
						onContacted={async (memberId, via) => {
							try {
								await setContacted({
									data: {
										memberId,
										meetingId: meeting.id,
										clubId: meeting.clubId,
										via,
									},
								});
								await router.invalidate();
							} catch (err) {
								toast.error(errMessage(err));
							}
						}}
						onUncontacted={async (memberId) => {
							try {
								await clearContacted({
									data: {
										memberId,
										meetingId: meeting.id,
										clubId: meeting.clubId,
									},
								});
								await router.invalidate();
							} catch (err) {
								toast.error(errMessage(err));
							}
						}}
					/>

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
								canEdit={effectiveCanManage && minutes.canEdit}
								clubGuests={clubGuests}
								offline={offlineMinutes}
								email={
									minutesEmail
										? {
												clubId: meeting.clubId,
												clubName,
												meetingDate: meeting.scheduledAt,
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
							<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-medium text-muted-foreground">
								<ClipboardList className="size-4 shrink-0" aria-hidden />
								Minutes couldn't load — refresh to try again.
							</div>
						</section>
					) : null}

					{isVoteCounter || effectiveCanManage ? (
						<section className="space-y-4 rounded-xl border border-border bg-card p-4">
							<div>
								<h2 className="font-display font-semibold text-lg">
									Ballot Counter console
								</h2>
								<p className="text-muted-foreground text-sm">
									Only visible to you. Add Table Topics speakers so they're
									eligible for Best Table Topics, then open a category, watch
									the count, and confirm the winner once it closes.
								</p>
							</div>
							<TableTopicsCapture
								speakers={consoleSpeakers}
								canEdit={true}
								busy={voteConsoleBusy}
								roster={voteCounterRoster}
								clubGuests={clubGuests}
								onAdd={handleAddTableTopicsSpeaker}
								onRemove={handleRemoveTableTopicsSpeaker}
								onMove={handleMoveTableTopicsSpeaker}
							/>
							<VoteCounterPanel
								meetingId={meeting.id}
								selfMemberId={myId}
								onSetWinner={handleSetVoteWinner}
								onClearWinner={handleClearVoteWinner}
							/>
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
						// bottom rows reachable. `7rem` = the 6rem `top-24` offset plus
						// 1rem of breathing room at the bottom edge.
						//
						// The cap lives here and the SCROLLER does not. This `<aside>` is
						// the positioner — sticky, width, order, and the height ceiling
						// that the pinning makes necessary — and it is a flex column so
						// the panel's card can fill it. The card then puts the scroller on
						// its own body, which is what keeps the title, the counts line and
						// the sync status visible while the rows move; the scroller used to
						// be this element, and a reader 25 rows into a 40-member roster had
						// lost the summary they were reading the rail for. `7rem` = the
						// 6rem `top-24` offset plus 1rem of breathing room at the bottom.
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
						// is the measured `w-44` track, and the row menu is a portalled
						// `DropdownMenuContent` — but a future popover that renders INLINE
						// would be cut off. Moving the scroller inward tightened that box
						// from the column to the card's body, so it is a smaller trap than
						// it was, not a new one.
						className="order-1 lg:order-2 lg:sticky lg:top-24 lg:flex lg:max-h-[calc(100vh-7rem)] lg:w-[340px] lg:shrink-0 lg:flex-col"
					>
						<MeetingAttendancePanel
							// `upcoming` → the outreach ladder; meeting day and after → the
							// record of who turned up. One derivation, off the route's frozen
							// clock, so this cannot disagree with the agenda beside it.
							mode={panelMode}
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
							locked={locked}
							onWriteRung={writeRung}
							onContacted={markAsked}
							onSetAttendance={writeAttendance}
							onAddGuest={addRollGuest}
							onRemoveGuest={removeRollGuest}
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
		</div>
	);
}
