import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resources } from "#/data/resources";

// Vitest runs from the repo root, so process.cwd() is the project root.
const ROOT = process.cwd();

describe("resources registry integrity (#310)", () => {
	for (const r of resources) {
		it(`${r.slug} has a markdown article`, () => {
			const md = resolve(ROOT, "content", "resources", `${r.slug}.md`);
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
});
