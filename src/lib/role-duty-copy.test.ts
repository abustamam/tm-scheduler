import { describe, expect, it } from "vitest";
import {
	notComingMaybeRoleText,
	notComingText,
	ROLE_FREED_DUTY_TEXT,
	roleDutyConfirmText,
	roleFreedDutyText,
} from "./role-duty-copy";

// protects=the confirm sentence names the roles and date and states the holder's duty; fails_when=the duty or "GavelUp doesn't tell anyone" is dropped; no_claim=none beyond protects
describe("roleDutyConfirmText", () => {
	it("names roles, date, the duty and that GavelUp tells no one", () => {
		const t = roleDutyConfirmText("Table Topics Master", "Tue, Oct 6");
		expect(t).toContain("You're Table Topics Master on Tue, Oct 6.");
		expect(t).toContain(
			"it's still on you to find a replacement or tell the Toastmaster or VPE",
		);
		expect(t).toContain("GavelUp doesn't tell anyone");
	});
});

// protects=singular vs plural freed text; fails_when=two roles read "Role freed."; no_claim=none beyond protects
describe("roleFreedDutyText", () => {
	it("is singular for one role and plural for more", () => {
		expect(roleFreedDutyText(1)).toBe(
			"Role freed. Now tell the Toastmaster or VPE, or find someone to cover it.",
		);
		expect(ROLE_FREED_DUTY_TEXT).toBe(roleFreedDutyText(1));
		expect(roleFreedDutyText(2)).toMatch(/^Roles freed\. Now tell/);
	});
});

// protects=no-role decline copy makes no notify claim and keeps the late-assignment clause; fails_when=the clause or the duty is dropped; no_claim=none beyond protects
describe("notComing texts", () => {
	it("keeps the since-load clause and the duty, and claims no notification", () => {
		const maybe = notComingMaybeRoleText("Tue, Oct 6");
		expect(maybe).toContain("since this page loaded, it will be freed too");
		expect(maybe).toContain("tell the Toastmaster or VPE");
		expect(notComingText("Tue, Oct 6")).toBe(
			"You'll be marked as not coming for the Tue, Oct 6 meeting.",
		);
	});
});
