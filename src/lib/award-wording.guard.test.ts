// #460: the Table Topics award is named ONE way for a reader — "Best Table
// Topics", plural — on every surface that prints, projects or renders it.
//
// Why a source grep rather than eleven behavioural assertions. The award's name
// is a display string duplicated across eleven modules, four of them private
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
// and the key of the four display maps. Only human-readable text is governed
// here.
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
 * Speaker" fail. The control below pins that behaviour, because a guard whose
 * matcher has silently stopped matching is indistinguishable from a clean tree.
 */
const SINGULAR = /Best Table Topic(?!s)/;

const SCANNED = /\.(m?[jt]sx?|cjs|cts)$/i;
/**
 * Tests may quote the old wording deliberately, to assert history. Kept in step
 * with `SCANNED`'s extension set on purpose — a narrower list here would sweep
 * `foo.test.mts` as production source.
 */
const IS_TEST = /\.(test|spec)\.(m?[jt]sx?|cjs|cts)$/i;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
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
 * Every surface that names the award to a reader, and the exact text each one
 * must still carry.
 *
 * The expectation is per-SITE rather than a bare `toContain(PLURAL)`, because a
 * whole-file substring is satisfied by any other mention in the same file: with
 * a plain substring, deleting `agenda-runsheet.ts`'s `AWARD_CATEGORIES` label
 * still passes on the two voting-detail strings further down, and
 * `slide-layout.ts` passes on its vote-slide title alone. Both halves of this
 * guard were reviewed as overclaiming exactly that, so each entry now pins the
 * construct that actually renders, not merely the words.
 *
 * Listed rather than discovered: a rename that DELETED the award's name from a
 * surface would otherwise satisfy the offender sweep perfectly.
 */
const SURFACES: { file: string; expect: string[] }[] = [
	{
		file: "src/lib/slide-layout.ts",
		// Title and body head line, which #460 also made agree with each other.
		expect: [
			`"Vote for ${PLURAL} Speaker"`,
			`"Please Vote for ${PLURAL} Speaker:"`,
		],
	},
	{
		file: "src/lib/agenda-slides.ts",
		expect: [`awardCategories.push("${PLURAL}")`],
	},
	{
		file: "src/lib/agenda-runsheet.ts",
		// The `AWARD_CATEGORIES` entry, not the voting-detail copy beside it.
		expect: [`label: "${PLURAL}"`],
	},
	{
		file: "src/lib/role-template.ts",
		// The Ballot Counter's role description, in prose.
		expect: [`Best Evaluator, and ${PLURAL}`],
	},
	{
		file: "src/server/role-sheet-layout.ts",
		expect: [`award("${PLURAL}")`],
	},
	{
		file: "src/server/minutes-pdf-logic.ts",
		expect: [`best_table_topics: "${PLURAL}"`],
	},
	{
		file: "src/components/club/meeting-minutes.tsx",
		expect: [`best_table_topics: "${PLURAL}"`],
	},
	{
		file: "src/components/club/ballot.tsx",
		expect: [`best_table_topics: "${PLURAL}"`],
	},
	{
		file: "src/components/club/vote-counter-panel.tsx",
		expect: [`best_table_topics: "${PLURAL}"`],
	},
	{
		file: "src/components/agenda/meeting-agenda-print.tsx",
		// The printed agenda's "Tonight's Votes" box, in reading order.
		expect: [`["Best Speaker", "${PLURAL}", "Best Evaluator"]`],
	},
	{
		// The Ballot Counter console's on-screen help text. Missing from this
		// list on the first pass — it was already plural, so nothing failed, and
		// a list that silently omits a surface is the maintenance trap a reviewer
		// flagged. Kept because it IS reader-facing copy naming the award.
		file: "src/routes/club.$clubId.meeting.$meetingId.tsx",
		expect: [`eligible for ${PLURAL}`],
	},
];

describe("#460: one wording for the Best Table Topics award", () => {
	// Control. Without this, flipping `SINGULAR`'s lookahead — or any edit that
	// stops it matching — leaves the sweep below permanently green with the bug
	// fully reintroduced, which is the failure mode a source guard cannot
	// otherwise show. Same reason `dialog-keyboard-reachability.test.ts` carries
	// a pre-fix control.
	it("the matcher it sweeps with can actually tell the two spellings apart", () => {
		expect(SINGULAR.test("Best Table Topic")).toBe(true);
		expect(SINGULAR.test("Best Table Topic, Best Evaluator")).toBe(true);
		expect(SINGULAR.test("Please Vote for Best Table Topic Speaker:")).toBe(
			true,
		);
		expect(SINGULAR.test(PLURAL)).toBe(false);
		expect(SINGULAR.test(`Vote for ${PLURAL} Speaker`)).toBe(false);
	});

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

	it.each(SURFACES)("$file still names the award to its reader", ({
		file,
		expect: expected,
	}) => {
		const abs = resolve(ROOT, file);
		expect(existsSync(abs), `${file} is missing`).toBe(true);
		// Comment-blind here: this half requires the text to BE present, so a
		// mention in a comment would be a false PASS with the real label deleted.
		const src = readSource(abs);
		for (const needle of expected) expect(src).toContain(needle);
	});
});
