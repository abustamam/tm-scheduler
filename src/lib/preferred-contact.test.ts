import { describe, expect, it } from "vitest";
import {
	availableContactMethods,
	CONTACT_METHODS,
	type ContactMethod,
	effectivePreferredContact,
	hasDialablePhone,
	isIos,
	NON_BLANK_PATTERN,
	preferredContactEditPayload,
	smsHref,
	telHref,
} from "./preferred-contact";

const PHONE = "+14155552671";
const EMAIL = "jane@example.com";

describe("availableContactMethods (#1093)", () => {
	it("offers every method when both email and a dialable phone exist", () => {
		expect(availableContactMethods({ email: EMAIL, phone: PHONE })).toEqual([
			"email",
			"call",
			"sms",
			"whatsapp",
		]);
	});

	it("offers only email without a phone", () => {
		expect(availableContactMethods({ email: EMAIL, phone: null })).toEqual([
			"email",
		]);
	});

	it("offers the three phone methods without an email", () => {
		expect(availableContactMethods({ email: null, phone: PHONE })).toEqual([
			"call",
			"sms",
			"whatsapp",
		]);
	});

	it("treats an NBSP-only or BOM-only email as no email", () => {
		for (const email of ["\u00a0", "\ufeff", "\u00a0\ufeff\u2028"]) {
			expect(availableContactMethods({ email, phone: null })).toEqual([]);
		}
	});

	it("treats a blank email as no email", () => {
		expect(availableContactMethods({ email: "   ", phone: null })).toEqual([]);
		expect(availableContactMethods({ email: "", phone: null })).toEqual([]);
	});

	it("treats a phone with no digit as no phone", () => {
		expect(
			availableContactMethods({ email: null, phone: "ask at church" }),
		).toEqual([]);
		expect(availableContactMethods({ email: null, phone: "" })).toEqual([]);
	});

	it("offers nothing with neither", () => {
		expect(availableContactMethods({ email: null, phone: null })).toEqual([]);
	});
});

describe("effectivePreferredContact (#1093)", () => {
	it("returns the stored method while its data exists", () => {
		for (const m of CONTACT_METHODS) {
			expect(effectivePreferredContact(m, { email: EMAIL, phone: PHONE })).toBe(
				m,
			);
		}
	});

	it("returns null for a phone method once the phone is gone", () => {
		for (const m of ["call", "sms", "whatsapp"] as ContactMethod[]) {
			expect(
				effectivePreferredContact(m, { email: EMAIL, phone: null }),
			).toBeNull();
			expect(
				effectivePreferredContact(m, { email: EMAIL, phone: "no digits" }),
			).toBeNull();
		}
	});

	it("returns null for email once the email is gone or blank", () => {
		expect(
			effectivePreferredContact("email", { email: null, phone: PHONE }),
		).toBeNull();
		expect(
			effectivePreferredContact("email", { email: "  ", phone: PHONE }),
		).toBeNull();
	});

	it("returns null for no preference", () => {
		expect(
			effectivePreferredContact(null, { email: EMAIL, phone: PHONE }),
		).toBeNull();
	});
});

describe("hasDialablePhone", () => {
	it("is a digit test, not a truthiness test", () => {
		expect(hasDialablePhone("+1 415")).toBe(true);
		expect(hasDialablePhone("ask at church")).toBe(false);
		expect(hasDialablePhone(null)).toBe(false);
		expect(hasDialablePhone(undefined)).toBe(false);
	});
});

describe("preferredContactEditPayload", () => {
	it("sends nothing when the field is unchanged", () => {
		expect(preferredContactEditPayload("sms", "sms")).toEqual({});
		expect(preferredContactEditPayload("", null)).toEqual({});
	});

	it("sends the new value, or null to clear", () => {
		expect(preferredContactEditPayload("call", "sms")).toEqual({
			preferredContact: "call",
		});
		expect(preferredContactEditPayload("", "sms")).toEqual({
			preferredContact: null,
		});
		expect(preferredContactEditPayload("email", null)).toEqual({
			preferredContact: "email",
		});
	});
});

describe("telHref / smsHref", () => {
	it("keeps a leading + and the digits only", () => {
		expect(telHref("+1 (415) 555-2671")).toBe("tel:+14155552671");
		expect(smsHref("415-555-2671")).toBe("sms:4155552671");
	});

	it("drops an extension instead of folding its digits in", () => {
		expect(smsHref("415-555-2671 x12")).toBe("sms:4155552671");
		expect(telHref("+1 415 555 2671 ext. 9")).toBe("tel:+14155552671");
	});

	it("uses &body= on iOS and ?body= elsewhere, URL-encoded", () => {
		expect(smsHref(PHONE, "ios", "Hi & bye?")).toBe(
			"sms:+14155552671&body=Hi%20%26%20bye%3F",
		);
		expect(smsHref(PHONE, "mobile", "Hi there")).toBe(
			"sms:+14155552671?body=Hi%20there",
		);
		expect(smsHref(PHONE, "desktop", "Hi")).toBe("sms:+14155552671?body=Hi");
	});

	it("is null with no digit even with a body", () => {
		expect(smsHref("ask", "ios", "hi")).toBeNull();
	});

	it("detects iOS, including iPadOS reporting a Macintosh UA", () => {
		expect(isIos({ userAgent: "iPhone", maxTouchPoints: 5 })).toBe(true);
		expect(isIos({ userAgent: "Macintosh", maxTouchPoints: 5 })).toBe(true);
		expect(isIos({ userAgent: "Macintosh", maxTouchPoints: 0 })).toBe(false);
		expect(isIos({ userAgent: "Android", maxTouchPoints: 5 })).toBe(false);
	});

	it("is null with nothing to dial", () => {
		expect(telHref("ask at church")).toBeNull();
		expect(smsHref(null)).toBeNull();
	});
});

describe("the shared whitespace definition (#1093 review)", () => {
	it("is exactly what JS .trim() removes, over the whole BMP", () => {
		const blank = new RegExp(`^${NON_BLANK_PATTERN.replace("[^", "[")}+$`);
		const disagree: string[] = [];
		for (let c = 0; c <= 0xffff; c++) {
			const ch = String.fromCharCode(c);
			if ((ch.trim() === "") !== blank.test(ch)) {
				disagree.push(c.toString(16));
			}
		}
		expect(disagree).toEqual([]);
	});

	it("is a bracket expression of literal characters, nothing to escape", () => {
		expect(NON_BLANK_PATTERN.startsWith("[^")).toBe(true);
		expect(NON_BLANK_PATTERN.endsWith("]")).toBe(true);
		const body = NON_BLANK_PATTERN.slice(2, -1);
		// No character either regex dialect would read as syntax in a class.
		expect(body).not.toMatch(/[\\\]^-]/);
	});
});
