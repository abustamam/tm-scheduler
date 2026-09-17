/**
 * Who a bearer token is, and what it may act on (#773, design D3).
 *
 * TWO entry points, and every tool calls exactly one:
 *
 *   - `authenticateToken(raw)` — resolves the token to a user and the clubs
 *     where they hold an active admin membership or an open officer term. Only
 *     `whoami` uses it, because `whoami` is what TELLS the caller which clubs
 *     exist and so has no `clubId` to check against.
 *   - `authorizeToken(raw, clubId)` — authenticate, then prove an active
 *     admin-or-officer membership in THAT club, then prove the club is not
 *     archived.
 *
 * Splitting them is what makes "no unauthenticated tool" machine-checkable
 * without an exemption list: the guard derives the tool set from the directory
 * and fails any tool calling neither, with `whoami` waived by name and reason.
 *
 * ## What this module must never import, and why
 *
 * `getSessionUser`, `requireUser`, `requireClubRole`, `requireMembership`,
 * `requestWriteActor`. A guard test enforces it across the whole `src/server/mcp/`
 * tree and the route.
 *
 * `requireClubRole` is the dangerous one, and the reason is not obvious from its
 * name. It falls through `requireMembership` to `requireReadWriteImpersonation`
 * (`guards.ts:257-285`), which reads impersonation sessions from the database —
 * so a superadmin with a browser "act as admin" session open on some club would
 * silently pass that authority to every token call on the same club. An
 * impersonation grant is a thing a human did in a browser under ADR-0020's
 * audit trail; a token is not that human's browser. This module therefore
 * resolves a REAL membership only, and a superadmin with no membership in a club
 * gets `FORBIDDEN` there however their browser session is set up.
 *
 * `getSessionUser` and the rest are excluded for the CSRF posture: bearer-only
 * means a cross-site POST carries no ambient credential, and that property holds
 * only while nothing on this path reads a cookie. It is tested behaviourally as
 * well as by import grep, because the grep is blind to a cookie reaching here
 * through a helper or a re-export, and it is the one claim in the design where
 * being wrong is a security hole rather than a bug.
 *
 * ## The club is derived from the meeting
 *
 * When a tool names a meeting (`meetingId`, `meetingDate`), the club comes from
 * the meeting row on the server — never from a `clubId` in the same input. A
 * caller who could pair their own club id with another club's meeting would
 * authorize against the first and act on the second.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import {
	clubMeetingRecurrence,
	clubs,
	meetings,
	members,
	officerTerms,
	people,
	user,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import {
	resolveActiveApiToken,
	touchApiToken,
} from "#/server/api-tokens-logic";
import { McpError } from "./errors";

/** A club the token owner may act on, as `whoami` reports it. */
export interface TokenClub {
	clubId: string;
	name: string;
	timezone: string;
	/** This membership's id — the `actor_member_id` every write is credited to. */
	membershipId: string;
	/** Why they are an admin here: a stored role, an elected office, or both. */
	via: "admin" | "officer";
	/** The standing recurrence rule's weekday (0 = Sunday) and time, if any. */
	recurrence: { weekday: number; timeOfDay: string } | null;
	/** Soft-archived (ADR-0016). Kept off `clubs`; see `AuthenticatedToken`. */
	archived: boolean;
}

export interface AuthenticatedToken {
	tokenId: string;
	user: { id: string; name: string; email: string };
	/**
	 * Clubs the owner may act on: active admin or open officer term, NOT
	 * archived. This is what `whoami` reports — a taken-down club must not even
	 * be named by a tool result.
	 */
	clubs: TokenClub[];
	/**
	 * The same set INCLUDING archived clubs, for `authorizeToken` alone.
	 *
	 * It exists so a real admin of an archived club gets `ARCHIVED` rather than
	 * `FORBIDDEN` — the same answer `requireMembership` gives them in the
	 * browser. Without it, filtering archived clubs out of `clubs` would silently
	 * turn a takedown into "you are not an admin", which is both a worse
	 * explanation and a different claim.
	 */
	membershipsIncludingArchived: TokenClub[];
}

/**
 * Thrown when the bearer token is missing, unknown or revoked. The ROUTE maps
 * this to HTTP 401 before any tool runs — it is not an `McpError`, because it is
 * not a tool result.
 */
export class McpUnauthorizedError extends Error {
	constructor(message = "Invalid or revoked token.") {
		super(message);
		this.name = "McpUnauthorizedError";
	}
}

/**
 * Resolve a raw bearer token to its owner and the clubs they may act on.
 *
 * The club list is computed from LIVE membership rows on every call, never
 * stored on the token: ending someone's officer term or deactivating their
 * membership narrows every token they hold immediately, with no token state to
 * update and no window where a stale grant is honoured.
 *
 * Archived clubs are filtered out here as well as asserted in `authorizeToken`.
 * Archiving is the takedown lever (ADR-0016), so a taken-down club must not even
 * be NAMED by a tool result.
 */
export async function authenticateToken(
	rawToken: string | null,
): Promise<AuthenticatedToken> {
	if (!rawToken) throw new McpUnauthorizedError("Missing bearer token.");
	const tok = await resolveActiveApiToken(rawToken);
	if (!tok) throw new McpUnauthorizedError();

	const [owner] = await db
		.select({ id: user.id, name: user.name, email: user.email })
		.from(user)
		.where(eq(user.id, tok.userId))
		.limit(1);
	// The FK cascades on user delete, so this is unreachable through the product;
	// fail closed rather than inventing an identity for the token.
	if (!owner) throw new McpUnauthorizedError();

	const all = await adminClubsForUser(tok.userId);

	// Telemetry for the `/me` token list. Outside any apply transaction (D10),
	// and never allowed to fail the call it accompanied — a missing timestamp is
	// a cosmetic loss, a failed tool call is not.
	await touchApiToken(tok.id).catch((err) => {
		console.error("[mcp] failed to stamp token last_used_at:", err);
	});

	return {
		tokenId: tok.id,
		user: { id: owner.id, name: owner.name, email: owner.email },
		clubs: all.filter((c) => !c.archived),
		membershipsIncludingArchived: all,
	};
}

/**
 * Every club where a USER holds an active admin membership or an open officer
 * term — effective-admin (#202), the same grant `requireClubRole` gives in the
 * browser, minus the impersonation fallback.
 *
 * Exported because two callers need exactly this set and must not disagree
 * about it: `authenticateToken` above, and the `/me` token UI, which offers to
 * mint a token only to someone whose token could authorize something. A second
 * copy of this query is how the two would drift into offering a credential that
 * can do nothing, or hiding one that could.
 *
 * Archived clubs are INCLUDED here and filtered by the caller — see
 * `AuthenticatedToken.membershipsIncludingArchived` for why that distinction is
 * load-bearing.
 */
export async function adminClubsForUser(userId: string): Promise<TokenClub[]> {
	const rows = await db
		.select({
			clubId: clubs.id,
			name: clubs.name,
			timezone: clubs.timezone,
			archivedAt: clubs.archivedAt,
			membershipId: members.id,
			clubRole: members.clubRole,
			officerTermId: officerTerms.id,
			recurrenceWeekday: clubMeetingRecurrence.weekday,
			recurrenceTimeOfDay: clubMeetingRecurrence.timeOfDay,
			recurrenceEnabled: clubMeetingRecurrence.enabled,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.innerJoin(clubs, eq(clubs.id, members.clubId))
		.leftJoin(
			officerTerms,
			and(
				eq(officerTerms.membershipId, members.id),
				isNull(officerTerms.termEnd),
			),
		)
		.leftJoin(clubMeetingRecurrence, eq(clubMeetingRecurrence.clubId, clubs.id))
		.where(and(eq(people.userId, userId), eq(members.status, "active")));

	// One row per (membership × open officer term), so collapse by club and keep
	// the strongest reason. A stored admin who also holds an office is reported
	// as `admin` — the stronger claim, and the one that survives their term
	// ending.
	const byClub = new Map<string, TokenClub>();
	for (const r of rows) {
		const isAdmin = r.clubRole === "admin";
		if (!isAdmin && r.officerTermId === null) continue;
		const existing = byClub.get(r.clubId);
		if (existing && (existing.via === "admin" || !isAdmin)) continue;
		byClub.set(r.clubId, {
			clubId: r.clubId,
			name: r.name,
			timezone: r.timezone,
			membershipId: r.membershipId,
			via: isAdmin ? "admin" : "officer",
			archived: isClubArchived({ archivedAt: r.archivedAt }),
			recurrence:
				r.recurrenceEnabled &&
				r.recurrenceWeekday !== null &&
				r.recurrenceTimeOfDay !== null
					? {
							weekday: r.recurrenceWeekday,
							timeOfDay: r.recurrenceTimeOfDay,
						}
					: null,
		});
	}
	return [...byClub.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface AuthorizedClub extends AuthenticatedToken {
	/** The club this call is authorized for. */
	club: TokenClub;
}

/**
 * Authenticate, then prove the owner may act on `clubId`.
 *
 * Throws `FORBIDDEN` — never `NOT_FOUND` — for a club the owner is not an
 * admin of, whether or not it exists. Distinguishing the two would let a token
 * enumerate the platform's clubs.
 */
export async function authorizeToken(
	rawToken: string | null,
	clubId: string,
): Promise<AuthorizedClub> {
	const auth = await authenticateToken(rawToken);
	const club = auth.membershipsIncludingArchived.find(
		(c) => c.clubId === clubId,
	);
	if (!club) {
		throw new McpError(
			"FORBIDDEN",
			"You are not an admin or officer of that club.",
		);
	}
	// After the membership resolves, matching `requireMembership`: a non-member
	// keeps the "not an admin" answer above and never learns the club exists,
	// while a real admin is told the club has been archived.
	if (club.archived) {
		throw new McpError("ARCHIVED", CLUB_ARCHIVED_MESSAGE);
	}
	return { ...auth, club };
}

/**
 * The club a meeting belongs to, read from the meeting row.
 *
 * The ONE way a meeting-scoped tool gets its club. Returns `NOT_FOUND` for an
 * unknown meeting; the caller then authorizes against what this returned, so an
 * unknown-to-them meeting becomes `FORBIDDEN` a moment later.
 */
export async function clubIdForMeeting(meetingId: string): Promise<string> {
	const [row] = await db
		.select({ clubId: meetings.clubId })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new McpError("NOT_FOUND", "Meeting not found.");
	return row.clubId;
}

/**
 * Authorize a call that names a MEETING rather than a club.
 *
 * Derives the club from the meeting first, so a `clubId` in the same input can
 * never decide what the call is checked against.
 */
export async function authorizeTokenForMeeting(
	rawToken: string | null,
	meetingId: string,
): Promise<AuthorizedClub> {
	return authorizeToken(rawToken, await clubIdForMeeting(meetingId));
}
