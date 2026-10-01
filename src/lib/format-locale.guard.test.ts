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

/** Parse one file, TSX or not by its extension. Shared by both detectors. */
function parse(fileName: string, text: string): ts.SourceFile {
	return ts.createSourceFile(
		fileName,
		text,
		ts.ScriptTarget.Latest,
		true,
		fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

/** `Intl`, or `Intl` read off `globalThis` / `window` / `self` (either form). */
function isGlobalIntl(expr: ts.Expression): boolean {
	const n = unwrap(expr);
	if (ts.isIdentifier(n)) return n.text === "Intl";
	if (memberName(n) !== "Intl") return false;
	const obj = memberObject(n);
	return (
		obj !== null &&
		ts.isIdentifier(unwrap(obj)) &&
		GLOBAL_OBJECTS.has((unwrap(obj) as ts.Identifier).text)
	);
}

/**
 * `…().resolvedOptions().timeZone`, exactly: the one question about the
 * runtime that formats nothing and is neither the locale nor a rendering in
 * the zone. Both detectors exempt it, through this one definition.
 */
function asksOnlyTimeZone(node: ts.Node): boolean {
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
}

/** Every runtime-locale call in `text`, as `line: source` strings. */
function runtimeLocaleOffenders(fileName: string, text: string): string[] {
	const sf = parse(fileName, text);

	// File-local `const` aliases: of `Intl` itself, and of one of its
	// constructors. Collected before the walk so use-before-declaration in a
	// hoisted function is still seen.
	const intlAliases = new Set<string>();
	const ctorAliases = new Set<string>();

	const isIntlRef = (expr: ts.Expression): boolean => {
		const n = unwrap(expr);
		if (ts.isIdentifier(n) && intlAliases.has(n.text)) return true;
		return isGlobalIntl(n);
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

// ---------------------------------------------------------------------------
// The TIME ZONE half (#1000).
//
// The locale guard above could not see what #1000 found in production: React
// #418 on `/admin/vpe-dashboard`, `/activity` and more, every one of them a
// date formatted with a named locale and NO zone. `timeZone` omitted resolves
// to the runtime's zone exactly as an omitted locale resolves to the runtime's
// locale, so Railway's UTC container prints "Jul 18" and a browser in Los
// Angeles "Jul 17" for a meeting held the evening of the 17th in the club's
// zone. `format.ts` says the zone "is handled per call site"; this is what
// checks that the call site handled it.
//
// ## What counts as an offender
//
// A RUNTIME ZONE is a zone argument that is absent, `undefined` or `void …`,
// or an options object literal with no `timeZone` key (or `timeZone:
// undefined`), passed to:
//
//   - a `#/lib/format` date formatter that TAKES a zone. The set is read off
//     `format.ts` itself, not listed here: every exported function with a
//     parameter named `timeZone` (positional), or with an options parameter
//     whose type has a `timeZone` member (`formatHistoryDate`). So a new
//     zone-taking formatter is covered the day it is written;
//   - `Intl.DateTimeFormat` (reached as `Intl.DateTimeFormat` or through
//     `globalThis` / `window` / `self`), and `toLocaleDateString` /
//     `toLocaleTimeString`, whose second argument is the options object.
//
// The resolvedOptions().timeZone chain is exempt here too, for the reason it
// is exempt above.
//
// ## What escapes it
//
//   - a zone or options object held in a variable (`formatShortDate(d, tz)`
//     where `tz` is undefined at runtime, `new Intl.DateTimeFormat(L, opts)`),
//     and an options literal with a spread, whose keys cannot be read;
//   - a formatter reached through anything but a named import from
//     `#/lib/format`, `@/lib/format` (the shadcn alias for the same file) or
//     `./format` — a namespace import, a re-export, a wrapper;
//   - `toLocaleString`, which is a Date's AND a number's, and this has no type
//     information to tell them apart;
//   - everything that is not a date in the wrong zone: `formatTenure`'s local
//     calendar arithmetic, `new Date()` in a render, `Math.random`, an ICU
//     difference between Node and Chrome (#1000's club-settings finding).
//
// ## Sanctioned and known
//
// SANCTIONED is a runtime zone that is correct, each with the reason. KNOWN is
// the set that was already there when this guard landed, outside #1000's diff:
// real, reported, and not fixed here. It may only SHRINK — a fixed entry left
// on it fails, so the list cannot rot into a blanket exemption.

/**
 * The zone-taking formatters `format.ts` exports: name → the argument index of
 * the zone, and whether that argument is the zone itself or an options object
 * carrying one.
 */
function zonedFormatters(): Map<
	string,
	{ index: number; kind: "zone" | "options" }
> {
	const path = join(SRC, "lib/format.ts");
	const sf = parse(path, readFileSync(path, "utf8"));
	const out = new Map<string, { index: number; kind: "zone" | "options" }>();
	for (const stmt of sf.statements) {
		if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue;
		const exported = stmt.modifiers?.some(
			(m) => m.kind === ts.SyntaxKind.ExportKeyword,
		);
		if (!exported) continue;
		stmt.parameters.forEach((param, index) => {
			if (ts.isIdentifier(param.name) && param.name.text === "timeZone") {
				out.set(stmt.name?.text ?? "", { index, kind: "zone" });
				return;
			}
			const type = param.type;
			if (
				type &&
				ts.isTypeLiteralNode(type) &&
				type.members.some(
					(m) =>
						ts.isPropertySignature(m) &&
						ts.isIdentifier(m.name) &&
						m.name.text === "timeZone",
				)
			) {
				out.set(stmt.name?.text ?? "", { index, kind: "options" });
			}
		});
	}
	return out;
}

const ZONED = zonedFormatters();

/** `undefined`, `void …`, or nothing at all. */
function isAbsent(arg: ts.Expression | ts.SpreadElement | undefined): boolean {
	if (arg === undefined) return true;
	if (ts.isSpreadElement(arg)) return false;
	const n = unwrap(arg);
	return (
		(ts.isIdentifier(n) && n.text === "undefined") || ts.isVoidExpression(n)
	);
}

/**
 * Whether an options argument leaves the zone to the runtime: absent, or a
 * literal whose `timeZone` is missing or `undefined`. A literal with a spread
 * could be carrying one, and a non-literal cannot be read, so both pass.
 */
function optionsLackZone(
	arg: ts.Expression | ts.SpreadElement | undefined,
): boolean {
	if (isAbsent(arg)) return true;
	if (arg === undefined || ts.isSpreadElement(arg)) return false;
	const n = unwrap(arg);
	if (!ts.isObjectLiteralExpression(n)) return false;
	if (n.properties.some(ts.isSpreadAssignment)) return false;
	const zone = n.properties.find(
		(p) =>
			(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
			p.name.getText() === "timeZone",
	);
	if (!zone) return true;
	return ts.isPropertyAssignment(zone) && isAbsent(zone.initializer);
}

const FORMAT_MODULES = new Set(["#/lib/format", "@/lib/format", "./format"]);
const TO_LOCALE_DATE = new Set(["toLocaleDateString", "toLocaleTimeString"]);

/** Every runtime-zone date format in `text`, as `line: source` strings. */
function runtimeZoneOffenders(fileName: string, text: string): string[] {
	const sf = parse(fileName, text);

	// Local name → the formatter it imports.
	const imported = new Map<string, string>();
	for (const stmt of sf.statements) {
		if (
			!ts.isImportDeclaration(stmt) ||
			!ts.isStringLiteral(stmt.moduleSpecifier) ||
			!FORMAT_MODULES.has(stmt.moduleSpecifier.text)
		) {
			continue;
		}
		const bindings = stmt.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const el of bindings.elements) {
			const name = (el.propertyName ?? el.name).text;
			if (ZONED.has(name)) imported.set(el.name.text, name);
		}
	}

	const isDateTimeFormat = (expr: ts.Expression): boolean => {
		const obj = memberObject(expr);
		return (
			memberName(expr) === "DateTimeFormat" && obj !== null && isGlobalIntl(obj)
		);
	};

	const found: string[] = [];
	const report = (node: ts.Node) => {
		const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
		found.push(`${line + 1}: ${node.getText(sf).split("\n")[0]}`);
	};

	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
			const args = node.arguments ?? [];
			const callee = unwrap(node.expression);
			const formatter = ts.isIdentifier(callee)
				? ZONED.get(imported.get(callee.text) ?? "")
				: undefined;
			if (ts.isCallExpression(node) && formatter) {
				const arg = args[formatter.index];
				const runtime =
					formatter.kind === "zone" ? isAbsent(arg) : optionsLackZone(arg);
				if (runtime) report(node);
			} else if (isDateTimeFormat(callee)) {
				if (optionsLackZone(args[1]) && !asksOnlyTimeZone(node)) report(node);
			} else if (
				ts.isCallExpression(node) &&
				TO_LOCALE_DATE.has(memberName(callee) ?? "") &&
				optionsLackZone(args[1])
			) {
				report(node);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return found;
}

/**
 * A runtime zone that is RIGHT, keyed `path: call` (the call's first line, as
 * the detector prints it, without the line number so an edit above it does
 * not churn this list).
 */
const SANCTIONED: Record<string, string> = {
	// Rendered only after mount, so the server never formats it and the
	// browser's zone is the member's own (#608).
	"src/components/speech-log-date.tsx: formatDayMonth(value)":
		"deferred past hydration by `mounted`",
	// `local` is BUILT in the runtime's zone from a URL's calendar date, so
	// formatting it in that same zone is what round-trips the date.
	"src/components/club/personal-meeting-body.tsx: formatMeetingDate(local)":
		"a Date constructed in the runtime's own zone",
	// The three below are fetched by `useQuery` with no loader prefetch, which
	// never runs during SSR, so the server renders none of them. And none is a
	// club's date: a personal token's or a connected app's last use, and the
	// viewer's own last offline visit, are the VIEWER's day (#1017).
	"src/components/api-tokens-section.tsx: new Date(t.lastUsedAt).toLocaleDateString(APP_LOCALE)":
		"client-only (useQuery, no SSR prefetch); the viewer's own day",
	"src/components/connected-apps-section.tsx: new Date(app.approvedAt).toLocaleDateString(APP_LOCALE)":
		"client-only (useQuery, no SSR prefetch); the viewer's own day",
	"src/lib/offline-status.ts: new Date(ts).toLocaleDateString(APP_LOCALE, {":
		"called with a localStorage timestamp after mount, or from client-only connected-apps",
};

/**
 * Found when this guard landed, outside #1000's diff, and listed in that
 * PR's inventory rather than fixed here (#1000's brief: more than five sites,
 * so list them and stop). A list, not a set: a file with two identical calls
 * carries two entries, so fixing one of them is still a change this list has
 * to make. May only shrink.
 */
const KNOWN: readonly string[] = [
	// Built in `send-minutes-dialog.tsx`, which has no zone to pass yet (#1017).
	"src/server/minutes-email-logic.ts: formatMeetingDate(meetingDate)",
	"src/server/minutes-email-logic.ts: formatMeetingDate(meetingDate)",
];

function allZoneOffenders(): string[] {
	const out: string[] = [];
	for (const path of sourceFiles(SRC)) {
		for (const hit of runtimeZoneOffenders(path, readFileSync(path, "utf8"))) {
			out.push(`${relative(ROOT, path)}: ${hit.replace(/^\d+: /, "")}`);
		}
	}
	return out;
}

/** How many times each entry of `list` appears. */
function tally(list: readonly string[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const k of list) out.set(k, (out.get(k) ?? 0) + 1);
	return out;
}

describe("no runtime-resolved time zone in a date formatter (#1000)", () => {
	it("every zone-taking date format names a zone", () => {
		const allowance = tally(KNOWN);
		const offenders = allZoneOffenders().filter((o) => {
			if (o in SANCTIONED) return false;
			const left = allowance.get(o) ?? 0;
			if (left === 0) return true;
			allowance.set(o, left - 1);
			return false;
		});
		expect(
			offenders,
			"pass the club's zone (the loader's `timezone`) rather than leaving it to the runtime",
		).toEqual([]);
	});

	it("KNOWN only shrinks: every entry still offends", () => {
		const current = tally(allZoneOffenders());
		const stale = [...tally(KNOWN)]
			.filter(([k, n]) => (current.get(k) ?? 0) < n)
			.map(([k]) => k);
		expect(stale, "fixed: remove it from KNOWN").toEqual([]);
		expect(
			Object.keys(SANCTIONED).filter((k) => !current.has(k)),
			"no longer a runtime zone: remove it from SANCTIONED",
		).toEqual([]);
	});

	it("reads the zone-taking formatters off format.ts", () => {
		// An empty map would make the first arm of the detector silent.
		expect(ZONED.get("formatShortDate")).toEqual({ index: 1, kind: "zone" });
		expect(ZONED.get("formatMeetingTimeRange")).toEqual({
			index: 2,
			kind: "zone",
		});
		expect(ZONED.get("formatHistoryDate")).toEqual({
			index: 1,
			kind: "options",
		});
		// A calendar-day formatter pins UTC itself and takes no zone.
		expect(ZONED.has("formatCalendarDay")).toBe(false);
	});

	describe("the detector", () => {
		const hits = (src: string) =>
			runtimeZoneOffenders(
				"x.tsx",
				`import { formatShortDate, formatHistoryDate, formatMeetingTimeRange as range } from "#/lib/format";\n${src}`,
			).length;

		it("flags a #/lib/format formatter with no zone", () => {
			expect(hits("formatShortDate(d);")).toBe(1);
			expect(hits("formatShortDate(d, undefined);")).toBe(1);
			expect(hits("formatShortDate(d, void 0);")).toBe(1);
			expect(hits("range(d, 60);")).toBe(1);
			expect(hits("formatHistoryDate(d);")).toBe(1);
			expect(hits("formatHistoryDate(d, { now });")).toBe(1);
			expect(hits("formatHistoryDate(d, { timeZone: undefined });")).toBe(1);
		});

		it("accepts a formatter given a zone", () => {
			expect(hits("formatShortDate(d, tz);")).toBe(0);
			expect(hits("range(d, 60, tz);")).toBe(0);
			expect(hits("formatHistoryDate(d, { timeZone: tz });")).toBe(0);
			expect(hits("formatHistoryDate(d, { timeZone });")).toBe(0);
		});

		it("flags Intl.DateTimeFormat and toLocaleDate/TimeString with no zone", () => {
			expect(hits("new Intl.DateTimeFormat(L, { day: 'numeric' });")).toBe(1);
			expect(hits("new Intl.DateTimeFormat(L);")).toBe(1);
			expect(hits("new globalThis.Intl.DateTimeFormat(L, {});")).toBe(1);
			expect(hits("d.toLocaleDateString(L);")).toBe(1);
			expect(hits("d.toLocaleTimeString(L, { hour: 'numeric' });")).toBe(1);
			expect(hits("new Intl.DateTimeFormat(L, { timeZone: undefined });")).toBe(
				1,
			);
		});

		it("accepts them given a zone, and asking for the runtime's zone", () => {
			expect(hits("new Intl.DateTimeFormat(L, { timeZone: tz });")).toBe(0);
			expect(
				hits("new Intl.DateTimeFormat(L, { day: 'numeric', timeZone });"),
			).toBe(0);
			expect(hits("d.toLocaleDateString(L, { timeZone: 'UTC' });")).toBe(0);
			expect(
				hits("const z = Intl.DateTimeFormat().resolvedOptions().timeZone;"),
			).toBe(0);
		});

		it("follows the @/ alias for the same module", () => {
			expect(
				runtimeZoneOffenders(
					"x.ts",
					'import { formatShortDate } from "@/lib/format"; formatShortDate(d);',
				),
			).toHaveLength(1);
		});

		it("ignores a same-named function that is not the import", () => {
			expect(
				runtimeZoneOffenders(
					"x.ts",
					"function formatShortDate(d) { return d; } formatShortDate(d);",
				),
			).toEqual([]);
		});

		it("still misses what the header says it misses", () => {
			// Pinned so the "What escapes it" list cannot claim coverage it lacks.
			expect(hits("new Intl.DateTimeFormat(L, opts);")).toBe(0);
			expect(hits("new Intl.DateTimeFormat(L, { ...opts });")).toBe(0);
			expect(hits("d.toLocaleString(L);")).toBe(0);
			expect(
				runtimeZoneOffenders(
					"x.ts",
					"import * as f from '#/lib/format'; f.formatShortDate(d);",
				),
			).toEqual([]);
		});
	});
});
