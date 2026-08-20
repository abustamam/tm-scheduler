import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resources } from "#/data/resources";
import { readSource } from "#/test/guard-source";

// Vitest runs from the repo root, so process.cwd() is the project root.
const ROOT = process.cwd();
const CONTENT_DIR = resolve(ROOT, "content", "resources");

describe("resources registry integrity (#310)", () => {
	for (const r of resources) {
		it(`${r.slug} has a markdown article`, () => {
			const md = resolve(CONTENT_DIR, `${r.slug}.md`);
			expect(existsSync(md), `missing ${md}`).toBe(true);
		});

		for (const d of r.downloads ?? []) {
			it(`${r.slug} download "${d.label}" points at an existing sheet`, () => {
				// Downloads must live under /role-sheets/ to avoid the /resources/$slug
				// route namespace (spec §Download path).
				expect(d.href.startsWith("/role-sheets/")).toBe(true);
				const pdf = resolve(ROOT, "public", d.href.replace(/^\//, ""));
				expect(existsSync(pdf), `missing ${pdf}`).toBe(true);
			});
		}
	}

	// Third direction: a STATIC route file claiming a registered slug BEATS
	// `resources.$slug`, so that slug's article becomes reachable from no URL and
	// renders nowhere. That is exactly what happened to `evaluation-resources`:
	// both assertions above were green (registry entry ✓, markdown file ✓) while
	// 26 committed lines of public prose — including the instruction telling the
	// reader how to search that very page — rendered on no page at all. A route
	// that takes a slug must render that slug's article itself. Enrolls the next
	// such route automatically rather than relying on someone remembering.
	//
	// Comment-blind (`readSource`): both are "this pattern must BE present", so a
	// comment merely naming `getResourceMarkdown` would be a false PASS.
	for (const r of resources) {
		const route = resolve(ROOT, "src", "routes", `resources.${r.slug}.tsx`);
		if (!existsSync(route)) continue;
		it(`${r.slug} has its own route, which must render the article`, () => {
			const src = readSource(route);
			expect(src).toContain(`getResourceMarkdown("${r.slug}")`);
			expect(src).toContain("<ReactMarkdown");
		});
	}

	// Reverse direction: no orphan markdown. A `content/resources/<slug>.md`
	// with no registry entry would never render (its slug hits notFound), so it
	// is almost certainly a mis-slugged file — fail loudly at test time.
	const slugs = new Set(resources.map((r) => r.slug));
	for (const file of readdirSync(CONTENT_DIR)) {
		if (!file.endsWith(".md")) continue;
		const slug = file.replace(/\.md$/, "");
		it(`markdown ${file} has a registry entry`, () => {
			expect(slugs.has(slug), `orphan markdown: ${file}`).toBe(true);
		});
	}
});
