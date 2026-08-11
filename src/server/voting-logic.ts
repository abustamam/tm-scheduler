/**
 * Digital voting DB logic (#510), split out from `voting.ts` (a createServerFn
 * module the guard test forbids from exporting db-touching functions).
 *
 * A vote SESSION is the window for one award category on one meeting. NULL
 * `closed_at` means open. The winner is NOT stored here — the Ballot Counter
 * confirms it into `meeting_awards` via the existing `setAward`.
 *
 * Authorization is the caller's job (`resolveVoteCounterAuthz`), matching how
 * `minutes-logic.ts` trusts its server fn's admin gate.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	guests,
	meetingAttendance,
	meetingBallotGuests,
	meetings,
	meetingVoteSessions,
	meetingVotes,
	members,
	tableTopicsSpeakers,
} from "#/db/schema";
import { cap } from "#/lib/cap";
import { logActivity } from "./activity";
import {
	type AwardCandidate,
	isEligibleCandidate,
	loadAwardCandidates,
} from "./award-candidates-logic";
import { isReadableClubForMeeting } from "./club-readable-logic";
import {
	AWARD_CATEGORIES,
	type AwardCategory,
	getMeetingClubId,
	requireMemberInMeetingClub,
} from "./minutes-logic";

export interface VoteSessionState {
	isOpen: boolean;
	openedAt: Date | null;
	closedAt: Date | null;
}

export type VoteSessionStates = Record<AwardCategory, VoteSessionState>;

/** Every category's window state, whether or not a session row exists. */
export async function listVoteSessions(
	meetingId: string,
): Promise<VoteSessionStates> {
	const rows = await db
		.select()
		.from(meetingVoteSessions)
		.where(eq(meetingVoteSessions.meetingId, meetingId));
	const byCategory = new Map(rows.map((r) => [r.category, r]));
	const out = {} as VoteSessionStates;
	for (const category of AWARD_CATEGORIES) {
		const row = byCategory.get(category);
		out[category] = {
			isOpen: Boolean(row) && row?.closedAt == null,
			openedAt: row?.openedAt ?? null,
			closedAt: row?.closedAt ?? null,
		};
	}
	return out;
}

interface WindowInput {
	meetingId: string;
	clubId: string;
	category: AwardCategory;
	actorMemberId: string | null;
}

/**
 * Open (or re-open) a category's vote. Upserts on the (meeting, category)
 * unique index rather than inserting a second row, so re-opening after a close
 * restores the SAME session and every ballot already cast into it.
 */
export async function openVote(input: WindowInput): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.insert(meetingVoteSessions)
			.values({
				meetingId: input.meetingId,
				category: input.category,
				openedByMemberId: input.actorMemberId,
			})
			.onConflictDoUpdate({
				target: [meetingVoteSessions.meetingId, meetingVoteSessions.category],
				set: {
					closedAt: null,
					openedAt: new Date(),
					openedByMemberId: input.actorMemberId,
					updatedAt: new Date(),
				},
			});
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "vote_open",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { category: input.category },
		});
	});
}

/** Close a category's vote. A no-op when it was never opened or is already
 *  closed — closing is idempotent so a double-tap is harmless. */
export async function closeVote(input: WindowInput): Promise<void> {
	await db.transaction(async (tx) => {
		const closed = await tx
			.update(meetingVoteSessions)
			.set({ closedAt: new Date(), updatedAt: new Date() })
			.where(
				and(
					eq(meetingVoteSessions.meetingId, input.meetingId),
					eq(meetingVoteSessions.category, input.category),
					isNull(meetingVoteSessions.closedAt),
				),
			)
			.returning({ id: meetingVoteSessions.id });
		if (closed.length === 0) return;
		await logActivity(tx, {
			clubId: input.clubId,
			actorMemberId: input.actorMemberId,
			action: "vote_close",
			targetType: "meeting",
			targetId: input.meetingId,
			detail: { category: input.category },
		});
	});
}

/**
 * Force-close every open vote on a meeting, inside a caller-supplied
 * transaction. Called by `applyCompleteMeeting` (#510) so a meeting that has
 * been closed out cannot still be voted on.
 *
 * Takes `tx` rather than opening its own, and does NOT route through
 * `closeVote`: the completion path sets `status = completed`, and `closeVote`'s
 * caller asserts the lock — so calling it here would throw on the very
 * transition that triggers it.
 */
export async function closeAllVotesTx(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	meetingId: string,
): Promise<void> {
	await tx
		.update(meetingVoteSessions)
		.set({ closedAt: sql`now()`, updatedAt: sql`now()` })
		.where(
			and(
				eq(meetingVoteSessions.meetingId, meetingId),
				isNull(meetingVoteSessions.closedAt),
			),
		);
}

export interface VoterRef {
	kind: "member" | "guest";
	id: string;
}

/**
 * Cast (or change) one ballot.
 *
 * Three things the client is NOT trusted for, in order:
 *
 *  1. The CANDIDATE is re-derived server-side from `loadAwardCandidates`, so a
 *     hand-crafted POST cannot vote for someone who never spoke.
 *  2. The VOTER is scoped to the meeting's club, the same way `setAward` scopes
 *     a winner, AND — member voters only — must hold an ACTIVE membership. A
 *     departed member's id must not be able to cast a NEW ballot on this
 *     public, unauthenticated endpoint. This check lives HERE, not in
 *     `requireMemberInMeetingClub` itself: that helper is shared with
 *     `setAward` and `addTableTopicsSpeaker`, where a departed member
 *     legitimately can still be recorded as a past meeting's award winner or
 *     Table Topics speaker — tightening it there would be a regression. A
 *     guest carries a `club_id` and is checked directly — AND, guest voters
 *     only, must have actually joined THIS MEETING's ballot (a
 *     `meeting_ballot_guests` link). Club membership alone is not enough: a
 *     guest row minted by some OTHER surface — the public guest book (no
 *     session, no throttle), an officer's manual add, a prior meeting's
 *     ballot — is club-scoped but was never counted against
 *     `joinBallotAsGuest`'s per-meeting cap, so accepting it directly as a
 *     voter here would let that cap bound nothing (#510 follow-up review
 *     finding 1a — the exploit that actually broke it: 70 public guest-book
 *     posts, then 70 `joinBallot` reuse-path calls that skipped the cap, then
 *     70 votes, against a cap of 60).
 *  3. The WINDOW is checked inside the INSERT rather than before it, and the
 *     session sub-select takes a `FOR SHARE` lock. Reading `closed_at` and then
 *     inserting leaves a gap in which the Ballot Counter closes the vote and a
 *     ballot still lands — but a bare `INSERT ... SELECT ... WHERE closed_at IS
 *     NULL` does NOT close that gap by itself: its source SELECT is evaluated
 *     once, at statement start. A re-vote (or a retried double-fire — the
 *     client explicitly retries on bad wifi) that parks on another writer's
 *     lock for the SAME voter row never re-runs that SELECT, so a Close that
 *     commits while the statement is parked is invisible when it wakes, and it
 *     applies its `ON CONFLICT DO UPDATE` anyway. `FOR SHARE` closes the actual
 *     gap: it makes the cast hold a share lock on the session row for the life
 *     of its statement, so `closeVote`'s UPDATE — which needs an exclusive lock
 *     on that SAME row — cannot commit while a cast is still in flight; it
 *     blocks until the cast finishes, and Postgres' EvalPlanQual re-checks
 *     `closed_at IS NULL` against the row's latest committed version before a
 *     parked cast is allowed to proceed. Either way, whichever of the two
 *     commits SECOND is forced to see the other's effect: no ballot can ever
 *     land after Close is observably closed. Do NOT remove `.for("share")` as
 *     apparent boilerplate — it is the entire fix for #510's cast-after-close
 *     race (see the race test in `voting.integration.test.ts`).
 */
export async function castVote(input: {
	meetingId: string;
	category: AwardCategory;
	voter: VoterRef;
	candidate: VoterRef;
}): Promise<void> {
	const clubId = await getMeetingClubId(input.meetingId);

	// (1) Candidate eligibility, from the SAME derivation the ballot rendered.
	const candidates = await loadAwardCandidates(input.meetingId);
	if (!isEligibleCandidate(candidates, input.category, input.candidate)) {
		throw new Error("That person is not eligible for this award.");
	}

	// (2) Voter scoping.
	if (input.voter.kind === "member") {
		await requireMemberInMeetingClub(input.voter.id, clubId);
		await requireActiveMember(input.voter.id);
	} else {
		await requireGuestInClub(input.voter.id, clubId);
		await requireGuestJoinedBallot(input.voter.id, input.meetingId);
	}

	const voterMemberId = input.voter.kind === "member" ? input.voter.id : null;
	const voterGuestId = input.voter.kind === "guest" ? input.voter.id : null;
	const candidateMemberId =
		input.candidate.kind === "member" ? input.candidate.id : null;
	const candidateGuestId =
		input.candidate.kind === "guest" ? input.candidate.id : null;

	// (3) Window check and write, atomically. `.for("share")` on the session
	// sub-select is load-bearing, not decoration: without it, a cast that parks
	// on another writer's row lock (e.g. a retried double-fire hitting the SAME
	// voter row) evaluates `closed_at IS NULL` once at statement start and never
	// re-checks it, so a Close that commits while the statement is parked is
	// invisible when the cast wakes. The doc comment above has the full
	// mechanism; see the race test in `voting.integration.test.ts`.
	//
	// drizzle's `.insert().select()` requires the selected keys to exactly match
	// the target table's columns (`haveSameKeys` in drizzle-orm/utils, checked at
	// call time) — a plain subset throws "selected fields are not the same or are
	// in a different order compared to the table definition". So `id`, `createdAt`
	// and `updatedAt` are selected too, computed in SQL, in the SAME order as the
	// `meetingVotes` column definitions. This does not weaken the atomicity: it is
	// still one INSERT ... SELECT ... WHERE statement.
	const inserted = await db
		.insert(meetingVotes)
		.select(
			db
				.select({
					id: sql<string>`gen_random_uuid()`.as("id"),
					sessionId: meetingVoteSessions.id,
					voterMemberId: sql<string | null>`${voterMemberId}::uuid`.as(
						"voter_member_id",
					),
					voterGuestId: sql<string | null>`${voterGuestId}::uuid`.as(
						"voter_guest_id",
					),
					candidateMemberId: sql<string | null>`${candidateMemberId}::uuid`.as(
						"candidate_member_id",
					),
					candidateGuestId: sql<string | null>`${candidateGuestId}::uuid`.as(
						"candidate_guest_id",
					),
					createdAt: sql<Date>`now()`.as("created_at"),
					updatedAt: sql<Date>`now()`.as("updated_at"),
				})
				.from(meetingVoteSessions)
				.where(
					and(
						eq(meetingVoteSessions.meetingId, input.meetingId),
						eq(meetingVoteSessions.category, input.category),
						isNull(meetingVoteSessions.closedAt),
					),
				)
				.for("share"),
		)
		.onConflictDoUpdate({
			target: voterMemberId
				? [meetingVotes.sessionId, meetingVotes.voterMemberId]
				: [meetingVotes.sessionId, meetingVotes.voterGuestId],
			set: {
				candidateMemberId,
				candidateGuestId,
				updatedAt: new Date(),
			},
		})
		.returning({ id: meetingVotes.id });

	if (inserted.length === 0) {
		throw new Error("Voting for this award is not open.");
	}
}

/** Throws unless `guestId` belongs to `clubId`. The guest-side twin of
 *  `requireMemberInMeetingClub`. */
async function requireGuestInClub(guestId: string, clubId: string) {
	const [row] = await db
		.select({ id: guests.id })
		.from(guests)
		.where(and(eq(guests.id, guestId), eq(guests.clubId, clubId)))
		.limit(1);
	if (!row) throw new Error("Guest not found in this club.");
}

/**
 * Throws unless `guestId` has joined THIS meeting's ballot — i.e. has a
 * `meeting_ballot_guests` row for `meetingId` (#510 follow-up review finding
 * 1a). Club membership (`requireGuestInClub`) is necessary but not
 * sufficient: a `guests` row can exist for reasons that have nothing to do
 * with this meeting's ballot — the public guest book (no session, no
 * throttle), an officer manually adding a guest to a role slot, a PRIOR
 * meeting's ballot. None of those write `meeting_ballot_guests`, and
 * `joinBallotAsGuest` — the only path that does, and the only path
 * `MAX_BALLOT_GUESTS_PER_MEETING` counts against — must be the sole way to
 * become a voter here. Skip this check and the cap bounds nothing: any guest
 * id from any other surface would still work as a voter, uncapped and
 * invisible to the count. This is exactly how the proven exploit worked — 70
 * public guest-book posts, then 70 `joinBallot` calls that all took the
 * reuse path, then 70 `castVote` calls, against a cap of 60.
 */
async function requireGuestJoinedBallot(guestId: string, meetingId: string) {
	const [row] = await db
		.select({ guestId: meetingBallotGuests.guestId })
		.from(meetingBallotGuests)
		.where(
			and(
				eq(meetingBallotGuests.meetingId, meetingId),
				eq(meetingBallotGuests.guestId, guestId),
			),
		)
		.limit(1);
	if (!row) {
		throw new Error("Guest has not joined this meeting's ballot.");
	}
}

/**
 * Throws unless `memberId`'s membership is ACTIVE. Voting-only: deliberately
 * NOT folded into `requireMemberInMeetingClub`, which is shared with
 * `setAward` and `addTableTopicsSpeaker` and stays permissive on status there
 * on purpose (a departed member can still be a past meeting's award winner or
 * Table Topics speaker). But a departed member's id must not be able to cast a
 * NEW ballot through this public, unauthenticated endpoint — the roster
 * surfaces already filter them out, and the ballot must match that.
 */
async function requireActiveMember(memberId: string) {
	const [row] = await db
		.select({ status: members.status })
		.from(members)
		.where(eq(members.id, memberId))
		.limit(1);
	if (row?.status !== "active") {
		throw new Error("Member is not active in this club.");
	}
}

export interface BallotCategory {
	isOpen: boolean;
	/** True once this category's vote has been opened at least once — a
	 *  currently-open category is also `hasOpened`. Lets the phone tell a
	 *  category that WAS open and has since closed ("Voting closed") apart
	 *  from one that has never been touched (rendered as nothing), which
	 *  `isOpen` alone cannot do: both read `false` (#510 review finding 2).
	 *  Derived from `openedAt`, not `closedAt` — never null once a session
	 *  row exists at all, open or closed. */
	hasOpened: boolean;
	candidates: AwardCandidate[];
}

export interface BallotData {
	meetingId: string;
	categories: Record<AwardCategory, BallotCategory>;
}

/** Every category at zero ballots — the not-found participation badge. */
function zeroBallotCounts(): Record<AwardCategory, { ballotsIn: number }> {
	const categories = {} as Record<AwardCategory, { ballotsIn: number }>;
	for (const category of AWARD_CATEGORIES) {
		categories[category] = { ballotsIn: 0 };
	}
	return categories;
}

/** Every category closed, nobody nominated — the not-found ballot. */
function closedBallotCategories(): Record<AwardCategory, BallotCategory> {
	const categories = {} as Record<AwardCategory, BallotCategory>;
	for (const category of AWARD_CATEGORIES) {
		categories[category] = {
			isOpen: false,
			hasOpened: false,
			candidates: [],
		};
	}
	return categories;
}

/**
 * What a phone sees. PUBLIC — names and ids only, never contact details: this
 * renders on a fully public route, and `voting.integration.test.ts` asserts the
 * payload directly rather than trusting the select list to stay narrow.
 *
 * Candidates are withheld for a closed category. There is no reason for a
 * closed ballot to ship a candidate list, and shipping one would let a phone
 * cast into a category the operator has not opened yet if the client were ever
 * wrong.
 */
export async function loadBallot(meetingId: string): Promise<BallotData> {
	// PUBLIC read (#544): `getBallot` takes no session, and a ballot's candidate
	// list is member and guest NAMES. An archived club answers as a ballot with
	// every category closed and nobody on it — which is also what the voting UI
	// already renders for a meeting whose sessions were never opened, so no
	// caller needs a new branch.
	if (!(await isReadableClubForMeeting(meetingId))) {
		return { meetingId, categories: closedBallotCategories() };
	}
	const [sessions, candidates] = await Promise.all([
		listVoteSessions(meetingId),
		loadAwardCandidates(meetingId),
	]);
	const categories = {} as Record<AwardCategory, BallotCategory>;
	for (const category of AWARD_CATEGORIES) {
		const session = sessions[category];
		categories[category] = {
			isOpen: session.isOpen,
			hasOpened: session.openedAt != null,
			candidates: session.isOpen ? candidates[category] : [],
		};
	}
	return { meetingId, categories };
}

export interface TallyResult {
	kind: "member" | "guest";
	id: string;
	name: string;
	count: number;
}

export interface CategoryTally {
	isOpen: boolean;
	results: TallyResult[];
	/** Who has voted — names only. Participation, never preference: it lets the
	 *  Ballot Counter spot a ballot from someone who went home, and it cannot
	 *  reveal a choice because no id or candidate travels with it. */
	voterNames: string[];
}

/** The Ballot Counter's view. GATED — never reachable from the public route. */
export async function loadTally(
	meetingId: string,
): Promise<Record<AwardCategory, CategoryTally>> {
	const [sessions, candidates] = await Promise.all([
		listVoteSessions(meetingId),
		loadAwardCandidates(meetingId),
	]);
	const rows = await db
		.select({
			category: meetingVoteSessions.category,
			candidateMemberId: meetingVotes.candidateMemberId,
			candidateGuestId: meetingVotes.candidateGuestId,
			voterMemberName: members.name,
			voterGuestName: guests.name,
		})
		.from(meetingVotes)
		.innerJoin(
			meetingVoteSessions,
			eq(meetingVoteSessions.id, meetingVotes.sessionId),
		)
		.leftJoin(members, eq(members.id, meetingVotes.voterMemberId))
		.leftJoin(guests, eq(guests.id, meetingVotes.voterGuestId))
		.where(eq(meetingVoteSessions.meetingId, meetingId));

	const out = {} as Record<AwardCategory, CategoryTally>;
	for (const category of AWARD_CATEGORIES) {
		const mine = rows.filter((r) => r.category === category);
		const counts = new Map<string, number>();
		for (const r of mine) {
			const key = r.candidateMemberId
				? `member:${r.candidateMemberId}`
				: r.candidateGuestId
					? `guest:${r.candidateGuestId}`
					: null;
			// A removed member's vote survives with a null candidate (FK set null)
			// and is dropped from the tally rather than counted for nobody.
			if (!key) continue;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		out[category] = {
			isOpen: sessions[category].isOpen,
			results: candidates[category]
				.map((c) => ({
					kind: c.kind,
					id: c.id,
					name: c.name,
					count: counts.get(`${c.kind}:${c.id}`) ?? 0,
				}))
				.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
			voterNames: mine
				.map((r) => r.voterMemberName ?? r.voterGuestName ?? "")
				.filter(Boolean)
				.sort((a, b) => a.localeCompare(b)),
		};
	}
	return out;
}

/** One Table Topics speaker, for the Ballot Counter console (#510). */
export interface TableTopicsSpeakerRef {
	id: string;
	kind: "member" | "guest";
	name: string;
	sortOrder: number;
}

/**
 * The meeting's Table Topics speakers, for the Ballot Counter console. GATED —
 * folded into `getVoteTally` (`voting.ts`) rather than exposed on its own, so
 * it is reachable ONLY through that gate.
 *
 * This exists because `getMinutes`' visibility gate is `canEdit || completed`
 * (`canEdit` meaning admin), so a non-admin Vote Counter's console gets an
 * EMPTY speaker list from `getMinutes` on any meeting that has not been
 * completed yet — the exact bug #510 shipped with. Widening `getMinutes`
 * instead would hand a Vote Counter full attendance and guest contact data to
 * get at this one list — precisely the over-grant the capability boundary
 * exists to avoid (#464 is the standing reminder that grants get enumerated,
 * not widened). So this is its own narrow query: names and ids only, no topic
 * and no contact details — `voting-payload.guard.test.ts` covers this module
 * for exactly that.
 */
export async function loadTableTopicsForConsole(
	meetingId: string,
): Promise<TableTopicsSpeakerRef[]> {
	const rows = await db
		.select({
			id: tableTopicsSpeakers.id,
			guestId: tableTopicsSpeakers.guestId,
			memberName: members.name,
			guestName: guests.name,
			sortOrder: tableTopicsSpeakers.sortOrder,
		})
		.from(tableTopicsSpeakers)
		.leftJoin(members, eq(members.id, tableTopicsSpeakers.memberId))
		.leftJoin(guests, eq(guests.id, tableTopicsSpeakers.guestId))
		.where(eq(tableTopicsSpeakers.meetingId, meetingId))
		.orderBy(asc(tableTopicsSpeakers.sortOrder), asc(tableTopicsSpeakers.id));
	return rows.map((r) => ({
		id: r.id,
		kind: r.guestId ? ("guest" as const) : ("member" as const),
		name: (r.guestId ? r.guestName : r.memberName) ?? "Unknown",
		sortOrder: r.sortOrder,
	}));
}

export interface Participation {
	categories: Record<AwardCategory, { ballotsIn: number }>;
	/**
	 * How many people are marked present, or NULL when there is no honest
	 * POSITIVE count yet.
	 *
	 * Null is the honest answer and the UI must render it as one ("7 votes in",
	 * not "7 of 0"). This is deliberately NOT "does any `meeting_attendance` row
	 * exist" — `setMemberPresence` upserts per toggle, so the instant an officer
	 * marks the FIRST member ABSENT (before marking anyone present), a row
	 * already exists with `present = 0`, and gating on row-existence alone
	 * rendered that as a real denominator: "7 of 0 present have voted" — the
	 * exact string this design otherwise avoids (#510 follow-up review finding
	 * 3). Only a count that is actually POSITIVE is a denominator worth
	 * showing.
	 *
	 * The server cannot know who is in the room: the ballot's name-pick
	 * identity lives in localStorage and is invisible until someone actually
	 * votes. Making the name pick write an attendance row would give a real
	 * denominator — and is deliberately NOT v1, because it is a public
	 * unauthenticated write into a table that means something, and anyone could
	 * mark anyone present.
	 */
	presentCount: number | null;
}

/**
 * How many ballots are in, per category. PUBLIC — this is what the projector
 * shows. Deliberately a bare count: per-candidate numbers stay in `loadTally`,
 * because a live leaderboard on the projector produces bandwagon voting and
 * kills the reveal.
 */
export async function loadParticipation(
	meetingId: string,
): Promise<Participation> {
	// PUBLIC read (#544), and the ungated sibling of `loadBallot` one function
	// above until this landed. Bare counts are thin data, but an endpoint that
	// keeps answering is a live existence oracle for a taken-down club — and an
	// asymmetry between two neighbours in ONE file, keyed identically, is exactly
	// how #544 happened in the first place.
	if (!(await isReadableClubForMeeting(meetingId))) {
		return { categories: zeroBallotCounts(), presentCount: null };
	}
	const rows = await db
		.select({
			category: meetingVoteSessions.category,
			ballotsIn: sql<number>`count(${meetingVotes.id})::int`,
		})
		.from(meetingVoteSessions)
		.leftJoin(meetingVotes, eq(meetingVotes.sessionId, meetingVoteSessions.id))
		.where(eq(meetingVoteSessions.meetingId, meetingId))
		.groupBy(meetingVoteSessions.category);
	const byCategory = new Map(rows.map((r) => [r.category, r.ballotsIn]));
	const categories = {} as Record<AwardCategory, { ballotsIn: number }>;
	for (const category of AWARD_CATEGORIES) {
		categories[category] = { ballotsIn: byCategory.get(category) ?? 0 };
	}

	// Only `present` is needed now — see the doc comment on `presentCount`. An
	// earlier version also selected a `marked` (any-row-exists) count and gated
	// on THAT being positive, which is exactly how "7 of 0" happened: a
	// mark-absent-only meeting has a marked row but zero present, and that read
	// as a real, if zero, denominator instead of "no honest denominator yet".
	const [attendance] = await db
		.select({
			present: sql<number>`count(*) filter (where ${meetingAttendance.status} = 'present')::int`,
		})
		.from(meetingAttendance)
		.where(eq(meetingAttendance.meetingId, meetingId));

	return {
		categories,
		presentCount: (attendance?.present ?? 0) > 0 ? attendance.present : null,
	};
}

/** Longest guest name the ballot will store, in CODE POINTS. */
const MAX_GUEST_NAME = 80;
/**
 * Most ballot IDENTITIES one meeting's guest ballot may mint — a count of
 * `meeting_ballot_guests` LINKS, not of `guests` rows created (#510 follow-up
 * review finding 1). The ballot is an unauthenticated public POST, so it needs
 * a ceiling — without one, a script fills `guests` for any club whose meeting
 * URL it can guess, and worse, every guest LINKED to a meeting is a distinct
 * voter under `meeting_votes_voter_guest_unique`, so an unbounded number of
 * links is an unbounded number of ballots in every open category. What must
 * be bounded is therefore "how many voters can this meeting mint", not "how
 * many fresh rows landed in the club-scoped `guests` table" — a reuse match
 * (an existing club guest linking to THIS meeting for the first time, e.g.
 * someone captured by the public guest book) is just as much a new voter as a
 * brand-new row, and must count the same way. Set far above any real club
 * meeting; a club that genuinely exceeds it adds the rest from the minutes
 * UI, which is gated.
 */
const MAX_BALLOT_GUESTS_PER_MEETING = 60;

/**
 * Register a visitor as a guest so they can vote (#510). PUBLIC and therefore
 * bounded on multiple axes: name length, and — what actually matters — how
 * many ballot IDENTITIES this meeting's guest ballot can mint in total.
 *
 * The name is capped with `cap`, which counts CODE POINTS. Do not replace it
 * with `.slice()`: the truncation added to close a DoS in #522 WAS a DoS,
 * because slicing UTF-16 splits a surrogate pair and emits a lone surrogate.
 *
 * FIND-OR-CREATE, not always-create (#510 review finding 2). The spec's
 * "Identify" surface says a guest picks from the meeting's existing guest list
 * or adds themselves; this endpoint only offers the free-text add half, so
 * without a server-side match a guest already on the club's roster — including
 * one who just spoke at Table Topics and is therefore a ballot CANDIDATE —
 * would mint a second `guests` row to vote as themselves, and an incognito
 * window plus the same name is a second ballot identity with no unique index
 * to stop it. The match is club-scoped on normalized (trimmed, case-folded)
 * name, the same shape `findGuestByContact` (`guest-pipeline-logic.ts`) uses
 * for its email/phone dedup, just on the one signal this endpoint collects —
 * and it EXCLUDES guests with `converted_membership_id` set (#510 follow-up
 * review finding 2). ADR-0018's picker exclusion (`listClubGuests`) already
 * settled that "a joined guest is a member"; without the same filter here, the
 * member that guest became could type their OWN former guest name into this
 * box, get the retired guest row handed back, and cast a SECOND ballot under
 * it — the member and guest arbiters are separate unique indexes
 * (`meeting_votes_voter_member_unique` / `..._voter_guest_unique`), so nothing
 * else catches that. A converted guest's name typed here still mints a FRESH
 * guest row rather than silently failing — that fresh row is a normal new
 * ballot identity, capped and counted like any other; what it must not do is
 * hand back the retired one.
 *
 * The cap counts `meeting_ballot_guests` LINKS, not `guests` row creation
 * (#510 follow-up review finding 1b — the previous framing, "gate NEW rows
 * only", was itself the hole: the reuse path skipped the count entirely, so
 * 70 names already sitting in `guests` from the public guest book — a surface
 * with no session and no throttle — all took the reuse path, all skipped the
 * cap, and all linked, landing 70 ballot identities against a cap of 60). What
 * must be bounded is ballot identities per meeting: a reuse match consumes
 * headroom exactly when it is this guest's FIRST link to THIS meeting,
 * regardless of whether it minted a `guests` row or reused one. The one case
 * that must stay free is an ALREADY-linked guest re-identifying — a
 * legitimate returning voter re-submitting the join form, not a new identity
 * — so the count only gates when no `meeting_ballot_guests` row for (this
 * meeting, this guest) exists yet; a club that already has 60 people on its
 * guest roster can still let its OWN returning ballot voters back in.
 * `meetingBallotGuests` is still written (idempotently) either way, so the
 * Ballot Counter's guest count reflects everyone actually on the ballot.
 *
 * LOCKED, not just wrapped in a transaction (#510 review finding 1 — the
 * BLOCKING one from the FIRST review). The old code read the
 * `meetingBallotGuests` count OUTSIDE any transaction and took no lock, so
 * every concurrent request read the same pre-insert count under READ
 * COMMITTED's snapshot-at-statement-start — a reviewer fired 200 concurrent
 * calls against a cap of 60 and all 200 landed. That is not just row spam on
 * this PUBLIC unauthenticated endpoint: every guest LINKED to a meeting is a
 * distinct voter under `meeting_votes_voter_guest_unique`, so one burst buys N
 * ballots in every open category, defeating one-vote-per-person without ever
 * touching that index. `SELECT ... FOR UPDATE` on the meeting row is taken as
 * the FIRST statement, before the name lookup, the link check and the count,
 * so every concurrent join for THIS meeting serializes behind one writer at a
 * time — mirroring the `.for("share")` idiom `castVote` uses for the same
 * class of read-then-write gap. See the concurrent-burst regression test in
 * `voting.integration.test.ts`, verified by mutation (revert the lock, watch
 * it fail — vitest swallows console output here, so a logging probe would not
 * have caught this the first time either).
 */
export async function joinBallotAsGuest(input: {
	meetingId: string;
	name: string;
}): Promise<{ id: string; name: string }> {
	const name = cap(input.name.trim(), MAX_GUEST_NAME);
	if (!name) throw new Error("A name is required to vote.");
	const normalizedName = name.toLowerCase();
	const clubId = await getMeetingClubId(input.meetingId);

	return db.transaction(async (tx) => {
		// The lock. Every later statement in this transaction — the name lookup,
		// the link check, the cap count, the inserts — runs only after this
		// resolves, so two concurrent joins for the same meeting can never both
		// observe "room for one more" and both write.
		await tx
			.select({ id: meetings.id })
			.from(meetings)
			.where(eq(meetings.id, input.meetingId))
			.limit(1)
			.for("update");

		// Excludes converted guests (`converted_membership_id` set) — ADR-0018's
		// "a joined guest is a member" rule, applied the same way `listClubGuests`
		// applies it to the assign picker (#510 follow-up review finding 2). A
		// converted guest's row is retired as a guest identity; typing their name
		// here must mint a fresh one rather than hand the old one back.
		const [existing] = await tx
			.select({ id: guests.id, name: guests.name })
			.from(guests)
			.where(
				and(
					eq(guests.clubId, clubId),
					isNull(guests.convertedMembershipId),
					sql`lower(trim(${guests.name})) = ${normalizedName}`,
				),
			)
			.limit(1);

		// Is this guest already linked to THIS meeting's ballot? Only relevant
		// when a match was found — a brand-new guest can never already be linked.
		// This, not "was a `guests` row just created", is what decides whether the
		// cap check below applies (#510 follow-up review finding 1b).
		let alreadyLinked = false;
		if (existing) {
			const [link] = await tx
				.select({ guestId: meetingBallotGuests.guestId })
				.from(meetingBallotGuests)
				.where(
					and(
						eq(meetingBallotGuests.meetingId, input.meetingId),
						eq(meetingBallotGuests.guestId, existing.id),
					),
				)
				.limit(1);
			alreadyLinked = Boolean(link);
		}

		// The cap bounds NEW links only. An already-linked guest re-identifying
		// consumes no headroom — a returning voter, not a new ballot identity —
		// but everything else does: a brand-new name, AND a club guest reused for
		// the first time on THIS meeting (e.g. one the public guest book already
		// created), both mint a NEW link and both count.
		if (!alreadyLinked) {
			const [{ count } = { count: 0 }] = await tx
				.select({ count: sql<number>`count(*)::int` })
				.from(meetingBallotGuests)
				.where(eq(meetingBallotGuests.meetingId, input.meetingId));
			if (count >= MAX_BALLOT_GUESTS_PER_MEETING) {
				throw new Error("Too many guests have joined this ballot.");
			}
		}

		let guest: { id: string; name: string };
		if (existing) {
			guest = existing;
		} else {
			const [created] = await tx
				.insert(guests)
				.values({ clubId, name })
				.returning({ id: guests.id, name: guests.name });
			guest = created;
		}

		// Idempotent: `meeting_ballot_guests`'s primary key is the (meeting, guest)
		// pair, so a repeat join by the same person — or a reuse match against a
		// guest not yet linked to THIS meeting's ballot — must not throw a
		// duplicate-key error.
		await tx
			.insert(meetingBallotGuests)
			.values({ meetingId: input.meetingId, guestId: guest.id })
			.onConflictDoNothing();

		return guest;
	});
}
