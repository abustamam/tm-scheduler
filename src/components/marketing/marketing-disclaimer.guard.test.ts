// Trademark guard for the MARKETING surfaces (#865; wording from #256 /
// ADR-0024): every anonymous, non-club page must show the Toastmasters
// International non-affiliation disclaimer.
//
// `src/routes/public-disclaimer.guard.test.ts` covers the public `club.*`
// routes and enrols only those. Before this file, `/` and `/resources/*` carried
// the disclaimer by convention alone, and a new marketing route would not have
// been enrolled anywhere. The rule here is structural: a route renders
// <MarketingShell> or <ResourcesShell> — both of which are pinned below to
// render the canonical constant — or it is named in EXEMPT with a reason.
//
// Source greps rather than render tests for the same reason as the club guard:
// what is protected is coverage of a route SET, including routes that do not
// exist yet. Every read is comment-blind (`#/test/guard-source`), so a comment
// that mentions `<MarketingShell` cannot stand in for the element. That
// includes the one "must NOT be present" check (the <header>/<footer> ban at
// the bottom), deliberately — see the note there.
import { readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROUTES = resolve(ROOT, "src/routes");
const MARKETING_DIR = "src/components/marketing";
const MARKETING_SHELL = `${MARKETING_DIR}/marketing-shell.tsx`;
const RESOURCES_SHELL = "src/components/resources/resources-shell.tsx";

const read = (rel: string) => readSource(resolve(ROOT, rel));
const readRoute = (file: string) => readSource(resolve(ROUTES, file));

/**
 * Route files that legitimately render neither shell, each with the reason.
 * Adding an entry is a claim that the page does not need the marketing chrome;
 * make it only for a surface that is not a marketing page.
 */
const EXEMPT: Record<string, string> = {
	"__root.tsx": "the app shell (providers, <head>), not a page",
	"_authed.tsx": "the signed-in layout; <AppShell> carries the disclaimer",
	"signin.tsx": "conversion surface with its own chrome; out of scope for #865",
	"claim.tsx": "conversion surface with its own chrome; out of scope for #865",
	"oauth.consent.tsx":
		"transactional surface with its own chrome; out of scope for #865",
	"unsubscribe.tsx":
		"transactional surface with its own chrome; out of scope for #865",
	"[.]well-known.$.ts": "a server handler for discovery documents, not a page",
};

/**
 * Enrol by CONTENT: a file is a route iff it declares `export const Route =` at
 * the start of a line (what the TanStack generator keys on). Anchored so a test
 * file that merely contains the phrase inside a regex literal — this one, or
 * `public-disclaimer.guard.test.ts` — does not enrol.
 */
const exportsRoute = (file: string) =>
	/^export const Route\s*=/m.test(readRoute(file));

/**
 * Top-level directories under `src/routes/` that hold no marketing pages:
 * signed-in pages (`_authed/`, whose layout's <AppShell> carries the
 * disclaimer) and API handlers (`api/`). Every OTHER directory is walked, so a
 * future `src/routes/districts/index.tsx` enrols like a flat route does.
 */
const SKIPPED_DIRS = new Set(["_authed", "api"]);

/** Every route file under `src/routes/`, walked RECURSIVELY, as a routes-relative path. */
function walkRoutes(dir: string = ROUTES): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const abs = join(dir, e.name);
		const rel = relative(ROUTES, abs);
		if (e.isDirectory()) return SKIPPED_DIRS.has(rel) ? [] : walkRoutes(abs);
		return /\.tsx?$/.test(e.name) && exportsRoute(rel) ? [rel] : [];
	});
}

const routeFiles = walkRoutes().sort();

/** `club.*` routes are the club guard's (`public-disclaimer.guard.test.ts`). */
const enrolled = routeFiles.filter(
	(f) => !basename(f).startsWith("club.") && !(f in EXEMPT),
);

/** Component files in the marketing directory, other than the shell itself. */
const marketingComponents = readdirSync(resolve(ROOT, MARKETING_DIR))
	.filter((f) => f.endsWith(".tsx") && !f.includes(".test."))
	.map((f) => `${MARKETING_DIR}/${f}`)
	.filter((f) => f !== MARKETING_SHELL)
	.sort();

describe("marketing surfaces carry the TI non-affiliation disclaimer (#865)", () => {
	it("MarketingShell renders the canonical constant, not inlined wording", () => {
		const src = read(MARKETING_SHELL);
		expect(src).toMatch(
			/import\s*\{[^}]*\bTOASTMASTERS_DISCLAIMER\b[^}]*\}\s*from\s*"#\/lib\/brand"/,
		);
		expect(src).toMatch(/\{TOASTMASTERS_DISCLAIMER\}/);
	});

	it("ResourcesShell renders the disclaimer on its anonymous branch", () => {
		const src = read(RESOURCES_SHELL);
		expect(src).toMatch(
			/import\s*\{[^}]*\bTOASTMASTERS_DISCLAIMER\b[^}]*\}\s*from\s*"#\/lib\/brand"/,
		);
		const close = src.indexOf("</AppShell>");
		expect(
			close,
			"ResourcesShell no longer has an <AppShell> branch to slice after",
		).toBeGreaterThan(-1);
		// The anonymous branch is the code AFTER the signed-in early return; the
		// signed-in branch gets the disclaimer from <AppShell> itself.
		expect(src.slice(close)).toMatch(/\{TOASTMASTERS_DISCLAIMER\}/);
	});

	it("finds the marketing routes (so a rename can't make this vacuous)", () => {
		expect(enrolled).toContain("index.tsx");
		expect(enrolled.some((f) => f.startsWith("resources."))).toBe(true);
	});

	it("every EXEMPT entry is a real route file (no stale exemptions)", () => {
		for (const file of Object.keys(EXEMPT)) {
			expect(routeFiles, `${file} is in EXEMPT but is not a route`).toContain(
				file,
			);
		}
	});

	for (const file of enrolled) {
		it(`${file} renders <MarketingShell> or <ResourcesShell>`, () => {
			expect(
				readRoute(file),
				`${file} is an anonymous, non-club route, so it must render ` +
					"<MarketingShell> (which carries the TI disclaimer) — or, if it " +
					"is genuinely not a marketing page, be added to EXEMPT with a reason.",
			).toMatch(/<(MarketingShell|ResourcesShell)\b/);
		});
	}

	// AC2 of #865: the marketing header/footer live in ONE file,
	// marketing-shell.tsx. A marketing route or marketing component that
	// hand-rolls a <header>/<footer> is the drift this extraction exists to end.
	//
	// Read comment-STRIPPED even though this is a "must NOT be present" check,
	// which guard-source.ts says should read raw: a commented-out <header> is
	// not a hand-rolled one, so stripping cannot hide a real violation here.
	it("finds marketing components besides the shell (so the ban can't be vacuous)", () => {
		expect(marketingComponents).toContain(`${MARKETING_DIR}/founder-note.tsx`);
	});

	for (const file of [
		...enrolled.map((f) => `src/routes/${f}`),
		...marketingComponents,
	]) {
		it(`${file} does not hand-roll its own <header>/<footer>`, () => {
			expect(
				read(file),
				`${file} renders its own <header>/<footer>; marketing chrome lives ` +
					`only in ${MARKETING_SHELL}.`,
			).not.toMatch(/<(header|footer)\b/);
		});
	}
});
