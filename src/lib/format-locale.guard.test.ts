// No formatter under `src/` may resolve its locale from the runtime (#708).
//
// ## Why a guard
//
// An omitted locale resolves against whichever process is formatting: the SSR
// container answers `en-US`, a Spanish-locale browser `es-ES`, and the two
// passes print different text for the same instant — a hydration mismatch that
// no single-runtime test can see (`src/test/hydration-across-runtimes.ts` says
// why). #708 found it in eleven files at once, five of them the shared
// formatters in `format.ts`, all written the natural way. The property worth
// protecting is that a TWELFTH cannot appear, which is a negative across the
// tree. Every such call passes `APP_LOCALE` from `#/lib/format` instead.
//
// ## What counts as an offender
//
//   - `Intl.<Anything>(undefined, …)`, with or without `new`;
//   - `Intl.<Anything>()` with no arguments at all — EXCEPT when the very next
//     thing is `.resolvedOptions()`. That is how the superadmin console reads
//     the browser's TIMEZONE, which is a question about the runtime rather than
//     a rendering of one; it formats nothing;
//   - `.toLocaleString()` / `.toLocaleDateString()` / `.toLocaleTimeString()`
//     called bare or with `undefined` first.
//
// ## Read direction: the TypeScript AST, not a text grep
//
// This is an offender guard, so a comment spelling the construction could only
// ever produce a false FAILURE — the safe direction, and why the repo's other
// offender guards read raw text. It reads the AST anyway, for the same safe
// reason: comments and strings are not call expressions, so the parse cannot
// hide a real call the way blanking text can, and prose that explains the bug
// (the dashboard and `speech-log-date.tsx` both quote the old call in their
// doc comments) does not have to be reworded to satisfy a grep. A call the
// parser sees is a call that runs.
//
// Honest limitation: an aliased constructor (`const F = Intl.DateTimeFormat;
// new F()`) or a locale held in a variable that happens to be `undefined`
// escapes it. The shape that shipped eleven times is the literal one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../..");
const SRC = join(ROOT, "src");

const TO_LOCALE = new Set([
	"toLocaleString",
	"toLocaleDateString",
	"toLocaleTimeString",
]);

/** Production source only: tests, the test harness and generated code are out. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (path === join(SRC, "test")) continue;
			out.push(...sourceFiles(path));
			continue;
		}
		if (!/\.(ts|tsx)$/.test(name)) continue;
		if (/\.test\.(ts|tsx)$/.test(name)) continue;
		if (name === "routeTree.gen.ts") continue;
		out.push(path);
	}
	return out;
}

function isUndefinedArg(node: ts.Expression | undefined): boolean {
	return (
		node !== undefined && ts.isIdentifier(node) && node.text === "undefined"
	);
}

/** `Intl.X` — the callee of an Intl constructor, with or without `new`. */
function isIntlMember(expr: ts.Expression): boolean {
	return (
		ts.isPropertyAccessExpression(expr) &&
		ts.isIdentifier(expr.expression) &&
		expr.expression.text === "Intl"
	);
}

/** Every runtime-locale call in `text`, as `line: source` strings. */
function runtimeLocaleOffenders(fileName: string, text: string): string[] {
	const sf = ts.createSourceFile(
		fileName,
		text,
		ts.ScriptTarget.Latest,
		true,
		fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const found: string[] = [];
	const report = (node: ts.Node) => {
		const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
		found.push(`${line + 1}: ${node.getText(sf).split("\n")[0]}`);
	};

	const visit = (node: ts.Node) => {
		if (
			(ts.isNewExpression(node) || ts.isCallExpression(node)) &&
			isIntlMember(node.expression)
		) {
			const args = node.arguments ?? ts.factory.createNodeArray();
			const first = args[0];
			if (isUndefinedArg(first)) report(node);
			else if (args.length === 0) {
				// `Intl.DateTimeFormat().resolvedOptions()` asks the runtime a
				// question (its zone) and formats nothing, so it is allowed.
				const parent = node.parent;
				const asksResolvedOptions =
					ts.isPropertyAccessExpression(parent) &&
					parent.expression === node &&
					parent.name.text === "resolvedOptions";
				if (!asksResolvedOptions) report(node);
			}
		}
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			TO_LOCALE.has(node.expression.name.text) &&
			(node.arguments.length === 0 || isUndefinedArg(node.arguments[0]))
		) {
			report(node);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return found;
}

describe("no runtime-resolved locale under src/ (#708)", () => {
	it("every Intl formatter and toLocale*String call names APP_LOCALE", () => {
		const offenders: string[] = [];
		for (const path of sourceFiles(SRC)) {
			for (const hit of runtimeLocaleOffenders(
				path,
				readFileSync(path, "utf8"),
			)) {
				offenders.push(`${relative(ROOT, path)}:${hit}`);
			}
		}
		expect(
			offenders,
			"pass APP_LOCALE from #/lib/format instead of resolving the locale from the runtime",
		).toEqual([]);
	});

	it("actually walks the tree", () => {
		// An empty offender list is also what a sweep that found no files says.
		const files = sourceFiles(SRC).map((p) => relative(ROOT, p));
		expect(files).toContain("src/lib/format.ts");
		expect(files).toContain("src/lib/dues.ts");
		expect(files.length).toBeGreaterThan(200);
		expect(files.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
	});

	// The detector's own cases, so each arm is known to fire and the exemption
	// is known to stay narrow.
	describe("the detector", () => {
		const hits = (src: string) => runtimeLocaleOffenders("x.ts", src).length;

		it("flags an undefined locale on an Intl constructor, with or without new", () => {
			expect(
				hits("new Intl.DateTimeFormat(undefined, { day: 'numeric' });"),
			).toBe(1);
			expect(hits("Intl.NumberFormat(undefined, { style: 'currency' });")).toBe(
				1,
			);
			expect(hits("new Intl.RelativeTimeFormat(undefined);")).toBe(1);
		});

		it("flags an Intl constructor with no arguments that goes on to format", () => {
			expect(hits("new Intl.DateTimeFormat().format(d);")).toBe(1);
			expect(hits("const f = new Intl.NumberFormat();")).toBe(1);
		});

		it("allows asking the runtime for its resolved options", () => {
			expect(
				hits("const z = Intl.DateTimeFormat().resolvedOptions().timeZone;"),
			).toBe(0);
		});

		it("flags bare and undefined-locale toLocale*String calls", () => {
			expect(hits("d.toLocaleDateString();")).toBe(1);
			expect(
				hits("d.toLocaleTimeString(undefined, { hour: 'numeric' });"),
			).toBe(1);
			expect(hits("n.toLocaleString();")).toBe(1);
		});

		it("accepts a named locale, and ignores comments and strings", () => {
			expect(hits("new Intl.DateTimeFormat(APP_LOCALE, {});")).toBe(0);
			expect(hits("d.toLocaleDateString('en-US');")).toBe(0);
			expect(hits("// new Intl.DateTimeFormat(undefined, {})")).toBe(0);
			expect(hits("const s = 'd.toLocaleDateString()';")).toBe(0);
		});
	});
});
