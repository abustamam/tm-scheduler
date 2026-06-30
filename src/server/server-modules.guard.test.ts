import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard against the client-bundle leak that broke production twice
 * (PR #48 + this PR): a `src/server/*.ts` module that defines a `createServerFn`
 * is imported by client route files, and the Start compiler strips the server-fn
 * *handlers* (and their `#/db` imports) from the client bundle — but a plain,
 * top-level db-touching export sitting in the same module is NOT stripped and
 * drags `#/db` → `pg` → `Buffer` into the browser ("Buffer is not defined").
 *
 * Rule: a server-fn module (one that contains `createServerFn`) may only export
 * `createServerFn`s and types. Plain functions / consts (the directly-testable
 * db logic) belong in a sibling `*-logic.ts` that client code never imports.
 * See `members-logic.ts` / `activity-feed-logic.ts`.
 *
 * This is a source-shape heuristic, not a full import-graph analysis, but it
 * catches the exact mistake both regressions made. Pure server helpers with no
 * `createServerFn` (e.g. `guards.ts`, `activity.ts`, `*-logic.ts`) are exempt —
 * by convention they are never imported by client routes.
 */
const serverDir = dirname(fileURLToPath(import.meta.url));

function topLevelExports(src: string): string[] {
	return src.split("\n").filter((line) => /^export\b/.test(line));
}

/** True for exports that are safe in a client-reachable server-fn module. */
function isAllowedExport(line: string): boolean {
	// Types are erased at build time — no runtime db code.
	if (/^export\s+(type|interface)\b/.test(line)) return true;
	// `export const x = createServerFn(...)` — the only allowed value export.
	if (/^export\s+const\s+\w+\s*=\s*createServerFn\b/.test(line)) return true;
	return false;
}

describe("server-fn modules keep db logic out of the client bundle", () => {
	const files = readdirSync(serverDir).filter(
		(f) =>
			f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith("-logic.ts"),
	);

	for (const file of files) {
		const src = readFileSync(join(serverDir, file), "utf8");
		if (!src.includes("createServerFn")) continue; // pure helper module — exempt

		it(`${file} exports only createServerFns and types`, () => {
			const offenders = topLevelExports(src).filter(
				(line) => !isAllowedExport(line),
			);
			expect(
				offenders,
				`${file} has non-createServerFn value export(s) that would leak #/db into the client bundle. ` +
					`Move this logic to a sibling '*-logic.ts' (see members-logic.ts):\n  ${offenders.join("\n  ")}`,
			).toEqual([]);
		});
	}
});
