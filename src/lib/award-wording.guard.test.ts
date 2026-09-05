// #460: the Table Topics award is named ONE way for a reader — "Best Table
// Topics", plural — on every surface that prints, projects or renders it.
//
// Why a source grep rather than ten behavioural assertions. The award's name
// is a display string duplicated across ten modules, four of them private
// `CATEGORY_LABELS` maps that export nothing and so cannot be imported and
// compared. Before this guard the repo carried both spellings at once: the run
// sheet's award label, the projected deck's award list and the printed agenda's
// votes box said the singular, while the minutes, the minutes PDF, the ballot,
// the vote-counter panel and the club role sheet said the plural — so which
// name a member read depended on which piece of paper they were holding.
//
// `agenda-parity.test.ts` could not see it. Parity proves the printed run sheet
// and the projected deck AGREE, and both were wrong in the same direction, so
// it stayed green through the whole life of the bug. That is the general shape:
// cross-surface agreement is not evidence about a defect present on both sides.
// This file therefore pins the LITERAL expected string instead.
//
// The internal key `best_table_topics` is untouched and out of scope — it is a
// Postgres ENUM value (`award_category`, drizzle/0022_zippy_killer_shrike.sql)
// and a key in five display maps. Only human-readable text is governed here.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../..");

/** The award's one correct reader-facing name. */
const PLURAL = "Best Table Topics";

/**
 * The retired singular, matched only where it is NOT the plural: the negative
 * lookahead is what makes "Best Table Topics" pass and "Best Table Topic
 * Speaker" fail.
 */
const SINGULAR = /Best Table Topic(?!s)/;

const SKIP_DIRS = new Set([
	"node_modules",
	".output",
	".wxt",
	".vite",
	"dist",
	"build",
]);
const SCANNED = /\.(m?[jt]sx?|cjs|cts)$/i;
/** Tests may quote the old wording deliberately, to assert history. */
const IS_TEST = /\.(test|spec)\.[jt]sx?$/i;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) walk(abs, out);
		else out.push(abs);
	}
	return out;
}

const sourceFiles = walk(resolve(ROOT, "src"))
	.filter((abs) => SCANNED.test(abs) && !IS_TEST.test(abs))
	// This guard states the pattern it forbids, so it can't be its own offender.
	.filter((abs) => abs !== SELF);

/**
 * The ten surfaces that name the award to a reader. Listed rather than
 * discovered: a rename that DELETED the name from one of them would otherwise
 * satisfy the offender-list half of this guard perfectly.
 */
const SURFACES = [
	"src/lib/slide-layout.ts",
	"src/lib/agenda-slides.ts",
	"src/lib/agenda-runsheet.ts",
	"src/lib/role-template.ts",
	"src/server/role-sheet-layout.ts",
	"src/server/minutes-pdf-logic.ts",
	"src/components/club/meeting-minutes.tsx",
	"src/components/club/ballot.tsx",
	"src/components/club/vote-counter-panel.tsx",
	"src/components/agenda/meeting-agenda-print.tsx",
];

describe("#460: one wording for the Best Table Topics award", () => {
	it("walks a non-trivial source tree (so a broken walk can't pass vacuously)", () => {
		expect(sourceFiles.length).toBeGreaterThan(100);
	});

	it("no non-test source file uses the singular display string", () => {
		const offenders: string[] = [];
		for (const abs of sourceFiles) {
			// Deliberately NOT `#/test/guard-source` (which blanks comments). This
			// half asserts an offender list is EMPTY, so a comment can only ever add
			// a false offender — stripping would LOOSEN it. The positive half below
			// is the opposite form and does read through there.
			if (SINGULAR.test(readFileSync(abs, "utf8"))) {
				offenders.push(relative(ROOT, abs));
			}
		}
		expect(
			offenders,
			`These files name the award "Best Table Topic" (singular). #460 settled ` +
				`on "${PLURAL}" for every reader-facing surface; the internal ` +
				`\`best_table_topics\` key is unaffected.`,
		).toEqual([]);
	});

	it.each(SURFACES)("%s still names the award to its reader", (rel) => {
		const abs = resolve(ROOT, rel);
		expect(existsSync(abs), `${rel} is missing`).toBe(true);
		// Comment-blind here: this half requires the string to BE present, so a
		// mention in a comment would be a false PASS with the real label deleted.
		expect(readSource(abs)).toContain(PLURAL);
	});
});
