// Wiring guard for AC3 of #1446: the roll toasts "Welcome back" once per member
// per view. The toast sits inside `writePresence`, which has no behavioural test
// surface here (a route component), so this pins the has/add pair on
// `welcomedRef` comment-blind: a comment naming it cannot satisfy the guard.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTE = resolve(
	import.meta.dirname,
	"club.$clubId.meeting.$meetingId.tsx",
);

describe("meeting roll welcome-back once per member (#1446)", () => {
	const src = readSource(ROUTE);
	const start = src.indexOf("async function writePresence(");
	const body = src.slice(start, src.indexOf("async function confirmAbsent"));

	it("lives inside writePresence", () => {
		expect(start).toBeGreaterThan(-1);
		expect(body.length).toBeGreaterThan(0);
	});

	it("toasts only when the member is not already in welcomedRef", () => {
		expect(body).toMatch(
			/result\.welcomeBack\s*&&\s*!welcomedRef\.current\.has\(memberId\)/,
		);
	});

	it("records the member in welcomedRef before toasting", () => {
		const add = body.indexOf("welcomedRef.current.add(memberId)");
		expect(add).toBeGreaterThan(-1);
		expect(add).toBeLessThan(body.indexOf("welcomeBackMessage("));
	});
});
