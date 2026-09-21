// Pure, client-safe evaluator-pairing folding (#709). NO `#/db` import lives
// here, for the reason `#/lib/attendance-lapse` states: a constant defined in a
// module that imports `#/db` at load throws `DATABASE_URL is not set` in
// vitest, which makes it unassertable and therefore silently raisable to any
// value. `recentPerSpeaker` IS the feature's window, so it has to be a number a
// unit test can pin without a database.
//
// The window SELECTION (which slots are pairings at all — held, past,
// non-cancelled, this club) is SQL's job — see `reporting-logic.ts`. This
// module folds whatever pairs it is handed into one row per speaker.

/**
 * The one number the section is.
 *
 * **Per SPEAKER, not per meeting**, and that is the decision #709 left open
 * ("last N meetings" and "last N evaluations" differ for an infrequent
 * speaker). A meeting-count window is what the neighbouring attendance section
 * uses, and it is right there because attendance is a club-wide rhythm. Pairing
 * is not: a member who speaks twice a year falls entirely outside any window
 * short enough to be useful for a weekly speaker, and that member is *exactly*
 * the one whose last evaluator the assigner cannot remember. Counting
 * evaluations per speaker is invariant to how often that speaker speaks, so the
 * frequent and the infrequent speaker get the same depth of history.
 *
 * Asserted ABSOLUTELY in the unit test (it equals 5, and a six-deep history is
 * truncated to exactly five) rather than as
 * `expect(row.recent.length).toBeLessThanOrEqual(recentPerSpeaker)`, which
 * passes for every value including 5,000 — the shape #519 shipped twice.
 */
export const EVALUATOR_PAIRING = {
	/** How many past evaluations of one speaker the section shows. */
	recentPerSpeaker: 5,
} as const;

/** One past evaluation of one speaker, as the dashboard renders it. */
export interface EvaluationPair {
	/**
	 * Stable identity of the evaluator, for repeat detection: a member id or a
	 * guest id. NOT the name — two people in one club can share a name, and
	 * repeat detection keyed on the name would report a pairing that never
	 * happened.
	 */
	evaluatorKey: string;
	evaluatorName: string;
	/** A non-member guest held the evaluator slot (#151). */
	isGuest: boolean;
	meetingId: string;
	scheduledAt: Date;
	/** This evaluator appears more than once in the speaker's SHOWN window. */
	repeat: boolean;
}

/** One speaker and who has evaluated them, newest first. */
export interface EvaluatorPairingRow {
	/** The member who was EVALUATED — this row's axis. */
	memberId: string;
	name: string;
	joinedAt: Date | null;
	/** Newest first, at most `EVALUATOR_PAIRING.recentPerSpeaker`. */
	recent: EvaluationPair[];
	/** Distinct evaluators within `recent`. */
	distinctEvaluators: number;
	/** Some evaluator in `recent` appears more than once. */
	hasRepeat: boolean;
}

/** One evaluator-slot → speaker-slot pairing, straight off the join. */
export interface PairingInput {
	speakerMemberId: string;
	speakerName: string;
	speakerJoinedAt: Date | null;
	/** Null when a guest held the evaluator slot. */
	evaluatorMemberId: string | null;
	/** Null when a member held the evaluator slot. */
	evaluatorGuestId: string | null;
	evaluatorMemberName: string | null;
	evaluatorGuestName: string | null;
	meetingId: string;
	scheduledAt: Date;
}

/**
 * Fold raw pairings into one row per speaker.
 *
 * Four rules carry the section, each settled deliberately:
 *
 * 1. **The row's axis is the SPEAKER.** #709's first acceptance criterion is
 *    "an assigner can see, for a given speaker, who has evaluated them
 *    recently", and the question at the picker is about one speaker. The mirror
 *    shape (one row per evaluator, listing who they have evaluated) answers a
 *    different question and implies a different sort.
 *
 * 2. **Repeats are counted AFTER truncation.** A duplicate outside the shown
 *    window would otherwise put a "repeat" marker on a row whose second
 *    occurrence the officer cannot see — a claim the surface does not support.
 *    The flag means exactly "the same name is in this list twice".
 *
 * 3. **A guest evaluator is a pairing.** Evaluator slots can be held by a
 *    non-member guest (#151), and dropping those would under-report the very
 *    repeat the section exists to catch — silently, since nothing on the page
 *    would hint that a row was missing. Only a pairing with NO assignee at all
 *    is dropped, which is the defensive half: the loader filters to held slots,
 *    which by construction carry one.
 *
 * 4. **Ordering never depends on the caller.** Pairs are sorted here rather
 *    than trusted from SQL, and tie-broken all the way down to the evaluator
 *    key — so two evaluators of one speaker at one meeting (a two-evaluator
 *    club), or two meetings sharing a `scheduled_at`, cannot make the
 *    TRUNCATION window's membership arbitrary. A pairing could otherwise enter
 *    or leave the shown five between loader runs: the nondeterminism class #437
 *    removed.
 */
export function groupEvaluatorPairings(
	pairs: PairingInput[],
	limit: number = EVALUATOR_PAIRING.recentPerSpeaker,
): EvaluatorPairingRow[] {
	interface Bucket {
		memberId: string;
		name: string;
		joinedAt: Date | null;
		pairs: Array<Omit<EvaluationPair, "repeat">>;
	}
	const bySpeaker = new Map<string, Bucket>();

	for (const p of pairs) {
		// Rule 3's defensive half: an evaluator slot with neither a member nor a
		// guest has nobody in it, so it is not a pairing at all.
		const evaluatorKey = p.evaluatorMemberId ?? p.evaluatorGuestId;
		if (!evaluatorKey) continue;
		const isGuest = p.evaluatorMemberId === null;
		const evaluatorName =
			(isGuest ? p.evaluatorGuestName : p.evaluatorMemberName) ?? "Someone";

		let bucket = bySpeaker.get(p.speakerMemberId);
		if (!bucket) {
			bucket = {
				memberId: p.speakerMemberId,
				name: p.speakerName,
				joinedAt: p.speakerJoinedAt,
				pairs: [],
			};
			bySpeaker.set(p.speakerMemberId, bucket);
		}
		bucket.pairs.push({
			evaluatorKey,
			evaluatorName,
			isGuest,
			meetingId: p.meetingId,
			scheduledAt: p.scheduledAt,
		});
	}

	const rows: EvaluatorPairingRow[] = [];
	for (const bucket of bySpeaker.values()) {
		// Rule 4 — newest first, fully tie-broken.
		const sorted = bucket.pairs
			.slice()
			.sort(
				(a, b) =>
					b.scheduledAt.getTime() - a.scheduledAt.getTime() ||
					a.meetingId.localeCompare(b.meetingId) ||
					a.evaluatorKey.localeCompare(b.evaluatorKey),
			);
		// Rule 2 — truncate, THEN count.
		const shown = sorted.slice(0, limit);
		const counts = new Map<string, number>();
		for (const p of shown) {
			counts.set(p.evaluatorKey, (counts.get(p.evaluatorKey) ?? 0) + 1);
		}
		const recent = shown.map((p) => ({
			...p,
			repeat: (counts.get(p.evaluatorKey) ?? 0) > 1,
		}));
		rows.push({
			memberId: bucket.memberId,
			name: bucket.name,
			joinedAt: bucket.joinedAt,
			recent,
			distinctEvaluators: counts.size,
			hasRepeat: recent.some((p) => p.repeat),
		});
	}

	// Repeats first — they are the only rows asking the assigner to DO
	// something, and varying who evaluates whom is the whole point. Then most
	// recently evaluated, so speakers in the current rotation sit above ones who
	// last spoke a year ago. Name breaks the tie so the order is stable across
	// reads.
	return rows.sort(
		(a, b) =>
			Number(b.hasRepeat) - Number(a.hasRepeat) ||
			(b.recent[0]?.scheduledAt.getTime() ?? 0) -
				(a.recent[0]?.scheduledAt.getTime() ?? 0) ||
			a.name.localeCompare(b.name),
	);
}
