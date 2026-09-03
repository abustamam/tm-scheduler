// The club-logo limits are declared ONCE and imported everywhere (#504).
//
// Why that matters, and the drift that proved it, are in the module this
// guards: `#/lib/club-logo-limits`. Not restated here — the repo's own rule
// (`club-archive.ts`) is that one file holds the narrative and the rest point
// at it, because a claim copied into six places rots in six places.
//
// Two checks, and they are deliberately opposite shapes:
//
//   1. OFFENDER SWEEP — no production source file outside the limits module may
//      DECLARE one of these names or spell one of the numbers. Read RAW, not
//      through `#/test/guard-source`: for an "offender list must be empty"
//      guard, a comment can only cause a false FAILURE (the safe direction),
//      whereas stripping comments would LOOSEN it. Same reasoning as
//      `ti-wordmark.guard.test.ts` and `server-modules.guard.test.ts`.
//
//   2. IMPORT ENROLMENT — any production file that USES one of these names must
//      import it from `#/lib/club-logo-limits`. This one is "the pattern must BE
//      present", so it reads comment-blind: a file whose comment merely mentions
//      the import path must not satisfy it. Derived from the sweep rather than
//      from a hardcoded file list, so the next consumer is enrolled the moment
//      it is written instead of when someone remembers to add it here.
//
// TEST files are exempt from the sweep on purpose. A test SHOULD be able to
// write `256 * 1024` — `club-logo-logic.integration.test.ts` and
// `club-logo-limits.test.ts` pin the absolute values, and a test stated only
// relative to the constant it guards passes for every value of that constant,
// including one that reintroduces the bug the cap exists to prevent.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_ENCODED_LENGTH, MAX_LOGO_BYTES } from "#/lib/club-logo-limits";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");
const LIMITS_MODULE = resolve(ROOT, "src/lib/club-logo-limits.ts");
const PARSER_MODULE = resolve(ROOT, "src/lib/image-dimensions.ts");

const SKIP_DIRS = new Set([
	"node_modules",
	".output",
	".vite",
	"dist",
	"build",
]);
const SCANNED = /\.(m?[jt]sx?|cjs|cts)$/i;
const IS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)src\/test\//;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) walk(abs, out);
		else out.push(abs);
	}
	return out;
}

/**
 * Production source, minus the limits module (which is where the declarations
 * belong) and minus this file (which states the patterns it forbids, so it
 * cannot be its own offender — the SELF filter `ti-wordmark.guard.test.ts` uses).
 *
 * `scripts/` is walked alongside `src/` because it is source here too — CLAUDE.md
 * names it in the ship sizing pathspec, and the closest precedent guard
 * (`attendance-plan-store.guard.test.ts`) enforces across both. Nothing there
 * hardcodes a cap today; walking it is enrolment, so a future seed or backfill
 * script is covered without anyone remembering.
 */
const productionFiles = ["src", "scripts"]
	.map((d) => resolve(ROOT, d))
	.flatMap((d) => (existsSync(d) ? walk(d) : []))
	.filter((abs) => SCANNED.test(abs))
	.filter((abs) => !IS_TEST.test(abs.replaceAll("\\", "/")))
	.filter((abs) => abs !== SELF && abs !== LIMITS_MODULE);

const raw = (abs: string) => readFileSync(abs, "utf8");
const rel = (abs: string) => relative(ROOT, abs);

/** Everything `#/lib/club-logo-limits` must export, and the only place they live. */
const EXPORTED_NAMES = [
	"MAX_LOGO_BYTES",
	"MAX_LOGO_KB",
	"MAX_ENCODED_LENGTH",
	"MAX_LOGO_DIMENSION",
	"ALLOWED_LOGO_MIME_TYPES",
	"AllowedLogoMime",
	"isAllowedLogoMime",
];

/**
 * The names no production file outside the limits module may declare.
 *
 * `ALLOWED_LOGO_TYPES` is the spelling the pre-#504 client duplicate used: it
 * resolves to nothing now, and an author reaching for "a local allow-list"
 * would reach for it first. Its generic sibling `ALLOWED_MIME_TYPES` is
 * deliberately NOT reserved — this is a logo guard, and a repo-wide ban on a
 * name that any future upload feature (the CSV import path, say) would
 * reasonably choose fails unrelated code with a message about club logos and
 * #496. A guard that fires on code it has no interest in gets deleted rather
 * than fixed. The value sweep and the import-enrolment check below cover the
 * hazard that actually exists.
 */
const FORBIDDEN_DECLARATIONS = [...EXPORTED_NAMES, "ALLOWED_LOGO_TYPES"];

/**
 * A DECLARATION of `name`, not a mention or an import of it.
 *
 * The trailing token matters: `import { type AllowedLogoMime }` is
 * `type AllowedLogoMime,` and a bare `\btype\s+NAME\b` flags every correct
 * consumer as an offender — which it did on the first run of this guard.
 * Requiring the `=` / `(` / `{` that a real declaration carries separates the
 * two without having to parse the import syntax.
 */
const DECLARATION = (name: string) =>
	new RegExp(
		`\\b(?:const|let|var)\\s+${name}\\s*[=:]` +
			`|\\btype\\s+${name}\\s*=` +
			`|\\b(?:interface|class|enum)\\s+${name}\\s*[{<]` +
			`|\\bfunction\\s+${name}\\s*[(<]`,
	);

/**
 * The literal values, DERIVED from the constants rather than typed out.
 *
 * Hardcoding `256 * 1024` here would make this file a second declaration of the
 * very numbers it polices, and it would retire silently: `club-logo-limits.test.ts`
 * pins the caps with `toBeLessThanOrEqual`, not equality, so lowering the byte cap
 * to 128 KiB keeps every test green while this sweep goes on hunting a value
 * nothing uses — and a fresh `128 * 1024` duplicate elsewhere goes undetected.
 *
 * Two boundaries this sweep does NOT cover, stated so the next reader does not
 * infer it is total:
 *
 *   · `MAX_LOGO_DIMENSION`'s value is not swept. `2000` is far too common a
 *     number to grep across `src/` without noise that would get the guard
 *     disabled. A NAMED re-declaration is still caught, and the copy-derivation
 *     tests catch a stale user-facing number.
 *   · A duplicate written under an unlisted identifier (`const LOGO_CAP = …`)
 *     evades the name half by construction. The value half is what catches it,
 *     which is why the spellings below include the reversed and shifted forms.
 */
const spellingsOf = (n: number): RegExp[] => {
	const grouped = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "_");
	const out = [
		new RegExp(`\\b${n}\\b`),
		new RegExp(`\\b${grouped.replace(/_/g, "_?")}\\b`),
	];
	// Multiplications and shifts that produce the same value, e.g. 256 * 1024,
	// 1024 * 256 and 256 << 10 for 262144.
	for (let bit = 1; bit < 31; bit++) {
		const unit = 2 ** bit;
		if (n % unit !== 0) continue;
		const other = n / unit;
		out.push(new RegExp(`\\b${other}\\s*\\*\\s*${unit}\\b`));
		out.push(new RegExp(`\\b${unit}\\s*\\*\\s*${other}\\b`));
		out.push(new RegExp(`\\b${other}\\s*<<\\s*${bit}\\b`));
	}
	out.push(new RegExp(`\\b0x${n.toString(16)}\\b`, "i"));
	return out;
};

const LITERALS: { patterns: RegExp[]; label: string }[] = [
	{ patterns: spellingsOf(MAX_LOGO_BYTES), label: "the decoded byte cap" },
	{ patterns: spellingsOf(MAX_ENCODED_LENGTH), label: "the encoded cap" },
];

describe("club-logo limits are declared once (#504)", () => {
	it("walks a non-trivial production tree (so a broken walk can't pass vacuously)", () => {
		expect(productionFiles.length).toBeGreaterThan(100);
	});

	it("the limits module exists and exports every name", () => {
		expect(existsSync(LIMITS_MODULE)).toBe(true);
		const src = readSource(LIMITS_MODULE);
		const missing = EXPORTED_NAMES.filter(
			(n) =>
				!new RegExp(`\\bexport\\s+(?:const|type|function)\\s+${n}\\b`).test(
					src,
				),
		);
		expect(
			missing,
			`#/lib/club-logo-limits must export these, and does not: ${missing.join(", ")}.`,
		).toEqual([]);
	});

	it.each([
		["src/lib/club-logo-limits.ts", LIMITS_MODULE],
		["src/lib/image-dimensions.ts", PARSER_MODULE],
	])("%s imports nothing, so client code can use it", (name, path) => {
		// The whole reason both live in `lib/` and not `server/`: an import of
		// `#/db` in either would drag `pg` → `Buffer` into the client bundle the
		// moment `club-settings.tsx` imports a cap or the parser, which is the
		// failure `server-modules.guard.test.ts` exists for one layer up.
		const imports = [
			...readSource(path).matchAll(/from\s+["']([^"']+)["']/g),
		].map((m) => m[1]);
		expect(
			imports,
			`${name} must stay dependency-free; it imports ${JSON.stringify(imports)}.`,
		).toEqual([]);
	});

	it("the declaration matcher separates a declaration from an import", () => {
		// A guard whose matcher is wrong is worse than no guard: it reports a
		// clean sweep of a codebase it cannot see. Both directions, on fixtures,
		// so this stays honest without depending on what src/ happens to contain.
		const decl = DECLARATION("MAX_LOGO_BYTES");
		expect(decl.test("const MAX_LOGO_BYTES = 256 * 1024;")).toBe(true);
		expect(decl.test("export const MAX_LOGO_BYTES = 1;")).toBe(true);
		expect(decl.test('let MAX_LOGO_BYTES = 1;\nimport "x";')).toBe(true);
		expect(decl.test('import { MAX_LOGO_BYTES } from "#/lib/x";')).toBe(false);
		expect(decl.test("if (file.size > MAX_LOGO_BYTES) return;")).toBe(false);

		const typeDecl = DECLARATION("AllowedLogoMime");
		expect(typeDecl.test("type AllowedLogoMime = string;")).toBe(true);
		expect(
			typeDecl.test('import { type AllowedLogoMime } from "#/lib/x";'),
		).toBe(false);
		expect(
			typeDecl.test("import {\n\ttype AllowedLogoMime,\n} from '#/lib/x';"),
		).toBe(false);
	});

	it("no production file outside the limits module re-declares a limit name", () => {
		const offenders = productionFiles.flatMap((abs) => {
			const src = raw(abs);
			return FORBIDDEN_DECLARATIONS.filter((n) => DECLARATION(n).test(src)).map(
				(n) => `${rel(abs)}: ${n}`,
			);
		});
		expect(
			offenders,
			"These files DECLARE a club-logo limit instead of importing it from " +
				`#/lib/club-logo-limits: ${JSON.stringify(offenders)}. Four files ` +
				"holding four identically-named constants is exactly how the pixel " +
				"cap ended up server-only (#496) with every gate green.",
		).toEqual([]);
	});

	it("no production file outside the limits module spells a limit's value", () => {
		const offenders = productionFiles.flatMap((abs) => {
			const src = raw(abs);
			return LITERALS.filter(({ patterns }) =>
				patterns.some((p) => p.test(src)),
			).map(({ label }) => `${rel(abs)}: ${label}`);
		});
		expect(
			offenders,
			"These files spell a club-logo limit as a literal: " +
				`${JSON.stringify(offenders)}. Import it from #/lib/club-logo-limits ` +
				"— a number retyped is a second declaration, whether or not it has a " +
				"name. (Tests are exempt: they pin the ABSOLUTE values on purpose.)",
		).toEqual([]);
	});

	it("every production file that uses a limit imports it from the limits module", () => {
		// Comment-blind: this half is "the import must BE present", where a
		// comment naming the path would otherwise be a false pass.
		const users = productionFiles.filter((abs) => {
			const src = readSource(abs);
			return EXPORTED_NAMES.some((n) => new RegExp(`\\b${n}\\b`).test(src));
		});
		expect(
			users.length,
			"No production file references a club-logo limit at all — the name list " +
				"or the sweep has gone stale, not the codebase.",
		).toBeGreaterThanOrEqual(3);

		const unimported = users
			.filter(
				(abs) =>
					!/from\s+["']#\/lib\/club-logo-limits["']/.test(readSource(abs)),
			)
			.map(rel);
		expect(
			unimported,
			"These files use a club-logo limit without importing it from " +
				`#/lib/club-logo-limits: ${JSON.stringify(unimported)}.`,
		).toEqual([]);
	});
});
