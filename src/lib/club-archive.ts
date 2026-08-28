// Pure, client-safe club soft-archive check (ADR-0016 / #186). Lives in `src/lib`
// (no `#/db` import) so BOTH the server guard (`src/server/guards.ts`) and the
// client-reachable public-loader helper (`src/lib/club-route.ts`) can import it
// without dragging `pg` → `Buffer` into the client bundle.

/**
 * Whether a club is soft-archived (`archived_at` set). The single reusable
 * archive check. A soft-archived club is inaccessible everywhere except the
 * superadmin console ITSELF (`requireSuperadmin`) — NOT through impersonation,
 * which `grantView` rejects like any other actor. An exemption for a read-only
 * session was written into #560 and dropped: see `grantView` in `server/guards.ts`
 * for the two reasons, both of which are what a caveat costs.
 *
 * THE canonical list of enforcement points. Other files point HERE rather than
 * restating it: this claim has now gone stale twice (#544, #560), and each restated
 * copy is another place it can rot independently.
 *
 * Four db-level points, and a route guard is none of them. Labelled by MECHANISM,
 * not by verb — an earlier version of this list said "authed WRITES" for the first
 * one, which is checkably false: GET server fns that gate with `requireClubRole`
 * (e.g. `getScoreboard` in `server/dcp.ts`) reach it too.
 *   - The MEMBERSHIP guards — `requireMembership` / `requireClubRole`
 *     (`server/guards.ts`) via the exported `assertClubNotArchived`. Every mutation,
 *     plus the GET fns that still gate this way.
 *   - The READ gates — `requireClubViewAccess` / `requireClubAdminView`, via
 *     `grantView` in the same file. These do NOT go through `requireMembership`;
 *     believing they did is what left an archived club serving its roster's contact
 *     details to its own members until #560.
 *   - PUBLIC, session-less `createServerFn` readers — `isReadableClub` /
 *     `isReadableClubForMeeting` / `isReadableClubForMember` in
 *     `server/club-readable-logic.ts`.
 *   - The PER-MEETING agenda-write resolvers — `resolveMeetingAgendaAuthz` /
 *     `resolveWordOfTheDayAuthz` / `resolveVoteCounterAuthz`
 *     (`server/meeting-authz-logic.ts`), via that module's private
 *     `assertMeetingClubNotArchived`. They resolve their own grant ladder and reach
 *     NONE of the three above. 14 server fns gate through them, and 11 had no other
 *     archive gate before v1.26.0.0: the agenda edits, the Word of the Day, the
 *     Table Topics and award writes, and the ballot TALLY read. Do NOT restate that
 *     as "the ballots" — `openVote` / `closeVote` were already gated downstream in
 *     `voting-logic.ts`, so the ballot hole was the tally, never the open/close.
 *     Open to a caller with no session at all, since the TMOD arm is honour-system
 *     (ADR-0010). Reads `archived_at` inline rather than calling
 *     `assertClubNotArchived`, because `guards.ts` imports that module and the call
 *     back would close an import cycle; same table, same `CLUB_ARCHIVED_MESSAGE`.
 *     Runs BEFORE the meeting-lock check in the two resolvers that HAVE one —
 *     `resolveVoteCounterAuthz` deliberately has none, which is also why the gate
 *     cannot be folded into `assertMeetingNotLocked`.
 *
 * Authed readers that resolve membership with a bare `getMembership` reach NONE of
 * them and must call a public seam themselves: `minutes.ts`, the minutes-PDF API
 * route and `my-activity-logic.ts` were each doing this until #560.
 *
 * Public no-auth club loaders (landing, present, print, and the #208 guest-book)
 * must treat an archived club as not-found.
 *
 * Router loaders reached through the `/club/$clubId` shell also funnel through
 * `resolveClubOrRedirect`, which calls this. But that guards the CALLER, not the
 * endpoint: a `createServerFn` is addressable directly with no session and no
 * router, so "route it through the shell" is not a gate. Believing otherwise is
 * exactly what left fourteen public readers open until #544 — do not repeat it.
 */
export function isClubArchived(club: { archivedAt: Date | null }): boolean {
	return club.archivedAt != null;
}

/**
 * The rejection every archive check raises. One copy, here rather than in
 * `guards.ts`, for the same reason `isClubArchived` is here: the write gate
 * (#555) added a caller that reads `archived_at` inside its own `FOR UPDATE`
 * lock instead of going through `assertClubNotArchived`, and a second inline
 * string is how two paths start telling a member different things about the
 * same club.
 */
export const CLUB_ARCHIVED_MESSAGE = "This club has been archived.";
