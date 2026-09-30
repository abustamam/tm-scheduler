// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isQuizComplete,
	MAX_REASONS,
	PATH_QUIZ,
	QUIZ_HANDOFF_KEY,
	QUIZ_PATHS,
	type QuizAnswers,
	scorePathQuiz,
	stashQuizSuggestion,
	suggestionWhy,
	suggestPaths,
	takeQuizSuggestion,
} from "./path-quiz";
import {
	CURRENT_PATH_GUIDE,
	isCurrentCourseCode,
	PATHWAYS_CATALOG,
} from "./pathways-catalog";

const currentCodes = PATHWAYS_CATALOG.filter((p) => p.status === "current")
	.map((p) => p.courseCode)
	.sort();
const legacyCodes = PATHWAYS_CATALOG.filter((p) => p.status === "legacy").map(
	(p) => p.courseCode,
);

/** For each question, the option weighing most toward `code` (first on a tie). */
function answersFavouring(code: string): QuizAnswers {
	const w = (o: { weights: object }) =>
		(o.weights as Record<string, number | undefined>)[code] ?? 0;
	return Object.fromEntries(
		PATH_QUIZ.map((q) => {
			const best = q.options.reduce((a, b) => (w(b) > w(a) ? b : a));
			return [q.id, best.id];
		}),
	);
}

describe("CURRENT_PATH_GUIDE (catalog, #935)", () => {
	it("covers exactly the current paths: no legacy path, none missing", () => {
		expect(Object.keys(CURRENT_PATH_GUIDE).sort()).toEqual(currentCodes);
		expect(currentCodes).toHaveLength(6);
	});

	it("gives each a focus line and TI's page for that path", () => {
		for (const p of PATHWAYS_CATALOG.filter((x) => x.status === "current")) {
			const guide = isCurrentCourseCode(p.courseCode)
				? CURRENT_PATH_GUIDE[p.courseCode]
				: undefined;
			expect(guide?.focus.trim().length).toBeGreaterThan(20);
			// TI's own path pages: pathways-overview/pathways-<name>-path.
			const slug = p.name.toLowerCase().replace(/\s+/g, "-");
			expect(guide?.tiUrl).toBe(
				`https://www.toastmasters.org/pathways-overview/pathways-${slug}-path`,
			);
		}
	});
});

describe("the quiz content", () => {
	it("has 5-8 questions, each with unique option ids", () => {
		expect(PATH_QUIZ.length).toBeGreaterThanOrEqual(5);
		expect(PATH_QUIZ.length).toBeLessThanOrEqual(8);
		expect(new Set(PATH_QUIZ.map((q) => q.id)).size).toBe(PATH_QUIZ.length);
		for (const q of PATH_QUIZ) {
			expect(q.options.length).toBeGreaterThanOrEqual(2);
			expect(new Set(q.options.map((o) => o.id)).size).toBe(q.options.length);
		}
	});

	it("weights only current paths, and every option weighs something", () => {
		for (const q of PATH_QUIZ) {
			for (const o of q.options) {
				const codes = Object.keys(o.weights);
				expect(codes.length, `${q.id}/${o.id}`).toBeGreaterThan(0);
				for (const c of codes) expect(currentCodes).toContain(c);
			}
		}
	});

	it("QUIZ_PATHS is the current paths only", () => {
		expect(QUIZ_PATHS.map((p) => p.courseCode).sort()).toEqual(currentCodes);
	});
});

describe("scorePathQuiz", () => {
	it("every current path is the top result for some answer set", () => {
		for (const code of currentCodes) {
			const [top, second] = scorePathQuiz(answersFavouring(code));
			expect(top?.courseCode, code).toBe(code);
			// Strictly ahead, so reachability does not lean on tie order.
			expect(top?.score).toBeGreaterThan(second?.score ?? 0);
		}
	});

	it("never returns a legacy path, for any single-answer set", () => {
		for (const q of PATH_QUIZ) {
			for (const o of q.options) {
				const codes = scorePathQuiz({ [q.id]: o.id }).map((s) => s.courseCode);
				for (const l of legacyCodes) expect(codes).not.toContain(l);
				expect(codes.sort()).toEqual(currentCodes);
			}
		}
	});

	it("adds each chosen option's weights", () => {
		const q = PATH_QUIZ[0];
		const o = q?.options[0];
		if (!q || !o) throw new Error("no questions");
		const scores = scorePathQuiz({ [q.id]: o.id });
		for (const s of scores) expect(s.score).toBe(o.weights[s.courseCode] ?? 0);
	});

	it("ignores unknown questions and options rather than trusting them", () => {
		const scores = scorePathQuiz({ nope: "x", [PATH_QUIZ[0]?.id ?? ""]: "x" });
		expect(scores.every((s) => s.score === 0)).toBe(true);
	});

	it("breaks ties in catalog order", () => {
		const scores = scorePathQuiz({});
		expect(scores.map((s) => s.courseCode)).toEqual(
			QUIZ_PATHS.map((p) => p.courseCode),
		);
	});

	it("builds the reasons from the member's own answers, strongest first, capped", () => {
		const code = currentCodes[0] ?? "";
		const answers = answersFavouring(code);
		const top = scorePathQuiz(answers).find((s) => s.courseCode === code);
		const chosenLabels = PATH_QUIZ.map(
			(q) => q.options.find((o) => o.id === answers[q.id])?.label,
		);
		expect(top?.reasons.length).toBe(MAX_REASONS);
		for (const r of top?.reasons ?? []) expect(chosenLabels).toContain(r);
	});
});

describe("suggestPaths", () => {
	it("suggests nothing before any answer", () => {
		expect(suggestPaths({})).toEqual([]);
	});

	it("shows a close runner-up and hides a distant one", () => {
		// One answer weighing two paths 2 and 1: second is exactly half, shown.
		const q = PATH_QUIZ.find((x) =>
			x.options.some((o) => Object.values(o.weights).sort().join() === "1,2"),
		);
		const o = q?.options.find(
			(x) => Object.values(x.weights).sort().join() === "1,2",
		);
		if (!q || !o) throw new Error("fixture: no 2+1 option");
		expect(suggestPaths({ [q.id]: o.id })).toHaveLength(2);

		// One answer weighing a single path: nothing else scored, one shown.
		const single = PATH_QUIZ.flatMap((x) =>
			x.options.map((opt) => ({ q: x, o: opt })),
		).find((x) => Object.keys(x.o.weights).length === 1);
		if (!single) throw new Error("fixture: no single-path option");
		expect(suggestPaths({ [single.q.id]: single.o.id })).toHaveLength(1);
	});

	it("hides a runner-up below half the leader", () => {
		// Persuasion-leaning answers score 8707 at 12 and the runner-up (8701)
		// at 5: under half, so only one path is shown.
		const answers = answersFavouring("8707");
		const [first, second] = scorePathQuiz(answers);
		expect([first?.score, second?.score]).toEqual([12, 5]);
		expect(suggestPaths(answers).map((s) => s.courseCode)).toEqual(["8707"]);
	});
});

describe("isQuizComplete / suggestionWhy", () => {
	it("is complete only when every question has a real answer", () => {
		const all = answersFavouring(currentCodes[0] ?? "");
		expect(isQuizComplete(all)).toBe(true);
		const { [PATH_QUIZ[0]?.id ?? ""]: _dropped, ...rest } = all;
		expect(isQuizComplete(rest)).toBe(false);
		expect(isQuizComplete({ ...all, [PATH_QUIZ[0]?.id ?? ""]: "bogus" })).toBe(
			false,
		);
	});

	it("quotes the answers", () => {
		const [top] = scorePathQuiz(answersFavouring(currentCodes[0] ?? ""));
		if (!top) throw new Error("no result");
		expect(suggestionWhy(top)).toBe(
			`You picked “${top.reasons[0]}” and “${top.reasons[1]}”.`,
		);
		expect(suggestionWhy({ ...top, reasons: [] })).toBe("");
	});
});

describe("the picker handoff", () => {
	afterEach(() => {
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it("round-trips a current path once, then is empty", () => {
		stashQuizSuggestion("8701");
		expect(sessionStorage.getItem(QUIZ_HANDOFF_KEY)).toBe("8701");
		expect(takeQuizSuggestion()).toBe("8701");
		expect(takeQuizSuggestion()).toBeNull();
	});

	it("refuses a legacy or unknown code, and clears it", () => {
		sessionStorage.setItem(QUIZ_HANDOFF_KEY, legacyCodes[0] ?? "8705");
		expect(takeQuizSuggestion()).toBeNull();
		expect(sessionStorage.getItem(QUIZ_HANDOFF_KEY)).toBeNull();
		sessionStorage.setItem(QUIZ_HANDOFF_KEY, "junk");
		expect(takeQuizSuggestion()).toBeNull();
	});

	it.each([
		"__proto__",
		"constructor",
		"toString",
		"hasOwnProperty",
	])("refuses the inherited key %s", (key) => {
		sessionStorage.setItem(QUIZ_HANDOFF_KEY, key);
		expect(takeQuizSuggestion()).toBeNull();
		expect(isCurrentCourseCode(key)).toBe(false);
	});

	it("survives blocked storage", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(() => stashQuizSuggestion("8701")).not.toThrow();
		expect(takeQuizSuggestion()).toBeNull();
	});
});
