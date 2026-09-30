import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_SHEETS } from "#/data/role-sheets";
import {
	findRoleGuideSource,
	hasGuideText,
	meetingRoleSheetHref,
	roleGuide,
	roleGuideAnchor,
	roleSheetForKey,
	rolesGuideUrl,
	staticRoleSheetHref,
} from "#/lib/role-guide";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { readSource } from "#/test/guard-source";

describe("roleGuide", () => {
	it("treats blank and whitespace halves as absent", () => {
		const g = roleGuide({
			name: "Timer",
			key: "timer",
			description: "  ",
			beforeNotes: "\n ",
			duringNotes: " Time it. ",
		});
		expect(g).toEqual({ description: null, before: null, during: "Time it." });
		expect(hasGuideText(g)).toBe(true);
	});

	it("reads an absent field exactly as NULL", () => {
		const g = roleGuide({ name: "X", key: null, description: "Does X." });
		expect(g).toEqual({ description: "Does X.", before: null, during: null });
		expect(hasGuideText(g)).toBe(false);
	});
});

describe("roleGuideAnchor", () => {
	it("hyphenates the key", () => {
		expect(roleGuideAnchor("toastmaster_of_the_day")).toBe(
			"toastmaster-of-the-day",
		);
		expect(roleGuideAnchor("ah_counter")).toBe("ah-counter");
	});

	it("drops anything that could break out of a fragment", () => {
		expect(roleGuideAnchor('x"><script>')).toBe("xscript");
		expect(roleGuideAnchor("a b#c")).toBe("abc");
	});

	it("is unique across the standard roles", () => {
		const anchors = ROLE_TEMPLATE.map((r) => roleGuideAnchor(r.key));
		expect(new Set(anchors).size).toBe(anchors.length);
	});
});

describe("roleSheetForKey", () => {
	it("maps exactly the six roles that have a printed sheet", () => {
		const withSheet = ROLE_TEMPLATE.filter((r) => roleSheetForKey(r.key)).map(
			(r) => r.key,
		);
		expect(withSheet.sort()).toEqual(
			[
				"ah_counter",
				"general_evaluator",
				"grammarian",
				"timer",
				"toastmaster_of_the_day",
				"vote_counter",
			].sort(),
		);
		// Every sheet is reachable from some role.
		expect(
			new Set(ROLE_TEMPLATE.map((r) => roleSheetForKey(r.key)?.key)),
		).toEqual(new Set([...ROLE_SHEETS.map((s) => s.key), undefined]));
	});

	it("has no sheet for a speaker, an evaluator, a custom or key-less role", () => {
		expect(roleSheetForKey("speaker")).toBeUndefined();
		expect(roleSheetForKey("evaluator")).toBeUndefined();
		expect(roleSheetForKey("table_topics_master")).toBeUndefined();
		expect(roleSheetForKey("zoom_host")).toBeUndefined();
		expect(roleSheetForKey(null)).toBeUndefined();
		expect(roleSheetForKey("constructor")).toBeUndefined();
	});

	it("builds the public blank copy and the meeting-aware copy", () => {
		const sheet = roleSheetForKey("vote_counter");
		if (!sheet) throw new Error("expected a sheet");
		expect(staticRoleSheetHref(sheet)).toBe("/role-sheets/ballot-counter.pdf");
		expect(meetingRoleSheetHref("m-1", sheet)).toBe(
			"/api/meetings/m-1/role-sheets/ballot-counter/pdf",
		);
	});
});

describe("findRoleGuideSource", () => {
	const sources = [
		{ name: "Timekeeper", key: "timer", description: null },
		{ name: "Sergeant-at-Arms", key: null, description: "Opens." },
	];

	it("matches by key, so a renamed role still finds its guide", () => {
		expect(
			findRoleGuideSource(sources, { roleKey: "timer", roleName: "Timer" }),
		).toBe(sources[0]);
	});

	it("matches a key-less role by exact name", () => {
		expect(
			findRoleGuideSource(sources, {
				roleKey: null,
				roleName: "Sergeant-at-Arms",
			}),
		).toBe(sources[1]);
	});

	it("never matches a keyed role by name, and returns null for a missing role", () => {
		expect(
			findRoleGuideSource(sources, {
				roleKey: "ah_counter",
				roleName: "Timekeeper",
			}),
		).toBeNull();
		expect(
			findRoleGuideSource(sources, { roleKey: null, roleName: "Timekeeper" }),
		).toBeNull();
	});
});

describe("rolesGuideUrl", () => {
	it("links the role's card on the club's roles guide", () => {
		expect(
			rolesGuideUrl({
				origin: "https://gavelup.app",
				clubId: "downtown",
				roleKey: "toastmaster_of_the_day",
			}),
		).toBe(
			"https://gavelup.app/club/downtown/roles-guide#toastmaster-of-the-day",
		);
	});

	it("links the top of the guide for a key-less role", () => {
		expect(
			rolesGuideUrl({ origin: "", clubId: "downtown", roleKey: null }),
		).toBe("/club/downtown/roles-guide");
	});
});

describe("ROLE_TEMPLATE guide text (#933)", () => {
	it("gives every standard role both halves", () => {
		for (const r of ROLE_TEMPLATE) {
			expect(r.beforeNotes.trim(), r.key).not.toBe("");
			expect(r.duringNotes.trim(), r.key).not.toBe("");
		}
	});

	it("is exactly what the migration backfills", () => {
		const file = readdirSync("drizzle")
			.filter((f) => f.endsWith(".sql"))
			.find((f) =>
				readSource(`drizzle/${f}`).includes('ADD COLUMN "before_notes"'),
			);
		if (!file) throw new Error("guide migration not found");
		const sqlText = readSource(`drizzle/${file}`);
		const re =
			/UPDATE "role_definitions" SET "(before_notes|during_notes)" = '((?:[^']|'')*)' WHERE "key" = '([a-z_]+)' AND "\1" IS NULL;/g;
		const backfilled = new Map<string, string>();
		for (const m of sqlText.matchAll(re)) {
			backfilled.set(`${m[3]}.${m[1]}`, (m[2] ?? "").replace(/''/g, "'"));
		}
		const expected = new Map<string, string>();
		for (const r of ROLE_TEMPLATE) {
			expected.set(`${r.key}.before_notes`, r.beforeNotes);
			expected.set(`${r.key}.during_notes`, r.duringNotes);
		}
		expect(backfilled.size).toBe(ROLE_TEMPLATE.length * 2);
		expect(Object.fromEntries(backfilled)).toEqual(
			Object.fromEntries(expected),
		);
	});
});
