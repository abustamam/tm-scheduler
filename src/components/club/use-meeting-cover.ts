import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import type {
	MeetingAgendaActions,
	SpeakerDetails,
} from "#/components/agenda/meeting-agenda";
import { showWriteError } from "#/components/write-error-toast";
import { slotLabel } from "#/lib/agenda";
import type { getMeetingByKey } from "#/server/meetings";
import { getPublicClubRoles } from "#/server/role-definitions";
import {
	addSpeakerSlot,
	claimSlot,
	confirmSlot,
	moveEvaluatorSlot,
	moveSpeakerSlot,
	reassignSlot,
	releaseSlot,
	removeRoleSlot,
	removeSpeakerSlot,
	unconfirmSlot,
} from "#/server/slots";
import { coverChipsFor, coverMeetingOver } from "./cover-chip";
import { coverLandingView, takeCoveredSlot } from "./cover-landing-card";
import type { CoverSlot } from "./cover-sheet";
import type { useRequireIdentity } from "./identity-gate";

type MeetingDetail = Awaited<ReturnType<typeof getMeetingByKey>>;

/**
 * The meeting page's claim and cover domain (#1476): the agenda's claim /
 * release / takeover actions, the cover-request landing card (`?cover=`), the
 * cover sheet a late release opens, and `declineFreesRoles` (which the outreach
 * hook takes as a parameter).
 */
export function useMeetingCover(args: {
	/** The club's uuid, for the public role definitions read. */
	clubUuid: string;
	/** The club key in the URL, stamped onto a cover sheet's link. */
	clubSlug: string;
	meeting: MeetingDetail["meeting"];
	slots: MeetingDetail["slots"];
	coverRequests: MeetingDetail["coverRequests"];
	meetingNumber: number | null | undefined;
	timezone: string;
	urlKey: string;
	search: unknown;
	/** This render's one clock. */
	now: Date;
	over: boolean;
	roleCounts: Record<string, number>;
	canManage: boolean;
	effectiveCanManage: boolean;
	isSignedIn: boolean;
	myId: string | null;
	/** The session member, null for an impersonating superadmin. */
	managerActorId: string | null;
	requireIdentity: ReturnType<typeof useRequireIdentity>["requireIdentity"];
}) {
	const {
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
	} = args;
	const router = useRouter();

	// The viewer's own late release waits here for the cover sheet (#1439).
	const [coverSlots, setCoverSlots] = useState<CoverSlot[]>([]);
	// `?cover=<slotId>` (#1440): "Can't, sorry" hides the landing card for this
	// visit; a reload with the link shows it again, which is the right reading
	// of a link someone re-opened.
	const [coverCardDismissed, setCoverCardDismissed] = useState(false);
	const [coverTakeBusy, setCoverTakeBusy] = useState(false);
	const coverParam = (search as { cover?: unknown }).cover;
	// The role's one-liner: the public roles read, only when a cover link is
	// present (the meeting payload's `clubRoles` is manager-only).
	const { data: coverRoleDefs } = useQuery({
		queryKey: ["public-club-roles", clubUuid] as const,
		queryFn: () => getPublicClubRoles({ data: clubUuid }),
		enabled: typeof coverParam === "string",
	});

	/**
	 * Whether a decline written by THIS viewer, about THIS member, frees roles.
	 *
	 * It predicts the server's ARM — `attendance-decline-logic.ts` releases on
	 * the officer arm, on the member's own answer, and on the Toastmaster's own
	 * row; it withholds only a Toastmaster acting on someone ELSE. So the two
	 * clauses here are officer-or-self, and `isTmod` is deliberately NOT read:
	 * the own-row TMOD case resolves to `via: "tmod"` server-side (arm order is
	 * officer → TMOD → self) and releases anyway, so branching on it here would
	 * put the client and the server back out of step.
	 *
	 * `canManage`, NOT `effectiveCanManage`: the server keys off the SESSION, and
	 * an admin previewing-as-member (#320) still carries one, so the preview flag
	 * would make this under-predict on a path where the release still lands.
	 *
	 * This decides COPY only. It is NOT the gate on whether to ask — see
	 * `writeRung` — and it is not the gate on the release either, which is the
	 * server's.
	 */
	function declineFreesRoles(memberId: string): boolean {
		// #762 / ADR-0026: freeing roles needs `proof: "session"`, so this predicts
		// the SERVER's answer per arm rather than gating the whole expression on
		// one proxy for a session.
		//
		// `canManage` stands alone because it is already that answer for the
		// officer arm: `canManageClub` grants on an admin membership OR a
		// `read_write` impersonation and refuses `read_only`, which is exactly what
		// `requireClubRole(admin)` resolves inside `resolveActor` and exactly what
		// `requireSessionActor` admits. An earlier draft hoisted the session term
		// in front of the whole disjunction, and that was a silent ADR-0016 / #246
		// admin-parity regression: `isSignedIn` here is `effectiveMemberId &&
		// authCtx?.user`, and an impersonating superadmin has NO `effectiveMemberId`
		// (see the note where `managerActorId` is derived). So the one principal
		// with full admin parity was predicted to free nothing, the dialog told them
		// the role stays, the flag was stripped — and the member was marked
		// `not_coming` while still holding every role, with no error and nothing on
		// screen to notice.
		//
		// The SELF arm is the one that needs the session term, and only it: an
		// anonymous roster pick reaches it — that is #699 — and the server refuses
		// the request outright rather than downgrading, so a dialog that promised a
		// release would be promising a write that throws before anything lands.
		return canManage || (isSignedIn && memberId === myId);
	}

	// Manager (admin) actions: act as the session member; exposes the manager-only
	// confirm/unconfirm/moveSpeaker/moveEvaluator/removeRole set.
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
		// No actor on the wire for release / reassign (#763): both read the
		// session, which is what lets an impersonating superadmin release.
		release: async (slot) => {
			await releaseSlot({ data: { slotId: slot.id } });
		},
		takeover: async (slot) => {
			if (!managerActorId) {
				throw new Error("Your account isn't linked to a club member yet.");
			}
			await reassignSlot({
				data: { slotId: slot.id, memberId: managerActorId },
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
		moveEvaluator: async (slot, direction) => {
			await moveEvaluatorSlot({ data: { slotId: slot.id, direction } });
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
	async function claimAs(
		me: { id: string },
		slot: { id: string },
		speakerDetails?: SpeakerDetails,
	) {
		await claimSlot({
			data: {
				slotId: slot.id,
				memberId: me.id,
				actorMemberId: me.id,
				speakerDetails,
			},
		});
	}
	const selfActions: MeetingAgendaActions = {
		claim: async (slot, speakerDetails) => {
			const me = await requireIdentity();
			if (!me) return;
			await claimAs(me, slot, speakerDetails);
		},
		// Rendered only for a signed-in holder (`canReleaseOwn`, #1003), so there
		// is no identity to resolve: the server reads the session (#763), and a
		// refusal reaches the agenda's `showWriteError` with its sign-in link.
		release: async (slot) => {
			await releaseSlot({ data: { slotId: slot.id } });
		},
		takeover: async (slot) => {
			const me = await requireIdentity();
			if (!me) return;
			await reassignSlot({ data: { slotId: slot.id, memberId: me.id } });
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

	// Cover requests (#1440): the landing card for a `?cover=` link, and a chip
	// per request. Each chip sits under its own role row, handed to the agenda
	// through `slotExtra` (#1461); a cancelled or past meeting shows none.
	const coverOver = coverMeetingOver({ over, status: meeting.status });
	const coverView = coverLandingView({
		cover: coverParam,
		dismissed: coverCardDismissed,
		slots,
		coverRequests,
		meetingOver: coverOver,
		roleCounts,
		roleDefs: coverRoleDefs,
		scheduledAt: new Date(meeting.scheduledAt),
		timezone,
		meetingNumber,
	});
	const coverChips = coverChipsFor({
		coverRequests,
		slots,
		roleCounts,
		scheduledAt: new Date(meeting.scheduledAt),
		timezone,
		now,
		meetingOver: coverOver,
	});
	// slot id -> its chip: the agenda places each under its own row (#1461).
	const coverChipBySlotId = new Map(
		coverChips.map((c) => [c.request.slotId, c]),
	);

	async function takeCoveredRole() {
		const slot = coverView.slot;
		if (!slot) return;
		await takeCoveredSlot({
			// The same self-serve claim the agenda uses: a signed-out visitor
			// picks their name first (PickNameForm), a signed-in member does not.
			claim: async () => {
				const me = await requireIdentity();
				if (!me) return false;
				await claimAs(me, slot);
				return true;
			},
			onTaken: () => toast.success(`You're on as ${coverView.roleLabel}.`),
			refresh: () => router.invalidate(),
			onError: (err) => showWriteError(err, "Something went wrong."),
			setBusy: setCoverTakeBusy,
		});
	}

	// The agenda's own-late-release hook: opens the cover sheet for the role the
	// viewer just let go of (#1439).
	function onOwnLateRelease(slot: MeetingDetail["slots"][number]) {
		setCoverSlots([
			{
				slotId: slot.id,
				meetingId: meeting.id,
				roleLabel: slotLabel(slot, roleCounts),
				scheduledAt: meeting.scheduledAt,
				clubSlug,
				urlKey,
				timeZone: timezone,
			},
		]);
	}

	return {
		actions,
		coverSlots,
		closeCoverSheet: () => setCoverSlots([]),
		onCoverChanged: () => router.invalidate(),
		onOwnLateRelease,
		coverView,
		coverOver,
		coverChipBySlotId,
		coverTakeBusy,
		takeCoveredRole,
		dismissCoverCard: () => setCoverCardDismissed(true),
		declineFreesRoles,
	};
}
