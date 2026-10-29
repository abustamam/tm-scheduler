// #1366: link TEXT must be AA on foam/white in light mode, so `--color-link`
// resolves to `--lagoon-ink`; every fill/border/gradient that used the old
// token now uses `--color-link-fill` (= `--lagoon-deep`, unchanged paint).
// Source greps, for the same reason as text-link-layering.guard.test.ts:
// jsdom loads no stylesheet.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "styles.css"), "utf8");

function luminance(hex: string): number {
	const c = [1, 3, 5].map((i) => {
		const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}
function lightVar(name: string): string {
	const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
	if (!m) throw new Error(`--${name} not found`);
	return m[1];
}

function walk(dir: string, out: string[] = []): string[] {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
	}
	return out;
}

describe("link colour split (#1366)", () => {
	it("--color-link is the ink step and link text is AA on foam and white", () => {
		expect(css).toMatch(/--color-link:\s*var\(--lagoon-ink\)/);
		const ink = lightVar("lagoon-ink");
		expect(contrast(ink, lightVar("foam"))).toBeGreaterThanOrEqual(4.5);
		expect(contrast(ink, "#ffffff")).toBeGreaterThanOrEqual(4.5);
	});

	it("--color-link-fill stays the old deep lagoon", () => {
		expect(css).toMatch(/--color-link-fill:\s*var\(--lagoon-deep\)/);
	});

	it("the global a rule and prose links use the token, hover is not colour-only", () => {
		expect(css).not.toMatch(/\ba\s*\{[^}]*color:\s*var\(--lagoon-deep\)/);
		expect(css).toMatch(
			/\.prose-gavelup a\s*\{[^}]*color:\s*var\(--color-link\)/,
		);
		expect(css).toMatch(/a:hover\s*\{[^}]*text-decoration-thickness:\s*2px/);
	});

	it("no bg-/border-/to- utility uses the text token", () => {
		const re = /(?<![\w-])(?:[\w[\]:-]*:)?(?:bg|border|to)-link(?![\w-])/;
		const offenders = walk(join(__dirname))
			.filter((p) => re.test(readFileSync(p, "utf8")))
			.map((p) => p.replace(__dirname, "src"));
		expect(offenders).toEqual([]);
	});
});
