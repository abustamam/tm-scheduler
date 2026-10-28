// Guards the DESIGN.md token and type vocabulary across `src` (#1317): no brand
// CSS var, arbitrary text size, raw palette colour, `transition-all`, text
// opacity, off-scale font weight or literal colour in a component or route.
//
// A source-grep guard because the change is a NEGATIVE ("this spelling is not
// used"), which no behavioural test can assert across a whole tree. Modelled on
// `routes/no-tel-links.guard.test.ts`; like it, this asserts an offender list
// is EMPTY, so it reads RAW (a comment can only add a false offender, and
// blanking comments would loosen the guard).
//
// D1 to D7 are copied verbatim from criterion 1 of the S issues (#1310 to #1314).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SELF = fileURLToPath(import.meta.url);
const SRC = resolve(dirname(SELF));
const ROOT = resolve(SRC, "..");

interface Rule {
	id: string;
	pattern: RegExp;
	why: string;
}

const RULES: Rule[] = [
	{
		id: "D1",
		pattern:
			/var\(--(sea-ink|lagoon|palm|sand|foam|line|surface|inset-glint|warning|success|hero)[a-z-]*\)/,
		why: "use a semantic token (text-muted-foreground, border-border, bg-surface-raised, ...), not a brand var",
	},
	{
		id: "D2",
		pattern: /\btext-\[[0-9.]+(px|rem|em)\]/,
		why: "use the six-step type scale (text-xs/sm/base/xl/2xl...), not an arbitrary size",
	},
	{
		id: "D3",
		pattern:
			/\b(text|bg|border|ring|fill|stroke|from|to|via|outline|decoration|accent|divide|placeholder|caret)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/,
		why: "use a semantic colour token, not a raw palette colour",
	},
	{
		id: "D4",
		pattern: /\btransition-all\b/,
		why: "name the properties that change (transition-colors or transition-[...])",
	},
	{
		id: "D5",
		pattern: /\btext-(?!(xs|sm|base|lg|xl|\dxl)\/)[a-z-]+\/\d+/,
		why: "no text opacity (AA contrast); use the solid text token",
	},
	{
		id: "D6",
		pattern: /\bfont-(medium|extrabold|black|light|thin|extralight)\b/,
		why: "only font-normal, font-semibold and font-bold are loaded",
	},
	{
		id: "D7",
		pattern:
			/\b(bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|accent|divide|caret)-\[(#|rgba?\(|hsla?\(|oklch\()/,
		why: "use a colour token, not a literal colour (shadows are exempt)",
	},
];

function hits(text: string): { line: number; id: string; why: string }[] {
	const out: { line: number; id: string; why: string }[] = [];
	text.split("\n").forEach((l, i) => {
		for (const r of RULES) {
			if (r.pattern.test(l)) out.push({ line: i + 1, id: r.id, why: r.why });
		}
	});
	return out;
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) walk(abs, out);
		else out.push(abs);
	}
	return out;
}

const REL_SKIP = new Set([
	"src/routeTree.gen.ts",
	"src/components/agenda/meeting-agenda-print.tsx",
]);

const scanned = walk(SRC)
	.filter((abs) => /\.tsx?$/.test(abs))
	.filter((abs) => abs !== SELF)
	.filter((abs) => !/\.test\.[^/]*$/.test(abs))
	.filter((abs) => !relative(ROOT, abs).startsWith("src/test/"))
	.filter((abs) => !REL_SKIP.has(relative(ROOT, abs)))
	// Print routes own their own CSS vocabulary.
	.filter((abs) => !readFileSync(abs, "utf8").includes("PRINT_PAGE_CSS"));

describe("design tokens (DESIGN.md)", () => {
	it("walks a non-trivial source tree (so a broken walk can't pass vacuously)", () => {
		expect(scanned.length).toBeGreaterThan(300);
	});

	it("no source file uses a banned token or type spelling (D1 to D7)", () => {
		const offenders: string[] = [];
		for (const abs of scanned) {
			for (const h of hits(readFileSync(abs, "utf8"))) {
				offenders.push(
					`${relative(ROOT, abs)}:${h.line} ${h.id}: ${h.why} (DESIGN.md)`,
				);
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("D1 to D7 patterns", () => {
	const cases: [string, string, string][] = [
		["D1", "text-[var(--sea-ink-soft)]", "text-muted-foreground"],
		["D2", "text-[11px]", "text-xs"],
		["D3", "bg-red-500", "bg-destructive"],
		["D4", "transition-all", "transition-colors"],
		["D5", "text-foreground/70", "text-sm/6"],
		["D6", "font-medium", "font-semibold"],
		["D7", "bg-[#fff]", "shadow-[0_1px_rgba(0,0,0,.1)]"],
	];
	for (const [id, bad, good] of cases) {
		it(`${id} matches ${bad} and not ${good}`, () => {
			const rule = RULES.find((r) => r.id === id);
			expect(rule?.pattern.test(bad)).toBe(true);
			expect(rule?.pattern.test(good)).toBe(false);
		});
	}
});
