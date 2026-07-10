import { describe, expect, it } from "vitest";
import { offlineVisitKey, relativeTime } from "./offline-status";

describe("offlineVisitKey", () => {
	it("namespaces the id", () => {
		expect(offlineVisitKey("abc")).toBe("gavelup-offline-visit:abc");
	});
});

describe("relativeTime", () => {
	const now = Date.UTC(2026, 6, 10, 21, 0, 0); // 2026-07-10T21:00:00Z

	it("says 'just now' under a minute", () => {
		expect(relativeTime(now - 30_000, now)).toBe("just now");
		expect(relativeTime(now, now)).toBe("just now");
	});

	it("pluralizes minutes", () => {
		expect(relativeTime(now - 60_000, now)).toBe("1 minute ago");
		expect(relativeTime(now - 5 * 60_000, now)).toBe("5 minutes ago");
	});

	it("pluralizes hours", () => {
		expect(relativeTime(now - 60 * 60_000, now)).toBe("1 hour ago");
		expect(relativeTime(now - 3 * 60 * 60_000, now)).toBe("3 hours ago");
	});

	it("falls back to a date past a day", () => {
		const twoDays = now - 2 * 24 * 60 * 60_000;
		expect(relativeTime(twoDays, now)).toBe(
			new Date(twoDays).toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			}),
		);
	});

	it("never reports a negative age", () => {
		expect(relativeTime(now + 10_000, now)).toBe("just now");
	});
});
