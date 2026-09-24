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
	officerTerms,
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
import {
	membershipPickOpenTermJoin,
	membershipPickOrder,
} from "./membership-pick-order";

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
 * Returns three things:
 *
 *  - `granted`, the admin decision;
 *  - `memberId`, the membership id to credit the write to (#396) — null for the
 *    memberless impersonation arm, where `logActivity` records the real
 *    superadmin in `impersonated_by` instead;
 *  - `membershipIds`, **every membership this human holds in this club**,
 *    whatever its role or status, empty when they have no session or are not on
 *    this roster.
 *
 * ## Why a SET, and why that is not the same question the ORDER answers
 *
 * The five-key order below exists to make ONE row the answer, deterministically,
 * because the admin grant and `actorMemberId` must not flip between requests
 * (#804). #747 needs a different question off the same rows — *is this asserted
 * id one of MINE* — and the answer to that is the whole set. `people.user_id`
 * carries only a non-unique index, so one human reachable through two Person
 * rows in one club is representable (the comment under the query says so), and
 * binding against the top-ranked row alone would refuse a signed-in member who
 * genuinely holds the slot on their OTHER membership. That refusal would land
 * only on the signed-in path, which is exactly the incoherence
 * `resolveSelfAssertGrant` rejects for the lapsed member below.
 *
 * So `picked` decides the admin arm and `membershipIds` binds the identity, from
 * ONE read. Two reads would be two MVCC snapshots, and the admin arm could then
 * grant off a row the self-assert arm never saw.
 *
 * ## Two things about the spelling, both load-bearing
 *
 * **The rest-destructure replaces `.limit(1)`, and keeps the order doing its
 * job.** `picked` is byte-for-byte the row `.limit(1)` returned — the first of
 * the same ordered result — so the admin decision and the credited id are
 * unchanged. Nothing else about the query moved.
 *
 * **The statement stays HERE, destructured, rather than being lifted into its
 * own loader or rewritten as a plain array assignment.**
 * `membership-pick-ordering.guard.test.ts` sweeps for statements that resolve
 * `people.user_id` to a `members` row and keep a single one — by `.limit(1)` OR
 * by a `const [` destructure — and requires each to carry an `ORDER BY`. It
 * anchors its vacuity floor on the key `meeting-authz-logic.ts:resolveAdminGrant`.
 * Moving the statement out renames that key; spelling it `const rows = await db…`
 * drops it from the sweep. Either one leaves that guard asserting nothing, so
 * change this shape only together with that file.
 */
async function resolveAdminGrant(
	sessionUserId: string | null | undefined,
	clubId: string,
): Promise<{
	granted: boolean;
	memberId: string | null;
	membershipIds: readonly string[];
}> {
	if (!sessionUserId) {
		return { granted: false, memberId: null, membershipIds: [] };
	}
	const [picked, ...alsoMine] = await db
		.select({
			id: members.id,
			clubRole: members.clubRole,
			status: members.status,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		// Open terms only; `officer_terms_open_idx` covers (membership_id, term_end).
		// Joined for the ORDER BY alone (key 3) — the count is never selected, and
		// no arm below grants on an officer term.
		.leftJoin(officerTerms, membershipPickOpenTermJoin())
		.where(and(eq(people.userId, sessionUserId), eq(members.clubId, clubId)))
		// `members.id` is the primary key, so every selected column OF `members` is
		// functionally dependent on it and needs no explicit grouping. Nothing here
		// crosses a join into another table's columns, so this one key is enough.
		.groupBy(members.id)
		// The shared five-key total order (`membership-pick-order.ts`, #838) that
		// `getMembership` and the two Pathways picks also use, so this grant and
		// the guard path cannot name different memberships. This used to be a bare
		// `.limit(1)` (#804): `people.user_id` has only a plain non-unique index
		// (`people_user_idx`), so one human reachable through two Person rows in
		// one club is representable, and Postgres was free to return either. The
		// admin arm below could grant on one request and fall through to
		// `tmod-self-assert` on the next with no change in data between them — and
		// on a request it DID grant, the `memberId` it returns is the
		// `actorMemberId` `logActivity` stamps (#396), so the audit trail could
		// name the other duplicate.
		//
		// The ORDER is shared, not the query: this does not call `getMembership`,
		// which additionally joins `clubs` and returns `archivedAt`/`clubId`/
		// `personId`, changing both the cost and the shape on this hot path.
		// `meeting-authz-membership-pick.integration.test.ts` asserts the two
		// resolvers agree on the SAME fixture.
		//
		// Two things that are true THERE and not here, so nobody reasons from the
		// wrong half:
		//
		// · Keys 1 and 2 are not what refuses a lapsed admin in THIS function — the
		//   `status === "active"` check below is, and the grant decision is
		//   invariant to swapping them. In `getMembership` the polarity genuinely
		//   is load-bearing, because `canManageClub` reads `clubRole` with no
		//   status check at all. Do not read the ordering as making the check below
		//   redundant: delete it and an inactive admin duplicate grants.
		// · "Two queries cannot disagree" means on ONE snapshot. Two statements
		//   read different MVCC snapshots, so this orders the rows a statement
		//   sees, not the rows two statements see. `getMembership` takes
		//   `conn: DbOrTx = db` so a caller inside a lock can pin the snapshot
		//   (`assertStillClubAdmin`, #806); this has no such parameter and cannot
		//   join a locked re-check. No live consequence today — all three
		//   resolvers here are called from route guards only — but that is a fact
		//   about the callers, not a guarantee of this function.
		.orderBy(...membershipPickOrder());
	// `picked` answers the admin arm; the whole set binds the identity. `picked`
	// is listed first because `alsoMine` is the REST of the same ordered result —
	// dropping it here would silently re-narrow the binding to one row.
	const membershipIds = picked ? [picked.id, ...alsoMine.map((m) => m.id)] : [];
	if (picked && picked.status === "active" && picked.clubRole === "admin") {
		return { granted: true, memberId: picked.id, membershipIds };
	}
	const session = await getActiveImpersonation(sessionUserId, clubId);
	if (session?.mode === "read_write") {
		markImpersonatedWrite(sessionUserId);
		return { granted: true, memberId: null, membershipIds };
	}
	return { granted: false, memberId: null, membershipIds };
}

/**
 * What the caller's session is, for `resolveSelfAssertGrant`.
 *
 * A discriminated union rather than a flag beside a nullable set, so "no session
 * but here are my memberships" and "signed in, and the set was forgotten" are
 * both unrepresentable. Those two are not cosmetic: the first would read as
 * anonymous and grant, and the second would refuse every signed-in caller
 * including the honest slot holder. The distinction that matters is present vs
 * absent, NOT empty vs non-empty — a session with an empty set is an outsider
 * holding an account, and it must refuse rather than fall back to the anonymous
 * arm.
 */
export type SelfAssertSession =
	/** No session at all: the honour-system caller ADR-0010 is built for. */
	| { present: false }
	/** Signed in. `membershipIds` is EVERY membership this human holds in this
	 *  club — empty when they are on no roster here. */
	| { present: true; membershipIds: readonly string[] };

/**
 * Build a {@link SelfAssertSession} from what a resolver already has.
 *
 * The ONE place `sessionUserId` becomes the `present` discriminant, so the three
 * resolvers cannot disagree about what "has a session" means — and so an
 * impersonating superadmin, whose `membershipIds` is empty, still reads as
 * present and is refused rather than falling through to the anonymous arm.
 */
function sessionOf(
	sessionUserId: string | null | undefined,
	membershipIds: readonly string[],
): SelfAssertSession {
	return sessionUserId ? { present: true, membershipIds } : { present: false };
}

/**
 * **A self-assert never overrides a session** (#747, ADR-0026).
 *
 * THE one place in this module that compares a self-asserted member id against a
 * role slot. Four arms route through it — agenda meta (TMOD), Word of the Day
 * (TMOD), Word of the Day (Grammarian), and the Ballot Counter gate — and
 * `self-assert-binding.guard.test.ts` fails if a fifth is written inline instead.
 * That guard is the durable half: the bug was never one arm, it was one SHAPE
 * copied four times, and four in-place fixes would leave the shape intact.
 *
 * The rules, in order:
 *
 *  - no `selfMemberId`, no `slotMemberId`, or they differ → refuse. Unchanged:
 *    the slot is still what authorizes, and an unassigned slot still grants
 *    nobody (ADR-0010).
 *  - **no session → grant.** The Toastmaster running the agenda from their phone
 *    with no account is the workflow this model exists for, and it keeps working
 *    byte for byte. Nothing about the anonymous path changes here.
 *  - **a session one of whose memberships in this club IS the asserted id →
 *    grant.** The client already sends exactly this (`useEffectiveMember` lets
 *    the session win over the localStorage name-pick), so an honest signed-in
 *    role holder pays nothing.
 *  - **a session that is anything else → refuse.** That includes a signed-in
 *    member asserting somebody ELSE's id, which is the bug, and it includes a
 *    session with NO membership in this club at all — an outsider holding an
 *    account, and a read-only impersonating superadmin with them. (A `read_write`
 *    impersonator never reaches here; the admin arm returns first.)
 *
 * Three things this deliberately does NOT do.
 *
 * **It does not bind against ONE membership.** `membershipIds` is the whole set
 * the caller holds in this club, because the question here is "is this id one of
 * mine", not "is it my top-ranked row". A human reachable through two Person rows
 * in one club is representable (`resolveAdminGrant`'s query comment), so binding
 * against the ordered pick alone would refuse a signed-in member who genuinely
 * holds the slot on their other membership — and refuse them ONLY when signed in,
 * which is the same incoherence the lapsed-member note below rejects.
 *
 * **It does not require the membership to be ACTIVE.** Every other session gate
 * in the repo does (`resolveSessionActor`, `resolveAdminGrant`), and they are
 * asking a different question: those grant a capability BECAUSE of the
 * membership, so a lapsed one must not. Here the slot grants the capability and
 * the membership only answers "is that id yours". Refusing a lapsed member who
 * holds the slot would leave them strictly worse off signed in than signed out,
 * since the anonymous arm above grants them — an incoherence, not a tightening.
 *
 * **It does not go through `resolveWriteActorWithProof`** (`write-actor-logic.ts`),
 * which also distinguishes a session-derived member id from an asserted one. That
 * seam answers who a write is CREDITED to, and its own module draws the line:
 * "the difference between attribution and authorization". Three concrete reasons
 * it is the wrong route here, kept where the next reader will look for them:
 * its asserted arm GRANTS any active member of the club, which is precisely what
 * must not authorize here; it THROWS (`requireMemberInClub`) where these
 * resolvers return `allowed: false`, and a slot held by a since-deactivated
 * member would start raising out of a resolver whose contract is a decision
 * object; and it re-reads the membership through `getMembership`, adding a second
 * query and a second snapshot to a resolver that already has the row. What IS
 * shared is the vocabulary — "session" vs "asserted" means one thing across the
 * repo (`#/lib/write-proof`), and this is that distinction applied to a grant.
 *
 * Pure, so the truth table is directly testable (`self-assert-grant.test.ts`).
 */
export function resolveSelfAssertGrant(args: {
	/** The member id the caller claims to be, off the wire. */
	selfMemberId: string | null | undefined;
	/** This meeting's assignee for the slot the arm keys off, or null. */
	slotMemberId: string | null;
	/** What the caller's session is, if any. */
	session: SelfAssertSession;
}): { granted: boolean; actorMemberId: string | null } {
	const refused = { granted: false, actorMemberId: null } as const;
	if (
		!args.selfMemberId ||
		!args.slotMemberId ||
		args.selfMemberId !== args.slotMemberId
	) {
		return refused;
	}
	// ONE name from here down, and that is deliberate. Past the equality above the
	// claim and the slot are the same VALUE, so any later mention of
	// `args.selfMemberId` would be interchangeable with this one — an edit that
	// swapped them would be undetectable by any test, while quietly moving both
	// the binding and the credited id onto the payload. `verified` is the value
	// read from the row the SERVER loaded, which is the source #396 requires for
	// `actorMemberId`, and there is no second name in scope to confuse it with.
	// `self-assert-binding.guard.test.ts` pins that in the source, which is the
	// only place it is visible.
	const verified = args.slotMemberId;
	const granted = { granted: true, actorMemberId: verified } as const;
	if (!args.session.present) return granted;
	return args.session.membershipIds.includes(verified) ? granted : refused;
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
	// Early refusal for both grant arms. Slot writers recheck status inside their
	// meeting-row lock; this preflight alone cannot protect a later write from
	// concurrent completion. Reopen is a separate admin path.
	assertMeetingNotLocked(meeting.status);
	const { tmodMemberId } = await loadRoleSlotAssignees(input.meetingId);

	// Admin path (session admin or read_write impersonation, #246). Also hands
	// back the caller's own membership in this club, which the self-assert arm
	// below binds against without a second read (#747).
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

	// TMOD self-assert path: caller holds this meeting's TMOD slot, and — when
	// they have a session — that slot is their own membership (#747).
	const tmod = resolveSelfAssertGrant({
		selfMemberId: input.selfMemberId,
		slotMemberId: tmodMemberId,
		session: sessionOf(input.sessionUserId, admin.membershipIds),
	});
	if (tmod.granted) {
		return {
			clubId,
			allowed: true,
			via: "tmod-self-assert",
			tmodMemberId,
			actorMemberId: tmod.actorMemberId,
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
	// Both self-assert arms below read the SAME session, so it is built once —
	// two calls to `sessionOf` would be two chances to pass a different one.
	const session = sessionOf(input.sessionUserId, admin.membershipIds);

	const tmod = resolveSelfAssertGrant({
		selfMemberId: input.selfMemberId,
		slotMemberId: tmodMemberId,
		session,
	});
	if (tmod.granted) {
		return {
			clubId,
			allowed: true,
			via: "tmod-self-assert",
			tmodMemberId,
			grammarianMemberId,
			actorMemberId: tmod.actorMemberId,
		};
	}

	const grammarian = resolveSelfAssertGrant({
		selfMemberId: input.selfMemberId,
		slotMemberId: grammarianMemberId,
		session,
	});
	if (grammarian.granted) {
		return {
			clubId,
			allowed: true,
			via: "grammarian-self-assert",
			tmodMemberId,
			grammarianMemberId,
			actorMemberId: grammarian.actorMemberId,
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

	const voteCounter = resolveSelfAssertGrant({
		selfMemberId: input.selfMemberId,
		slotMemberId: voteCounterMemberId,
		session: sessionOf(input.sessionUserId, admin.membershipIds),
	});
	if (voteCounter.granted) {
		return {
			clubId,
			allowed: true,
			via: "vote-counter-self-assert",
			voteCounterMemberId,
			actorMemberId: voteCounter.actorMemberId,
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
