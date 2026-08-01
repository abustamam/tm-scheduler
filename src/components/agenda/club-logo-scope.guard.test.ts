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

const LOGIC_FILE = "src/server/club-logo-logic.ts";
const ROUTE_FILE = "src/routes/api/club.$clubId.logo.ts";

/**
 * Every statement that TOUCHES `club_logos` — `.from(clubLogos)` for reads and
 * `.delete(clubLogos)` for removals — sliced from the call site up to its
 * terminating `;` (or EOF if none). Statement-scoped rather than whole-file so
 * one correctly-scoped access can't paper over a second, unscoped one
 * elsewhere in the same file.
 *
 * Deletes are included deliberately. This guard originally matched only
 * `.from(`, because #495 specified it as covering "the logo READ path" — and a
 * delete is not a read. That left the worst case unguarded: dropping the
 * `WHERE` from `removeClubLogo` would erase EVERY club's logo, and neither
 * this guard nor the integration suite caught it (every test seeded one club).
 */
function clubLogosStatements(src: string): string[] {
	const out: string[] = [];
	const re = /\.(?:from|delete)\(clubLogos\)/g;
	let m: RegExpExecArray | null = re.exec(src);
	while (m !== null) {
		const end = src.indexOf(";", m.index);
		out.push(src.slice(m.index, end === -1 ? src.length : end + 1));
		m = re.exec(src);
	}
	return out;
}

describe("club logo reads are scoped per-club (#495, ADR-0024 constraint 2)", () => {
	it("finds every club_logos access to check (so a rewrite can't go vacuous)", () => {
		const statements = clubLogosStatements(read(LOGIC_FILE));
		// 3 = two reads (meta, serving) + one delete (remove). A floor of 2
		// would still pass if the `.delete(` half of the matcher were lost,
		// which is precisely the hole this guard was widened to close.
		expect(statements.length).toBeGreaterThanOrEqual(3);
	});

	it("every club_logos read AND delete in the logic layer filters on eq(clubLogos.clubId, …)", () => {
		const statements = clubLogosStatements(read(LOGIC_FILE));
		const unscoped = statements.filter(
			(stmt) => !/eq\(clubLogos\.clubId,/.test(stmt),
		);
		expect(
			unscoped,
			`${LOGIC_FILE} reads or deletes club_logos without a clubId-scoped predicate: ` +
				`${JSON.stringify(unscoped)}. Every read AND delete must filter with ` +
				"eq(clubLogos.clubId, <the requested club's id>) — an unscoped read serves one club to another; an unscoped DELETE " +
				"erases every club's logo (ADR-0024 constraint 2).",
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
