/**
 * The three change-of-address emails and the `/account` outcome copy (#1091).
 * The flow itself is `account-email-change.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
	buildAddressChangedNoticeEmail,
	buildAddressInUseEmail,
	buildChangeEmailVerificationEmail,
	CHANGE_EMAIL_LINK_EXPIRY_SECONDS,
} from "#/lib/magic-link-email";
import { emailChangeOutcomeMessage } from "#/lib/member-email-change";

const HOSTILE = `<b>x</b>"@evil.example`;

describe("change-of-address emails", () => {
	it("the link lives for one hour, as the copy says", () => {
		expect(CHANGE_EMAIL_LINK_EXPIRY_SECONDS).toBe(3600);
		const m = buildChangeEmailVerificationEmail("https://l/x", "a@b.example");
		expect(m.text).toContain("expires in 1 hour");
		expect(m.html).toContain("expires in 1 hour");
		expect(m.text).toContain("https://l/x");
	});

	it("the in-use email carries no link and points at a merge", () => {
		const m = buildAddressInUseEmail("a@b.example");
		expect(m.text).toContain(
			"This address is already in use on GavelUp, so it can't be added to another account. Ask your club officer or GavelUp support to merge them.",
		);
		expect(m.html).not.toMatch(/<a /);
	});

	it("the notice names the new address and says what to do if it wasn't you", () => {
		const m = buildAddressChangedNoticeEmail("new@b.example");
		expect(m.text).toContain(
			"Your GavelUp sign-in address was changed to new@b.example. If this wasn't you, contact GavelUp support.",
		);
	});

	it("escapes the typed address in every HTML body", () => {
		for (const m of [
			buildChangeEmailVerificationEmail("https://l/x", HOSTILE),
			buildAddressInUseEmail(HOSTILE),
			buildAddressChangedNoticeEmail(HOSTILE),
		]) {
			expect(m.html).not.toContain("<b>x</b>");
			expect(m.html).toContain("&lt;b&gt;x&lt;/b&gt;");
		}
	});
});

describe("emailChangeOutcomeMessage", () => {
	it("reports a landed change as success and every refusal as an error", () => {
		expect(emailChangeOutcomeMessage("changed")?.tone).toBe("success");
		for (const o of ["stale", "in_use", "unbound", "expired"]) {
			expect(emailChangeOutcomeMessage(o)?.tone).toBe("error");
		}
	});

	it("says nothing for an absent or unknown value", () => {
		expect(emailChangeOutcomeMessage(undefined)).toBeNull();
		expect(emailChangeOutcomeMessage("<script>")).toBeNull();
	});
});
