import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { guestRsvpSchema, MIN_FILL_MS } from "./guest-rsvp-schemas";

const base = () => ({
	clubId: randomUUID(),
	meetingId: randomUUID(),
	clientKey: randomUUID(),
	firstName: "Pat",
});

describe("guestRsvpSchema", () => {
	it("reads a missing, negative, NaN or non-number fillMs as too fast", () => {
		for (const fillMs of [undefined, -1, Number.NaN, Infinity, "9000", null]) {
			const parsed = guestRsvpSchema.parse({ ...base(), fillMs });
			expect(parsed.fillMs).toBe(0);
			expect(parsed.fillMs).toBeLessThan(MIN_FILL_MS);
		}
	});

	it("keeps a finite, non-negative fillMs", () => {
		expect(guestRsvpSchema.parse({ ...base(), fillMs: 5000 }).fillMs).toBe(
			5000,
		);
	});

	it("strips an unknown guestId key", () => {
		const parsed = guestRsvpSchema.parse({
			...base(),
			fillMs: 5000,
			guestId: randomUUID(),
		});
		expect("guestId" in parsed).toBe(false);
	});

	it("never rejects on the honeypot", () => {
		expect(guestRsvpSchema.parse({ ...base(), website: "x" }).website).toBe(
			"x",
		);
	});
});
