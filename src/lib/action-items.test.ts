import { describe, expect, it } from "vitest";
import { openAsOf, resolvedBetween } from "./action-items";

const AT = (iso: string) => new Date(iso);

/** Raised on `created`, resolved on `resolved` (null = still open). */
function item(id: string, created: string, resolved: string | null = null) {
	return {
		id,
		createdAt: AT(created),
		resolvedAt: resolved === null ? null : AT(resolved),
	};
}

const MARCH = AT("2026-03-10T19:00:00Z");
const FEBRUARY = AT("2026-02-10T19:00:00Z");

describe("openAsOf — what a past meeting's minutes must show", () => {
	// The whole point. Minutes are a historical record but "what's open" is a
	// live query, so rendering current state into a past meeting's minutes makes
	// the record rewrite itself: email March's minutes in April and they show
	// April. Every rule here exists to stop that.
	it("includes an item raised before the meeting and still open", () => {
		const items = [item("a", "2026-01-05T00:00:00Z")];
		expect(openAsOf(items, MARCH).map((i) => i.id)).toEqual(["a"]);
	});

	it("includes an item that was still open AT the meeting but resolved later", () => {
		// Resolved in April. March's minutes must still show it as open.
		const items = [item("a", "2026-01-05T00:00:00Z", "2026-04-01T00:00:00Z")];
		expect(openAsOf(items, MARCH).map((i) => i.id)).toEqual(["a"]);
	});

	it("excludes an item resolved before the meeting", () => {
		const items = [item("a", "2026-01-05T00:00:00Z", "2026-02-01T00:00:00Z")];
		expect(openAsOf(items, MARCH)).toEqual([]);
	});

	it("excludes an item raised after the meeting", () => {
		// Raised in April. It cannot appear in March's minutes.
		const items = [item("a", "2026-04-05T00:00:00Z")];
		expect(openAsOf(items, MARCH)).toEqual([]);
	});

	it("treats an item resolved exactly at the meeting instant as already closed", () => {
		const items = [item("a", "2026-01-05T00:00:00Z", MARCH.toISOString())];
		expect(openAsOf(items, MARCH)).toEqual([]);
	});

	it("treats an item raised exactly at the meeting instant as open", () => {
		const items = [item("a", MARCH.toISOString())];
		expect(openAsOf(items, MARCH).map((i) => i.id)).toEqual(["a"]);
	});

	it("is stable — the same window returns the same answer every time", () => {
		const items = [
			item("a", "2026-01-05T00:00:00Z"),
			item("b", "2026-01-06T00:00:00Z", "2026-04-01T00:00:00Z"),
			item("c", "2026-04-05T00:00:00Z"),
		];
		const first = openAsOf(items, MARCH).map((i) => i.id);
		const second = openAsOf(items, MARCH).map((i) => i.id);
		expect(first).toEqual(second);
		expect(first).toEqual(["a", "b"]);
	});

	it("orders oldest first, so the longest-outstanding item leads", () => {
		const items = [
			item("newer", "2026-02-01T00:00:00Z"),
			item("oldest", "2026-01-01T00:00:00Z"),
			item("middle", "2026-01-15T00:00:00Z"),
		];
		expect(openAsOf(items, MARCH).map((i) => i.id)).toEqual([
			"oldest",
			"middle",
			"newer",
		]);
	});
});

describe("resolvedBetween — the 'closed since last time' list", () => {
	it("includes an item resolved inside the window", () => {
		const items = [item("a", "2026-01-01T00:00:00Z", "2026-02-20T00:00:00Z")];
		expect(resolvedBetween(items, FEBRUARY, MARCH).map((i) => i.id)).toEqual([
			"a",
		]);
	});

	it("excludes an item resolved before the window opened", () => {
		const items = [item("a", "2026-01-01T00:00:00Z", "2026-01-20T00:00:00Z")];
		expect(resolvedBetween(items, FEBRUARY, MARCH)).toEqual([]);
	});

	it("excludes an item resolved after the window closed", () => {
		const items = [item("a", "2026-01-01T00:00:00Z", "2026-04-20T00:00:00Z")];
		expect(resolvedBetween(items, FEBRUARY, MARCH)).toEqual([]);
	});

	it("excludes an item that is still open", () => {
		const items = [item("a", "2026-01-01T00:00:00Z")];
		expect(resolvedBetween(items, FEBRUARY, MARCH)).toEqual([]);
	});

	it("covers everything up to the meeting when there is no previous meeting", () => {
		// A club's very first minutes: `from` is null, so the window opens at the
		// beginning of time rather than returning nothing.
		const items = [item("a", "2026-01-01T00:00:00Z", "2026-01-20T00:00:00Z")];
		expect(resolvedBetween(items, null, MARCH).map((i) => i.id)).toEqual(["a"]);
	});

	it("orders most recently resolved first", () => {
		const items = [
			item("early", "2026-01-01T00:00:00Z", "2026-02-12T00:00:00Z"),
			item("late", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"),
		];
		expect(resolvedBetween(items, FEBRUARY, MARCH).map((i) => i.id)).toEqual([
			"late",
			"early",
		]);
	});
});
