/**
 * Every MCP tool authorizes, and nothing on the MCP path reads a cookie (#773,
 * design D12).
 *
 * ## Why this DERIVES the tool set instead of listing it
 *
 * A hand-written list cannot fail for the case it exists to catch: the tool that
 * forgot its authorization check is the tool that is also missing from the list.
 * On #544 nine readers were enrolled by hand, `getMeeting` sat ungated in the
 * same file, and the guard stayed green. So this walks
 * `src/server/mcp/tools/`, treats every exported tool definition it finds as a
 * candidate, and fails any that calls neither entry point.
 *
 * `whoami` sits in an explicit waiver map with its reason: it is the tool that
 * TELLS a caller which clubs exist, so it has no `clubId` to be checked against
 * and calls `authenticateToken` instead. Splitting the two entry points is what
 * makes "no unauthenticated tool" machine-checkable with exactly one waiver
 * rather than a list of exceptions.
 *
 * It ALSO cross-checks the registry both ways — a tool file that is not
 * registered is unreachable, and a registered name with no file is a rename
 * nobody finished.
 *
 * ## The cookie rule
 *
 * `/api/mcp` is bearer-only, and that is the whole CSRF posture: a cross-site
 * POST carries no ambient credential, so there is nothing to forge. The rule
 * holds only while nothing on this path reads a cookie. `requireClubRole` is the
 * one that looks harmless and is not — it falls through `requireMembership` to
 * `requireReadWriteImpersonation` (`guards.ts:257-285`), which reads
 * impersonation sessions from the database, so a superadmin's browser "act as
 * admin" session would silently become token authority.
 *
 * **This grep is not the whole defence and must not be read as one.** It is
 * blind to a cookie arriving through a helper or a re-export. The behavioural
 * half lives in `mcp-route.integration.test.ts`: a real session cookie with no
 * `Authorization` header gets 401 and writes nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readSource } from "#/test/guard-source";

// The tool modules reach `#/db` on import. Nothing here runs a query.
vi.mock("#/db", () => ({ db: {} }));

const mcpDir = dirname(fileURLToPath(import.meta.url));
const toolsDir = join(mcpDir, "tools");
const routeFile = resolve(mcpDir, "../../routes/api/mcp.ts");

/**
 * Tools allowed to call `authenticateToken` instead of `authorizeToken`, with
 * the reason. Adding an entry widens the set of tools that run without a club
 * check, so it must never be a silently-green one-line edit — the size
 * assertion at the bottom forces it through review.
 */
const AUTHENTICATE_ONLY: Record<string, string> = {
	"whoami.ts":
		"whoami is what tells a caller which clubs exist, so it has no clubId to " +
		"be authorized against. It returns only the token owner's own identity " +
		"and the clubs their own memberships already grant.",
};

/** The two sanctioned club-scoped entry points. */
const AUTHORIZE = /\bauthorizeToken(ForMeeting)?\s*\(/;
/** The authenticate-only entry point, for the waived tool. */
const AUTHENTICATE = /\bauthenticateToken\s*\(/;

/**
 * Functions that read the session cookie, directly or through a fallback.
 * Matched as an IMPORTED BINDING, not as any mention: a comment naming
 * `requireClubRole` (this file's own header does) must not fail the guard.
 */
const COOKIE_READERS = [
	"getSessionUser",
	"requireUser",
	"requestWriteActor",
	"requireClubRole",
	"requireMembership",
] as const;

/** Every `*.ts` under a directory, recursively, excluding tests. */
function sourceFiles(dir: string, base = dir): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(full, base));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out.sort();
}

/**
 * The import bindings a module pulls in, as a flat list of names.
 *
 * Parses `import { a, b as c } from "..."` rather than searching the whole file
 * for the identifier, so a mention in prose or in a string is not an offender.
 */
function importedBindings(src: string): string[] {
	const out: string[] = [];
	const importBlock =
		/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
	let m = importBlock.exec(src);
	while (m) {
		for (const part of (m[1] ?? "").split(",")) {
			const name = part
				.trim()
				.split(/\s+as\s+/)[0]
				?.trim();
			if (name) out.push(name.replace(/^type\s+/, ""));
		}
		m = importBlock.exec(src);
	}
	return out;
}

/** True when a tool module's source calls a club-scoped authorization entry. */
function callsAuthorize(src: string): boolean {
	return AUTHORIZE.test(src);
}

const toolFiles = sourceFiles(toolsDir).filter(
	(f) => !f.endsWith(`${"/"}index.ts`),
);

interface DiscoveredTool {
	file: string;
	basename: string;
	name: string;
}

/** Import each tool module and read the definitions it exports. */
async function discoverTools(): Promise<DiscoveredTool[]> {
	const found: DiscoveredTool[] = [];
	for (const file of toolFiles) {
		const mod: Record<string, unknown> = await import(file);
		for (const value of Object.values(mod)) {
			if (
				value &&
				typeof value === "object" &&
				typeof (value as { name?: unknown }).name === "string" &&
				typeof (value as { handler?: unknown }).handler === "function" &&
				typeof (value as { config?: unknown }).config === "object"
			) {
				found.push({
					file,
					basename: file.slice(toolsDir.length + 1),
					name: (value as { name: string }).name,
				});
			}
		}
	}
	return found;
}

const discovered = await discoverTools();
const { MCP_TOOLS } = await import("./tools");

describe("every MCP tool authorizes (#773)", () => {
	it("sweeps the tools directory and finds tools there", () => {
		// A sweep that finds nothing passes vacuously. This is the floor that
		// makes every case below mean something.
		expect(toolFiles.length).toBeGreaterThanOrEqual(5);
		expect(discovered.length).toBeGreaterThanOrEqual(5);
		expect(discovered.map((t) => t.name)).toContain("record_guest_book");
	});

	for (const tool of discovered) {
		it(`${tool.basename} (${tool.name}) checks a club membership`, () => {
			// "Must BE present", so read through `readSource`, which blanks
			// comments: a tool whose only mention of `authorizeToken` is in a
			// comment has not called it.
			const src = readSource(tool.file);
			const waiver = AUTHENTICATE_ONLY[tool.basename];
			if (waiver) {
				expect(
					AUTHENTICATE.test(src),
					`${tool.basename} is waived from the club check but does not call ` +
						`authenticateToken either, so it authorizes NOTHING. Waiver reason: ${waiver}`,
				).toBe(true);
				return;
			}
			expect(
				callsAuthorize(src),
				`${tool.basename} calls neither authorizeToken nor ` +
					`authorizeTokenForMeeting, so a token holder reaches it without any ` +
					`membership in the club it acts on. Add the call, or add an entry to ` +
					`AUTHENTICATE_ONLY with a reason (and expect that to be argued for in review).`,
			).toBe(true);
		});
	}

	it("the registry lists every tool file, and no name without one", () => {
		const registered = MCP_TOOLS.map((t) => t.name).sort();
		const onDisk = discovered.map((t) => t.name).sort();
		expect(
			registered,
			"src/server/mcp/tools/index.ts and the tools directory disagree. A tool " +
				"file that is not registered is unreachable; a registered name with no " +
				"file is a rename nobody finished.",
		).toEqual(onDisk);
	});

	it("every tool name is unique", () => {
		const names = MCP_TOOLS.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("the authenticate-only waiver list has not grown", () => {
		// Widening this exempts a tool from the club check entirely, so it must
		// break a test and be argued for rather than land as a one-line edit.
		expect(Object.keys(AUTHENTICATE_ONLY)).toEqual(["whoami.ts"]);
		expect(AUTHENTICATE_ONLY["whoami.ts"]?.length ?? 0).toBeGreaterThan(20);
	});

	// Mutation verification, per the design: prove the predicate can FAIL for a
	// NEW non-compliant tool, rather than by breaking an enrolled one. Without
	// this the sweep above passes whether or not `callsAuthorize` works at all,
	// which is how a source guard rots into decoration.
	it("the predicate flags a new tool that forgot its check", () => {
		const compliant = `
			import { authorizeToken } from "../authz-logic";
			export const xTool = { name: "x", config: {}, handler: async (i, c) => {
				const { club } = await authorizeToken(c.rawToken, i.clubId);
				return club;
			}};
		`;
		const byMeeting = `
			import { authorizeTokenForMeeting } from "../authz-logic";
			export const yTool = { handler: async (i, c) =>
				authorizeTokenForMeeting(c.rawToken, i.meetingId) };
		`;
		const forgot = `
			import { db } from "#/db";
			export const zTool = { name: "z", config: {}, handler: async (i) =>
				db.select().from(anything).where(eq(anything.clubId, i.clubId)) };
		`;
		// A mention in a COMMENT is not a call; `readSource` blanks those before
		// this predicate ever sees them, so simulate that here.
		const commentOnly = `
			export const wTool = { handler: async () => null };
		`;
		expect(callsAuthorize(compliant)).toBe(true);
		expect(callsAuthorize(byMeeting)).toBe(true);
		expect(callsAuthorize(forgot)).toBe(false);
		expect(callsAuthorize(commentOnly)).toBe(false);
	});
});

describe("nothing on the MCP path reads a session cookie (#773)", () => {
	const files = [...sourceFiles(mcpDir), routeFile];

	it("sweeps the mcp tree and the route", () => {
		expect(files.length).toBeGreaterThanOrEqual(8);
		expect(files).toContain(routeFile);
	});

	for (const file of files) {
		const rel = file.slice(file.indexOf("/src/") + 1);
		it(`${rel} imports no cookie-reading function`, () => {
			// Deliberately NOT `readSource`. This asserts an offender list is
			// EMPTY, so blanking comments could only ever REMOVE a false offender
			// — which would loosen the guard. The binding parse below is what
			// keeps a prose mention (this file's own header has several) from
			// failing it.
			const src = readFileSync(file, "utf8");
			const bound = new Set(importedBindings(src));
			const offenders = COOKIE_READERS.filter((fn) => bound.has(fn));
			expect(
				offenders,
				`${rel} imports ${offenders.join(", ")}. /api/mcp is bearer-only: ` +
					`reading a cookie here gives a cross-site POST an ambient credential, ` +
					`and requireClubRole in particular falls through to ` +
					`requireReadWriteImpersonation, which would hand a superadmin's ` +
					`browser "act as admin" session to every token call on that club. ` +
					`Resolve the membership through src/server/mcp/authz-logic instead.`,
			).toEqual([]);
		});
	}

	it("the binding parser sees an import and ignores a mention", () => {
		// Same reason as the predicate self-test above: without this, the sweep
		// passes on a clean tree whether or not `importedBindings` works.
		const imported = `import { requireClubRole, getMembership } from "../guards";`;
		const renamed = `import { requireUser as ru } from "#/server/guards";`;
		const mentioned = `// never call requireClubRole here\nconst s = "requireUser";`;
		expect(importedBindings(imported)).toContain("requireClubRole");
		expect(importedBindings(renamed)).toContain("requireUser");
		expect(importedBindings(mentioned)).toEqual([]);
	});
});
