/**
 * The deploy chain must actually SEED `meeting_templates` on every boot, not
 * merely have a script capable of doing so sitting unused in the repo.
 *
 * `scripts/seed-templates.ts`'s own header records the failure this guards:
 * `meeting_templates` reached a database only when a human remembered to run
 * `bun run seed:templates` by hand, so production shipped v1.21.0.0's "Change
 * meeting type" picker offering every club nothing but the empty state, for
 * two releases — found only by querying prod directly. The fix was wiring the
 * seed into the deploy itself (Dockerfile `CMD`, `package.json`'s `start`, and
 * the `build` step that produces `.output/seed-templates.mjs` in the first
 * place), and that wiring has no OTHER gate: dropping the entry from `CMD`
 * reproduces the exact bug — the container still boots, the server still
 * answers requests, `node` still exits 0 — which is precisely the "silently
 * absent gate reads exactly like a passing one" shape this repo's other
 * deploy-time guards (migrations, seed-catalog) already exist to close for
 * their own scripts. Nothing type-checks a shell string, and nothing runs
 * this Dockerfile in CI, so a source read is the only seam available.
 *
 * ## Comment-blind where it matters, raw where blindness would be wrong
 *
 * `Dockerfile`'s `CMD` line is read through `readSource` for consistency with
 * this repo's other "must BE present" guards, but the real protection here is
 * structural rather than comment-stripping: Dockerfile comments start with
 * `#` (a syntax `readSource` does not strip — it only blanks `//` and
 * `/* *\/`), so a comment reading `# runs seed-templates.mjs` could satisfy a
 * blanket "does the file contain this string" check. The assertions below
 * never ask that; they extract the literal `CMD` INSTRUCTION line via an
 * anchored `^CMD` regex and check only its own text. A `#`-prefixed comment
 * line can never match `^CMD`, so this is immune to the bypass without
 * needing comment-stripping to do the work.
 *
 * `package.json` is parsed as JSON and read by FIELD (`scripts.start`,
 * `scripts.build`), never scanned as raw text. JSON has no comment syntax to
 * blank, and stripping arbitrary substrings from JSON text before parsing it
 * risks corrupting a string value that legitimately contains `//` — reading
 * the specific field via `JSON.parse` is both stronger and safer than either
 * `readSource` or a raw substring search would be here.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOCKERFILE = resolve(ROOT, "Dockerfile");
const PACKAGE_JSON = resolve(ROOT, "package.json");

type PackageJson = { scripts?: Record<string, string> };

function loadPackageJson(): PackageJson {
	return JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as PackageJson;
}

describe("the deploy chain seeds meeting_templates on every boot", () => {
	it("Dockerfile's CMD runs .output/seed-templates.mjs", () => {
		const src = readSource(DOCKERFILE);
		const cmdLine = src.match(/^CMD\b.*$/m)?.[0];
		expect(
			cmdLine,
			"no `CMD` instruction found in Dockerfile — if it was renamed or " +
				"restructured, update this extraction; if it was deleted, that is " +
				"the bug, not the test.",
		).toBeTruthy();
		expect(
			cmdLine,
			"Dockerfile's CMD must run node .output/seed-templates.mjs. Without " +
				"it, production boots with meeting_templates empty and exits 0 — " +
				"seed-templates.ts's own header describes this exact regression.",
		).toContain("seed-templates.mjs");
	});

	it("package.json's start script runs .output/seed-templates.mjs", () => {
		const pkg = loadPackageJson();
		expect(
			pkg.scripts?.start,
			"package.json has no `start` script, or it was restructured — this " +
				"is the same boot sequence the Dockerfile CMD runs outside a " +
				"container and the two must not drift.",
		).toBeTruthy();
		expect(
			pkg.scripts?.start,
			"package.json's `start` script must run .output/seed-templates.mjs, " +
				"matching the Dockerfile CMD above.",
		).toContain("seed-templates.mjs");
	});

	it("package.json's build script produces seed-templates.mjs via build:seed-templates", () => {
		const pkg = loadPackageJson();
		expect(pkg.scripts?.build, "package.json has no `build` script").toBeTruthy();
		expect(
			pkg.scripts?.build,
			"package.json's `build` script must run `build:seed-templates`, or " +
				".output/seed-templates.mjs is never produced and the CMD/start " +
				"line above fails at boot with a missing file instead of seeding.",
		).toContain("build:seed-templates");
		expect(
			pkg.scripts?.["build:seed-templates"],
			"the `build:seed-templates` script itself is missing from package.json",
		).toContain("seed-templates.ts");
	});
});
