import type { Plugin } from "vite";

/**
 * Fails the CLIENT build when a server-only module reaches the browser bundle.
 *
 * Production broke three times the same way (PR #48, its follow-up, #1550): a
 * `src/server/*.ts` module that client routes import kept `#/db` alive after
 * the Start compiler stripped its `createServerFn` handlers, so `pg` and
 * `src/db/index.ts` (which reads `process.env` and builds a pool at import)
 * shipped to the browser and the page crashed before React rendered. #1550 did
 * it with one type alias, `Pick<typeof db, "select">`, which the source-shape
 * guard (`server-modules.guard.test.ts`) cannot see. This gate checks the
 * module graph the bundler actually built instead.
 *
 * The build printed the symptom every time, as "externalized for browser
 * compatibility" warnings; warnings do not fail a build, this does.
 */

const SERVER_ONLY: ReadonlyArray<{ test: (id: string) => boolean; why: string }> =
	[
		{
			test: (id) => /\/src\/db\/index\.ts(\?|$)/.test(id),
			why: "the db client (src/db/index.ts)",
		},
		{
			test: (id) =>
				/\/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(pg|pg-[^/]+|pgpass)\//.test(
					id,
				),
			why: "the Postgres driver",
		},
		// Not "any `__vite-browser-external`": pptxgenjs dynamically imports a
		// Node built-in behind a Node-only branch, harmlessly, on clean main.
	];

export interface Leak {
	id: string;
	why: string;
	/** Importer chain, from the first app module down to the leaked module. */
	chain: string[];
}

/** The server-only modules in `moduleIds`, each with one importer chain back
 *  to app code, so the error names the file to fix rather than `pg`. */
export function findServerOnlyLeaks(
	moduleIds: Iterable<string>,
	importersOf: (id: string) => readonly string[],
): Leak[] {
	const leaks: Leak[] = [];
	for (const id of moduleIds) {
		const rule = SERVER_ONLY.find((r) => r.test(id));
		if (!rule) continue;
		leaks.push({ id, why: rule.why, chain: chainToApp(id, importersOf) });
	}
	return leaks;
}

function isAppModule(id: string): boolean {
	return id.includes("/src/") && !id.includes("/node_modules/");
}

/** Breadth-first up the importers until an app module that is not itself
 *  server-only (the db client is in `src/`, but it is the leak, not the cause). */
function chainToApp(
	start: string,
	importersOf: (id: string) => readonly string[],
): string[] {
	const parent = new Map<string, string | null>([[start, null]]);
	const queue = [start];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		if (id !== start && isAppModule(id) && !SERVER_ONLY.some((r) => r.test(id))) {
			const chain: string[] = [];
			for (let at: string | null = id; at !== null; at = parent.get(at) ?? null) {
				chain.push(at);
			}
			return chain;
		}
		for (const importer of importersOf(id)) {
			if (parent.has(importer)) continue;
			parent.set(importer, id);
			queue.push(importer);
		}
	}
	return [start];
}

export function formatLeaks(leaks: Leak[], root: string): string {
	const rel = (id: string) => (id.startsWith(root) ? id.slice(root.length + 1) : id);
	// One `pg` leak drags in dozens of driver files; name each culprit app
	// module once, with its shortest chain.
	const byCulprit = new Map<string, Leak>();
	for (const leak of leaks) {
		const seen = byCulprit.get(leak.chain[0]);
		if (!seen || leak.chain.length < seen.chain.length) {
			byCulprit.set(leak.chain[0], leak);
		}
	}
	const lines = [...byCulprit.values()].map(
		(l) => `  - ${l.why}: ${l.chain.map(rel).join("\n      → ")}`,
	);
	return [
		"Server-only code reached the CLIENT bundle; the page would crash in the browser.",
		...lines,
		"Fix: keep db-touching code (including `typeof db` types) out of modules client",
		"routes import — move it to a sibling `*-logic.ts`, or use `import type`.",
	].join("\n");
}

export function clientServerOnlyGate(): Plugin {
	let root = "";
	return {
		name: "client-server-only-gate",
		apply: "build",
		applyToEnvironment: (env) => env.name === "client",
		configResolved(config) {
			root = config.root;
		},
		buildEnd(error) {
			if (error) return;
			const leaks = findServerOnlyLeaks(this.getModuleIds(), (id) => {
				const info = this.getModuleInfo(id);
				// A dynamic import of the db client crashes too, just later.
				return [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])];
			});
			if (leaks.length > 0) this.error(formatLeaks(leaks, root));
		},
	};
}
