/**
 * `isEligibleCandidate` and `disqualificationFor` — the pure half of the award
 * eligibility gate (#510, #723).
 *
 * NOT an integration suite, deliberately, and that is the point of the file
 * existing separately from `award-candidates.integration.test.ts`: these two
 * functions take their data as arguments, so they can be exercised with no
 * database at all. An assertion living in the DB-backed suite would carry that
 * suite's `describe.skipIf(!hasTestDb)` and vanish from a `bun run test` with
 * `TEST_DATABASE_URL` unset — silently, with the pass count still green. This
 * is the gate `castVote` calls; it should be the LAST thing that skips.
 *
 * `#/db` is mocked only so the module can be imported: `src/db/index.ts`
 * evaluates `process.env.DATABASE_URL!` at load, and neither function under
 * test touches the client.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

const { disqualificationFor, isEligibleCandidate } = await import(
	"./award-candidates-logic"
);
const { AWARD_CATEGORIES } = await import("./minutes-logic");

type Candidates = Parameters<typeof isEligibleCandidate>[0];
type Index = Parameters<typeof disqualificationFor>[0];

const ANA = { kind: "member" as const, id: "m-1" };
const BO = { kind: "member" as const, id: "m-2" };

/** Every category empty; override the one a test cares about. */
function candidates(over: Partial<Candidates> = {}): Candidates {
	return {
		best_speaker: [],
		best_evaluator: [],
		best_table_topics: [],
		...over,
	};
}

function index(over: Partial<Index> = {}): Index {
	return {
		best_speaker: new Map(),
		best_evaluator: new Map(),
		best_table_topics: new Map(),
		...over,
	};
}

const listed = (
	id: string,
	name: string,
	disqualified: { reason: string } | null = null,
) => ({ kind: "member" as const, id, name, disqualified });

describe("isEligibleCandidate (#510, #723)", () => {
	it("is true for a listed candidate with no ruling against them", () => {
		const c = candidates({ best_speaker: [listed("m-1", "Ana")] });
		expect(isEligibleCandidate(c, "best_speaker", ANA)).toBe(true);
	});

	it("is false for someone who is not on the list at all", () => {
		const c = candidates({ best_speaker: [listed("m-1", "Ana")] });
		expect(isEligibleCandidate(c, "best_speaker", BO)).toBe(false);
	});

	// THE load-bearing assertion of #723 (AC 3). Hiding the name on the ballot is
	// a courtesy to a phone that has polled; this is the only thing that refuses
	// the vote, and a hand-crafted POST never polls at all.
	it("is FALSE for a listed candidate who has been disqualified", () => {
		const c = candidates({
			best_speaker: [listed("m-1", "Ana", { reason: "Outside the window" })],
		});
		expect(isEligibleCandidate(c, "best_speaker", ANA)).toBe(false);
	});

	// AC 7, at the level the gate actually decides it: the lists are per
	// category, so a ruling in one cannot leak into another. A shared
	// `Set`/`Map` keyed on the candidate alone is the bug this catches, and it
	// would look correct in every single-category test above.
	it("does not leak a ruling across categories", () => {
		const c = candidates({
			best_speaker: [listed("m-1", "Ana", { reason: "Outside the window" })],
			best_evaluator: [listed("m-1", "Ana")],
		});
		expect(isEligibleCandidate(c, "best_speaker", ANA)).toBe(false);
		expect(isEligibleCandidate(c, "best_evaluator", ANA)).toBe(true);
	});

	it("distinguishes a member from a guest with the same id", () => {
		const c = candidates({
			best_speaker: [{ ...listed("x", "Ana"), kind: "guest" as const }],
		});
		expect(
			isEligibleCandidate(c, "best_speaker", { kind: "member", id: "x" }),
		).toBe(false);
		expect(
			isEligibleCandidate(c, "best_speaker", { kind: "guest", id: "x" }),
		).toBe(true);
	});
});

describe("disqualificationFor (#723)", () => {
	// This is the arm `isEligibleCandidate` cannot cover: a write-in has no
	// derived list to be on, so `castVote`'s write-in branch consults this
	// directly. Without it the write-in arm is the hole in the gate.
	it("answers for a WRITE-IN, which isEligibleCandidate cannot", () => {
		const i = index({
			best_table_topics: new Map([
				["writeIn:bo smith", { reason: "No Word of the Day" }],
			]),
		});
		expect(
			disqualificationFor(i, "best_table_topics", {
				kind: "writeIn",
				id: "bo smith",
			}),
		).toEqual({ reason: "No Word of the Day" });
		expect(
			disqualificationFor(i, "best_table_topics", {
				kind: "writeIn",
				id: "ana lee",
			}),
		).toBe(null);
	});

	it("is null in a category with nothing recorded", () => {
		const i = index();
		for (const category of AWARD_CATEGORIES) {
			expect(disqualificationFor(i, category, ANA)).toBe(null);
		}
	});
});
