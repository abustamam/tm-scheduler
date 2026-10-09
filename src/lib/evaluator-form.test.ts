import { describe, expect, it } from "vitest";
import { resolveEvaluatorLinks } from "#/lib/agenda";
import {
	GENERIC_EVALUATION_RESOURCE,
	resolveEvaluationResources,
} from "#/lib/evaluation-resources";
import { evaluatingByMember, evaluatorFormBrief } from "#/lib/evaluator-form";
import { buildNudge } from "#/lib/nudge";
import { dutiesForRole } from "#/lib/role-duties";

const ICE_BREAKER = resolveEvaluationResources("Ice Breaker").resources;

describe("evaluatorFormBrief", () => {
	it("is null for a null target (no pairing)", () => {
		expect(evaluatorFormBrief(null)).toBeNull();
	});

	it("is null when the speaker slot has no holder", () => {
		expect(evaluatorFormBrief({ speakerName: null })).toBeNull();
		expect(evaluatorFormBrief({ speakerName: "   " })).toBeNull();
	});

	it("resolves a known project to its form", () => {
		const b = evaluatorFormBrief({
			speakerName: "Priyanka Rao",
			projectName: "Ice Breaker",
		});
		expect(b?.isGenericFallback).toBe(false);
		expect(b?.resources).toEqual(ICE_BREAKER);
		expect(b?.resources[0]?.url).toContain("8101e");
	});

	it("carries every resource of a multi-form project", () => {
		const b = evaluatorFormBrief({
			speakerName: "Priyanka Rao",
			projectName: "Evaluation and Feedback",
		});
		expect(b?.resources.length).toBeGreaterThan(1);
		expect(b?.isGenericFallback).toBe(false);
	});

	it.each([
		null,
		undefined,
		"TBA",
		"A Project Nobody Wrote",
	])("falls back to the generic form for project %s", (projectName) => {
		const b = evaluatorFormBrief({ speakerName: "Priyanka", projectName });
		expect(b?.isGenericFallback).toBe(true);
		expect(b?.resources).toEqual([GENERIC_EVALUATION_RESOURCE]);
	});

	it("names the speaker by preferred name, else first name (#486)", () => {
		expect(
			evaluatorFormBrief({
				speakerName: "Priyanka Rao",
				speakerPreferredName: "Priya",
			})?.speaker,
		).toBe("Priya");
		expect(evaluatorFormBrief({ speakerName: "Priyanka Rao" })?.speaker).toBe(
			"Priyanka",
		);
		expect(
			evaluatorFormBrief({
				speakerName: "Priyanka Rao",
				speakerPreferredName: "  ",
			})?.speaker,
		).toBe("Priyanka");
	});
});

describe("evaluatingByMember", () => {
	const paired = { speakerName: "Priyanka Rao", projectName: "Ice Breaker" };

	it("gives a paired evaluator's first slot an entry", () => {
		const m = evaluatingByMember([{ assigneeId: "m1", evaluates: paired }]);
		expect(m.get("m1")?.speaker).toBe("Priyanka");
	});

	it("an earlier non-evaluator slot blocks a later paired one", () => {
		const m = evaluatingByMember([
			{ assigneeId: "m1", evaluates: null },
			{ assigneeId: "m1", evaluates: paired },
		]);
		expect(m.has("m1")).toBe(false);
	});

	it("omits an unpaired evaluator, an unassigned slot and a speaker-less pair", () => {
		const m = evaluatingByMember([
			{ assigneeId: "m1", evaluates: null },
			{ assigneeId: null, evaluates: paired },
			{ assigneeId: "m2", evaluates: { speakerName: null } },
		]);
		expect(m.size).toBe(0);
	});

	it("does not let a later slot replace the first one's entry", () => {
		const m = evaluatingByMember([
			{ assigneeId: "m1", evaluates: paired },
			{
				assigneeId: "m1",
				evaluates: { speakerName: "Someone Else", projectName: null },
			},
		]);
		expect(m.get("m1")?.speaker).toBe("Priyanka");
	});
});

describe("resolveEvaluatorLinks (#1163 fields)", () => {
	it("carries the speaker's preferred name and project onto `evaluates`", () => {
		const [speaker, evaluator] = resolveEvaluatorLinks([
			{
				id: "s1",
				evaluatesSlotId: null,
				assigneeName: "Priyanka Rao",
				holderPreferredName: "Priya",
				speechTitle: "Hello",
				projectName: "Ice Breaker",
			},
			{
				id: "e1",
				evaluatesSlotId: "s1",
				assigneeName: "Sam Lee",
				speechTitle: null,
			},
		]);
		expect(speaker?.evaluates).toBeNull();
		expect(evaluator?.evaluates).toEqual({
			slotId: "s1",
			speakerName: "Priyanka Rao",
			speakerPreferredName: "Priya",
			speechTitle: "Hello",
			projectName: "Ice Breaker",
		});
	});
});

describe("agenda and rail drafts (#1163)", () => {
	it("are the same string for the same evaluator", () => {
		const rows = resolveEvaluatorLinks([
			{
				id: "s1",
				evaluatesSlotId: null,
				assigneeName: "Priyanka Rao",
				holderPreferredName: "Priya",
				speechTitle: "Hello",
				projectName: "Ice Breaker",
				assigneeId: "m-speaker",
			},
			{
				id: "e1",
				evaluatesSlotId: "s1",
				assigneeName: "Sam Lee",
				speechTitle: null,
				assigneeId: "m-eval",
			},
		]);
		const evalRow = rows[1];
		const input = {
			name: "Sam Lee",
			roleName: "Evaluator",
			meetingDate: "Thu, Jul 23",
			shareUrl: "https://gavelup.app/club/mcf/meeting/abc",
			mode: "confirm" as const,
		};
		// The agenda builds its brief from the slot; the rail from the map.
		const agenda = buildNudge({
			...input,
			evaluating: evaluatorFormBrief(evalRow?.evaluates ?? null),
		});
		const rail = buildNudge({
			...input,
			evaluating: evaluatingByMember(rows).get("m-eval"),
		});
		expect(rail.message).toBe(agenda.message);
		expect(agenda.message).toContain("evaluating Priya's speech");
	});
});

describe("Evaluator duties", () => {
	it("still owns none: the form is a brief, not a RoleDuty", () => {
		expect(
			dutiesForRole({ roleKey: "evaluator", roleName: "Evaluator" }),
		).toEqual([]);
	});
});
