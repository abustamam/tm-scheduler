// Trademark guard (#495, ADR-0024 constraint 2 — "Uploads are strictly
// per-club. No shared asset library, template gallery, cross-club reuse, or
// 'logos other clubs use'."). Serving one club's uploaded logo bytes to
// another club is what turns GavelUp into the distributor of a mark it
// never vetted, which is the exact thing the whole posture depends on not
// being true. This guard has two independent checks:
//
//   1. Every read of `club_logos` is scoped to the requested club — the
//      logic layer filters with `eq(clubLogos.clubId, …)`, and the public
//      GET route forwards the URL's OWN clubId into that read rather than
//      some other value.
//   2. No file anywhere under `src/` names a cross-club logo concept (a
//      shared "library"/"gallery", or "logos other clubs use") — a concept
//      that would defeat the point even if every individual query were
//      technically scoped one club at a time.
//
// Both are "pattern must BE present" guards (check 1 requires a scoping
// predicate to exist; check 2 requires the ABSENCE of a concept, but reads
// the same way for the same reason): reading through `#/test/guard-source`
// (comment-blind) means a comment merely mentioning
// `eq(clubLogos.clubId, …)` — or a comment explaining why no shared logo
// library exists, which is exactly what this file's own prose and
// `club-logo-logic.ts`'s doc comments do — can't be mistaken for the real
// thing, in either direction. Raw source would let a comment fake a scoped
// read that isn't there (the precise defect #498 fixed for a different
// guard) and would also risk a false failure against this repo's own
// explanatory comments.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../../..");

const read = (rel: string) => readSource(resolve(ROOT, rel));

// ---------------------------------------------------------------------------
// Check 1 — every club_logos read is scoped to the requested club.
// ---------------------------------------------------------------------------

const ROUTE_FILE = "src/routes/api/club.$clubId.logo.ts";

/**
 * Every statement that TOUCHES `club_logos`, sliced from the call site up to
 * its terminating `;` (or EOF). Statement-scoped rather than whole-file so one
 * correctly-scoped access can't paper over a second, unscoped one in the same
 * file.
 *
 * Scoped by TABLE AND VERB, not by a prose phrase, because this guard has now
 * been too narrow twice:
 *   · It first matched only `.from(`, since #495 described it as covering "the
 *     logo READ path" — and a delete is not a read. That left the worst case
 *     unguarded: dropping the `WHERE` from `removeClubLogo` erases EVERY club's
 *     logo, and neither this guard nor the suite caught it.
 *   · It then matched only a hardcoded `club-logo-logic.ts`, so the `innerJoin`
 *     added in #496 to build the role-sheet PDF was invisible to it purely
 *     because it lived in a different file.
 *
 * Hence: every verb, and every file under `src/` (see `sourceFiles`). A new
 * call site is covered the moment it is written, without anyone remembering to
 * enroll it here.
 */
function clubLogosStatements(src: string, verbs: string[]): string[] {
	const out: string[] = [];
	const re = new RegExp(`\\.(?:${verbs.join("|")})\\(\\s*clubLogos\\b`, "g");
	let m: RegExpExecArray | null = re.exec(src);
	while (m !== null) {
		const end = src.indexOf(";", m.index);
		out.push(src.slice(m.index, end === -1 ? src.length : end + 1));
		m = re.exec(src);
	}
	return out;
}

/**
 * Verbs that SELECT existing rows. These are the ones the per-club predicate
 * rule applies to: without `eq(clubLogos.clubId, …)` they can read another
 * club's logo, or delete every club's.
 */
const ROW_SELECTING_VERBS = [
	"from",
	"delete",
	"update",
	"innerJoin",
	"leftJoin",
	"rightJoin",
];

/**
 * `insert` selects nothing, so the predicate rule is meaningless for it — it is
 * scoped by the `clubId` it WRITES (plus `requireClubRole` upstream), and it
 * cannot serve one club's bytes to another. Counted toward the floor so losing
 * the sweep is still detectable, but exempt from the predicate assertion.
 */
const ALL_VERBS = [...ROW_SELECTING_VERBS, "insert"];

function accessWith(verbs: string[]): { file: string; stmt: string }[] {
	return sourceFiles.flatMap((abs) => {
		const rel = relative(ROOT, abs);
		return clubLogosStatements(read(rel), verbs).map((stmt) => ({
			file: rel,
			stmt,
		}));
	});
}

describe("club logo access is scoped per-club (#495/#496, ADR-0024 constraint 2)", () => {
	it("finds every club_logos access across src/ (so a rewrite can't go vacuous)", () => {
		const found = accessWith(ALL_VERBS);
		// 5 = two reads, one insert and one delete in the logic layer, plus the
		// role-sheet PDF join added by #496. A floor set to one file's count would
		// pass again if the file sweep or a verb were lost from the matcher —
		// both of which have already happened once each.
		expect(
			found.length,
			`Expected at least 5 club_logos access statements across src/, found ${found.length}: ` +
				`${JSON.stringify(found.map((f) => f.file))}. If this dropped, the ` +
				"matcher lost a verb or the file sweep broke — fix that rather than " +
				"lowering the floor.",
		).toBeGreaterThanOrEqual(5);
	});

	it("every club_logos access anywhere in src/ filters on eq(clubLogos.clubId, …)", () => {
		const unscoped = accessWith(ROW_SELECTING_VERBS).filter(
			({ stmt }) => !/eq\(clubLogos\.clubId,/.test(stmt),
		);
		expect(
			unscoped,
			"These statements touch club_logos without a clubId-scoped predicate: " +
				`${JSON.stringify(unscoped)}. Every read, join and delete must filter ` +
				"with eq(clubLogos.clubId, <this club's id>) — an unscoped read serves " +
				"one club's logo to another; an unscoped DELETE erases every club's " +
				"(ADR-0024 constraint 2).",
		).toEqual([]);
	});

	it("the public GET route forwards the requested URL's own clubId into the scoped read", () => {
		const src = read(ROUTE_FILE);
		expect(
			src,
			`${ROUTE_FILE} must call loadClubLogoForServing(params.clubId) — the ` +
				"clubId parsed from the requested URL — so the bytes served are " +
				"always the requesting club's own, never a different one.",
		).toMatch(/loadClubLogoForServing\(\s*params\.clubId\s*\)/);
	});
});

// ---------------------------------------------------------------------------
// Check 2 — no cross-club logo concept exists anywhere in src/.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
	"node_modules",
	".output",
	".vite",
	"dist",
	"build",
]);
const SCANNED = /\.(m?[jt]sx?|cjs|cts)$/i;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) walk(abs, out);
		else out.push(abs);
	}
	return out;
}

const sourceFiles = (
	existsSync(resolve(ROOT, "src")) ? walk(resolve(ROOT, "src")) : []
)
	.filter((abs) => SCANNED.test(abs))
	// This guard states the pattern it forbids, so it can't be its own
	// offender — same move as ti-wordmark.guard.test.ts's SELF filter.
	.filter((abs) => abs !== SELF);

/**
 * A cross-club logo concept: a shared "logo library"/"logo gallery" (either
 * word order), or "logos [that/for] other clubs [use]" — the exact phrase
 * from ADR-0024 constraint 2 and the #495 issue body. Deliberately a lexical
 * heuristic, like `ti-wordmark.guard.test.ts`'s filename regex — it can't
 * catch every conceivable phrasing of the concept, but it catches the shape
 * a real implementation of "browse other clubs' logos" would actually use.
 */
const CROSS_CLUB_LOGO =
	/logo[\s-]*(library|gallery)|(library|gallery)[\s-]*(of[\s-]+)?logos|logos?[\s-]+(that[\s-]+|for[\s-]+)?other[\s-]+clubs|other[\s-]+clubs['’]?[\s-]+logos?|shared[\s-]+logo|cross-club[\s-]+logo/i;

describe("no cross-club logo concept exists anywhere in src/ (#495, ADR-0024 constraint 2)", () => {
	it("walks a non-trivial source tree (so a broken walk can't pass vacuously)", () => {
		expect(sourceFiles.length).toBeGreaterThan(100);
	});

	it("no file references a shared logo library/gallery or a cross-club logo listing", () => {
		const offenders = sourceFiles
			.filter((abs) => CROSS_CLUB_LOGO.test(read(relative(ROOT, abs))))
			.map((abs) => relative(ROOT, abs));
		expect(
			offenders,
			"These files reference a cross-club logo concept (a shared library/" +
				'gallery, or "logos other clubs use"). ADR-0024 constraint 2 forbids ' +
				"this outright — a club's uploaded logo may only ever be read scoped " +
				"to that club:\n  " +
				offenders.join("\n  "),
		).toEqual([]);
	});
});
