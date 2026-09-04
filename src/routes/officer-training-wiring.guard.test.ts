/**
 * The DCP route's Club Officer Training wiring, and the promise that nothing
 * writes goal 9 on its own (#531).
 *
 * ## Why a source guard and not a render test
 *
 * `OfficerTrainingPanel` has 37 component tests — with props the test supplies.
 * That is exactly the position CLAUDE.md records #319 shipping from: both
 * components were well covered and the bug was in neither, because the defect
 * was the EXPRESSION at the call site. Every prop this route computes is
 * untested by construction, and three of them decide whether the feature works
 * at all:
 *
 *   · which category the panel renders under (`cat === "training"`),
 *   · which goal row carries the derived badge (`g.key === TRAINING_GOAL_KEY`),
 *   · whether the apply is OFFERED (`training.hasRecords`) — the guard that
 *     stops an apply of 0 clearing a hand-entered Met on no evidence.
 *
 * Rendering `_authed/admin/dcp.tsx` to observe them means a router context, an
 * auth context and five mocked server fns. The repo's idiom for a layer vitest
 * cannot otherwise reach is a comment-blind source guard, and this is one.
 *
 * ## Two read modes, one per assertion class
 *
 * `src/test/guard-source.ts` is explicit that these need OPPOSITE readers:
 *
 *   · "must BE present" → `readSource` (comment-blind). A comment naming the
 *     expression satisfies a raw `toContain`, so the real wiring could be
 *     deleted with a comment above it still quoting it. This file's own header
 *     quotes `cat === "training"` and `training.hasRecords`, which is precisely
 *     the trip-wire.
 *   · "must be ABSENT" → `readFileSync` (raw). Stripping only DELETES text, and
 *     the stripper is a lexer rather than a parser, so it could erase a real
 *     offending line and report clean — a false PASS on the half that exists to
 *     catch the regression.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TRAINING_GOAL_KEY } from "#/lib/officer-training";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");

const ROUTE = "src/routes/_authed/admin/dcp.tsx";
const TRAINING_LOGIC = "src/server/officer-training-logic.ts";
const TRAINING_FNS = "src/server/officer-training.ts";

/** Comment-blind — for "the wiring must BE present" only. */
const stripped = (rel: string) => readSource(rel);
/** Verbatim — for "the offender must be ABSENT" only. */
const raw = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

describe("DCP route → officer training wiring (#531)", () => {
	const src = stripped(ROUTE);

	it("loads the training payload in the route loader", () => {
		// Without this the panel renders from nothing on first paint and the admin
		// sees an empty card until some later client fetch — or never, since the
		// route has no other trigger.
		expect(src).toContain("getOfficerTraining({");
		expect(src).toContain("clubId: club.clubId, programYear: year");
	});

	it("renders the panel under the TRAINING category, not another one", () => {
		// Goal 9 is the training goal. Rendering the panel under "administration"
		// (goal 10, the other composite) typechecks, renders, and puts the records
		// under the wrong heading with every other gate green.
		expect(src).toContain('cat === "training" && training');
		expect(src).toContain("<OfficerTrainingPanel");
		expect(src).toContain("view={training}");
	});

	it("keys the derived badge on the goal-9 constant, not a bare string", () => {
		// `g.key === "g10"` is one character from `"g9"` and would move the
		// suggestion onto the composite ADMINISTRATION goal.
		expect(src).toContain("g.key === TRAINING_GOAL_KEY");
		expect(TRAINING_GOAL_KEY).toBe("g9");
	});

	it("offers the apply ONLY once training is recorded", () => {
		// The gate that stops an apply of 0 clearing a President's hand-entered
		// Met on no evidence — the same shape as `pathwaysSynced` gating the
		// education assist. Dropping `.hasRecords` leaves a button that is always
		// offered and, for a club that has recorded nothing, always destructive.
		expect(src).toContain('category === "training" && training.hasRecords');
		expect(src).toContain("suggestTraining ?");
	});

	it("names the value the apply will write, before the click", () => {
		// This action can LOWER a stored value, so the label has to say which way
		// it is going. A generic "Apply" would make clearing a Met look like
		// setting one.
		expect(src).toContain("Apply training records (mark met)");
		expect(src).toContain("Apply training records (mark not met)");
	});

	it("refreshes the scoreboard after every training write", () => {
		// The g9 badge and the panel's tallies come from the SAME rows. Updating
		// the panel alone leaves the badge above it claiming 3 of 4 after the
		// fourth officer was recorded.
		expect(src).toContain("afterTrainingWrite");
		expect(src).toContain("setView(await getScoreboard(");
	});
});

describe("nothing writes goal 9 on its own (#531 / ADR-0019)", () => {
	// The issue's central promise: "a club must not be told it missed a point
	// because someone forgot to tick a box in our app." Recording training must
	// therefore never touch `dcp_goal_progress`. RAW reads — these are
	// offender sweeps, where stripping could only hide a real offence.
	for (const rel of [TRAINING_LOGIC, TRAINING_FNS]) {
		it(`${rel} never touches dcp_goal_progress`, () => {
			const source = raw(rel);
			// Both spellings: the drizzle symbol AND the snake_case SQL name, since a
			// raw `sql` template is invisible to typecheck.
			expect(
				source,
				`${rel} must not write dcp_goal_progress. Officer training produces a SUGGESTION the President applies (ADR-0019's third assist); a write here would tick goal 9 silently, and TI — not GavelUp — is the record of who was trained.`,
			).not.toContain("dcpGoalProgress");
			expect(source).not.toContain("dcp_goal_progress");
		});
	}

	it("the apply is the ONLY path from training records to goal 9", () => {
		// `applyTrainingSuggestion` lives in `dcp-logic.ts` and routes through
		// `updateGoal`, which owns the composite 0/1 clamp and the audit stamp. A
		// second upsert would be a second place to forget the clamp.
		const dcpLogic = stripped("src/server/dcp-logic.ts");
		expect(dcpLogic).toContain("export async function applyTrainingSuggestion");
		expect(dcpLogic).toContain("goalKey: TRAINING_GOAL_KEY");
		expect(dcpLogic).toContain("await updateGoal(");
	});

	it("the scoreboard read reports the suggestion without storing it", () => {
		// Present on the read payload…
		const dcpLogic = stripped("src/server/dcp-logic.ts");
		expect(dcpLogic).toContain("deriveTrainingSuggestion(clubId, programYear)");
		expect(dcpLogic).toContain("derivedTraining,");

		// …and `getScoreboard` itself must not write. RAW read — an offender sweep,
		// where stripping could delete the very line being looked for.
		const body = getScoreboardBody(raw("src/server/dcp-logic.ts"));
		// Vacuity floor FIRST. Without it, a rename that made the slice empty
		// would satisfy both negatives below and this case could only pass. The
		// floor counts something structural about the function (its two
		// distinguishing calls), not a lexical accident of how it is written.
		expect(body).toContain("computeDcpSummary({");
		expect(body).toContain("deriveTrainingSuggestion(");

		expect(body).not.toContain(".insert(");
		expect(body).not.toContain(".update(");
	});
});

/**
 * The text of `getScoreboard`, sliced from its declaration to the next
 * top-level one. Never to a bare `});` — CLAUDE.md records #565, where that
 * pattern matched a later column-0 brace and ran a slice straight through the
 * neighbouring function, lending it a call it did not make. Forty of 162 slices
 * over-captured, one by 11,000 characters.
 */
function getScoreboardBody(source: string): string {
	const start = source.indexOf("export async function getScoreboard(");
	if (start === -1) {
		throw new Error(
			"getScoreboard not found in dcp-logic.ts — renamed or removed. Re-point this guard rather than deleting the case.",
		);
	}
	const rest = source.slice(start);
	const lines = rest.split("\n");
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		// i > 0 skips the declaration's own opening line.
		if (i > 0 && /^(?:export |\/\/ ---)/.test(line)) {
			return rest.slice(0, offset);
		}
		offset += line.length + 1;
	}
	return rest;
}
