/**
 * `parseEvaluation` and what a 200 answer from the evaluations API may be (#1047, fifth review
 * round). An error object or `null` is not an evaluation and must not read as an empty one; an
 * evaluation with an explicitly empty `responses` list is a real, empty evaluation.
 * Run: cd extension && bunx vitest run lib/easy-speak-parse-evaluation.test.ts
 */
import { describe, expect, it } from "vitest";
import { PageShapeError, parseEvaluation } from "./easy-speak-parse";
import { FIXTURE_IDENTITY, setup } from "./easy-speak-test-kit";

const item = {
	evaluation_id: 501,
	direction: "received",
	speaker_name: "Avery Alderfinch",
	evaluator_name: "Dana Vexford",
	meeting_date: "2026-09-22",
} as Parameters<typeof parseEvaluation>[0];

const bad: [string, unknown][] = [
	["an error object", { error: "temporarily unavailable" }],
	["null", null],
	["an empty object", {}],
	["an evaluation that is null", { evaluation: null }],
	["an evaluation that is a string", { evaluation: "gone" }],
	["an evaluation that is a list", { evaluation: [] }],
	["an evaluation with no responses list", { evaluation: { evaluation_id: 501 } }],
];

describe("parseEvaluation structure", () => {
	for (const [label, answer] of bad) {
		it(`rejects ${label} as a page-shape failure`, () => {
			expect(() => parseEvaluation(item, answer, "Avery Alderfinch")).toThrow(PageShapeError);
		});
	}

	it("accepts an evaluation whose responses list is explicitly empty", () => {
		const e = parseEvaluation(item, { evaluation: { evaluation_id: 501, responses: [] } }, "Avery Alderfinch");
		expect(e.esId).toBe("501");
		expect(e.text).toBe("");
	});
});

describe("an unusable 200 answer for an evaluation, in the walk", () => {
	for (const [label, body] of [
		["an error object", JSON.stringify({ error: "temporarily unavailable" })],
		["null", "null"],
	] as const) {
		it(`exports no evaluation for ${label}, and says evaluations were skipped`, async () => {
			const s = setup({ identity: FIXTURE_IDENTITY, override: (url) => (url.endsWith("/eval/501") ? body : undefined) });
			const { bundle } = await s.run();
			expect(bundle.evaluations).toEqual([]);
			expect(s.progress.some((l) => /evaluations skipped: evaluation 501 is not the Easy-Speak page/.test(l))).toBe(true);
			expect(bundle.meetings).toHaveLength(3);
		});
	}

	it("still exports an evaluation with an empty responses list", async () => {
		const s = setup({
			override: (url) => (url.endsWith("/eval/501") ? JSON.stringify({ evaluation: { evaluation_id: 501, responses: [] } }) : undefined),
		});
		const { bundle } = await s.run();
		expect(bundle.evaluations.map((e) => e.esId).sort()).toEqual(["501", "502"]);
		expect(s.progress.some((l) => /evaluations skipped/.test(l))).toBe(false);
	});
});
