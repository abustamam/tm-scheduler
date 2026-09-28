import { describe, expect, it } from "vitest";
import { leaveFeedbackInput } from "./role-feedback-input";

const MEETING = "22222222-2222-4222-8222-222222222222";
const SLOT = "33333333-3333-4333-8333-333333333333";
const MEMBER = "55555555-5555-4555-8555-555555555555";

const legacy = {
	meetingId: MEETING,
	target: { kind: "slot", id: SLOT },
	wentWell: "Crisp",
	tryNext: "",
};
const person = {
	meetingId: MEETING,
	recipientMemberId: MEMBER,
	role: { kind: "general" },
	wentWell: "Crisp",
	tryNext: "",
};

describe("leaveFeedbackInput (#1021)", () => {
	it("accepts the legacy shape unchanged, and the person shape for every role kind", () => {
		expect(leaveFeedbackInput.parse(legacy)).toEqual(legacy);
		for (const role of [
			{ kind: "slot", slotId: SLOT },
			{ kind: "tableTopics", speakerId: SLOT },
			{ kind: "definition", roleDefinitionId: SLOT },
			{ kind: "tableTopicsSpeaker" },
			{ kind: "general" },
		]) {
			expect(leaveFeedbackInput.parse({ ...person, role })).toEqual({
				...person,
				role,
			});
		}
	});

	it("refuses a mix of the two shapes rather than dropping half of it", () => {
		expect(() =>
			leaveFeedbackInput.parse({ ...legacy, recipientMemberId: MEMBER }),
		).toThrow();
		expect(() =>
			leaveFeedbackInput.parse({ ...person, target: legacy.target }),
		).toThrow();
		expect(() =>
			leaveFeedbackInput.parse({ ...legacy, role: { kind: "general" } }),
		).toThrow();
	});

	it("refuses a non-uuid recipient or role id, an unknown kind, and free-text labels", () => {
		expect(() =>
			leaveFeedbackInput.parse({ ...person, recipientMemberId: "x" }),
		).toThrow();
		expect(() =>
			leaveFeedbackInput.parse({
				...person,
				role: { kind: "slot", slotId: "not-a-uuid" },
			}),
		).toThrow();
		expect(() =>
			leaveFeedbackInput.parse({ ...person, role: { kind: "Speaker" } }),
		).toThrow();
		// A label smuggled beside a kind is stripped, never passed on.
		const parsed = leaveFeedbackInput.parse({
			...person,
			role: { kind: "general", label: "Anything" },
		});
		expect(parsed).toEqual(person);
	});

	it("has no field for a writer: an extra identity key is stripped", () => {
		const parsed = leaveFeedbackInput.parse({ ...person, writerId: MEMBER });
		expect(parsed).not.toHaveProperty("writerId");
	});
});
