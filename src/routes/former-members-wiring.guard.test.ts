// Wiring pins for former members in history surfaces (#1328). The activity
// and roster routes cannot render in jsdom (loader + server fns), and each
// pinned expression has a same-typed wrong twin (`[]`, `members`,
// `listClubMembers`) that typechecks and renders, so only a source pin sees it.
// COMMENT-BLIND (`readSource`).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES = dirname(fileURLToPath(import.meta.url));
const ACTIVITY = readSource(resolve(ROUTES, "_authed/activity.tsx"));
const ROSTER = readSource(resolve(ROUTES, "_authed/roster.tsx"));
const ACTORS = readSource(resolve(ROUTES, "../server/activity-actors.ts"));

describe("listActivityActors is gated (#1328)", () => {
	it("awaits requireUser and requireClubAdminView with the club id", () => {
		expect(ACTORS).toMatch(/const user = await requireUser\(\);/);
		expect(ACTORS).toMatch(/await requireClubAdminView\(user\.id, clubId\);/);
		expect(ACTORS).toContain('createServerFn({ method: "GET" })');
	});
});

describe("the activity member filter lists former members (#1328)", () => {
	it("loads listActivityActors, not listClubMembers, and marks (former)", () => {
		expect(ACTIVITY).toMatch(/listActivityActors\(\{ data: clubId \}\)/);
		expect(ACTIVITY).not.toContain("listClubMembers");
		expect(ACTIVITY).toContain("(former)");
	});
});

describe("the roster feeds the former list to both add dialogs (#1328)", () => {
	it("passes formerNames={formerMembers.map((m) => m.name)} at both call sites", () => {
		const hits =
			ROSTER.match(/formerNames=\{formerMembers\.map\(\(m\) => m\.name\)\}/g) ??
			[];
		expect(hits).toHaveLength(2);
	});

	it("labels the Speeches given card as current members, not all time", () => {
		expect(ROSTER).toMatch(
			/label: "Speeches given"[\s\S]{0,400}note: "current members"/,
		);
		expect(ROSTER).not.toContain('"all time"');
	});
});
