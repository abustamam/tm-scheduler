// Authorization decision for per-meeting agenda writes, split out from the
// session-aware guard in `guards.ts` so the db-touching branch logic is
// directly integration-testable by mocking `#/db`. This module must never be
// imported by client components (it touches `db`/`pg`).
import { and, asc, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	clubs,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import {
	isMeetingLocked,
	MEETING_LOCKED_MESSAGE,
} from "#/lib/meeting-lifecycle";
import {
	findGrammarianSlot,
	findTmodSlot,
	findVoteCounterSlot,
} from "#/lib/meeting-roles";
import { markImpersonatedWrite } from "./impersonation-actor";
import { getActiveImpersonation } from "./impersonation-logic";

/**
 * The archive choke point for every per-meeting WRITE resolver in this module
 * (#555). Archiving is the platform takedown lever (ADR-0016), and a write to a
 * taken-down club must THROW rather than resolve `allowed: false` — every caller
 * already has an error path, and accepting an edit nobody can ever read is the
 * worse failure. Fails CLOSED on a missing club, matching `assertClubNotArchived`.
 *
 * Reads `clubs.archived_at` here instead of calling `guards.ts`'s
 * `assertClubNotArchived`: `guards.ts` imports THIS module, so importing it back
 * would close an import cycle. Same table, same shared message constant, so the
 * two paths cannot tell a member different things about the same club.
 */
async function assertMeetingClubNotArchived(clubId: string): Promise<void> {
	const [club] = await db
		.select({ archivedAt: clubs.archivedAt })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	if (!club) throw new Error("Club not found.");
	if (isClubArchived(club)) throw new Error(CLUB_ARCHIVED_MESSAGE);
}

/**
 * The meeting-lock choke point (#150). Throws when a meeting's status is
 * `completed` so every agenda mutation that runs it inherits the lock. Only
 * "Reopen" (a separate admin path) may change a completed meeting. Pure — call
 * with the status a mutation already loaded.
 */
export function assertMeetingNotLocked(status: string): void {
	if (isMeetingLocked(status)) {
		throw new Error(MEETING_LOCKED_MESSAGE);
	}
}

export interface MeetingAgendaAuthzInput {
	meetingId: string;
	/** Signed-in user id (admin path), or null for public callers. */
	sessionUserId?: string | null;
	/** Self-asserted roster member id (TMOD path), or null. */
	selfMemberId?: string | null;
}

export interface MeetingAgendaAuthz {
	clubId: string;
	allowed: boolean;
	/** Which path granted access (null when denied). Callers use this to keep
	 *  reschedule/cancel/status admin-only: a `tmod-self-assert` grant must not
	 *  ride the club-decision boundary. */
	via: "admin" | "tmod-self-assert" | null;
	/** The meeting's TMOD slot assignee, or null when unassigned/absent. */
	tmodMemberId: string | null;
	/** The member to credit in `activity_log` for a write made under this grant
	 *  (#396): the session's own membership on the admin path, the verified
	 *  self-asserted holder on the TMOD path. Null when denied, or when the grant
	 *  came from a memberless `read_write` impersonation (`logActivity` stamps the
	 *  superadmin instead). NEVER the client's `actorMemberId` — that is the
	 *  forgeable input this replaces. */
	actorMemberId: string | null;
}

/**
 * Admin-path grant shared by the agenda-edit and Word-of-the-Day authz: a live
 * session that resolves (via Person, ADR-0008 Phase B) to an active `admin`
 * membership in this club, OR a superadmin with an active `read_write`
 * impersonation of this club (#246). In the impersonation case it marks the
 * request so the write is attributed to the real superadmin. A `read_only`
 * session never grants — writes stay blind to it by construction.
 *
 * Returns `granted` plus the membership id to credit the write to (#396) — null
 * for the memberless impersonation arm, where `logActivity` records the real
 * superadmin in `impersonated_by` instead.
 */
async function resolveAdminGrant(
	sessionUserId: string | null | undefined,
	clubId: string,
): Promise<{ granted: boolean; memberId: string | null }> {
	if (!sessionUserId) return { granted: false, memberId: null };
	const [membership] = await db
		.select({
			id: members.id,
			clubRole: members.clubRole,
			status: members.status,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(and(eq(people.userId, sessionUserId), eq(members.clubId, clubId)))
		.limit(1);
	if (
		membership &&
		membership.status === "active" &&
		membership.clubRole === "admin"
	) {
		return { granted: true, memberId: membership.id };
	}
	const session = await getActiveImpersonation(sessionUserId, clubId);
	if (session?.mode === "read_write") {
		markImpersonatedWrite(sessionUserId);
		return { granted: true, memberId: null };
	}
	return { granted: false, memberId: null };
}

/**
 * Resolve the meeting's TMOD and Grammarian slot assignees (each null when the
 * slot is unassigned or absent). Identifies roles the same way the rest of the
 * app does — by `role_definitions.key`, with the name only as the fallback for a
 * slot that carries no key (#464).
 *
 * `key` is selected, not just `name`: this is the SERVER side of the capability,
 * so matching on the display name did not merely hide a button. A club that
 * renamed its Toastmaster of the Day had the mutation itself refused, and a club
 * that invented any role starting with "Toastmaster" had it granted.
 */
async function loadRoleSlotAssignees(meetingId: string): Promise<{
	tmodMemberId: string | null;
	grammarianMemberId: string | null;
	voteCounterMemberId: string | null;
}> {
	const slotRows = await db
		.select({
			roleName: roleDefinitions.name,
			roleKey: roleDefinitions.key,
			assignedMemberId: roleSlots.assignedMemberId,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(eq(roleSlots.meetingId, meetingId))
		// Deterministic, and the SAME order the route sees (`loadMeetingDetail`
		// orders by these two). The keyed pass makes the common tie irrelevant, but
		// two KEYLESS rows both named canonically are still separated by order
		// alone — `role_definitions` has no unique constraint on (club_id, name) and
		// the Add Role form posts free text, so that pair is constructible. Without
		// this the same meeting could grant a different member between requests, and
		// the server could disagree with the button the client rendered.
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex));
	return {
		tmodMemberId: findTmodSlot(slotRows)?.assignedMemberId ?? null,
		grammarianMemberId: findGrammarianSlot(slotRows)?.assignedMemberId ?? null,
		voteCounterMemberId:
			findVoteCounterSlot(slotRows)?.assignedMemberId ?? null,
	};
}

/**
 * This meeting's Toastmaster-of-the-Day slot assignee, or null when the slot is
 * unassigned or absent.
 *
 * A narrow export of `loadRoleSlotAssignees` for the planned-attendance seam
 * (#576), which needs the TMOD identity but none of the agenda-edit decisions
 * the resolvers below make — it has its own D6 ladder in `attendance-plan.ts`,
 * and duplicating the admin arm here would give that one rule two homes.
 *
 * Sharing the loader rather than re-querying is the point: it matches on
 * `role_definitions.key` with the name only as a fallback, so a club that
 * renamed its Toastmaster of the Day still resolves and a club that invented a
 * role starting with "Toastmaster" still does not. A second hand-rolled query
 * would be exactly where that distinction gets lost.
 */
export async function loadTmodMemberId(
	meetingId: string,
): Promise<string | null> {
	return (await loadRoleSlotAssignees(meetingId)).tmodMemberId;
}

/**
 * Decide whether a caller may edit a meeting's agenda content (meta + slots).
 * Allowed when the caller is a club `admin` (via a live session) OR the
 * self-asserted `memberId` equals the meeting's TMOD slot assignee. If the TMOD
 * slot is unassigned there is no self-serve editor — only admin passes.
 * Throws when the meeting does not exist, is locked, or its club is archived.
 */
export async function resolveMeetingAgendaAuthz(
	input: MeetingAgendaAuthzInput,
): Promise<MeetingAgendaAuthz> {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const clubId = meeting.clubId;
	// Archive choke point (#555): the agenda-edit family — updateMeeting,
	// add/remove/move speaker, move evaluator — reaches the db through here and
	// through nothing else, so the takedown gate belongs here rather than in five
	// handlers that each have to remember it. It must run BEFORE either grant arm
	// returns: the admin arm returns first, so gating only the TMOD path would
	// leave the family open to any club admin, and the TMOD arm needs no session
	// at all, which is the wider hole of the two.
	//
	// It also runs BEFORE the lock check in the two resolvers that HAVE one
	// (`resolveVoteCounterAuthz` deliberately has none — a Ballot Counter's
	// capabilities span the live meeting — which is also why the archive gate
	// cannot simply fold into `assertMeetingNotLocked`). Takedown
	// outranks every other reason to refuse: with the lock first, an archived
	// club's COMPLETED meeting answered "this meeting is completed", which both
	// discloses meeting state the takedown was meant to end and answers
	// differently from the same club's scheduled meeting.
	await assertMeetingClubNotArchived(clubId);
	// Lock choke point (#150): a completed meeting rejects every agenda edit that
	// funnels through here (update meta, add/remove/move speaker). Reopen is a
	// separate admin path and does not run this.
	assertMeetingNotLocked(meeting.status);
	const { tmodMemberId } = await loadRoleSlotAssignees(input.meetingId);

	// Admin path (session admin or read_write impersonation, #246).
	const admin = await resolveAdminGrant(input.sessionUserId, clubId);
	if (admin.granted) {
		return {
			clubId,
			allowed: true,
			via: "admin",
			tmodMemberId,
			actorMemberId: admin.memberId,
		};
	}

	// TMOD self-assert path: caller holds this meeting's TMOD slot.
	if (
		input.selfMemberId &&
		tmodMemberId &&
		input.selfMemberId === tmodMemberId
	) {
		return {
			clubId,
			allowed: true,
			via: "tmod-self-assert",
			tmodMemberId,
			// Verified against the slot above, so it is safe to credit.
			actorMemberId: tmodMemberId,
		};
	}

	return {
		clubId,
		allowed: false,
		via: null,
		tmodMemberId,
		actorMemberId: null,
	};
}

export interface WordOfTheDayAuthz {
	clubId: string;
	allowed: boolean;
	/** Which path granted access (null when denied). */
	via: "admin" | "tmod-self-assert" | "grammarian-self-assert" | null;
	tmodMemberId: string | null;
	grammarianMemberId: string | null;
	/** The member to credit in `activity_log` (#396) — see `MeetingAgendaAuthz`. */
	actorMemberId: string | null;
}

/**
 * Decide whether a caller may edit a meeting's Word of the Day (word +
 * definition + example) — a narrower capability than the full agenda edit
 * (#296). Allowed when the caller is a club `admin` (session), OR the
 * self-asserted `memberId` holds the meeting's TMOD slot, OR the self-asserted
 * `memberId` holds the meeting's Grammarian slot. The Grammarian owns the WOD in
 * a Toastmasters meeting, so the grammarian slot unlocks WOD editing on the
 * self-serve surface without granting any other meeting-meta edit. If the slot a
 * path keys off is unassigned, that path can't grant. Throws when the meeting
 * does not exist or is locked (#150 choke point).
 */
export async function resolveWordOfTheDayAuthz(
	input: MeetingAgendaAuthzInput,
): Promise<WordOfTheDayAuthz> {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const clubId = meeting.clubId;
	// Same archive gate as the agenda resolver above, for the same reason and in
	// the same position: before the admin arm returns, and before the lock check.
	await assertMeetingClubNotArchived(clubId);
	assertMeetingNotLocked(meeting.status);
	const { tmodMemberId, grammarianMemberId } = await loadRoleSlotAssignees(
		input.meetingId,
	);

	const admin = await resolveAdminGrant(input.sessionUserId, clubId);
	if (admin.granted) {
		return {
			clubId,
			allowed: true,
			via: "admin",
			tmodMemberId,
			grammarianMemberId,
			actorMemberId: admin.memberId,
		};
	}

	if (
		input.selfMemberId &&
		tmodMemberId &&
		input.selfMemberId === tmodMemberId
	) {
		return {
			clubId,
			allowed: true,
			via: "tmod-self-assert",
			tmodMemberId,
			grammarianMemberId,
			actorMemberId: tmodMemberId,
		};
	}

	if (
		input.selfMemberId &&
		grammarianMemberId &&
		input.selfMemberId === grammarianMemberId
	) {
		return {
			clubId,
			allowed: true,
			via: "grammarian-self-assert",
			tmodMemberId,
			grammarianMemberId,
			actorMemberId: grammarianMemberId,
		};
	}

	return {
		clubId,
		allowed: false,
		via: null,
		tmodMemberId,
		grammarianMemberId,
		actorMemberId: null,
	};
}

export interface VoteCounterAuthz {
	clubId: string;
	allowed: boolean;
	via: "admin" | "vote-counter-self-assert" | null;
	voteCounterMemberId: string | null;
	/** The member to credit in `activity_log` (null for an impersonated admin). */
	actorMemberId: string | null;
	/** The meeting's status, so the caller can decide about the lock itself. */
	meetingStatus: string;
}

/**
 * Decide whether a caller may operate a meeting's digital votes (#510): open
 * and close the windows, read the running tally, and confirm the winner.
 * Allowed for a club `admin` (session), or when the self-asserted `memberId`
 * holds the meeting's `vote_counter` slot.
 *
 * UNLIKE `resolveMeetingAgendaAuthz` and `resolveWordOfTheDayAuthz`, this does
 * NOT call `assertMeetingNotLocked`, and that is deliberate. Completing a
 * meeting is what force-closes voting, so a uniform lock check here would (a)
 * make the tally unreadable on exactly the meetings whose tally matters, and
 * (b) block the Ballot Counter from confirming a winner afterwards — which
 * `setAward` explicitly permits, because minutes are written up after the
 * meeting. Callers that MUTATE the vote window call `assertMeetingNotLocked`
 * on the returned `meetingStatus` themselves.
 */
export async function resolveVoteCounterAuthz(
	input: MeetingAgendaAuthzInput,
): Promise<VoteCounterAuthz> {
	const meeting = await db.query.meetings.findFirst({
		where: eq(meetings.id, input.meetingId),
	});
	if (!meeting) throw new Error("Meeting not found.");
	const clubId = meeting.clubId;
	// Same archive gate as the two resolvers above. This one deliberately has NO
	// lock check (a Ballot Counter's capabilities span the live meeting), which is
	// why the archive gate cannot be folded into `assertMeetingNotLocked`.
	await assertMeetingClubNotArchived(clubId);
	const { voteCounterMemberId } = await loadRoleSlotAssignees(input.meetingId);

	const admin = await resolveAdminGrant(input.sessionUserId, clubId);
	if (admin.granted) {
		return {
			clubId,
			allowed: true,
			via: "admin",
			voteCounterMemberId,
			actorMemberId: admin.memberId,
			meetingStatus: meeting.status,
		};
	}

	if (
		input.selfMemberId &&
		voteCounterMemberId &&
		input.selfMemberId === voteCounterMemberId
	) {
		return {
			clubId,
			allowed: true,
			via: "vote-counter-self-assert",
			voteCounterMemberId,
			// Verified against the slot above, so it is safe to credit.
			actorMemberId: voteCounterMemberId,
			meetingStatus: meeting.status,
		};
	}

	return {
		clubId,
		allowed: false,
		via: null,
		voteCounterMemberId,
		actorMemberId: null,
		meetingStatus: meeting.status,
	};
}
