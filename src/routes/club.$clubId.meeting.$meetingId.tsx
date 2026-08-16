import { useQuery } from "@tanstack/react-query";
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
import { useEffect, useState } from "react";
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
import { useOnlineStatus } from "#/hooks/use-online-status";
import { buildRoleCounts, slotLabel } from "#/lib/agenda";
import {
	applyFlex,
	buildRunOfShow,
	expandRunSheet,
} from "#/lib/agenda-runsheet";
import { buildSlideDeck } from "#/lib/agenda-slides";
import type { PlanStatus } from "#/lib/attendance-panel";
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
import { footerDate } from "#/lib/slide-layout";
import { hasWordOfTheDay } from "#/lib/word-poster";
import { getOpenActionItems } from "#/server/action-items";
import {
	clearPlannedAttendance,
	setPlannedAttendance,
} from "#/server/attendance-plan";
import { clearAvailability, setAvailability } from "#/server/availability";
import { getClubLogoMeta } from "#/server/club-logo";
import {
	completeMeeting,
	getMeetingByKey,
	getPublicMeetingByKey,
	listPastMeetings,
	listUpcomingMeetings,
	reopenMeeting,
} from "#/server/meetings";
import { listMembers } from "#/server/members";
import {
	addTableTopics,
	clearMinutesAward,
	getMinutes,
	moveTableTopics,
	removeTableTopics,
	setMinutesAward,
} from "#/server/minutes";
import { getMinutesRecipients } from "#/server/minutes-email";
import type { AwardCategory } from "#/server/minutes-logic";
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
		minutes,
		openActionItems,
		minutesEmail,
		meetingNumber,
		nextMeetingAt,
		urlKey,
		geIntroducesFunctionaries,
		logoUrl,
	} = Route.useLoaderData();
	const router = useRouter();
	const online = useOnlineStatus();

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

	const [availBusy, setAvailBusy] = useState(false);
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

	// One club config drives both renderings of this meeting (#367).
	const flex = applyFlex(
		expandRunSheet(slots, buildRunOfShow({ geIntroducesFunctionaries })),
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
	const deck = buildSlideDeck({
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
	// PR 2 ships plan mode only — roll mode (`today` / `completed`) is PR 3, so
	// the panel simply does not render outside `upcoming` yet.
	const showPlanPanel = effectiveCanManage && phase === "upcoming";

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
	// Derived here rather than carried as their own payload fields (#396 PR2
	// task 6): both are redundant with data the payload already ships.
	// `unavailableMembers` (public) already names who is `not_coming`; `plan`
	// (canManage-gated, [] otherwise — same gate the old dedicated field used)
	// already carries every rung including `reached_out`.
	const unavailableMemberIds = unavailableMembers.map((m) => m.id);
	const contactedMemberIds = plan
		.filter((p) => p.status === "reached_out")
		.map((p) => p.memberId);

	async function writeRung(memberId: string, next: PlanStatus | null) {
		const previous = plan.find((p) => p.memberId === memberId)?.status ?? null;
		setRungOverride((o) => ({ ...o, [memberId]: next }));
		try {
			await (next === null
				? clearPlannedAttendance({ data: { memberId, meetingId: meeting.id } })
				: setPlannedAttendance({
						data: { memberId, meetingId: meeting.id, status: next },
					}));
		} catch (e) {
			// Roll back to what the server last told us, not to `null` — reverting
			// to empty would silently erase a rung the officer did not touch.
			setRungOverride((o) => ({ ...o, [memberId]: previous }));
			toast.error(e instanceof Error ? e.message : "Couldn't save that.");
		}
	}

	// Drop the override for a member once the server payload agrees, so the map
	// cannot grow unboundedly across a long session.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the
	// server payload only — including `rungOverride` would re-run on every write.
	useEffect(() => {
		setRungOverride((o) => {
			const next = { ...o };
			let changed = false;
			for (const [memberId, value] of Object.entries(o)) {
				const server =
					plan.find((p) => p.memberId === memberId)?.status ?? null;
				if (server === value) {
					delete next[memberId];
					changed = true;
				}
			}
			return changed ? next : o;
		});
	}, [plan]);

	// Advances no-answer → reached out; must NOT touch a member who already
	// answered (spec D5). Read through the override so a chip set a moment ago
	// counts.
	async function markAsked(memberId: string) {
		const current =
			rungOverride[memberId] !== undefined
				? rungOverride[memberId]
				: (plan.find((p) => p.memberId === memberId)?.status ?? null);
		if (current !== null) return;
		await writeRung(memberId, "reached_out");
	}

	const myUnavailable = myId ? unavailableMemberIds.includes(myId) : false;
	// The agenda's internal claim/assign acts as this member: the session member
	// for a manager (null for an impersonator), the effective member otherwise.
	const agendaMemberId = effectiveCanManage ? managerActorId : myId;
	const containerClass = canManage
		? "max-w-workspace px-4 pt-5 pb-10 sm:px-7 sm:pt-7 space-y-5"
		: "mx-auto w-full max-w-reading p-4 pb-8 md:p-6 space-y-5";

	async function toggleAvailability() {
		setAvailBusy(true);
		try {
			const me = await requireIdentity();
			if (!me) return;
			if (myUnavailable) {
				await clearAvailability({
					data: { memberId: me.id, meetingId: meeting.id, clubId: clubUuid },
				});
				toast.success("You're marked as available again.");
			} else {
				await setAvailability({
					data: { memberId: me.id, meetingId: meeting.id, clubId: clubUuid },
				});
				toast.success("Got it — you can't make this one.");
			}
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setAvailBusy(false);
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
		winner: { kind: "member" | "guest"; id: string },
	) {
		try {
			await setMinutesAward({
				data: {
					meetingId: meeting.id,
					category,
					memberId: winner.kind === "member" ? winner.id : undefined,
					guestId: winner.kind === "guest" ? winner.id : undefined,
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
			<div className="lg:flex lg:items-start lg:gap-6">
				<div className="min-w-0 flex-1 space-y-5">
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
							You're offline — minutes edits are saved on this device and sync
							when you reconnect. Other changes (meeting details, roles) need a
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
							myUnavailable={myUnavailable}
							availBusy={availBusy}
							canToggleAvailability={viewer.canToggleAvailability}
							onToggleAvailability={toggleAvailability}
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
								onMutated={() => router.invalidate()}
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
				{showPlanPanel ? (
					<aside className="mt-5 lg:mt-0 lg:sticky lg:top-24 lg:w-[340px] lg:shrink-0">
						<MeetingAttendancePanel
							// `loaderRoster`, not the union-typed `roster` local (which
							// falls back to the client-fetched PUBLIC roster with no
							// contact fields) — this panel only renders under
							// `showPlanPanel`, i.e. `effectiveCanManage`, where the loader
							// always populates the full contact roster.
							roster={loaderRoster}
							plan={plan}
							rungOverride={rungOverride}
							roleByMemberId={roleByMemberId}
							meetingDate={nudgeDate}
							shareUrl={nudgeShareUrl}
							locked={locked}
							onWriteRung={writeRung}
							onContacted={markAsked}
						/>
					</aside>
				) : null}
			</div>
		</div>
	);
}
