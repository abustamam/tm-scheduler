// The public `/timer` page (#1248) is client-only: no loader, no server
// function, and an import graph that reaches neither the timing writer nor the
// database. A source walk rather than a render test, because what is protected
// is a property of every module the route can ever pull in — one `#/server`
// import added to the clock a year from now must fail here, not at runtime
// on a signed-out phone.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = resolve(ROOT, "src/routes/timer.tsx");

function resolveModule(spec: string, from: string): string | null {
	const base = spec.startsWith("#/")
		? resolve(ROOT, "src", spec.slice(2))
		: spec.startsWith(".")
			? resolve(dirname(from), spec)
			: null;
	if (!base) return null;
	for (const c of [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}/index.ts`,
		`${base}/index.tsx`,
	]) {
		if (existsSync(c) && /\.tsx?$/.test(c)) return c;
	}
	return null;
}

/** Every first-party specifier, type-only imports included: a type import is
 *  erased, but a plain one that LOOKS type-only is how a graph grows. */
function specifiers(source: string): string[] {
	return [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
		(m) => m[1],
	);
}

function graph(): { specs: Set<string>; files: Set<string> } {
	const files = new Set<string>();
	const specs = new Set<string>();
	const walk = (file: string) => {
		if (files.has(file)) return;
		files.add(file);
		for (const spec of specifiers(readSource(file))) {
			specs.add(spec);
			const next = resolveModule(spec, file);
			if (next) walk(next);
		}
	};
	walk(ENTRY);
	return { specs, files };
}

describe("/timer is client-only (#1248)", () => {
	const { specs, files } = graph();

	it("walks a real graph (so a rename can't make this vacuous)", () => {
		const rel = [...files].map((f) => f.slice(ROOT.length + 1));
		expect(rel).toContain("src/components/timer/timer-clock.tsx");
		expect(rel).toContain("src/components/timer/standalone-timer.tsx");
		expect(rel).toContain("src/lib/timer-signal.ts");
	});

	it("reaches neither #/server nor #/db", () => {
		const bad = [...specs].filter(
			(s) =>
				/^#\/(server|db)(\/|$)/.test(s) ||
				/(^|\/)(server|db)\/[\w.-]+$/.test(s) ||
				/@tanstack\/react-start/.test(s),
		);
		expect(bad).toEqual([]);
		for (const f of files) {
			expect(f, "a server or db module is in the /timer graph").not.toMatch(
				/\/src\/(server|db)\//,
			);
		}
	});

	it("the route has no loader, beforeLoad or server function", () => {
		const src = readSource(ENTRY);
		expect(src).not.toMatch(/\b(loader|beforeLoad|createServerFn)\b/);
	});

	it("renders MarketingShell, which carries the TI disclaimer", () => {
		expect(readSource(ENTRY)).toMatch(/<MarketingShell\b/);
	});
});
