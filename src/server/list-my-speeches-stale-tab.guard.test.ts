// `listMySpeeches` answers a pre-#681 tab in the pre-#681 shape (#681).
//
// Before #681 the fn took no input and returned a bare array of rows carrying
// `evaluatorName`, and the dashboard loader `.map`ped it. A tab left open across
// the deploy keeps running that old loader against the new server (a server
// fn's URL is derived from file and export name, so it does not change), and an
// object there throws `speeches.map is not a function` and blanks the
// dashboard. So the no-input call returns the bare array, each row still
// carrying `evaluatorName`, and the current dashboard always sends an input and
// narrows the result.
//
// This is the only thing that can hold that contract. A `createServerFn` cannot
// be invoked from vitest, and the route tests `vi.mock("#/server/club")`
// wholesale, so the wire shape is invisible to the rest of the suite. Same
// construction as `club-logo-method.guard.test.ts`: the "must BE present"
// assertions read comment-blind (`#/test/guard-source`), where a comment quoting
// the code would be a false PASS, and the one "must be ABSENT" check reads raw.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource, serverFnDeclarations } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");

const club = serverFnDeclarations(
	readSource(resolve(ROOT, "src/server/club.ts")),
);
const fn = club.find((d) => d.name === "listMySpeeches");
const DASHBOARD = resolve(ROOT, "src/routes/_authed/dashboard.tsx");
const dashboard = readSource(DASHBOARD);
/** Verbatim, for the one "must be ABSENT" assertion (see `guard-source.ts`). */
const dashboardRaw = readFileSync(DASHBOARD, "utf8");

describe("listMySpeeches stale-tab contract (#681)", () => {
	it("is still declared, and still GET", () => {
		expect(fn, "listMySpeeches not found in src/server/club.ts").toBeTruthy();
		expect(fn?.method).toBe("GET");
	});

	it("keeps its input optional, so a no-input call still validates", () => {
		expect(fn?.body).toMatch(/\.optional\(\)\s*\.parse\(input\)/);
	});

	it("answers a no-input call with the bare array, evaluatorName included", () => {
		const branch = fn?.body.match(
			/if\s*\(\s*data\s*===\s*undefined\s*\)\s*\{([\s\S]*?)\n\t\t\}/,
		);
		expect(branch, "no `if (data === undefined) { … }` branch").toBeTruthy();
		expect(branch?.[1]).toMatch(/return\s+rows\.map\(/);
		expect(branch?.[1]).toMatch(
			/evaluatorName:\s*speechLogEvaluatorNames\(r\.evaluators\)/,
		);
	});

	it("the dashboard always sends an input and narrows the result", () => {
		expect(dashboard).toMatch(/listMySpeeches\(\{\s*data:\s*\{/);
		expect(dashboardRaw).not.toMatch(/listMySpeeches\(\s*\)/);
		expect(dashboard).toMatch(/Array\.isArray\(speechLog\)/);
	});
});
