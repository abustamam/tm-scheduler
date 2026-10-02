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
//
// ## Why every seam here is `Public`
//
// The server fns are reachable with NO session (an anonymous Toastmaster
// drafts from the roster pick, ADR-0010), so these are public readers in the
// `CODING_STANDARDS.md` sense: an archived club and an unknown meeting get the
// SAME answer (refused / null), so a caller cannot tell a taken-down club from
// one that never existed. `public-readers-archive-gate.guard.test.ts` pins the
// server fns to these names.

import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { clubs, meetings, members, people } from "#/db/schema";
import {
	LINEUP_BLAST_REFUSED_MESSAGE,
	type LineupBlastData,
	mayDraftLineupBlast,
} from "#/lib/lineup-blast";
import {
	isMeetingCancelled,
	MEETING_CANCELLED_MESSAGE,
} from "#/lib/meeting-cancellation-notice";
import { appBaseUrl } from "#/lib/unsubscribe-token";
import { isReadableClubForMeeting } from "./club-readable-logic";
import { getActiveImpersonation } from "./impersonation-logic";
import { McpError } from "./mcp/errors";
import {
	loadTmodMemberId,
	resolveSelfAssertGrant,
} from "./meeting-authz-logic";
import { loadMeetingSlots } from "./meeting-slots-logic";
import { resolveMeetingUrlKey } from "./meeting-url-key-logic";
import { getOpenOfficerPositions } from "./officers-logic";

export interface LineupBlastAccessInput {
	meetingId: string;
	/** Signed-in user id, or null for a caller with no session. */
	sessionUserId: string | null;
	/** Self-asserted roster member id (the Toastmaster arm), or null. */
	selfMemberId: string | null;
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
 *    active membership of their own (the read grant `requireClubAdminView`
 *    gives);
 *  - officer: an ACTIVE membership holding an open officer term;
 *  - Toastmaster: the caller holds this meeting's Toastmaster slot, through the
 *    shared `resolveSelfAssertGrant` (#747) — so an anonymous Toastmaster on
 *    their phone passes the way they do for the agenda, and a signed-in member
 *    asserting somebody ELSE's id does not.
 *
 * An unknown meeting and an archived club both answer `{ allowed: false }`
 * BEFORE any grant arm, the same answer as a refusal, so no caller learns
 * which of the three it was.
 */
export async function resolvePublicLineupBlastAccess(
	input: LineupBlastAccessInput,
): Promise<{ allowed: boolean }> {
	const refused = { allowed: false };
	// False for an unknown meeting AND an archived club: one answer for both.
	if (!(await isReadableClubForMeeting(input.meetingId))) return refused;
	const [meeting] = await db
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, input.meetingId))
		.limit(1);
	if (!meeting) return refused;
	const clubId = meeting.clubId;

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

	return {
		allowed: mayDraftLineupBlast({ isAdmin, isOfficer, holdsToastmasterSlot }),
	};
}

/**
 * `resolvePublicLineupBlastAccess`, throwing the one generic refusal when the
 * caller may not draft — whether they are unentitled, the meeting is unknown,
 * or the club is archived.
 */
export async function requirePublicLineupBlastAccess(
	input: LineupBlastAccessInput,
): Promise<void> {
	const { allowed } = await resolvePublicLineupBlastAccess(input);
	if (!allowed) throw new Error(LINEUP_BLAST_REFUSED_MESSAGE);
}

/**
 * What the draft is built from, for one meeting, or null for an unknown
 * meeting or an archived club (one not-found shape for both).
 *
 * Reads slots through `loadMeetingSlots`, the ONE slot loader the meeting page,
 * the print route and `get_agenda` already share, so the draft lists exactly
 * the slots, in exactly the order, the agenda shows. The footer's origin is
 * `appBaseUrl()`, chosen here so the button and `get_lineup_blast` link the same
 * page.
 *
 * Not an authorization check: every caller gates first
 * (`requirePublicLineupBlastAccess`, or the MCP tool's
 * `authorizeTokenForMeeting`). It re-checks the archive because that refusal
 * must hold whichever gate ran.
 */
export async function loadPublicLineupBlastData(
	meetingId: string,
): Promise<LineupBlastData | null> {
	if (!(await isReadableClubForMeeting(meetingId))) return null;
	const [row] = await db
		.select({
			meetingId: meetings.id,
			clubId: meetings.clubId,
			scheduledAt: meetings.scheduledAt,
			status: meetings.status,
			clubName: clubs.name,
			slug: clubs.slug,
			timezone: clubs.timezone,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) return null;
	// A cancelled meeting has no lineup to blast (#1057), and the refusal is the
	// member-facing sentence rather than `null`: `null` means "unknown or taken
	// down" to both callers, and the officer who is told the generic refusal
	// would go looking for a permission problem that is not there.
	//
	// An `McpError`, not a bare `Error`, because `get_lineup_blast` calls this
	// directly and `toMcpError` replaces any other throw with INTERNAL — the
	// caller would learn that it failed and nothing about why. The code is the
	// nearest the vocabulary has: the meeting no longer accepts the request.
	// The browser's `getLineupBlast` rethrows it and the sheet reads `.message`.
	if (isMeetingCancelled(row.status)) {
		throw new McpError("LOCKED", MEETING_CANCELLED_MESSAGE);
	}

	const [urlKey, slots] = await Promise.all([
		resolveMeetingUrlKey(row.clubId, row.scheduledAt, row.timezone),
		loadMeetingSlots(meetingId),
	]);

	return {
		origin: appBaseUrl(),
		club: { name: row.clubName, slug: row.slug, timezone: row.timezone },
		meeting: { id: row.meetingId, urlKey, scheduledAt: row.scheduledAt },
		slots: slots.map((s) => ({
			roleName: s.roleName,
			slotIndex: s.slotIndex,
			slotsUnordered: s.slotsUnordered,
			status: s.status,
			assigneeName: s.assigneeName,
		})),
	};
}
