import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resources } from "#/data/resources";

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
