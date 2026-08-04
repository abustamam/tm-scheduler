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
// WHAT THIS GUARD CANNOT DO — read before trusting it. It is a lexical net,
// not a proof of scoping, and it has now been too weak three separate times:
// first it matched only `.from(` (a `delete` was invisible), then only one
// hardcoded file (#496's `innerJoin` was invisible), and then its predicate
// rule turned out to be satisfied by a column-to-column JOIN CONDITION, which
// scopes nothing at all — `.from(clubs).innerJoin(clubLogos, eq(clubLogos
// .clubId, clubs.id))` with no WHERE returns an ARBITRARY club's logo and was
// reported clean. Each fix made it broader; none made it a proof, because a
// regex cannot tell which value a predicate is bound to.
//
// So the REAL guarantee for constraint 2 lives in
// `club-logo-logic.integration.test.ts` ("loadRoleSheetLogo"), which seeds two
// clubs and asserts one never receives the other's bytes. This file's job is
// to catch the cheap, obvious regressions early and to keep new call sites
// from using shapes nothing can inspect. Treat a green run here as "nothing
// obviously wrong", never as "scoping is correct".
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
	"fullJoin",
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

	/**
	 * `eq(clubLogos.clubId, someTable.someColumn)` — a column-to-column JOIN
	 * CONDITION. It satisfies the rule above while scoping NOTHING to a
	 * requested club: it only says "line these two tables up".
	 */
	const JOIN_CONDITION = /eq\(clubLogos\.clubId,\s*\w+\.\w+\s*\)/;
	/** `eq(clubLogos.clubId, clubId)` — bound to a scalar the caller supplied. */
	const SCALAR_BINDING = /eq\(clubLogos\.clubId,\s*\w+\s*\)/;

	it("a join-condition-only access must still bind a WHERE", () => {
		const leaky = accessWith(ROW_SELECTING_VERBS).filter(
			({ stmt }) =>
				JOIN_CONDITION.test(stmt) &&
				!SCALAR_BINDING.test(stmt) &&
				!/\.where\(/.test(stmt),
		);
		expect(
			leaky,
			"These statements scope club_logos ONLY with a join condition and no " +
				`WHERE: ${JSON.stringify(leaky)}. A join condition lines two tables ` +
				"up; it does not pick a club. `.from(clubs).innerJoin(clubLogos, " +
				"eq(clubLogos.clubId, clubs.id))` with no WHERE returns an ARBITRARY " +
				"club's logo bytes while passing the rule above — which is the shape " +
				"loadRoleSheetLogo uses (its real scoping is eq(meetings.id, …)).",
		).toEqual([]);
	});

	/**
	 * Shapes that read `club_logos` WITHOUT going through a verb this matcher
	 * can see — so the checks above would report zero offenders while every
	 * club's bytes went out the door.
	 *
	 * These are not hypothetical. `schema.ts` defines `clubsRelations.logo =
	 * one(clubLogos)` and the client is `drizzle(url, { schema })`, so
	 * `db.query.clubs.findMany({ with: { logo: true } })` works TODAY and reads
	 * every club's logo in one statement — the literal thing constraint 2
	 * forbids. `alias()` and a raw `sql` template evade it the same way. Banning
	 * the shapes outright is enforceable; teaching the verb matcher to
	 * understand them is not.
	 */
	const INVISIBLE_SHAPES: { pattern: RegExp; why: string }[] = [
		{
			pattern: /db\.query\.clubLogos/,
			why: "the relational query API bypasses the verb matcher entirely",
		},
		{
			pattern: /with:\s*\{[^}]*\blogo\b/,
			why: "a relational include pulls logo rows for every parent club row",
		},
		{
			pattern: /alias\(\s*clubLogos\b/,
			why: "an alias renames the table out of the matcher's view",
		},
		{
			pattern: /\bclub_logos\b/,
			why: "raw SQL against the table name is invisible to every check here",
		},
	];

	it("no file reaches club_logos through a shape this guard cannot see", () => {
		// `schema.ts` necessarily names the table and defines the relation.
		const exempt = /src\/db\/schema\.ts$/;
		const offenders = sourceFiles
			.filter((abs) => !exempt.test(relative(ROOT, abs)))
			.flatMap((abs) => {
				const src = read(relative(ROOT, abs));
				return INVISIBLE_SHAPES.filter(({ pattern }) => pattern.test(src)).map(
					({ why }) => `${relative(ROOT, abs)} — ${why}`,
				);
			});
		expect(
			offenders,
			"These reach club_logos in a way the verb/predicate checks above are " +
				`blind to:\n  ${offenders.join("\n  ")}\n` +
				"Use an explicit `.select().from(clubLogos).where(eq(clubLogos." +
				"clubId, <id>))` so the scoping is visible to this guard and to a " +
				"reader (ADR-0024 constraint 2).",
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
