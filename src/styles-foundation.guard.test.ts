// Guards for the styles.css foundation (#1306): motion tokens, one reduced-motion
// block, one background wash, and the semantic aliases the S1 to S5 sweeps
// move components onto.
//
// A source parse, like `text-link-layering.guard.test.ts`: jsdom loads no
// stylesheet, so nothing in-process sees these. The real cascade is checked
// by `styles-foundation-browser.test.ts`.
//
// Comment-blind (`readSource`) throughout: every assertion here is a
// must-be-present or must-be-absent check on a rule, and this file's own
// comments in styles.css quote the selectors it looks for.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const STYLES = resolve(dirname(fileURLToPath(import.meta.url)), "./styles.css");
const css = readSource(STYLES);

/** Body of the first top-level block whose header starts with `header`, brace-aware. */
function blockBody(source: string, header: string): string {
	const at = source.indexOf(header);
	if (at === -1) return "";
	const open = source.indexOf("{", at);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0)
			return source.slice(open + 1, i);
	}
	return "";
}

const theme = blockBody(css, "@theme inline");
const root = blockBody(css, "\n:root");

describe("styles.css foundation (#1306)", () => {
	it("extraction is not vacuous", () => {
		expect(theme.length).toBeGreaterThan(200);
		expect(root.length).toBeGreaterThan(200);
	});

	it("declares the six motion tokens in :root and the easings in @theme inline", () => {
		const tokens: Record<string, string> = {
			"--duration-micro": "120ms",
			"--duration-short": "200ms",
			"--duration-medium": "300ms",
			"--ease-enter": "cubic-bezier(0.2, 0, 0, 1)",
			"--ease-exit": "cubic-bezier(0.4, 0, 1, 1)",
			"--ease-move": "cubic-bezier(0.4, 0, 0.2, 1)",
		};
		for (const [name, value] of Object.entries(tokens)) {
			expect(root, `${name} in :root`).toContain(`${name}: ${value};`);
		}
		for (const name of ["--ease-enter", "--ease-exit", "--ease-move"]) {
			expect(theme, `${name} in @theme inline`).toContain(
				`${name}: ${tokens[name]};`,
			);
		}
	});

	it("has exactly one prefers-reduced-motion block, setting both durations on *", () => {
		const header = "@media (prefers-reduced-motion: reduce)";
		expect(css.split(header).length - 1).toBe(1);
		const body = blockBody(css, header);
		expect(body).toMatch(/\*\s*,/);
		expect(body).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
		expect(body).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
	});

	it("paints one wash on body, from --hero-a, and drops the overlay layers", () => {
		const body = blockBody(css, "\nbody {");
		const bg = /background:([^;]*);/.exec(body)?.[1] ?? "";
		expect(bg).not.toBe("");
		expect(bg.match(/radial-gradient\(/g)).toHaveLength(1);
		expect(bg).toContain("var(--hero-a)");
		expect(bg).not.toContain("linear-gradient");
		expect(css).not.toMatch(/body::before/);
		expect(css).not.toMatch(/body::after/);
		// The variable stays: the marketing shell may reference it.
		expect(css).toContain("--hero-b:");
	});

	it.each([
		["--color-surface-raised", "var(--surface-strong)"],
		["--color-surface-glass", "var(--surface)"],
		["--color-surface-soft", "var(--foam)"],
		["--color-surface-muted", "var(--sand)"],
		["--color-link", "var(--lagoon-deep)"],
		["--color-highlight", "var(--lagoon)"],
		["--color-primary-ink", "var(--lagoon-ink)"],
		["--color-timer-green", "#1f7a46"],
		["--color-timer-yellow", "#f2c230"],
		["--color-timer-red", "#c0262d"],
		["--color-timer-over", "#7a1218"],
		["--color-timer-yellow-ink", "#1a1405"],
	])("@theme inline declares %s as %s", (name, value) => {
		expect(theme).toContain(`${name}: ${value};`);
	});
});
