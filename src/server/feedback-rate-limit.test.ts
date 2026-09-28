import { describe, expect, it } from "vitest";
import { createIpLimiter } from "./feedback-rate-limit";

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
