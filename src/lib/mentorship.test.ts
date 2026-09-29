import { describe, expect, it } from "vitest";
import { mentorshipFocusEnum } from "#/db/schema";
import {
	isActivePairing,
	isNewMemberMentorship,
	MENTORSHIP_FOCUS_LABELS,
	MENTORSHIP_FOCUSES,
	mentorshipFocusText,
	orderMentorCandidates,
} from "./mentorship";

describe("mentorship focus (#939)", () => {
	it("is the database enum, value for value", () => {
		expect([...MENTORSHIP_FOCUSES]).toEqual(mentorshipFocusEnum.enumValues);
	});

	it("labels every focus, and none of them reads as the charter club mentor", () => {
		for (const f of MENTORSHIP_FOCUSES) {
			expect(MENTORSHIP_FOCUS_LABELS[f]).toBeTruthy();
			expect(MENTORSHIP_FOCUS_LABELS[f].toLowerCase()).not.toContain("club");
		}
	});

	it("reads as the label, the free text for 'other', or nothing", () => {
		expect(mentorshipFocusText("new_member", null)).toBe("New member");
		expect(mentorshipFocusText("other", "  Evaluations ")).toBe("Evaluations");
		expect(mentorshipFocusText("other", "   ")).toBe("Other");
		expect(mentorshipFocusText("contest", "ignored")).toBe("Contest");
		expect(mentorshipFocusText(null, null)).toBeNull();
	});
});

describe("which pairings count (#939)", () => {
	const ended = new Date("2026-09-10T00:00:00Z");
	it("active means not ended", () => {
		expect(isActivePairing({ endedAt: null })).toBe(true);
		expect(isActivePairing({ endedAt: ended })).toBe(false);
	});
	it("a new-member mentorship is active AND focused on new_member", () => {
		expect(isNewMemberMentorship({ focus: "new_member", endedAt: null })).toBe(
			true,
		);
		expect(isNewMemberMentorship({ focus: "new_member", endedAt: ended })).toBe(
			false,
		);
		expect(isNewMemberMentorship({ focus: "contest", endedAt: null })).toBe(
			false,
		);
		expect(isNewMemberMentorship({ focus: null, endedAt: null })).toBe(false);
	});
});

describe("orderMentorCandidates (#939)", () => {
	it("puts willing members first, each group by name, and drops the mentee", () => {
		const ordered = orderMentorCandidates(
			[
				{ id: "z", name: "Zed", willingToMentor: false },
				{ id: "me", name: "Aaron Mentee", willingToMentor: true },
				{ id: "b", name: "Bea", willingToMentor: true },
				{ id: "a", name: "Abe", willingToMentor: false },
				{ id: "c", name: "Cal", willingToMentor: true },
			],
			"me",
		);
		expect(ordered.map((c) => c.id)).toEqual(["b", "c", "a", "z"]);
	});
});
