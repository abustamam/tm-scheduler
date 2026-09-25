// No formatter under `src/` may resolve its locale from the runtime (#708).
//
// ## Why a guard
//
// An omitted locale resolves against whichever process is formatting: the SSR
// container answers `en-US`, a Spanish-locale browser `es-ES`, and the two
// passes print different text for the same instant — a hydration mismatch that
// no single-runtime test can see (`src/test/hydration-across-runtimes.ts` says
// why). #708 found it in eleven files at once, six of them the shared
// formatters in `format.ts`, all written the natural way. The property worth
// protecting is that a TWELFTH cannot appear, which is a negative across the
// tree. Every such call passes `APP_LOCALE` from `#/lib/format` instead.
//
// ## What counts as an offender
//
// A RUNTIME LOCALE is a locale argument that is absent, the identifier
// `undefined`, a `void …` expression, an empty array literal (`[]` also means
// "the default locale"), or a spread (`...args`, whose contents this cannot
// see). Any of those, passed to:
//
//   - an Intl constructor, with or without `new`, reached as `Intl.X`,
//     `Intl["X"]`, `globalThis.Intl.X` / `window.Intl.X` / `self.Intl.X` (and
//     their bracket forms), through a file-local `const I = Intl` alias, or
//     through a file-local `const F = Intl.X` / `const { X } = Intl`
//     constructor alias;
//   - `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString`, called
//     as a method (`x.toLocaleString()`, `x["toLocaleString"]()`);
//   - either of the above through `.call(thisArg, locale)` or
//     `.apply(thisArg, [locale])` — where an `.apply` argument list that is not
//     an array literal counts as a runtime locale, since it cannot be read.
//
// ONE exemption: `Intl.DateTimeFormat().resolvedOptions().timeZone`, exactly
// that chain. That is how the superadmin console reads the browser's TIMEZONE,
// a question about the runtime rather than a rendering of one. `.locale` on the
// same chain IS the runtime locale and is flagged, as is any other property.
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
// ## What escapes it — deliberately, and exactly
//
// It is a per-file syntactic check with no type information or data flow, so:
//
//   - a locale held in a variable or parameter (`new Intl.DateTimeFormat(loc)`
//     where `loc` is `undefined` at runtime) passes;
//   - aliases other than a top-level-or-nested `const` in the SAME file pass:
//     an imported alias, a `let`/`var` or reassigned one, a function parameter,
//     and a destructure from anything but `Intl` itself
//     (`const { Intl: I } = globalThis`). A `const` alias of a `const` alias is
//     followed, two links deep regardless of declaration order;
//   - an Intl constructor or a toLocale* method reached through a computed key
//     that is not a string literal (`x[method]()`), through `.bind`, through
//     `Reflect.construct` / `Reflect.apply`, or through a stored method
//     (`const f = Date.prototype.toLocaleString; f.call(d)`);
//   - `toLocaleUpperCase` / `toLocaleLowerCase` and `String.localeCompare`,
//     which are locale-sensitive but are not date or currency formatting and
//     are out of #708's scope.
//
// The shape that shipped eleven times is the literal one; the list above is
// what a determined author could still write, not what one writes by accident.
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

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);

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

function unwrap(node: ts.Expression): ts.Expression {
	let n = node;
	while (
		ts.isParenthesizedExpression(n) ||
		ts.isAsExpression(n) ||
		ts.isNonNullExpression(n) ||
		ts.isSatisfiesExpression(n)
	) {
		n = n.expression;
	}
	return n;
}

/** The member name of `a.b` or `a["b"]`, or null for anything else. */
function memberName(expr: ts.Expression): string | null {
	const n = unwrap(expr);
	if (ts.isPropertyAccessExpression(n)) return n.name.text;
	if (
		ts.isElementAccessExpression(n) &&
		ts.isStringLiteralLike(n.argumentExpression)
	) {
		return n.argumentExpression.text;
	}
	return null;
}

/** The object of `a.b` / `a[b]`, or null. */
function memberObject(expr: ts.Expression): ts.Expression | null {
	const n = unwrap(expr);
	if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
		return n.expression;
	}
	return null;
}

/**
 * Whether one locale argument (the first element of the argument list, or
 * undefined when the list is empty) resolves to the runtime's locale.
 */
function isRuntimeLocale(
	args: readonly (ts.Expression | ts.SpreadElement)[],
): boolean {
	const first = args[0];
	if (first === undefined) return true;
	if (ts.isSpreadElement(first)) return true;
	const n = unwrap(first);
	if (ts.isIdentifier(n) && n.text === "undefined") return true;
	if (ts.isVoidExpression(n)) return true;
	if (ts.isArrayLiteralExpression(n) && n.elements.length === 0) return true;
	return false;
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

	// File-local `const` aliases: of `Intl` itself, and of one of its
	// constructors. Collected before the walk so use-before-declaration in a
	// hoisted function is still seen.
	const intlAliases = new Set<string>();
	const ctorAliases = new Set<string>();

	const isIntlRef = (expr: ts.Expression): boolean => {
		const n = unwrap(expr);
		if (ts.isIdentifier(n)) {
			return n.text === "Intl" || intlAliases.has(n.text);
		}
		if (memberName(n) === "Intl") {
			const obj = memberObject(n);
			return (
				obj !== null &&
				ts.isIdentifier(unwrap(obj)) &&
				GLOBAL_OBJECTS.has((unwrap(obj) as ts.Identifier).text)
			);
		}
		return false;
	};

	const isIntlCtor = (expr: ts.Expression): boolean => {
		const n = unwrap(expr);
		if (ts.isIdentifier(n)) return ctorAliases.has(n.text);
		if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
			return isIntlRef(n.expression);
		}
		return false;
	};

	const collect = (node: ts.Node) => {
		if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const) {
			for (const decl of node.declarations) {
				if (!decl.initializer) continue;
				if (ts.isIdentifier(decl.name)) {
					if (isIntlRef(decl.initializer)) intlAliases.add(decl.name.text);
					else if (isIntlCtor(decl.initializer)) {
						ctorAliases.add(decl.name.text);
					}
				} else if (
					ts.isObjectBindingPattern(decl.name) &&
					isIntlRef(decl.initializer)
				) {
					for (const el of decl.name.elements) {
						if (ts.isIdentifier(el.name)) ctorAliases.add(el.name.text);
					}
				}
			}
		}
		ts.forEachChild(node, collect);
	};
	// Two passes so `const I = Intl; const F = I.DateTimeFormat;` resolves.
	collect(sf);
	collect(sf);

	const found: string[] = [];
	const report = (node: ts.Node) => {
		const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
		found.push(`${line + 1}: ${node.getText(sf).split("\n")[0]}`);
	};

	/**
	 * `…().resolvedOptions().timeZone`, exactly: the one question about the
	 * runtime that formats nothing and is not the locale.
	 */
	const asksOnlyTimeZone = (node: ts.Node): boolean => {
		const access = node.parent;
		if (
			!access ||
			!ts.isPropertyAccessExpression(access) ||
			access.expression !== node ||
			access.name.text !== "resolvedOptions"
		) {
			return false;
		}
		const call = access.parent;
		if (!call || !ts.isCallExpression(call) || call.expression !== access) {
			return false;
		}
		const prop = call.parent;
		return (
			!!prop &&
			ts.isPropertyAccessExpression(prop) &&
			prop.expression === call &&
			prop.name.text === "timeZone"
		);
	};

	/**
	 * The effective callee and locale arguments of a call, seeing through
	 * `.call(thisArg, …)` and `.apply(thisArg, [...])`. `null` args means the
	 * list could not be read (an `.apply` whose list is not an array literal).
	 */
	const effective = (
		node: ts.CallExpression | ts.NewExpression,
	): {
		callee: ts.Expression;
		args: readonly (ts.Expression | ts.SpreadElement)[] | null;
	} => {
		const args = node.arguments ?? [];
		if (ts.isCallExpression(node)) {
			const via = memberName(node.expression);
			const target = memberObject(node.expression);
			if (target && via === "call") {
				return { callee: target, args: args.slice(1) };
			}
			if (target && via === "apply") {
				const list = args[1];
				if (list === undefined) return { callee: target, args: [] };
				const n = ts.isSpreadElement(list) ? null : unwrap(list);
				if (n && ts.isArrayLiteralExpression(n)) {
					return { callee: target, args: n.elements };
				}
				return { callee: target, args: null };
			}
		}
		return { callee: node.expression, args };
	};

	const visit = (node: ts.Node) => {
		if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
			const { callee, args } = effective(node);
			const runtime = args === null || isRuntimeLocale(args);
			if (runtime) {
				if (isIntlCtor(callee)) {
					if (!asksOnlyTimeZone(node)) report(node);
				} else if (
					ts.isCallExpression(node) &&
					TO_LOCALE.has(memberName(callee) ?? "")
				) {
					report(node);
				}
			}
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

		it("flags the other spellings of a runtime locale", () => {
			expect(hits("new Intl.DateTimeFormat(void 0, {});")).toBe(1);
			expect(hits("new Intl.DateTimeFormat([], {});")).toBe(1);
			expect(hits("new Intl.DateTimeFormat(...args);")).toBe(1);
			expect(hits("new Intl.DateTimeFormat((undefined), {});")).toBe(1);
			expect(hits("d.toLocaleDateString(void 0);")).toBe(1);
			expect(hits("d.toLocaleDateString(...args);")).toBe(1);
		});

		it("flags Intl reached through globalThis, window, self or a bracket", () => {
			expect(hits("new globalThis.Intl.DateTimeFormat(undefined);")).toBe(1);
			expect(hits("new window.Intl.NumberFormat();")).toBe(1);
			expect(hits("new self['Intl'].DateTimeFormat();")).toBe(1);
			expect(hits("new Intl['DateTimeFormat'](undefined, {});")).toBe(1);
			expect(hits("globalThis.Intl['NumberFormat']();")).toBe(1);
		});

		it("flags a file-local const alias of Intl or of a constructor", () => {
			expect(hits("const I = Intl; new I.DateTimeFormat(undefined);")).toBe(1);
			expect(
				hits("const I = globalThis.Intl; const f = new I.NumberFormat();"),
			).toBe(1);
			expect(hits("const F = Intl.DateTimeFormat; new F();")).toBe(1);
			expect(
				hits("const { DateTimeFormat } = Intl; new DateTimeFormat(undefined);"),
			).toBe(1);
			expect(
				hits("const { NumberFormat: NF } = Intl; new NF(undefined, {});"),
			).toBe(1);
			expect(hits("const I = Intl; const F = I.DateTimeFormat; new F();")).toBe(
				1,
			);
			// A named locale through the alias is fine.
			expect(hits("const I = Intl; const J = I; new J.DateTimeFormat();")).toBe(
				1,
			);
			expect(hits("const I = Intl; new I.DateTimeFormat('en-US');")).toBe(0);
		});

		it("flags .call and .apply on a toLocale* method or an Intl constructor", () => {
			expect(hits("Number.prototype.toLocaleString.call(x);")).toBe(1);
			expect(
				hits("Date.prototype.toLocaleDateString.call(d, undefined);"),
			).toBe(1);
			expect(hits("Date.prototype.toLocaleString.apply(d);")).toBe(1);
			expect(hits("Date.prototype.toLocaleString.apply(d, []);")).toBe(1);
			expect(hits("Date.prototype.toLocaleString.apply(d, args);")).toBe(1);
			expect(hits("Intl.DateTimeFormat.call(null, undefined);")).toBe(1);
			expect(hits("Date.prototype.toLocaleString.call(d, 'en-US');")).toBe(0);
			expect(
				hits("Date.prototype.toLocaleString.apply(d, ['en-US', {}]);"),
			).toBe(0);
		});

		it("allows asking the runtime for its time zone, and nothing else", () => {
			expect(
				hits("const z = Intl.DateTimeFormat().resolvedOptions().timeZone;"),
			).toBe(0);
			expect(
				hits("const l = Intl.DateTimeFormat().resolvedOptions().locale;"),
			).toBe(1);
			expect(hits("const o = Intl.DateTimeFormat().resolvedOptions();")).toBe(
				1,
			);
			expect(
				hits("const { timeZone } = Intl.DateTimeFormat().resolvedOptions();"),
			).toBe(1);
		});

		it("flags bare and undefined-locale toLocale*String calls", () => {
			expect(hits("d.toLocaleDateString();")).toBe(1);
			expect(
				hits("d.toLocaleTimeString(undefined, { hour: 'numeric' });"),
			).toBe(1);
			expect(hits("n.toLocaleString();")).toBe(1);
			expect(hits("d['toLocaleDateString']();")).toBe(1);
		});

		it("accepts a named locale, and ignores comments and strings", () => {
			expect(hits("new Intl.DateTimeFormat(APP_LOCALE, {});")).toBe(0);
			expect(hits("d.toLocaleDateString('en-US');")).toBe(0);
			expect(hits("d.toLocaleDateString(['en-US']);")).toBe(0);
			expect(hits("// new Intl.DateTimeFormat(undefined, {})")).toBe(0);
			expect(hits("const s = 'd.toLocaleDateString()';")).toBe(0);
			// A local that merely shares the name of a method is not a call to it.
			expect(hits("const Intl2 = {}; new Intl2.DateTimeFormat();")).toBe(0);
		});

		it("still misses what the header says it misses", () => {
			// Pinned so the "What escapes it" list cannot drift into claiming
			// coverage it does not have: if one of these starts failing, the check
			// got stronger and the comment should shrink with it.
			expect(hits("new Intl.DateTimeFormat(loc);")).toBe(0);
			expect(hits("let I = Intl; new I.DateTimeFormat();")).toBe(0);
			expect(hits("x[method]();")).toBe(0);
			expect(hits("Reflect.construct(Intl.DateTimeFormat, []);")).toBe(0);
			expect(hits("s.toLocaleUpperCase();")).toBe(0);
		});
	});
});
