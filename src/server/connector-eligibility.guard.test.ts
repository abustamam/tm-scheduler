// Two structural rules #852 depends on, each of which fails silently when
// broken: the officer rule is written once, and `cimd()` sits where it works.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

// `#/lib/auth` seeds an `oauth_resource` row at import; with no database that
// init fails, is logged, and is not what this file is about.
vi.mock("#/db", () => ({ db: {} }));

const SRC = join(import.meta.dirname, "..");

/** Every non-test `.ts` / `.tsx` file under `src/`. */
function sourceFiles(dir = SRC): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return [];
		return [path];
	});
}

/** The slice of `source` from `start` up to (not including) `end`; throws if either is absent. */
function between(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	if (from === -1 || to === -1) {
		throw new Error(
			`${start} … ${end} not found — the code moved. Re-point this guard rather than deleting the case.`,
		);
	}
	return source.slice(from, to);
}

const CALL = /\bmayUseConnector\(session\.user\.id\)/;

describe("the officer rule is written once (#852)", () => {
	it("connector-eligibility.ts is the only caller of adminClubsForUser besides authz-logic.ts, where it lives", () => {
		// An offender-list guard, so it reads RAW source (see guard-source.ts):
		// stripping comments could only hide a caller, never invent one.
		// `authz-logic.ts` defines it and `authenticateToken` resolves a token's
		// clubs with it; any OTHER caller is a second copy of "who may connect".
		const callers = sourceFiles()
			.filter((path) =>
				/\badminClubsForUser\s*\(/.test(readFileSync(path, "utf8")),
			)
			.map((path) => relative(SRC, path))
			.sort();
		expect(callers).toEqual([
			"server/connector-eligibility.ts",
			"server/mcp/authz-logic.ts",
		]);
	});

	it.each([
		"getApiTokenState",
		"generateApiToken",
	])("api-tokens.ts's %s asks mayUseConnector", (fn) => {
		// Per server fn, not per file: a file-level match would still pass
		// with one of the two quietly back on an inline copy, or on nothing.
		const body = serverFnBody(
			readSource(join(SRC, "server/api-tokens.ts")),
			fn,
		);
		expect(body).toMatch(/\bmayUseConnector\(user\.id\)/);
	});

	it("the consent hook in auth.ts refuses an approval with it", () => {
		const hook = between(
			readSource(join(SRC, "lib/auth.ts")),
			"hooks: {",
			"advanced: {",
		);
		expect(hook).toMatch(CALL);
		expect(hook).toMatch(/ctx\.body\?\.accept === true/);
		expect(hook).toMatch(/error: NOT_AN_OFFICER\b/);
	});

	it("lookupConsentClient reads it and reports it on BOTH signed-in arms", () => {
		const body = between(
			readSource(join(SRC, "server/oauth-consent-logic.ts")),
			"export async function lookupConsentClient",
			"\n}\n",
		);
		expect(body).toMatch(
			/const eligible = await mayUseConnector\(session\.user\.id\)/,
		);
		// The identified-client arm and the lookup-failed arm.
		expect(body.match(/^\s*eligible,$/gm)).toHaveLength(2);
	});
});

describe("unlisted metadata client ids are refused before resolution (#852)", () => {
	it("the auth.ts hook runs unlistedCimdClientId before any path check", () => {
		const hook = between(
			readSource(join(SRC, "lib/auth.ts")),
			"before: createAuthMiddleware(",
			'if (ctx.path !== "/oauth2/consent") return;',
		);
		expect(hook).toMatch(/\bunlistedCimdClientId\(\{/);
		expect(hook).toMatch(/error: "invalid_client"/);
	});
});

describe("cimd() is registered where it works (#852)", () => {
	it("after the provider mcp() installs, and before tanstackStartCookies(), which stays last", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { auth } = await import("#/lib/auth");
		const ids = (auth.options.plugins ?? []).map((p) => p.id);
		error.mockRestore();
		expect(ids.indexOf("cimd")).toBeGreaterThan(ids.indexOf("oauth-provider"));
		expect(ids.indexOf("oauth-provider")).toBeGreaterThan(-1);
		expect(ids.at(-1)).toBe("tanstack-start-cookies");
		expect(ids.filter((id) => id === "tanstack-start-cookies")).toHaveLength(1);
		expect(ids.filter((id) => id === "cimd")).toHaveLength(1);
	});
});
