// Lineup blast (#1024), the DB half: load what a draft is built from, and
// decide who may draft one. Split from the `createServerFn` wrappers in
// `lineup-blast.ts` because a server-fn module may export only server fns and
// types, and because a handler body is unreachable from a test.
//
// Read-only. Nothing here writes, and nothing here sends: the app drafts, a
// human sends (`#/lib/nudge`).
//
// No contact details and no video-call link are read. A slot carries a role, a
// status and a holder's NAME, which is exactly what the public meeting page
// already shows anyone holding its link.

import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings, members, people } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	LINEUP_BLAST_REFUSED_MESSAGE,
	type LineupBlastData,
	type LineupSlotStatus,
	mayDraftLineupBlast,
} from "#/lib/lineup-blast";
import { isReadableClub } from "./club-readable-logic";
import { getActiveImpersonation } from "./impersonation-logic";
import {
	loadTmodMemberId,
	resolveSelfAssertGrant,
} from "./meeting-authz-logic";
import { loadMeetingSlots } from "./meeting-slots-logic";
import { resolveMeetingUrlKey } from "./meeting-url-key-logic";
import { getOpenOfficerPositions } from "./officers-logic";

/** The club a meeting belongs to. Throws for an unknown meeting. */
async function meetingClubId(meetingId: string): Promise<string> {
	const [row] = await db
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	return row.clubId;
}

/**
 * The archive gate (ADR-0016): an archived club drafts nothing, for every arm.
 * `isReadableClub` answers false for an unknown club too.
 */
export async function assertLineupClubReadable(clubId: string): Promise<void> {
	if (!(await isReadableClub(clubId))) throw new Error(CLUB_ARCHIVED_MESSAGE);
}

export interface LineupBlastAccessInput {
	meetingId: string;
	/** Signed-in user id, or null for a caller with no session. */
	sessionUserId: string | null;
	/** Self-asserted roster member id (the Toastmaster arm), or null. */
	selfMemberId: string | null;
}

export interface LineupBlastAccess {
	clubId: string;
	allowed: boolean;
	via: "admin" | "officer" | "toastmaster" | null;
}

/**
 * Every membership this human holds in this club, whatever its role or status.
 *
 * The WHOLE set rather than one pick, for two reasons. The Toastmaster arm binds
 * a self-asserted id against it (#747: "is this id one of MINE" is a set
 * question). And the admin and officer arms ask whether ANY active membership
 * grants, which is deterministic without the shared pick order and cannot flip
 * between requests the way a single unordered pick could (#804).
 *
 * Not `getMembership`: that lives in `guards.ts`, which also holds the cookie
 * readers, and this module is imported by the MCP tool, whose tree must reach
 * none of them.
 */
async function membershipsInClub(userId: string, clubId: string) {
	return db
		.select({
			id: members.id,
			clubRole: members.clubRole,
			status: members.status,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(and(eq(people.userId, userId), eq(members.clubId, clubId)));
}

/**
 * May this caller draft this meeting's lineup? Decided by `mayDraftLineupBlast`
 * — the one statement of the rule — from three facts gathered here:
 *
 *  - admin: an ACTIVE membership whose stored role is `admin`, or a
 *    superadmin with an active impersonation session of this club and no
 *    membership of their own (the same read grant `requireClubAdminView` gives);
 *  - officer: an ACTIVE membership holding an open officer term;
 *  - Toastmaster: the caller holds this meeting's Toastmaster slot, through the
 *    shared `resolveSelfAssertGrant` (#747) — so an anonymous Toastmaster on
 *    their phone passes the way they do for the agenda, and a signed-in member
 *    asserting somebody ELSE's id does not.
 *
 * Throws for an unknown meeting and for an archived club, BEFORE any grant
 * arm, so a takedown answers the same for everyone.
 */
export async function resolveLineupBlastAccess(
	input: LineupBlastAccessInput,
): Promise<LineupBlastAccess> {
	const clubId = await meetingClubId(input.meetingId);
	await assertLineupClubReadable(clubId);

	let isAdmin = false;
	let isOfficer = false;
	let membershipIds: string[] = [];
	if (input.sessionUserId) {
		const mine = await membershipsInClub(input.sessionUserId, clubId);
		membershipIds = mine.map((m) => m.id);
		const active = mine.filter((m) => m.status === "active");
		isAdmin = active.some((m) => m.clubRole === "admin");
		for (const m of active) {
			if (isOfficer) break;
			isOfficer = (await getOpenOfficerPositions(db, m.id)).length > 0;
		}
		// A superadmin with no active membership here, viewing through an
		// impersonation session: the read grant `requireClubAdminView` gives.
		if (
			active.length === 0 &&
			(await getActiveImpersonation(input.sessionUserId, clubId))
		) {
			isAdmin = true;
		}
	}

	const holdsToastmasterSlot = resolveSelfAssertGrant({
		selfMemberId: input.selfMemberId,
		slotMemberId: await loadTmodMemberId(input.meetingId),
		session: input.sessionUserId
			? { present: true, membershipIds }
			: { present: false },
	}).granted;

	const allowed = mayDraftLineupBlast({
		isAdmin,
		isOfficer,
		holdsToastmasterSlot,
	});
	return {
		clubId,
		allowed,
		via: !allowed
			? null
			: isAdmin
				? "admin"
				: isOfficer
					? "officer"
					: "toastmaster",
	};
}

/** `resolveLineupBlastAccess`, throwing when the caller may not draft. */
export async function requireLineupBlastAccess(
	input: LineupBlastAccessInput,
): Promise<LineupBlastAccess> {
	const access = await resolveLineupBlastAccess(input);
	if (!access.allowed) throw new Error(LINEUP_BLAST_REFUSED_MESSAGE);
	return access;
}

/**
 * What the draft is built from, for one meeting. Reads slots through
 * `loadMeetingSlots`, the ONE slot loader the meeting page, the print route
 * and `get_agenda` already share, so the draft lists exactly the slots, in
 * exactly the order, the agenda shows.
 *
 * Ungated: every caller gates first (`requireLineupBlastAccess`, or the MCP
 * tool's `authorizeTokenForMeeting`). It re-checks the archive anyway, because
 * that is the one refusal that must hold whichever gate ran.
 */
export async function loadLineupBlastData(
	meetingId: string,
): Promise<LineupBlastData> {
	const [row] = await db
		.select({
			meetingId: meetings.id,
			clubId: meetings.clubId,
			scheduledAt: meetings.scheduledAt,
			clubName: clubs.name,
			slug: clubs.slug,
			timezone: clubs.timezone,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	await assertLineupClubReadable(row.clubId);

	const [urlKey, slots] = await Promise.all([
		resolveMeetingUrlKey(row.clubId, row.scheduledAt, row.timezone),
		loadMeetingSlots(meetingId),
	]);

	return {
		club: { name: row.clubName, slug: row.slug, timezone: row.timezone },
		meeting: { id: row.meetingId, urlKey, scheduledAt: row.scheduledAt },
		slots: slots.map((s) => ({
			roleName: s.roleName,
			slotIndex: s.slotIndex,
			slotsUnordered: s.slotsUnordered,
			status: s.status as LineupSlotStatus,
			assigneeName: s.assigneeName,
		})),
	};
}
