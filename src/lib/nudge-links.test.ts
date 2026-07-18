import { describe, expect, it } from "vitest";
import {
	buildNudge,
	buildNudgeMessage,
	buildNudgeSubject,
	firstName,
	mailtoHref,
	toWhatsappNumber,
	whatsappHref,
} from "./nudge-links";

const LINK = "https://gavelup.app/club/acme";

describe("firstName", () => {
	it("returns the first token", () => {
		expect(firstName("Jane Doe")).toBe("Jane");
		expect(firstName("Cher")).toBe("Cher");
	});

	it("trims and collapses whitespace", () => {
		expect(firstName("  Jane   Doe ")).toBe("Jane");
	});

	it("falls back to 'there' when empty", () => {
		expect(firstName("")).toBe("there");
		expect(firstName("   ")).toBe("there");
	});
});

describe("toWhatsappNumber", () => {
	it("strips '+', spaces, dashes, and parens", () => {
		expect(toWhatsappNumber("+1 (555) 123-4567")).toBe("15551234567");
		expect(toWhatsappNumber("555-123-4567")).toBe("5551234567");
	});

	it("returns null for missing or too-short numbers", () => {
		expect(toWhatsappNumber(null)).toBeNull();
		expect(toWhatsappNumber(undefined)).toBeNull();
		expect(toWhatsappNumber("")).toBeNull();
		expect(toWhatsappNumber("12345")).toBeNull(); // 5 digits < 7
		expect(toWhatsappNumber("ext. 42")).toBeNull();
	});
});

describe("buildNudgeMessage", () => {
	it("greets by first name and includes the link", () => {
		const msg = buildNudgeMessage({ memberName: "Jane Doe", link: LINK });
		expect(msg).toContain("Hi Jane!");
		expect(msg).toContain(LINK);
	});

	it("includes the club name when provided", () => {
		const msg = buildNudgeMessage({
			memberName: "Jane",
			clubName: "Acme Toastmasters",
			link: LINK,
		});
		expect(msg).toContain("at Acme Toastmasters");
	});

	it("omits the club clause when the name is blank", () => {
		const msg = buildNudgeMessage({
			memberName: "Jane",
			clubName: "   ",
			link: LINK,
		});
		expect(msg).not.toContain(" at ");
	});
});

describe("buildNudgeSubject", () => {
	it("names the club when known", () => {
		expect(buildNudgeSubject("Acme")).toBe("Open roles at Acme");
	});

	it("falls back generically", () => {
		expect(buildNudgeSubject(null)).toBe("Open roles coming up");
		expect(buildNudgeSubject("  ")).toBe("Open roles coming up");
	});
});

describe("whatsappHref", () => {
	it("builds a wa.me link with the message url-encoded", () => {
		const href = whatsappHref("+1 555 123 4567", "Hi Jane! Grab a role: x");
		expect(href).toBe(
			`https://wa.me/15551234567?text=${encodeURIComponent("Hi Jane! Grab a role: x")}`,
		);
		// spaces encode as %20, not '+'
		expect(href).toContain("%20");
		expect(href).not.toContain("+");
	});

	it("returns null when there's no usable phone", () => {
		expect(whatsappHref(null, "msg")).toBeNull();
		expect(whatsappHref("123", "msg")).toBeNull();
	});
});

describe("mailtoHref", () => {
	it("builds a mailto with subject + body", () => {
		const href = mailtoHref("jane@example.com", "Open roles", "Hi Jane!");
		expect(href).toBe(
			"mailto:jane@example.com?subject=Open%20roles&body=Hi%20Jane!",
		);
	});

	it("encodes spaces as %20 rather than '+'", () => {
		const href = mailtoHref("jane@example.com", "a b", "c d");
		expect(href).toContain("subject=a%20b");
		expect(href).toContain("body=c%20d");
		expect(href).not.toContain("+");
	});

	it("leaves the address itself unencoded", () => {
		const href = mailtoHref("jane@example.com", "s", "b");
		expect(href?.startsWith("mailto:jane@example.com?")).toBe(true);
	});

	it("returns null when there's no email", () => {
		expect(mailtoHref(null, "s", "b")).toBeNull();
		expect(mailtoHref("  ", "s", "b")).toBeNull();
	});
});

describe("buildNudge", () => {
	it("produces both channels when both are on file", () => {
		const nudge = buildNudge({
			memberName: "Jane Doe",
			clubName: "Acme",
			link: LINK,
			email: "jane@example.com",
			phone: "+1 555 123 4567",
		});
		expect(nudge.whatsappHref).toContain("https://wa.me/15551234567");
		expect(nudge.mailtoHref).toContain("mailto:jane@example.com");
		expect(nudge.subject).toBe("Open roles at Acme");
		expect(nudge.message).toContain("Hi Jane!");
		expect(nudge.message).toContain(LINK);
		// the same message rides both channels
		expect(nudge.whatsappHref).toContain(encodeURIComponent(nudge.message));
		expect(nudge.mailtoHref).toContain(encodeURIComponent(nudge.message));
	});

	it("nulls the channels that have no contact", () => {
		const nudge = buildNudge({
			memberName: "Jane",
			link: LINK,
			email: null,
			phone: null,
		});
		expect(nudge.whatsappHref).toBeNull();
		expect(nudge.mailtoHref).toBeNull();
	});
});
