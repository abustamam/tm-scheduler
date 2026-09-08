/**
 * The agent-instruction docs may cite only paths that exist.
 *
 * `CLAUDE.md`, `CODING_STANDARDS.md`, `CONTEXT.md`, `docs/agents/*.md` and `TODOS/README.md`
 * are read by every agent before it touches the repo, and they steer by path: "see
 * `src/x.ts`", "the harness is `src/test/y.ts`". A citation that outlives its file sends the
 * next agent to grep for something that is not there, and nothing else in the gate notices:
 * Biome excludes Markdown, `tsc` never sees it, and a dead path reads exactly like a live one.
 * CLAUDE.md cited `src/integrations/better-auth/header-user.tsx` as the example `authClient`
 * consumer for some time after b7efda0 deleted it; this test is what would have said so.
 *
 * ## What counts as a citation
 *
 * A backticked token whose first segment is a directory at the repo root, containing no
 * whitespace and none of `<`, `>`, `*`, `…`, `{`, `}`. Those characters mark a template
 * (`TODOS/<branch-name>.md`, `chromium_headless_shell-*`), not a path. `$` is deliberately
 * allowed through, because TanStack route files carry it (`src/routes/api/auth/$.ts`) and a
 * shell variable never starts with a repo directory. Build outputs (`.output/…`) never match:
 * `.output` is not checked in, so a fresh checkout has no such directory.
 *
 * ## Why the extractor is tested, not just the docs
 *
 * A guard that greps a doc and finds nothing to check passes exactly like a doc with no dead
 * paths. So one test pins that the extractor pulls a known live citation out of CLAUDE.md, and
 * one feeds it a synthetic doc with a dead path and a template and asserts it reports the first
 * and skips the second. Both are what let the per-doc assertions below mean anything.
 *
 * Skills under `.claude/skills/` are NOT covered: `session-retro/SKILL.md` names a path whose
 * absence is the point ("if an installer re-creates `.claude/skills/retro`, delete it").
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Directories at the repo root: the only legal first segment of a cited path. */
const TOP_LEVEL_DIRS: ReadonlySet<string> = new Set(
	readdirSync(ROOT, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
		.map((entry) => entry.name),
);

const DOCS = [
	"CLAUDE.md",
	"CODING_STANDARDS.md",
	"CONTEXT.md",
	...readdirSync(resolve(ROOT, "docs/agents"))
		.filter((name) => name.endsWith(".md"))
		.map((name) => `docs/agents/${name}`),
	"TODOS/README.md",
].filter((rel) => existsSync(resolve(ROOT, rel)));

const PLACEHOLDER = /[\s<>*…{}]/;

/** Every distinct repo-relative path a Markdown document cites in backticks. */
function citedPaths(
	markdown: string,
	topLevelDirs: ReadonlySet<string>,
): string[] {
	const out = new Set<string>();
	for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
		const token = match[1];
		if (PLACEHOLDER.test(token)) continue;
		const slash = token.indexOf("/");
		if (slash <= 0) continue;
		if (!topLevelDirs.has(token.slice(0, slash))) continue;
		out.add(token);
	}
	return [...out];
}

describe("citedPaths", () => {
	it("reports a dead path and skips a template", () => {
		const doc =
			"see `src/nope.ts`, `TODOS/<branch-name>.md`, `src/routes/api/auth/$.ts` and `bun run dev`";
		expect(citedPaths(doc, new Set(["src", "TODOS"]))).toEqual([
			"src/nope.ts",
			"src/routes/api/auth/$.ts",
		]);
	});

	it("extracts a known live citation from CLAUDE.md", () => {
		const cited = citedPaths(
			readFileSync(resolve(ROOT, "CLAUDE.md"), "utf8"),
			TOP_LEVEL_DIRS,
		);
		expect(cited).toContain("src/db/schema.ts");
		expect(cited.length).toBeGreaterThan(20);
	});
});

describe("agent-instruction docs cite only paths that exist", () => {
	for (const rel of DOCS) {
		it(rel, () => {
			const cited = citedPaths(
				readFileSync(resolve(ROOT, rel), "utf8"),
				TOP_LEVEL_DIRS,
			);
			const missing = cited.filter((path) => !existsSync(resolve(ROOT, path)));
			expect(missing).toEqual([]);
		});
	}
});
