import { describe, expect, it } from "vitest";
import { FEEDBACK_PER_MEETING_CAP } from "#/lib/feedback-window";
import {
	createIpLimiter,
	createSenderMeetingCap,
	FEEDBACK_PER_ADDRESS_PER_MEETING_CAP,
} from "./feedback-rate-limit";

describe("createIpLimiter (#984)", () => {
	it("admits `limit` attempts per window, then refuses until the window resets", () => {
		const l = createIpLimiter({ limit: 3, windowMs: 1000 });
		expect([0, 1, 2, 3].map((t) => l.take("203.0.113.9", t))).toEqual([
			true,
			true,
			true,
			false,
		]);
		expect(l.take("203.0.113.9", 999)).toBe(false);
		expect(l.take("203.0.113.9", 1000)).toBe(true);
	});

	it("keys each address separately", () => {
		const l = createIpLimiter({ limit: 1, windowMs: 1000 });
		expect(l.take("203.0.113.9", 0)).toBe(true);
		expect(l.take("203.0.113.9", 0)).toBe(false);
		expect(l.take("198.51.100.4", 0)).toBe(true);
	});

	it("stays bounded under a flood of distinct addresses", () => {
		const l = createIpLimiter({ limit: 1, windowMs: 60_000, maxKeys: 50 });
		for (let i = 0; i < 500; i++) l.take(`10.0.${i >> 8}.${i & 255}`, i);
		expect(l.size()).toBeLessThanOrEqual(50);
	});

	it("sweeps expired addresses", () => {
		const l = createIpLimiter({ limit: 1, windowMs: 10 });
		l.take("a", 0);
		l.take("b", 0);
		l.take("c", 100);
		expect(l.size()).toBe(1);
	});
});

describe("createSenderMeetingCap (#1038)", () => {
	const M1 = "11111111-1111-4111-8111-111111111111";
	const M2 = "22222222-2222-4222-8222-222222222222";
	const FAR = 1_000_000;

	it("is 150, half the meeting cap, so one address can never fill a meeting", () => {
		expect(FEEDBACK_PER_ADDRESS_PER_MEETING_CAP).toBe(150);
		expect(FEEDBACK_PER_ADDRESS_PER_MEETING_CAP).toBeLessThan(
			FEEDBACK_PER_MEETING_CAP,
		);
	});

	it("admits the 150th note from one address to a meeting and refuses the 151st", () => {
		const c = createSenderMeetingCap({
			cap: FEEDBACK_PER_ADDRESS_PER_MEETING_CAP,
		});
		for (let i = 0; i < 149; i++) c.take("203.0.113.9", M1, FAR, i);
		expect(c.take("203.0.113.9", M1, FAR, 149)).toBe(true);
		expect(c.take("203.0.113.9", M1, FAR, 150)).toBe(false);
		expect(c.take("203.0.113.9", M1, FAR, 151)).toBe(false);
	});

	it("keeps other addresses, and the same address at another meeting, unaffected", () => {
		const c = createSenderMeetingCap({ cap: 2 });
		expect(c.take("203.0.113.9", M1, FAR, 0)).toBe(true);
		expect(c.take("203.0.113.9", M1, FAR, 0)).toBe(true);
		expect(c.take("203.0.113.9", M1, FAR, 0)).toBe(false);
		expect(c.take("198.51.100.4", M1, FAR, 0)).toBe(true);
		expect(c.take("203.0.113.9", M2, FAR, 0)).toBe(true);
	});

	it("shares one budget across the meeting id's letter case", () => {
		const c = createSenderMeetingCap({ cap: 2 });
		const id = "abcdef12-3456-4789-8abc-def123456789";
		expect(c.take("a", id, FAR, 0)).toBe(true);
		expect(c.take("a", id.toUpperCase(), FAR, 0)).toBe(true);
		expect(c.take("a", id, FAR, 0)).toBe(false);
		expect(c.take("a", id.toUpperCase(), FAR, 0)).toBe(false);
		c.release("a", id.toUpperCase());
		expect(c.take("a", id, FAR, 0)).toBe(true);
		expect(c.size()).toBe(1);
	});

	it("gives a released slot back, and releasing an unknown pair is a no-op", () => {
		const c = createSenderMeetingCap({ cap: 1 });
		expect(c.take("a", M1, FAR, 0)).toBe(true);
		expect(c.take("a", M1, FAR, 0)).toBe(false);
		c.release("a", M1);
		expect(c.size()).toBe(0);
		expect(c.take("a", M1, FAR, 0)).toBe(true);
		c.release("b", M1);
		expect(c.size()).toBe(1);
	});

	it("forgets a meeting's entries once its window has closed", () => {
		const c = createSenderMeetingCap({ cap: 1 });
		expect(c.take("a", M1, 100, 0)).toBe(true);
		expect(c.take("b", M1, 100, 0)).toBe(true);
		expect(c.take("a", M1, 100, 99)).toBe(false);
		expect(c.size()).toBe(2);
		// Past `expiresAt`, the next new key sweeps both away.
		c.take("c", M2, FAR, 100);
		expect(c.size()).toBe(1);
	});

	it("does not keep refusing a pair whose own entry has expired", () => {
		const c = createSenderMeetingCap({ cap: 1 });
		expect(c.take("a", M1, 100, 0)).toBe(true);
		expect(c.take("a", M1, 100, 50)).toBe(false);
		expect(c.take("a", M1, 200, 100)).toBe(true);
		expect(c.size()).toBe(1);
	});

	it("does not track a meeting whose window has already closed", () => {
		const c = createSenderMeetingCap({ cap: 1 });
		expect(c.take("a", M1, 10, 10)).toBe(true);
		expect(c.size()).toBe(0);
	});

	it("stays bounded under a flood of meetings and addresses", () => {
		const c = createSenderMeetingCap({ cap: 1, maxKeys: 50 });
		for (let i = 0; i < 500; i++) {
			c.take(`10.0.${i >> 8}.${i & 255}`, i % 2 ? M1 : M2, FAR, i);
		}
		expect(c.size()).toBeLessThanOrEqual(50);
	});
});
