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
	/** `role_definitions` rows for the club's script role names (#520). */
	roleDefs: [] as { key: string | null; name: string }[],
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
//
// THENABLE, not just `.limit()`-resolving. Drizzle's query builders are awaitable
// at any point, and #520's role-name read has no `.limit()` — it ends at
// `.where()` — so a `.limit()`-only stub returned the builder itself and the
// caller got `rows.flatMap is not a function`. Answering on `then` as well makes
// the stub match the real shape rather than the one shape the existing callers
// happened to use.
vi.mock("#/db", () => {
	const chain = (cols: Record<string, unknown>) => {
		const rows = () => {
			if ("clubName" in cols) return [stored.row];
			// The role-name read (#520) selects `{ key, name }`.
			if ("key" in cols && "name" in cols) return stored.roleDefs;
			// The logo read: no row ⇒ `loadRoleSheetLogo` short-circuits to null.
			return [];
		};
		// The role-name read is AWAITED at `.where()`; the other two go on to
		// `.limit()`. So `where` resolves for the first and keeps chaining for the
		// rest, which is the same answer-by-shape the header describes. A `then` on
		// `self` would model drizzle's real thenable builder more closely, but
		// Biome's `noThenProperty` rejects it and the rule is right in general —
		// this narrower branch needs no suppression.
		const self = {
			from: () => self,
			innerJoin: () => self,
			where: () =>
				"key" in cols && "name" in cols ? Promise.resolve(rows()) : self,
			limit: () => Promise.resolve(rows()),
		};
		return self;
	};
	return { db: { select: chain } };
});

vi.mock("#/server/minutes-logic", () => ({
	loadMinutesProgram: () => Promise.resolve(stored.program),
}));

import type { MinutesProgramRow } from "./minutes-logic";
import {
	loadRoleSheetFill,
	renderRoleSheetPdf,
	speakerLabels,
} from "./role-sheets-pdf-logic";

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

	/**
	 * #520 through the REAL loader, not a hand-built fill.
	 *
	 * `role-sheet-layout.test.ts` proves the builders substitute a name they are
	 * given; this proves `loadRoleSheetFill` gives them the club's. Between the two
	 * sits the query and the canonical-defaults merge, which is where a rename
	 * silently stops arriving — the layout tests would stay green through any
	 * failure in here.
	 */
	it("carries the club's own role names from the database onto the sheet", async () => {
		stored.row = {
			clubName: "Harborlight",
			scheduledAt: new Date("2026-07-23T01:00:00Z"),
			timezone: "America/Chicago",
			wordOfTheDay: null,
			wodDefinition: null,
		};
		stored.program = [];
		stored.roleDefs = [
			{ key: "timer", name: "Timekeeper" },
			// A role the scripts never name — must not disturb the merge.
			{ key: "speaker", name: "Presenter" },
			// A club-invented role with no key, which the query returns and the
			// merge has to skip rather than crash on.
			{ key: null, name: "Chief Vibes Officer" },
		];

		const ge = await renderRoleSheetPdf("meeting-1", "general-evaluator");
		const text = Buffer.from(ge.bytes).toString("latin1");
		// PDF text is compressed, so assert through the fill the loader built
		// rather than by grepping bytes — the render is covered above.
		const fill = await loadRoleSheetFill("meeting-1");
		expect(fill.roleNames?.timer).toBe("Timekeeper");
		// Unnamed roles keep OUR word, so a partially-configured club reads as it
		// always did instead of as a blank.
		expect(fill.roleNames?.grammarian).toBe("Grammarian");
		expect(fill.roleNames?.toastmaster_of_the_day).toBe("Toastmaster");
		expect(text.startsWith("%PDF-")).toBe(true);
	});

	it("caps a stored role name before it reaches the renderer", async () => {
		stored.row = {
			clubName: "Harborlight",
			scheduledAt: new Date("2026-07-23T01:00:00Z"),
			timezone: "America/Chicago",
			wordOfTheDay: null,
			wodDefinition: null,
		};
		stored.program = [];
		// `role_definitions.name` has no write-side max, and since #520 it is
		// interpolated mid-sentence into a one-page sheet rendered in this process.
		stored.roleDefs = [{ key: "timer", name: "T".repeat(50_000) }];

		const timer = await renderRoleSheetPdf("meeting-1", "timer");
		expect(pageCount(timer.bytes)).toBe(1);
	});
});
