// A tab loaded before #1656 must not be sent a `kind: "past"` row (#1656).
//
// `listMySpeeches` and `getMemberProfile` already take an input from tabs older
// than this change, and those tabs' render reads `evaluators.length` on every
// row, so a past row (no evaluators) throws it. The wire contract: the new
// client sends `pastRows: true`, and without it the server leaves the past query
// unrun, so `limit` and `truncated` still count meeting rows alone.
//
// A `createServerFn` cannot be invoked from vitest and the route tests mock
// `#/server/club` wholesale, so this reads the source, comment-blind
// (`#/test/guard-source`), as `list-my-speeches-stale-tab.guard.test.ts` does.
// The logic behind it (`includePast: false`) is run against the database in
// `my-activity-past-rows.integration.test.ts`.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource, serverFnDeclarations } from "#/test/guard-source";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const club = serverFnDeclarations(
	readSource(resolve(ROOT, "src/server/club.ts")),
);

describe("the pastRows capability flag (#1656)", () => {
	for (const name of ["listMySpeeches", "getMemberProfile"]) {
		const fn = club.find((d) => d.name === name);
		it(`${name} accepts the flag and runs the past query only when it is true`, () => {
			expect(fn, `${name} not found`).toBeTruthy();
			expect(fn?.method).toBe("GET");
			expect(fn?.body).toMatch(/pastRows:\s*z\.boolean\(\)\.optional\(\)/);
			expect(fn?.body).toMatch(/includePast:\s*data\??\.pastRows\s*===\s*true/);
		});
	}

	const callers: Array<[string, string, RegExp]> = [
		[
			"the dashboard loader",
			"src/routes/_authed/dashboard.tsx",
			/listMySpeeches\(\{[^)]*pastRows:\s*true/,
		],
		[
			"the member profile loader",
			"src/routes/_authed/members.$id.tsx",
			/getMemberProfile\(\{[^)]*pastRows:\s*true/,
		],
	];
	for (const [label, file, call] of callers) {
		it(`${label} sends pastRows: true`, () => {
			expect(readSource(resolve(ROOT, file))).toMatch(call);
		});
	}
});
