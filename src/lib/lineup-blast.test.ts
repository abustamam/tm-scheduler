import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildLineupBlast,
	CONFIRMED_MARK,
	type LineupBlastData,
	type LineupSlot,
	lineupMailtoHref,
	mayDraftLineupBlast,
	withArticle,
} from "./lineup-blast";

const ORIGIN = "https://gavelup.app";

function slot(
	roleName: string,
	status: LineupSlot["status"],
	assigneeName: string | null,
	slotIndex = 0,
): LineupSlot {
	return { roleName, slotIndex, status, assigneeName };
}

function data(slots: LineupSlot[]): LineupBlastData {
	return {
		club: {
			name: "Downtown Speakers",
			slug: "downtown",
			timezone: "America/New_York",
		},
		meeting: {
			id: "00000000-0000-4000-8000-000000000001",
			urlKey: "2026-10-01",
			// 23:30 UTC on 1 Oct is 19:30 on 1 Oct in New York, and already 2 Oct
			// in UTC terms for anything that forgot the zone.
			scheduledAt: new Date("2026-10-01T23:30:00Z"),
		},
		slots,
	};
}

const LINEUP = data([
	slot("Toastmaster", "confirmed", "Lauren Keeler"),
	slot("Table Topics Master", "claimed", "Mari Wondimu"),
	slot("Speaker", "confirmed", "Ada Lovelace", 0),
	slot("Speaker", "claimed", "Grace Hopper", 1),
	slot("Speaker", "open", null, 2),
	slot("Timer", "open", null),
	slot("Ah-Counter", "open", null),
]);

describe("buildLineupBlast (#1024)", () => {
	it("lists every slot in the order given, with each status's marker", () => {
		const blast = buildLineupBlast(LINEUP, ORIGIN);
		const body = blast.text.split("\n\n")[1]?.split("\n");
		expect(body).toEqual([
			`Toastmaster – Lauren Keeler – ${CONFIRMED_MARK}`,
			"Table Topics Master – Mari Wondimu –",
			`Speaker 1 – Ada Lovelace – ${CONFIRMED_MARK}`,
			"Speaker 2 – Grace Hopper –",
			"Speaker 3 – 🙋 Need a Speaker",
			"Timer – 🙋 Need a Timer",
			"Ah-Counter – 🙋 Need an Ah-Counter",
		]);
	});

	it("leaves a claimed line blank, with no 'please confirm' text", () => {
		const blast = buildLineupBlast(LINEUP, ORIGIN);
		expect(blast.text).toContain("Mari Wondimu –\n");
		expect(blast.text.toLowerCase()).not.toContain("please confirm");
	});

	it("headers with the club and the date and time in the CLUB's zone", () => {
		const blast = buildLineupBlast(LINEUP, ORIGIN);
		expect(blast.text.startsWith("*🎤 Downtown Speakers lineup*\n")).toBe(true);
		expect(blast.text).toContain("📅 Thursday, October 1, 7:30 PM");
		expect(blast.subject).toBe("Downtown Speakers lineup: Thursday, October 1");
	});

	it("counts the open roles, and says nothing when none are open", () => {
		const blast = buildLineupBlast(LINEUP, ORIGIN);
		expect(blast.openCount).toBe(3);
		expect(blast.text).toContain("\n\n3 roles still open\n\n");

		const one = buildLineupBlast(data([slot("Timer", "open", null)]), ORIGIN);
		expect(one.text).toContain("1 role still open");

		const full = buildLineupBlast(
			data([slot("Timer", "confirmed", "Ann Lee")]),
			ORIGIN,
		);
		expect(full.openCount).toBe(0);
		expect(full.text).not.toContain("still open");
		expect(full.html).not.toContain("still open");
	});

	it("ends on the public meeting page", () => {
		const blast = buildLineupBlast(LINEUP, ORIGIN);
		expect(
			blast.text.endsWith(
				"Claim or confirm your role: https://gavelup.app/club/downtown/meeting/2026-10-01",
			),
		).toBe(true);
		expect(blast.html).toContain(
			'<a href="https://gavelup.app/club/downtown/meeting/2026-10-01">',
		);
	});

	it("reads a claimed slot with no holder as open, never 'Timer – –'", () => {
		const blast = buildLineupBlast(
			data([
				slot("Timer", "claimed", null),
				slot("Grammarian", "claimed", " "),
			]),
			ORIGIN,
		);
		expect(blast.lines.map((l) => l.state)).toEqual(["open", "open"]);
		expect(blast.text).not.toContain("– –");
	});

	it("does not number an unordered role", () => {
		const blast = buildLineupBlast(
			data([
				{ ...slot("Contestant", "claimed", "A B", 0), slotsUnordered: true },
				{ ...slot("Contestant", "claimed", "C D", 1), slotsUnordered: true },
			]),
			ORIGIN,
		);
		expect(blast.lines.map((l) => l.label)).toEqual([
			"Contestant",
			"Contestant",
		]);
	});

	it("highlights Confirmed in yellow and needed roles in red in the HTML", () => {
		const blast = buildLineupBlast(LINEUP, ORIGIN);
		expect(blast.html).toContain(
			`Lauren Keeler – <span style="background-color:#ffff00">${CONFIRMED_MARK}</span>`,
		);
		expect(blast.html).toContain(
			'Timer – <span style="color:#d00000">🙋 Need a Timer</span>',
		);
		expect(blast.html).toContain(
			'<span style="color:#d00000">3 roles still open</span>',
		);
		// A claimed line carries no mark at all, in either output.
		expect(blast.html).toContain("Mari Wondimu –<br>");
	});

	it("escapes every name and role in the HTML", () => {
		const blast = buildLineupBlast(
			data([
				slot("<b>Timer</b>", "open", null),
				slot("Toastmaster", "confirmed", '<img src=x onerror="alert(1)">'),
			]),
			ORIGIN,
		);
		expect(blast.html).not.toContain("<img");
		expect(blast.html).not.toContain("<b>Timer");
		expect(blast.html).toContain(
			"&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
		);
	});

	it("an empty meeting still drafts a header and the link", () => {
		const blast = buildLineupBlast(data([]), ORIGIN);
		expect(blast.lines).toEqual([]);
		expect(blast.text).toContain("Claim or confirm your role:");
	});
});

describe("withArticle", () => {
	it("uses 'an' before a vowel and 'a' otherwise", () => {
		expect(withArticle("Ah-Counter")).toBe("an Ah-Counter");
		expect(withArticle("Evaluator")).toBe("an Evaluator");
		expect(withArticle("Timer")).toBe("a Timer");
		expect(withArticle(" General Evaluator ")).toBe("a General Evaluator");
	});
});

describe("lineupMailtoHref", () => {
	it("carries the plain text and subject, with no recipient", () => {
		const blast = buildLineupBlast(LINEUP, ORIGIN);
		const href = lineupMailtoHref(blast);
		expect(href?.startsWith("mailto:?subject=")).toBe(true);
		const body = new URL(href ?? "").searchParams.get("body");
		expect(body).toBe(blast.text);
	});

	it("is null when the draft is too long for a mail link", () => {
		const many = data(
			Array.from({ length: 60 }, (_, i) =>
				slot("Speaker", "confirmed", `Member Number ${i}`, i),
			),
		);
		expect(lineupMailtoHref(buildLineupBlast(many, ORIGIN))).toBeNull();
	});
});

describe("mayDraftLineupBlast (#1024 decision: who)", () => {
	it("admits an admin, an officer, or the Toastmaster, and nobody else", () => {
		const cases: [boolean, boolean, boolean, boolean][] = [
			[false, false, false, false],
			[true, false, false, true],
			[false, true, false, true],
			[false, false, true, true],
			[true, true, true, true],
		];
		for (const [isAdmin, isOfficer, holdsToastmasterSlot, expected] of cases) {
			expect(
				mayDraftLineupBlast({ isAdmin, isOfficer, holdsToastmasterSlot }),
			).toBe(expected);
		}
	});
});

/**
 * The meeting's video-call link never reaches a lineup draft (#731/#754).
 *
 * Two halves. The builder's input type has no field for it, so no value can
 * flow in; and every module on the lineup path is swept RAW for any spelling
 * of the field, comments included, so nobody adds one. The route's own
 * join-url guard (`join-url-not-on-print-surfaces.guard.test.ts`) keeps its
 * list of withheld modules; these are this feature's.
 */
describe("the join link is never in a lineup draft (#731)", () => {
	const JOIN_URL = /join[_-]?url/i;
	const root = resolve(__dirname, "..", "..");
	const LINEUP_MODULES = [
		"src/lib/lineup-blast.ts",
		"src/components/club/lineup-blast-sheet.tsx",
		"src/server/lineup-blast.ts",
		"src/server/lineup-blast-logic.ts",
		"src/server/mcp/tools/get-lineup-blast.ts",
	];

	it("the pattern fires on a module that does name the field (vacuity floor)", () => {
		const route = readFileSync(
			resolve(root, "src/routes/club.$clubId.meeting.$meetingId.tsx"),
			"utf8",
		);
		expect(JOIN_URL.test(route)).toBe(true);
	});

	for (const rel of LINEUP_MODULES) {
		it(`${rel} never names the field`, () => {
			expect(JOIN_URL.test(readFileSync(resolve(root, rel), "utf8"))).toBe(
				false,
			);
		});
	}

	it("a draft built from data smuggling a link does not carry it", () => {
		// Belt to the type's brace: an object with an extra field (a future
		// loader that spread a meeting row) still drafts only what the builder
		// reads.
		const smuggled = {
			...LINEUP,
			meeting: { ...LINEUP.meeting, joinUrl: "https://zoom.example/j/123" },
		} as LineupBlastData;
		const blast = buildLineupBlast(smuggled, ORIGIN);
		expect(JSON.stringify(blast)).not.toContain("zoom.example");
	});
});
