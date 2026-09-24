import { describe, expect, it } from "vitest";
import { speechLogEvaluatorLabel, speechLogEvaluatorNames } from "./speech-log";

const ana = { name: "Ana", isGuest: false };
const bo = { name: "Bo", isGuest: false };
const jane = { name: "Jane Doe", isGuest: true };

describe("speechLogEvaluatorLabel (#681)", () => {
	it("past, one evaluator", () => {
		expect(
			speechLogEvaluatorLabel({
				evaluators: [ana],
				hasEvaluatorSlot: true,
				isUpcoming: false,
			}),
		).toBe("Evaluated by Ana");
	});

	it("past, a member and a guest — the guest is suffixed", () => {
		expect(
			speechLogEvaluatorLabel({
				evaluators: [ana, jane],
				hasEvaluatorSlot: true,
				isUpcoming: false,
			}),
		).toBe("Evaluated by Ana and Jane Doe (guest)");
	});

	it("past, three evaluators join with commas and a final 'and'", () => {
		expect(
			speechLogEvaluatorLabel({
				evaluators: [ana, bo, jane],
				hasEvaluatorSlot: true,
				isUpcoming: false,
			}),
		).toBe("Evaluated by Ana, Bo and Jane Doe (guest)");
	});

	it("upcoming, one evaluator is singular", () => {
		expect(
			speechLogEvaluatorLabel({
				evaluators: [ana],
				hasEvaluatorSlot: true,
				isUpcoming: true,
			}),
		).toBe("Evaluator: Ana");
	});

	it("upcoming, a lone guest evaluator is suffixed too", () => {
		expect(
			speechLogEvaluatorLabel({
				evaluators: [jane],
				hasEvaluatorSlot: true,
				isUpcoming: true,
			}),
		).toBe("Evaluator: Jane Doe (guest)");
	});

	it("upcoming, two evaluators is plural", () => {
		expect(
			speechLogEvaluatorLabel({
				evaluators: [ana, jane],
				hasEvaluatorSlot: true,
				isUpcoming: true,
			}),
		).toBe("Evaluators: Ana and Jane Doe (guest)");
	});

	it("upcoming, an evaluator slot nobody holds", () => {
		expect(
			speechLogEvaluatorLabel({
				evaluators: [],
				hasEvaluatorSlot: true,
				isUpcoming: true,
			}),
		).toBe("Evaluator not yet assigned");
	});

	it("past, an evaluator slot nobody held says nothing", () => {
		expect(
			speechLogEvaluatorLabel({
				evaluators: [],
				hasEvaluatorSlot: true,
				isUpcoming: false,
			}),
		).toBeNull();
	});

	it.each([
		true,
		false,
	])("no evaluator slot says nothing (upcoming=%s)", (isUpcoming) => {
		expect(
			speechLogEvaluatorLabel({
				evaluators: [],
				hasEvaluatorSlot: false,
				isUpcoming,
			}),
		).toBeNull();
	});
});

// The legacy `evaluatorName` a pre-#681 tab reads (see `listMySpeeches`).
describe("speechLogEvaluatorNames (#681)", () => {
	it("is null with no evaluators", () => {
		expect(speechLogEvaluatorNames([])).toBeNull();
	});

	it("joins every held evaluator, guests suffixed", () => {
		expect(speechLogEvaluatorNames([ana, jane])).toBe(
			"Ana and Jane Doe (guest)",
		);
	});
});
