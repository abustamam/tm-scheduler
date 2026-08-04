/**
 * Pure unit tests for the role-sheet speaker-label model (#311). `speakerLabels`
 * is the single source of the names pre-filled into the Timer / Ah-Counter
 * sheets, so these tests pin the rule: only *assigned speaker* slots appear (open
 * slots leave blank rows), in agenda order, with the speech title when set.
 *
 * Plus the render caps on the real request path (#519), which need the db read
 * stubbed rather than bypassed — see the second describe.
 */
import { describe, expect, it, vi } from "vitest";
import { RENDER_CAPS } from "#/server/role-sheet-layout";

/** What the stubbed database is holding for the current test. */
const stored = vi.hoisted(() => ({
	row: {} as Record<string, unknown>,
	program: [] as unknown[],
}));

// role-sheets-pdf-logic imports #/db (via minutes-logic) at the top level; mock
// it so these tests run without a DATABASE_URL and without Postgres.
//
// The stub answers by SHAPE, not by call order: `loadRoleSheetFill` issues its
// meeting/club read and `loadRoleSheetLogo`'s read together inside one
// `Promise.all`, so keying off the selected columns keeps the fixture honest if
// that ordering is ever rearranged. The logo read is answered with no row, which
// short-circuits `loadRoleSheetLogo` to null and leaves the image decode — a
// separately bounded concern (`isDecodeSafe`) — out of these tests.
vi.mock("#/db", () => {
	const chain = (cols: Record<string, unknown>) => {
		const self = {
			from: () => self,
			innerJoin: () => self,
			where: () => self,
			limit: () => Promise.resolve("clubName" in cols ? [stored.row] : []),
		};
		return self;
	};
	return { db: { select: chain } };
});

vi.mock("#/server/minutes-logic", () => ({
	loadMinutesProgram: () => Promise.resolve(stored.program),
}));

import type { MinutesProgramRow } from "./minutes-logic";
import { renderRoleSheetPdf, speakerLabels } from "./role-sheets-pdf-logic";

function row(p: Partial<MinutesProgramRow>): MinutesProgramRow {
	return {
		slotId: "slot",
		roleName: "Speaker",
		category: "speaker",
		assigneeName: null,
		isGuest: false,
		speechTitle: null,
		...p,
	};
}

describe("speakerLabels (#311)", () => {
	it("keeps only assigned speaker slots, in order", () => {
		const program = [
			row({ category: "speaker", assigneeName: "Alice" }),
			row({ category: "evaluator", assigneeName: "Ed" }),
			row({ category: "speaker", assigneeName: "Bob" }),
		];
		expect(speakerLabels(program)).toEqual(["Alice", "Bob"]);
	});

	it("drops open speaker slots (no assignee) so their rows stay blank", () => {
		const program = [
			row({ category: "speaker", assigneeName: "Alice" }),
			row({ category: "speaker", assigneeName: null }),
		];
		expect(speakerLabels(program)).toEqual(["Alice"]);
	});

	it("appends the speech title in quotes when set", () => {
		const program = [
			row({ assigneeName: "Alice", speechTitle: "My Icebreaker" }),
			row({ assigneeName: "Bob", speechTitle: null }),
		];
		expect(speakerLabels(program)).toEqual(['Alice — "My Icebreaker"', "Bob"]);
	});

	it("returns an empty list for a program with no assigned speakers", () => {
		expect(speakerLabels([])).toEqual([]);
		expect(
			speakerLabels([row({ category: "evaluator", assigneeName: "Ed" })]),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// #519, on the REAL request path. `renderRoleSheetPdf` is what the public GET
// calls; every other assertion about the caps exercises `buildRoleSheetDoc` or
// `capFill` directly, so nothing covered the step that actually matters — that
// the values read OUT OF THE DATABASE reach the capped entry point rather than
// some other builder. Deleting `capFill` from `buildRoleSheetDoc` is caught in
// `role-sheet-layout.test.ts`; a future `renderRoleSheetPdf` that called
// `BUILDERS[key](fill)` itself, or a new column plumbed into the fill past the
// cap, is caught only here.
//
// Asserts PAGE COUNT rather than wall-clock time: timing is flaky on CI and
// passes for the wrong reason on a fast machine, whereas 500 stored speakers
// and a 50,000-character stored definition are visibly multi-page uncapped.
// ---------------------------------------------------------------------------
describe("renderRoleSheetPdf bounds what the public route renders (#519)", () => {
	function pageCount(bytes: Uint8Array): number {
		const m = Buffer.from(bytes)
			.toString("latin1")
			.match(/\/Count\s+(\d+)/);
		if (m == null) throw new Error("no /Count in the PDF page tree");
		return Number(m[1]);
	}

	it("caps values coming from the database, not just a hand-built fill", async () => {
		stored.row = {
			clubName: "C".repeat(50_000),
			scheduledAt: new Date("2026-07-23T01:00:00Z"),
			timezone: "America/Chicago",
			wordOfTheDay: "w".repeat(50_000),
			wodDefinition: "n".repeat(50_000),
		};
		// 500 assigned speaker slots — the measured second half of the attack
		// (2,059ms against an 87ms baseline).
		stored.program = Array.from({ length: 500 }, (_, i) => ({
			category: "speaker",
			assigneeName: `Speaker ${i}`,
			speechTitle: "A Speech Title",
		}));

		// The Timer's sheet takes the speaker rows; the Grammarian's takes the WOD.
		// Both are one page, which is also the product promise these sheets ship on.
		const timer = await renderRoleSheetPdf("meeting-1", "timer");
		expect(pageCount(timer.bytes)).toBe(1);
		const grammarian = await renderRoleSheetPdf("meeting-1", "grammarian");
		expect(pageCount(grammarian.bytes)).toBe(1);

		// The RETURNED club name is capped too. It never enters the PDF — the route
		// interpolates it into the `content-disposition` filename — so it was the
		// one value on this public route reaching a response without a bound, and
		// `clubs.name` has no write-side max. Asserting the bytes alone cannot see
		// it: reverting this cap leaves every page-count assertion above green.
		expect(timer.clubName.length).toBeLessThanOrEqual(RENDER_CAPS.club);
		expect(timer.date.length).toBeLessThanOrEqual(RENDER_CAPS.date);
	});
});
