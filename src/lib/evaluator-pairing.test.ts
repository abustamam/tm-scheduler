// Unit tests for the evaluator-pairing fold (#709). No database: the whole
// point of `#/lib/evaluator-pairing` living outside `reporting-logic.ts` is
// that `EVALUATOR_PAIRING.recentPerSpeaker` is assertable without one. A
// constant defined in a module that imports `#/db` throws `DATABASE_URL is not
// set` here, which is how a window silently becomes any value at all.
import { describe, expect, it } from "vitest";
import {
	EVALUATOR_PAIRING,
	groupEvaluatorPairings,
	type PairingInput,
} from "./evaluator-pairing";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-09-01T18:00:00Z").getTime();

/** A meeting `daysAgo` before T0, with a sortable id. */
function at(daysAgo: number) {
	return {
		meetingId: `m-${String(1000 - daysAgo).padStart(4, "0")}`,
		scheduledAt: new Date(T0 - daysAgo * DAY),
	};
}

function pair(over: Partial<PairingInput> & { daysAgo: number }): PairingInput {
	const { meetingId, scheduledAt } = at(over.daysAgo);
	return {
		speakerMemberId: "speaker-1",
		speakerName: "Alex Rivera",
		speakerJoinedAt: new Date("2024-01-15T00:00:00Z"),
		evaluatorMemberId: "eval-1",
		evaluatorGuestId: null,
		evaluatorMemberName: "Sam Chen",
		evaluatorGuestName: null,
		meetingId,
		scheduledAt,
		...over,
	};
}

describe("EVALUATOR_PAIRING", () => {
	it("shows five evaluations per speaker", () => {
		// ABSOLUTE, not relative to itself. `expect(row.recent.length)
		// .toBeLessThanOrEqual(recentPerSpeaker)` passes for 5,000 too, which puts
		// a club's entire history in one row with the suite green (#519's shape).
		expect(EVALUATOR_PAIRING.recentPerSpeaker).toBe(5);
	});
});

describe("groupEvaluatorPairings", () => {
	it("gives one row per speaker, newest evaluation first", () => {
		const rows = groupEvaluatorPairings([
			pair({ daysAgo: 30, evaluatorMemberId: "a", evaluatorMemberName: "Ada" }),
			pair({ daysAgo: 7, evaluatorMemberId: "b", evaluatorMemberName: "Bo" }),
			pair({
				daysAgo: 14,
				speakerMemberId: "speaker-2",
				speakerName: "Casey Kim",
				evaluatorMemberId: "c",
				evaluatorMemberName: "Cleo",
			}),
		]);

		expect(rows).toHaveLength(2);
		const alex = rows.find((r) => r.memberId === "speaker-1");
		expect(alex?.recent.map((p) => p.evaluatorName)).toEqual(["Bo", "Ada"]);
		expect(alex?.distinctEvaluators).toBe(2);
		expect(alex?.hasRepeat).toBe(false);
	});

	it("truncates to exactly five, keeping the five most recent", () => {
		// Six evaluations, oldest LAST in the input so a fold that simply took the
		// first five would keep the wrong ones AND still produce five rows.
		const rows = groupEvaluatorPairings(
			[60, 5, 50, 12, 40, 20].map((daysAgo, i) =>
				pair({
					daysAgo,
					evaluatorMemberId: `e${i}`,
					evaluatorMemberName: `Eval ${i}`,
				}),
			),
		);

		expect(rows[0]?.recent).toHaveLength(5);
		// The 60-days-ago one (index 0 of the input) is the one dropped.
		expect(rows[0]?.recent.map((p) => p.evaluatorName)).toEqual([
			"Eval 1", // 5d
			"Eval 3", // 12d
			"Eval 5", // 20d
			"Eval 4", // 40d
			"Eval 2", // 50d
		]);
	});

	it("flags an evaluator who appears twice in the shown window", () => {
		const rows = groupEvaluatorPairings([
			pair({ daysAgo: 7, evaluatorMemberId: "a", evaluatorMemberName: "Ada" }),
			pair({ daysAgo: 21, evaluatorMemberId: "b", evaluatorMemberName: "Bo" }),
			pair({ daysAgo: 35, evaluatorMemberId: "a", evaluatorMemberName: "Ada" }),
		]);

		const row = rows[0];
		expect(row?.hasRepeat).toBe(true);
		expect(row?.distinctEvaluators).toBe(2);
		// BOTH occurrences carry the flag — the marker means "this name is in this
		// list twice", so marking only the later one would leave the officer
		// hunting for the other half of a pairing the row claims to have.
		expect(
			row?.recent.filter((p) => p.repeat).map((p) => p.evaluatorName),
		).toEqual(["Ada", "Ada"]);
	});

	it("does NOT flag a repeat whose twin fell outside the shown window", () => {
		// Ada evaluated at 7d and again at 90d, with five others in between. The
		// 90d pairing is truncated away, so the surface shows Ada once — and a
		// "repeat" marker beside a name that appears once is a claim the row does
		// not support. Counting before truncation is the bug this pins.
		const rows = groupEvaluatorPairings([
			pair({ daysAgo: 7, evaluatorMemberId: "a", evaluatorMemberName: "Ada" }),
			pair({ daysAgo: 14, evaluatorMemberId: "b", evaluatorMemberName: "Bo" }),
			pair({
				daysAgo: 21,
				evaluatorMemberId: "c",
				evaluatorMemberName: "Cleo",
			}),
			pair({ daysAgo: 28, evaluatorMemberId: "d", evaluatorMemberName: "Dev" }),
			pair({ daysAgo: 35, evaluatorMemberId: "e", evaluatorMemberName: "Eze" }),
			pair({ daysAgo: 90, evaluatorMemberId: "a", evaluatorMemberName: "Ada" }),
		]);

		expect(rows[0]?.recent).toHaveLength(5);
		expect(rows[0]?.hasRepeat).toBe(false);
		expect(rows[0]?.recent.every((p) => !p.repeat)).toBe(true);
	});

	it("keeps a guest evaluator, keyed by the guest id", () => {
		const rows = groupEvaluatorPairings([
			pair({
				daysAgo: 7,
				evaluatorMemberId: null,
				evaluatorMemberName: null,
				evaluatorGuestId: "g1",
				evaluatorGuestName: "Robin Visitor",
			}),
			pair({ daysAgo: 21, evaluatorMemberId: "a", evaluatorMemberName: "Ada" }),
		]);

		const guest = rows[0]?.recent[0];
		expect(guest?.evaluatorName).toBe("Robin Visitor");
		expect(guest?.isGuest).toBe(true);
		expect(guest?.evaluatorKey).toBe("g1");
		expect(rows[0]?.recent[1]?.isGuest).toBe(false);
	});

	it("flags a guest who evaluated the same speaker twice", () => {
		// The case a member-only implementation drops silently: the repeat is real
		// and entirely between the speaker and a non-member.
		const rows = groupEvaluatorPairings([
			pair({
				daysAgo: 7,
				evaluatorMemberId: null,
				evaluatorMemberName: null,
				evaluatorGuestId: "g1",
				evaluatorGuestName: "Robin Visitor",
			}),
			pair({
				daysAgo: 28,
				evaluatorMemberId: null,
				evaluatorMemberName: null,
				evaluatorGuestId: "g1",
				evaluatorGuestName: "Robin Visitor",
			}),
		]);

		expect(rows[0]?.hasRepeat).toBe(true);
		expect(rows[0]?.distinctEvaluators).toBe(1);
	});

	it("keys repeats on the id, not the name", () => {
		// Two different people called Sam Chen are not a repeat. Keying on the
		// displayed name would report a pairing that never happened, and the
		// officer has no way to tell from the row that it is wrong.
		const rows = groupEvaluatorPairings([
			pair({
				daysAgo: 7,
				evaluatorMemberId: "a",
				evaluatorMemberName: "Sam Chen",
			}),
			pair({
				daysAgo: 21,
				evaluatorMemberId: "b",
				evaluatorMemberName: "Sam Chen",
			}),
		]);

		expect(rows[0]?.hasRepeat).toBe(false);
		expect(rows[0]?.distinctEvaluators).toBe(2);
	});

	it("drops a pairing with no assignee at all", () => {
		const rows = groupEvaluatorPairings([
			pair({
				daysAgo: 7,
				evaluatorMemberId: null,
				evaluatorMemberName: null,
				evaluatorGuestId: null,
				evaluatorGuestName: null,
			}),
		]);
		expect(rows).toEqual([]);
	});

	it("sorts repeat rows first, then by most recent evaluation", () => {
		const rows = groupEvaluatorPairings([
			// Speaker A: evaluated most recently, no repeat.
			pair({
				daysAgo: 3,
				speakerMemberId: "A",
				speakerName: "Aaa",
				evaluatorMemberId: "x",
				evaluatorMemberName: "Xen",
			}),
			// Speaker B: older, but the same evaluator twice.
			pair({
				daysAgo: 30,
				speakerMemberId: "B",
				speakerName: "Bbb",
				evaluatorMemberId: "y",
				evaluatorMemberName: "Yves",
			}),
			pair({
				daysAgo: 60,
				speakerMemberId: "B",
				speakerName: "Bbb",
				evaluatorMemberId: "y",
				evaluatorMemberName: "Yves",
			}),
			// Speaker C: older still, no repeat.
			pair({
				daysAgo: 45,
				speakerMemberId: "C",
				speakerName: "Ccc",
				evaluatorMemberId: "z",
				evaluatorMemberName: "Zia",
			}),
		]);

		expect(rows.map((r) => r.memberId)).toEqual(["B", "A", "C"]);
	});

	it("orders deterministically when two pairings share a date", () => {
		// A two-evaluator club: both evaluate the same speaker at the same meeting.
		// Without the key tie-break the pair's order — and, at the window's edge,
		// WHICH of them is shown — changes between loader runs (#437's class).
		const build = (order: PairingInput[]) => groupEvaluatorPairings(order);
		const a = pair({
			daysAgo: 7,
			evaluatorMemberId: "aaa",
			evaluatorMemberName: "Ada",
		});
		const b = pair({
			daysAgo: 7,
			evaluatorMemberId: "bbb",
			evaluatorMemberName: "Bo",
		});

		expect(build([a, b])[0]?.recent.map((p) => p.evaluatorKey)).toEqual([
			"aaa",
			"bbb",
		]);
		expect(build([b, a])[0]?.recent.map((p) => p.evaluatorKey)).toEqual([
			"aaa",
			"bbb",
		]);
	});

	it("returns no rows for no pairings", () => {
		expect(groupEvaluatorPairings([])).toEqual([]);
	});
});
