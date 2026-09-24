// Two structural rules #852 depends on, each of which fails silently when
// broken: the officer rule is written once, and `cimd()` sits where it works.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

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

/** Source with comments removed, so a sentence naming a function is not a call. */
function code(path: string): string {
	return readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the officer rule is written once (#852)", () => {
	it("only connector-eligibility.ts turns adminClubsForUser into a yes/no", () => {
		// `authz-logic.ts` defines it and `authenticateToken` resolves a token's
		// clubs with it; any OTHER caller is a second copy of "who may connect",
		// which is how `/me` and the consent screen would drift apart.
		const callers = sourceFiles()
			.filter((path) => /\badminClubsForUser\s*\(/.test(code(path)))
			.map((path) => relative(SRC, path))
			.sort();
		expect(callers).toEqual([
			"server/connector-eligibility.ts",
			"server/mcp/authz-logic.ts",
		]);
	});

	it.each([
		"server/oauth-consent-logic.ts",
		"lib/auth.ts",
	])("%s asks mayUseConnector", (file) => {
		expect(code(join(SRC, file))).toMatch(/\bmayUseConnector\s*\(/);
	});

	it.each([
		"getApiTokenState",
		"generateApiToken",
	])("api-tokens.ts's %s asks mayUseConnector", (fn) => {
		// Per server fn, not per file: the file-level match would still pass
		// with one of the two quietly back on an inline copy, or on nothing.
		const body = code(join(SRC, "server/api-tokens.ts"))
			.split(/\bexport const /)
			.find((chunk) => chunk.startsWith(`${fn} `));
		expect(body, `${fn} not found`).toBeDefined();
		expect(body).toMatch(/\bmayUseConnector\s*\(/);
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
