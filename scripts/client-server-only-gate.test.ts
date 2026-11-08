import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import {
	clientServerOnlyGate,
	findServerOnlyLeaks,
	formatLeaks,
} from "./client-server-only-gate.ts";

describe("client server-only gate wiring", () => {
	// A gate nobody registers passes every build. Read the config as source:
	// importing it would load Start, Nitro and Tailwind into this test.
	const config = readFileSync(join(__dirname, "..", "vite.config.ts"), "utf8");

	it("is registered in vite.config.ts's plugins array", () => {
		const plugins = config.slice(config.indexOf("plugins: ["));
		const body = plugins.slice(0, plugins.indexOf("\n\t],"));
		// Code lines only, so a commented-out call does not count.
		const code = body
			.split("\n")
			.filter((line) => !line.trim().startsWith("//"))
			.join("\n");
		expect(code).toMatch(/^\t\tclientServerOnlyGate\(\),$/m);
	});

	it("runs on the client build only", () => {
		const plugin: Plugin = clientServerOnlyGate();
		expect(plugin.apply).toBe("build");
		const applies = plugin.applyToEnvironment as (env: {
			name: string;
		}) => boolean;
		expect(applies({ name: "client" })).toBe(true);
		expect(applies({ name: "ssr" })).toBe(false);
		expect(typeof plugin.buildEnd).toBe("function");
	});
});

const R = "/repo";

/** A module graph as `importer → imported[]`, inverted for the gate. */
function graph(edges: Record<string, string[]>) {
	const importers = new Map<string, string[]>();
	const ids = new Set<string>();
	for (const [from, tos] of Object.entries(edges)) {
		ids.add(from);
		for (const to of tos) {
			ids.add(to);
			importers.set(to, [...(importers.get(to) ?? []), from]);
		}
	}
	return { ids, importersOf: (id: string) => importers.get(id) ?? [] };
}

// The shape #1550 shipped: a route imports a server-fn module that kept `#/db`.
const LEAKED = graph({
	[`${R}/src/routes/club.$clubId.index.tsx`]: [`${R}/src/server/slots.ts`],
	[`${R}/src/server/slots.ts`]: [`${R}/src/db/index.ts`, `${R}/src/db/schema.ts`],
	[`${R}/src/db/index.ts`]: [`${R}/node_modules/drizzle-orm/node-postgres/index.js`],
	[`${R}/node_modules/drizzle-orm/node-postgres/index.js`]: [
		`${R}/node_modules/pg/lib/index.js`,
	],
	[`${R}/node_modules/pg/lib/index.js`]: [`${R}/node_modules/pg-types/index.js`],
});

describe("client server-only gate", () => {
	it("flags the db client and the pg driver, naming the server module", () => {
		const leaks = findServerOnlyLeaks(LEAKED.ids, LEAKED.importersOf);
		expect(leaks.map((l) => l.id).sort()).toEqual([
			`${R}/node_modules/pg-types/index.js`,
			`${R}/node_modules/pg/lib/index.js`,
			`${R}/src/db/index.ts`,
		]);
		// The chain stops at the first app module that is not itself the leak:
		// slots.ts, not src/db/index.ts.
		for (const leak of leaks) {
			expect(leak.chain[0]).toBe(`${R}/src/server/slots.ts`);
			expect(leak.chain.at(-1)).toBe(leak.id);
		}
	});

	it("passes a client graph with schema but no db client or driver", () => {
		const clean = graph({
			[`${R}/src/routes/club.$clubId.index.tsx`]: [`${R}/src/server/slots.ts`],
			[`${R}/src/server/slots.ts`]: [`${R}/src/db/schema.ts`],
			[`${R}/src/db/schema.ts`]: [`${R}/node_modules/drizzle-orm/pg-core/index.js`],
			// What pptxgenjs does on clean main: harmless, must not trip the gate.
			[`${R}/node_modules/pptxgenjs/dist/pptxgen.es.js`]: [
				"__vite-browser-external",
			],
			// Names that merely start with "pg" are not the driver.
			[`${R}/src/lib/x.ts`]: [`${R}/node_modules/pgsomething/index.js`],
		});
		expect(findServerOnlyLeaks(clean.ids, clean.importersOf)).toEqual([]);
	});

	it("reports each culprit once, relative to the root", () => {
		const leaks = findServerOnlyLeaks(LEAKED.ids, LEAKED.importersOf);
		const message = formatLeaks(leaks, R);
		expect(message.match(/^ {2}- /gm)).toHaveLength(1);
		expect(message).toContain("src/server/slots.ts\n      → src/db/index.ts");
		expect(message).not.toContain(R);
		// Whatever order the bundler lists modules in, the shortest chain wins.
		const reversed = formatLeaks([...leaks].reverse(), R);
		expect(reversed).toContain("→ src/db/index.ts\n");
		expect(reversed).not.toContain("pg-types");
	});

	it("survives an import cycle", () => {
		const cyclic = graph({
			[`${R}/node_modules/pg/lib/a.js`]: [`${R}/node_modules/pg/lib/b.js`],
			[`${R}/node_modules/pg/lib/b.js`]: [`${R}/node_modules/pg/lib/a.js`],
		});
		const leaks = findServerOnlyLeaks(cyclic.ids, cyclic.importersOf);
		expect(leaks).toHaveLength(2);
		// No app module above it: the chain is just the leak itself.
		expect(leaks[0].chain).toEqual([leaks[0].id]);
	});
});
