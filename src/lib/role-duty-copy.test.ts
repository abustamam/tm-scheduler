import { describe, expect, it } from "vitest";
import {
	DUTY_TOAST_MS,
	NOT_COMING_NO_ROLE_TEXT,
	notComingMaybeRoleText,
	notComingText,
	notComingToast,
	ROLE_FREED_DUTY_TEXT,
	ROLE_KEPT_DUTY_TEXT,
	roleDutyConfirmText,
	roleFreedDutyText,
} from "./role-duty-copy";

describe("roleDutyConfirmText", () => {
	// protects=the confirm sentence names the roles and date and states the holder's duty; fails_when=the duty or "GavelUp doesn't tell anyone" is dropped; no_claim=none beyond protects
	it("names roles, date, the duty and that GavelUp tells no one", () => {
		const t = roleDutyConfirmText("Table Topics Master", "Tue, Oct 6");
		expect(t).toContain("You're Table Topics Master on Tue, Oct 6.");
		expect(t).toContain(
			"it's still on you to find a replacement or tell the Toastmaster or VPE",
		);
		expect(t).toContain("GavelUp doesn't tell anyone");
	});
});

describe("roleFreedDutyText", () => {
	// protects=singular vs plural freed text; fails_when=two roles read "Role freed."; no_claim=none beyond protects
	it("is singular for one role and plural for more", () => {
		expect(roleFreedDutyText(1)).toBe(
			"Role freed. Now tell the Toastmaster or VPE, or find someone to cover it.",
		);
		expect(ROLE_FREED_DUTY_TEXT).toBe(roleFreedDutyText(1));
		expect(roleFreedDutyText(2)).toMatch(/^Roles freed\. Now tell/);
	});
});

describe("notComing texts", () => {
	// protects=no-role decline copy makes no notify claim and keeps the late-assignment clause; fails_when=the clause or the duty is dropped; no_claim=none beyond protects
	it("keeps the since-load clause and the duty, and claims no notification", () => {
		const maybe = notComingMaybeRoleText("Tue, Oct 6");
		expect(maybe).toContain("since this page loaded, it will be freed too");
		expect(maybe).toContain("tell the Toastmaster or VPE");
		expect(notComingText("Tue, Oct 6")).toBe(
			"You'll be marked as not coming for the Tue, Oct 6 meeting.",
		);
	});
});

describe("notComingToast", () => {
	// protects=a decline that freed roles reads Role(s) freed for DUTY_TOAST_MS; fails_when=released>0 yields the kept or no-role text or a default duration, even when holdsRole is true; no_claim=none beyond protects
	it("released > 0 reads roleFreedDutyText with the long duration", () => {
		expect(notComingToast(2, true)).toEqual({
			text: roleFreedDutyText(2),
			duration: DUTY_TOAST_MS,
		});
		expect(notComingToast(1, false).text).toBe(roleFreedDutyText(1));
	});

	// protects=a decline that freed nothing from someone holding a role says the role is still theirs; fails_when=it claims the role was freed or drops the long duration; no_claim=holdsRole is the caller's prediction, not verified here
	it("nothing freed but a role held reads ROLE_KEPT_DUTY_TEXT", () => {
		expect(notComingToast(0, true)).toEqual({
			text: ROLE_KEPT_DUTY_TEXT,
			duration: DUTY_TOAST_MS,
		});
	});

	// protects=a no-role decline gets the plain text at the default duration; fails_when=duty text or a duration appears; no_claim=none beyond protects
	it("nothing freed and no role reads the plain text with no duration", () => {
		const t = notComingToast(0, false);
		expect(t).toEqual({ text: NOT_COMING_NO_ROLE_TEXT });
		expect("duration" in t).toBe(false);
	});
});
