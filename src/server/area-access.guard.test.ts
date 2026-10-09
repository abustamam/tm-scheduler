/**
 * What keeps the Area Director's read from becoming more than counts (#1119,
 * ADR-0032), pinned at the source.
 *
 * `area-guards.integration.test.ts` runs the handlers and sees the refusals. It
 * cannot see the things that keep the role small, because each is an ABSENCE
 * or an ORDER that no call exercises:
 *
 * - the gate runs before the loader, in the handler (a handler body is
 *   unreachable from a source-free call, and a gate after the read is
 *   decoration);
 * - no club guard, no public-reader gate and no meeting authorization knows
 *   `area_directors` exists, so the role can never widen one;
 * - the guard and the auth context ask #1116's predicate and do not restate it,
 *   so the nav and the access cannot disagree about the same person;
 * - nothing under `src/server/mcp/` imports an area module, so the connector
 *   stays blind to area data.
 *
 * Two reading modes (`guard-source.ts`): a "must BE present" assertion reads
 * COMMENT-BLIND, so a comment naming the call cannot satisfy it with the real
 * call deleted; an "offender list must be EMPTY" assertion reads RAW, because
 * stripping comments there could only LOOSEN it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const raw = (path: string) => readFileSync(path, "utf8");

describe("the area server fns run the gate before the loader (#1119)", () => {
	it("getAreaHealth runs requireUser, then requireAreaDirector on that user, then loadAreaHealth", () => {
		const body = serverFnBody(
			readSource("src/server/area-health.ts"),
			"getAreaHealth",
		);
		const handler = body.slice(body.indexOf(".handler("));
		const session = handler.indexOf("const user = await requireUser();");
		const gate = handler.indexOf(
			"await requireAreaDirector(user.id, data.areaId);",
		);
		const load = handler.indexOf("loadAreaHealth(");
		expect(session, "requireUser() is gone").toBeGreaterThan(-1);
		expect(gate, "requireAreaDirector(user.id, …) is gone").toBeGreaterThan(-1);
		expect(load, "loadAreaHealth( is gone").toBeGreaterThan(-1);
		expect(session).toBeLessThan(gate);
		expect(gate).toBeLessThan(load);
	});

	it("previewConsoleArea runs requireUser, then requireSuperadmin on that user, then loadAreaHealth", () => {
		const body = serverFnBody(
			readSource("src/server/areas.ts"),
			"previewConsoleArea",
		);
		const handler = body.slice(body.indexOf(".handler("));
		const session = handler.indexOf("const currentUser = await requireUser();");
		const gate = handler.indexOf("await requireSuperadmin(currentUser.id);");
		const load = handler.indexOf("loadAreaHealth(");
		expect(session, "requireUser() is gone").toBeGreaterThan(-1);
		expect(gate, "requireSuperadmin(currentUser.id) is gone").toBeGreaterThan(
			-1,
		);
		expect(load, "loadAreaHealth( is gone").toBeGreaterThan(-1);
		expect(session).toBeLessThan(gate);
		expect(gate).toBeLessThan(load);
	});

	it("the director's read is not the superadmin's: neither fn calls the other's gate", () => {
		// The preview is the superadmin's door and `getAreaHealth` the director's.
		// A superadmin passing the second would be the ambient bypass ADR-0016
		// section 4 rejects, and a director passing the first would hand the
		// console's read to the role.
		const director = serverFnBody(
			readSource("src/server/area-health.ts"),
			"getAreaHealth",
		);
		const preview = serverFnBody(
			readSource("src/server/areas.ts"),
			"previewConsoleArea",
		);
		expect(director).not.toContain("requireSuperadmin");
		expect(preview).not.toContain("requireAreaDirector");
		expect(readSource("src/server/area-guards.ts")).not.toMatch(
			/requireSuperadmin|isSuperadmin/,
		);
	});
});

describe("getAreaHealth bounds its input (#1119)", () => {
	it("caps the id's length in the validator, before any guard or query sees it", () => {
		// Every invalid input gets the one refusal (the integration test proves it
		// at the real handler); the cap is what keeps an enormous string from being
		// parsed as a uuid or sent to the database at all, and no message tells it
		// apart, so only the source can hold it.
		expect(readSource("src/server/area-health.ts")).toMatch(
			/areaId:\s*z\.string\(\)\.max\(\d+\)/,
		);
	});
});

describe("no club guard can reach the area role (#1119)", () => {
	// The files that decide who may read or write a club's records. Each must
	// stay ignorant of `area_directors`, or the role has widened a guard.
	const CLUB_GATES = [
		"src/server/guards.ts",
		"src/server/club-readable-logic.ts",
		"src/server/meeting-authz-logic.ts",
		"src/server/meeting-write-gate.ts",
		"src/server/mcp/authz-logic.ts",
	];

	for (const file of CLUB_GATES) {
		it(`${file} never mentions the area tables or the area guard`, () => {
			const source = raw(file);
			// Control: the file is the real one, not an empty or moved stub.
			expect(source.length).toBeGreaterThan(500);
			expect(source).not.toMatch(
				/areaDirectors|area_directors|area-guards|requireAreaDirector|area-terms-logic/,
			);
		});
	}

	it("the guard reads the refusal FROM guards.ts, and nothing there reads from the guard", () => {
		expect(readSource("src/server/area-guards.ts")).toMatch(
			/import \{ NO_PERMISSION_MESSAGE \} from "\.\/guards";/,
		);
	});

	it("the refusal message is declared once, in src/lib, and guards.ts re-exports it unchanged", () => {
		// `area-refusal.ts` is client code and cannot import `guards.ts` (it reaches
		// `#/db`), so the string lives in a client-safe module both read. A second
		// literal in `guards.ts` would let the two drift while every test passes.
		const guards = raw("src/server/guards.ts");
		expect(guards).toContain(
			'import { NO_PERMISSION_MESSAGE } from "#/lib/permission-message";',
		);
		expect(guards).toContain("export { NO_PERMISSION_MESSAGE };");
		expect(guards).not.toMatch(/NO_PERMISSION_MESSAGE\s*=/);
		const refusal = raw("src/lib/area-refusal.ts");
		expect(readSource("src/lib/area-refusal.ts")).toContain(
			"err.message === NO_PERMISSION_MESSAGE",
		);
		expect(refusal).not.toMatch(/permission to do that/);
	});
});

describe("the guard and the auth context ask #1116's predicate (#1119)", () => {
	for (const file of [
		"src/server/area-guards.ts",
		"src/server/auth-context.ts",
	]) {
		it(`${file} imports area-terms-logic and never says endedAt`, () => {
			// Must BE present: comment-blind, so a comment naming the module cannot
			// stand in for the import.
			expect(readSource(file)).toMatch(/from "\.\/area-terms-logic"/);
			// Offender must be EMPTY: raw. A second copy of "open" (`ended_at IS
			// NULL`) without the year check would keep a past year's director in.
			expect(raw(file)).not.toMatch(/endedAt|ended_at/);
		});
	}

	it("the guard calls isCurrentTerm and the auth context calls loadCurrentAreasForUser", () => {
		expect(readSource("src/server/area-guards.ts")).toContain(
			"isCurrentTerm()",
		);
		// Whitespace-tolerant: the formatter wraps the call across lines.
		expect(readSource("src/server/auth-context.ts")).toMatch(
			/loadCurrentAreasForUser\(\s*user\.id,?\s*\)/,
		);
	});
});

describe("nothing under src/server/mcp imports an area module (#1119)", () => {
	/** Every `.ts` / `.tsx` under a directory, recursively, tests included. */
	function files(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) return files(full);
			return /\.tsx?$/.test(entry.name) ? [full] : [];
		});
	}

	/** The area modules: the guard, #1116's terms, #1117's health, the visits (#1120), the area fns. */
	const AREA_MODULES = new Set([
		"area-guards",
		"area-terms-logic",
		"area-health",
		"area-health-logic",
		"area-visits",
		"area-visits-logic",
		"areas",
		"areas-logic",
	]);

	/** The module names a source imports: static, dynamic and re-exports. */
	function importedModules(source: string): string[] {
		const specifiers = [
			...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
			...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
			...source.matchAll(/\bimport\s+["']([^"']+)["']/g),
		].map((m) => m[1] as string);
		return specifiers.map((s) =>
			(s.split("/").pop() as string).replace(/\.tsx?$/, ""),
		);
	}

	const mcpFiles = files("src/server/mcp");

	it("sweeps the connector's files, and sees an import when there is one (control)", () => {
		// The floor: an empty walk would pass the sweep below vacuously.
		expect(mcpFiles.length).toBeGreaterThan(10);
		expect(
			importedModules(
				'import { x } from "../area-guards";\nconst y = await import("#/server/areas-logic");',
			),
		).toEqual(["area-guards", "areas-logic"]);
	});

	it("no file imports an area module", () => {
		const offenders = mcpFiles.flatMap((file) =>
			importedModules(raw(file))
				.filter((name) => AREA_MODULES.has(name))
				.map((name) => `${file} imports ${name}`),
		);
		expect(offenders).toEqual([]);
	});
});

describe("the console preview shows the area on the page (#1119)", () => {
	it("keys the preview panel by the area, so moving to another area never shows the previous one's numbers", () => {
		// The panel holds the loaded preview in state. Two console area pages are
		// one component instance to React, so without `key` the state survives the
		// move and the page would show area A's counts under area B's heading.
		expect(
			readSource("src/routes/_authed/superadmin/areas.$areaId.tsx"),
		).toContain("<AreaPreviewPanel key={area.id} areaId={area.id} />");
	});
});
