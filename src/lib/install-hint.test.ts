// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLAIMS_KEY,
	markDismissed,
	noteClaim,
	readClaims,
	readDismissed,
	shouldOfferInstall,
} from "./install-hint";

const base = { claims: 2, dismissed: false, standalone: false, isPhone: true };

afterEach(() => {
	vi.restoreAllMocks();
	window.localStorage.clear();
});

// protects: the hint is offered only from the second claim, once, on a phone
// outside the installed app. fails_when: any one condition is dropped from the
// rule. no_claim: says nothing about the UI that acts on the answer.
describe("shouldOfferInstall truth table", () => {
	it("offers on claim 2 and later", () => {
		expect(shouldOfferInstall(base)).toBe(true);
		expect(shouldOfferInstall({ ...base, claims: 5 })).toBe(true);
	});
	it("not on the first claim", () => {
		expect(shouldOfferInstall({ ...base, claims: 1 })).toBe(false);
	});
	it("not once dismissed", () => {
		expect(shouldOfferInstall({ ...base, dismissed: true })).toBe(false);
	});
	it("not when already installed", () => {
		expect(shouldOfferInstall({ ...base, standalone: true })).toBe(false);
	});
	it("not on desktop", () => {
		expect(shouldOfferInstall({ ...base, isPhone: false })).toBe(false);
	});
});

// protects: claims accumulate across calls and survive a read. fails_when:
// noteClaim overwrites instead of incrementing, or a garbage value throws.
// no_claim: does not prove the event wiring (component test).
describe("noteClaim", () => {
	it("increments the stored count", () => {
		expect(noteClaim()).toBe(1);
		expect(noteClaim()).toBe(2);
		expect(readClaims()).toBe(2);
	});
	it("treats a corrupt value as zero", () => {
		window.localStorage.setItem(CLAIMS_KEY, "abc");
		expect(noteClaim()).toBe(1);
	});
});

// protects: a blocked store never produces an offer or an exception.
// fails_when: a storage call escapes its try/catch, or a failed read of the
// dismissed flag reads as "not dismissed". no_claim: only jsdom's Storage.
describe("throwing storage", () => {
	it("never offers and never throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(noteClaim()).toBe(0);
		expect(readClaims()).toBe(0);
		expect(readDismissed()).toBe(true);
		expect(markDismissed()).toBe(false);
	});
});
