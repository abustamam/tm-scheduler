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
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "#/db";
import {
	guests,
	meetingAttendance,
	meetingVoteSessions,
	meetingVotes,
	members,
} from "#/db/schema";
import { logActivity } from "./activity";
import {
	type AwardCandidate,
	isEligibleCandidate,
	loadAwardCandidates,
} from "./award-candidates-logic";
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
 *     guest carries a `club_id` and is checked directly.
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
	candidates: AwardCandidate[];
}

export interface BallotData {
	meetingId: string;
	categories: Record<AwardCategory, BallotCategory>;
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
	const [sessions, candidates] = await Promise.all([
		listVoteSessions(meetingId),
		loadAwardCandidates(meetingId),
	]);
	const categories = {} as Record<AwardCategory, BallotCategory>;
	for (const category of AWARD_CATEGORIES) {
		const isOpen = sessions[category].isOpen;
		categories[category] = {
			isOpen,
			candidates: isOpen ? candidates[category] : [],
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

export interface Participation {
	categories: Record<AwardCategory, { ballotsIn: number }>;
	/**
	 * How many people are marked present, or NULL when nobody has marked
	 * attendance yet.
	 *
	 * Null is the honest answer and the UI must render it as one ("7 votes in",
	 * not "7 of 0"). The server cannot know who is in the room: the ballot's
	 * name-pick identity lives in localStorage and is invisible until someone
	 * actually votes. Making the name pick write an attendance row would give a
	 * real denominator — and is deliberately NOT v1, because it is a public
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

	const [attendance] = await db
		.select({
			marked: sql<number>`count(*)::int`,
			present: sql<number>`count(*) filter (where ${meetingAttendance.status} = 'present')::int`,
		})
		.from(meetingAttendance)
		.where(eq(meetingAttendance.meetingId, meetingId));

	return {
		categories,
		presentCount: (attendance?.marked ?? 0) > 0 ? attendance.present : null,
	};
}
