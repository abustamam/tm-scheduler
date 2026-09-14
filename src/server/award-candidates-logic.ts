/**
 * Who may win each award on a meeting (#510), with display names.
 *
 * ONE derivation, read by two callers that must never disagree: the public
 * ballot renders it, and `castVote` validates against it. If they drifted, the
 * ballot would offer a candidate the server rejects — a failure that only shows
 * up mid-meeting.
 *
 * Best Speaker  → holders of `speaker`-category role slots
 * Best Evaluator→ holders of `evaluator`-category role slots
 * Best Table Topics → the meeting's recorded Table Topics speakers
 *
 * Names ONLY. No email, no phone: the ballot is a fully public surface and the
 * public club sheet is a soft gate, so contact details must never reach it.
 * `award-candidates.integration.test.ts` asserts that directly.
 *
 * Since #723 this module also owns DISQUALIFICATION — who may no longer win
 * despite having spoken. It lives here rather than beside the ballot for the
 * same "one derivation" reason the file opens with: `isEligibleCandidate` is
 * the server-side gate `castVote` calls, so the mark that hides a name on the
 * ballot and the mark that makes the server refuse the vote have to be the
 * same fact. Stamped onto each candidate rather than returned separately, so a
 * consumer cannot read the list and forget to consult it.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	guests,
	meetingCandidateDisqualifications,
	members,
	roleDefinitions,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { capDisqualificationReason } from "#/lib/disqualification";
import { writeInKey } from "#/lib/write-in-limits";
import { AWARD_CATEGORIES, type AwardCategory } from "./minutes-logic";

/**
 * A person who may win an award.
 *
 * `kind` discriminates what `id` MEANS, and the three cases are genuinely
 * different: `member` and `guest` are foreign keys into their tables, while
 * `writeIn` has no row at all and its `id` is the `writeInKey` of the name a
 * voter typed (#582). Keeping one shape lets the ballot render and post all
 * three the same way; the client never needs to know which it is holding.
 */
export interface AwardCandidate {
	kind: "member" | "guest" | "writeIn";
	/** Member/guest: the row id. Write-in: `writeInKey(name)`. */
	id: string;
	name: string;
	/**
	 * Why this candidate can no longer win, or null (#723).
	 *
	 * NOT optional. Every producer of an `AwardCandidate` has to answer this,
	 * which is the point: the public ballot, the tally and `isEligibleCandidate`
	 * all read one list, and a producer that could leave the field off would
	 * silently mean "eligible" on all three at once — including the one that
	 * decides whether the server accepts a vote.
	 */
	disqualified: CandidateDisqualification | null;
}

/** Why a candidate was ruled out. An object rather than a bare string so the
 *  null check at a call site reads as "is this person out", and so a later
 *  `at`/`by` can be added without touching every consumer. */
export interface CandidateDisqualification {
	reason: string;
}

export type AwardCandidates = Record<AwardCategory, AwardCandidate[]>;

/**
 * Every disqualification on a meeting, per category, keyed `${kind}:${id}` —
 * the same key `loadAwardCandidates` de-dupes on and the tally counts under
 * (#723).
 *
 * A MAP rather than a list because every consumer asks the same question
 * ("is this one candidate out?") once per candidate, and because building it
 * once is what lets `loadWriteInCandidates` — which lives in `voting-logic.ts`
 * and produces the OTHER half of the ballot's candidate list — stamp its rows
 * from the identical fact.
 */
export type DisqualifiedIndex = Record<
	AwardCategory,
	Map<string, CandidateDisqualification>
>;

/** Build that index for one meeting. One indexed read; see the type above. */
export async function loadDisqualifications(
	meetingId: string,
): Promise<DisqualifiedIndex> {
	const rows = await db
		.select({
			category: meetingCandidateDisqualifications.category,
			memberId: meetingCandidateDisqualifications.candidateMemberId,
			guestId: meetingCandidateDisqualifications.candidateGuestId,
			writeIn: meetingCandidateDisqualifications.candidateWriteIn,
			reason: meetingCandidateDisqualifications.reason,
		})
		.from(meetingCandidateDisqualifications)
		.where(eq(meetingCandidateDisqualifications.meetingId, meetingId));

	const out = {} as DisqualifiedIndex;
	for (const category of AWARD_CATEGORIES) out[category] = new Map();
	for (const r of rows) {
		// The write-in column already holds the FOLDED key (see the schema
		// comment), but it is folded again here rather than trusted: this reaches
		// the public ballot and the `castVote` gate, and a row written by any
		// future path that skips `disqualifyCandidate` would otherwise fail to
		// match the candidate it names — which fails OPEN, letting the vote
		// through. Folding an already-folded key is a no-op.
		const key = r.memberId
			? disqualificationKey({ kind: "member", id: r.memberId })
			: r.guestId
				? disqualificationKey({ kind: "guest", id: r.guestId })
				: r.writeIn
					? disqualificationKey({
							kind: "writeIn",
							id: writeInKey(r.writeIn),
						})
					: null;
		// Unreachable while the table's exactly-one check holds; dropped rather
		// than crashed on, because a candidate-less row disqualifies nobody.
		if (!key) continue;
		// Capped on the way OUT as well as in — the column is unbounded `text`
		// and this string renders on every phone in the room.
		out[r.category].set(key, {
			reason: capDisqualificationReason(r.reason),
		});
	}
	return out;
}

/**
 * This candidate's disqualification, or null. Handles all three kinds — unlike
 * `isEligibleCandidate` below, a WRITE-IN can be disqualified, because the Vote
 * Counter sees the typed name on their console once it has been cast once.
 *
 * THE one place the `${kind}:${id}` key is read. Every consumer goes through
 * it — `loadAwardCandidates` and `loadWriteInCandidates` when they stamp, and
 * `castVote`'s write-in arm when it gates — because a key format spelled
 * independently in four places is how the two sides of a lookup quietly stop
 * agreeing. This feature already shipped one bug of exactly that shape (the
 * undo that folded its input and matched the column raw), which is why the
 * spellings were collapsed rather than left as four correct copies.
 */
export function disqualificationFor(
	index: DisqualifiedIndex,
	category: AwardCategory,
	candidate: { kind: "member" | "guest" | "writeIn"; id: string },
): CandidateDisqualification | null {
	return index[category].get(disqualificationKey(candidate)) ?? null;
}

/** The key `disqualificationFor` reads and `loadDisqualifications` writes.
 *  Not exported: nothing outside this module should be building it. */
function disqualificationKey(candidate: {
	kind: "member" | "guest" | "writeIn";
	id: string;
}): string {
	return `${candidate.kind}:${candidate.id}`;
}

/**
 * `dq` is OPTIONAL, and the default is the point (#723).
 *
 * Omit it and this function loads the index itself, so a caller that knows
 * nothing about disqualification still gets correctly stamped candidates —
 * which matters because every caller is a place a ruled-out candidate must not
 * slip through, and an argument each one has to remember is exactly what goes
 * missing when a fourth appears.
 *
 * Pass it when you are ALSO calling `loadWriteInCandidates`, which produces the
 * other half of the ballot's candidate list and needs the same index. Both
 * `loadBallot` and `loadTally` do, so without the parameter each poll issued
 * the identical `where meeting_id = ?` TWICE, concurrently — on the read every
 * phone in the room makes every 5 seconds.
 */
export async function loadAwardCandidates(
	meetingId: string,
	dq?: DisqualifiedIndex,
): Promise<AwardCandidates> {
	// All three reads take only `meetingId` and none depends on another, so they
	// go in parallel rather than stacking three round-trips on the public poll.
	const [disqualified, slotRows, ttRows] = await Promise.all([
		dq ? Promise.resolve(dq) : loadDisqualifications(meetingId),
		// `members.name` is the per-club authoritative display name, denormalized
		// on purpose (#486) — it is what `loadMinutes` already reads for award
		// winners. Do NOT join through `people.name`: the two diverge, and the
		// ballot must show the same name every other surface shows.
		db
			.select({
				category: roleDefinitions.category,
				memberId: roleSlots.assignedMemberId,
				guestId: roleSlots.assignedGuestId,
				memberName: members.name,
				guestName: guests.name,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
			.leftJoin(guests, eq(guests.id, roleSlots.assignedGuestId))
			.where(eq(roleSlots.meetingId, meetingId))
			.orderBy(asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex)),
		db
			.select({
				memberId: tableTopicsSpeakers.memberId,
				guestId: tableTopicsSpeakers.guestId,
				memberName: members.name,
				guestName: guests.name,
			})
			.from(tableTopicsSpeakers)
			.leftJoin(members, eq(members.id, tableTopicsSpeakers.memberId))
			.leftJoin(guests, eq(guests.id, tableTopicsSpeakers.guestId))
			.where(eq(tableTopicsSpeakers.meetingId, meetingId))
			.orderBy(asc(tableTopicsSpeakers.sortOrder)),
	]);

	const empty = (): AwardCandidates => ({
		best_speaker: [],
		best_evaluator: [],
		best_table_topics: [],
	});
	const out = empty();
	// De-dupe per category: a member may hold two speaker slots and must appear
	// on the ballot once. Keyed by `kind:id`, insertion-ordered.
	const seen: Record<AwardCategory, Set<string>> = {
		best_speaker: new Set(),
		best_evaluator: new Set(),
		best_table_topics: new Set(),
	};

	const push = (
		category: AwardCategory,
		row: {
			memberId: string | null;
			guestId: string | null;
			memberName: string | null;
			guestName: string | null;
		},
	) => {
		const kind = row.memberId ? "member" : row.guestId ? "guest" : null;
		if (!kind) return;
		const id = (row.memberId ?? row.guestId) as string;
		const name = (kind === "member" ? row.memberName : row.guestName) ?? "";
		if (!name) return;
		const key = `${kind}:${id}`;
		if (seen[category].has(key)) return;
		seen[category].add(key);
		out[category].push({
			kind,
			id,
			name,
			disqualified: disqualificationFor(disqualified, category, { kind, id }),
		});
	};

	for (const r of slotRows) {
		if (r.category === "speaker") push("best_speaker", r);
		else if (r.category === "evaluator") push("best_evaluator", r);
	}
	for (const r of ttRows) push("best_table_topics", r);

	return out;
}

/**
 * True when `candidate` is eligible for `category` on this meeting.
 *
 * WRITE-INS ARE NOT CHECKED HERE, and must not be: the whole point of #582 is
 * a candidate with no row to check against. `castVote` handles that arm
 * separately — it validates the NAME (length, non-blank) rather than
 * membership of a derived list. Passing a write-in to this function would
 * always answer false, so the type excludes it rather than leaving a caller
 * to discover that at runtime. Note that a write-in CAN still be disqualified;
 * `castVote`'s write-in arm consults `disqualificationFor` directly, because
 * this function is not the thing that gates it.
 *
 * `!c.disqualified` is the load-bearing half of #723 (AC 3). Hiding the name
 * on the ballot is a UI courtesy: a phone whose 5s poll has not landed yet
 * still holds a tappable button for someone who has just been ruled out, and a
 * hand-crafted POST never polls at all. This is where a MEMBER-or-GUEST vote
 * is refused; the write-in arm of `castVote` is the other half, and there are
 * exactly those two — both throw the same message, and `voting-logic.ts` is
 * the only file that throws it.
 */
export function isEligibleCandidate(
	candidates: AwardCandidates,
	category: AwardCategory,
	candidate: { kind: "member" | "guest"; id: string },
): boolean {
	return candidates[category].some(
		(c) =>
			c.kind === candidate.kind && c.id === candidate.id && !c.disqualified,
	);
}

export { AWARD_CATEGORIES };
