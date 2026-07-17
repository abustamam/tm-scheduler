// Unit tests for the signed no-auth unsubscribe token (#274). Pure crypto — no
// DB. BETTER_AUTH_SECRET is provided by the vitest setup file (src/test/setup-env.ts).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildUnsubscribeUrl,
	createUnsubscribeToken,
	verifyUnsubscribeToken,
} from "./unsubscribe-token";

describe("unsubscribe token (#274)", () => {
	it("round-trips: a freshly minted token verifies back to its personId", () => {
		const personId = randomUUID();
		const token = createUnsubscribeToken(personId);
		expect(verifyUnsubscribeToken(token)).toBe(personId);
	});

	it("rejects a token with a tampered personId (signature no longer matches)", () => {
		const personId = randomUUID();
		const token = createUnsubscribeToken(personId);
		const sig = token.slice(token.lastIndexOf(".") + 1);
		// Swap the id but keep the original signature — a forgery attempt.
		const forged = `${randomUUID()}.${sig}`;
		expect(verifyUnsubscribeToken(forged)).toBeNull();
	});

	it("rejects a token with a tampered signature", () => {
		const personId = randomUUID();
		const token = createUnsubscribeToken(personId);
		const tampered = `${token}x`;
		expect(verifyUnsubscribeToken(tampered)).toBeNull();
	});

	it("rejects an unsigned / malformed token", () => {
		expect(verifyUnsubscribeToken(randomUUID())).toBeNull(); // no dot/sig
		expect(verifyUnsubscribeToken("")).toBeNull();
		expect(verifyUnsubscribeToken(".")).toBeNull();
		expect(verifyUnsubscribeToken("abc.")).toBeNull();
	});

	it("builds an absolute unsubscribe URL carrying the token", () => {
		const personId = randomUUID();
		const url = buildUnsubscribeUrl(personId);
		expect(url).toMatch(/^https?:\/\/.+\/unsubscribe\?token=/);
		const token = decodeURIComponent(url.split("token=")[1]);
		expect(verifyUnsubscribeToken(token)).toBe(personId);
	});
});
