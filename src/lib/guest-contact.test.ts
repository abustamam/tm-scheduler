import { describe, expect, it } from "vitest";
import {
	GUEST_CONTACT_REFUSAL_MESSAGES,
	GUEST_CONTACT_REFUSAL_ORDER,
	isGuestContactRefusal,
} from "./guest-contact";

describe("guest contact refusals (#1125)", () => {
	it("says the three sentences the issue names, verbatim", () => {
		expect(GUEST_CONTACT_REFUSAL_MESSAGES).toEqual({
			signed_in: "This person has signed in. They change it themselves.",
			member_here: "They're a member here. Edit them on their member page.",
			member_elsewhere:
				"They're a member of another club, which manages their contact.",
		});
	});

	it("tries them in the order signed in, a member here, a member elsewhere", () => {
		expect([...GUEST_CONTACT_REFUSAL_ORDER]).toEqual([
			"signed_in",
			"member_here",
			"member_elsewhere",
		]);
	});

	it("has a sentence for every reason and no reason without one", () => {
		expect(Object.keys(GUEST_CONTACT_REFUSAL_MESSAGES).sort()).toEqual(
			[...GUEST_CONTACT_REFUSAL_ORDER].sort(),
		);
	});

	it("narrows a value the server sent, and refuses anything else", () => {
		for (const reason of GUEST_CONTACT_REFUSAL_ORDER) {
			expect(isGuestContactRefusal(reason)).toBe(true);
		}
		expect(isGuestContactRefusal(null)).toBe(false);
		expect(isGuestContactRefusal(undefined)).toBe(false);
		expect(isGuestContactRefusal("multi_club")).toBe(false);
		expect(isGuestContactRefusal(3)).toBe(false);
	});
});
