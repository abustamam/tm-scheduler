import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, serverFnDeclarations } from "#/test/guard-source";

// Structural guard (#939): no public route or loader returns mentorship data.
//
// Pairings are visible only to the mentee, the mentor and admins, in-app. The
// server fns that read them all take a session (`mentorship-authz.guard.test.ts`
// pins which gate each one runs), and the only OTHER reader is the orientation
// checklist, whose "Get a mentor" item carries the mentor's name and contact —
// also session-gated (`orientation-authz.guard.test.ts`). What neither of those
// can see is a PUBLIC surface reaching for one of these readers. That is what
// this file holds.
//
// HOW IT FINDS PUBLIC ROUTES. Enumerated from the filesystem, never listed: a
// route is PUBLIC unless it lives under `src/routes/_authed/`, the pathless
// layout whose `beforeLoad` redirects a signed-out visitor to /signin. So every
// other file under `src/routes/` counts — the anonymous `club.*` pages, the
// marketing and resource pages, `__root.tsx` (which renders for everyone), and
// every HTTP handler under `src/routes/api/` (a handler answers whoever calls
// it; `/api/mcp` authenticates its own token, but it still may not return
// pairings). `_authed.tsx` itself is the gate, not a page, and is skipped. A
// new public route is covered the day it is added, which is the direction a
// guard has to fail in.
//
// RAW source for the absence checks, on purpose (see `#/test/guard-source`):
// stripping comments only LOOSENS an "the offender must be ABSENT" check, and a
// commented-out import is somebody half-way through adding the leak.
const ROUTES = __dirname;
const SRC = resolve(ROUTES, "..");

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = resolve(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(abs));
		else out.push(abs);
	}
	return out;
}

const PUBLIC_ROUTES = walk(ROUTES)
	.map((abs) => relative(ROUTES, abs))
	.filter(
		(f) =>
			/\.tsx?$/.test(f) &&
			!f.includes(".test.") &&
			!f.startsWith("_authed/") &&
			f !== "_authed.tsx",
	)
	.sort();

/** What a public surface may not name: the readers, the table, the flag. */
const FORBIDDEN: { pattern: RegExp; what: string }[] = [
	{ pattern: /mentor/i, what: "anything mentorship (module, table, label)" },
	{ pattern: /#\/server\/orientation/, what: "the orientation server fns" },
	{ pattern: /orientation-logic/, what: "the orientation loader" },
	{
		pattern: /orientation-checklist/,
		what: "the checklist, which renders the mentor's contact",
	},
];

describe("mentorship stays off every public surface (#939)", () => {
	it("enumerates the public routes, so a rename cannot make this vacuous", () => {
		expect(PUBLIC_ROUTES).toContain("club.$clubId.tsx");
		expect(PUBLIC_ROUTES).toContain("club.$clubId.meeting.$meetingId.tsx");
		expect(PUBLIC_ROUTES).toContain("__root.tsx");
		expect(PUBLIC_ROUTES).toContain("api/mcp.ts");
		expect(PUBLIC_ROUTES).not.toContain("_authed/dashboard.tsx");
		expect(PUBLIC_ROUTES).not.toContain("_authed.tsx");
		expect(PUBLIC_ROUTES.length).toBeGreaterThanOrEqual(30);
	});

	for (const file of PUBLIC_ROUTES) {
		it(`${file} returns no mentorship data`, () => {
			const src = readFileSync(resolve(ROUTES, file), "utf8");
			for (const { pattern, what } of FORBIDDEN) {
				expect(
					pattern.test(src),
					`${file} names ${what} (${pattern}). Pairings are visible only to the mentee, the mentor and admins, in-app (#939).`,
				).toBe(false);
			}
		});
	}

	// The server side of the same boundary. A public route could still leak a
	// pairing through a SESSION-LESS server fn in some other module that
	// reads the table, so the table itself may be touched only by the logic
	// modules whose every caller is gated (the merge only re-points rows).
	it("only the gated logic modules touch the mentorships table", () => {
		const TABLE_READERS = new Set([
			"server/mentorship-logic.ts",
			"server/orientation-logic.ts",
			// Re-points pairings on a member merge; returns none of them.
			"server/membership-collapse-logic.ts",
		]);
		const readers = walk(SRC)
			.map((abs) => relative(SRC, abs))
			.filter(
				(f) =>
					/\.tsx?$/.test(f) &&
					!f.includes(".test.") &&
					!f.startsWith("test/") &&
					f !== "db/schema.ts" &&
					f !== "routeTree.gen.ts",
			)
			.filter((f) =>
				/\bmentorships\b/.test(readFileSync(resolve(SRC, f), "utf8")),
			);
		expect(readers.sort()).toEqual([...TABLE_READERS].sort());
	});

	it("every mentorship server fn takes a session", () => {
		const src = readSource(resolve(SRC, "server/mentorship.ts"));
		const fns = serverFnDeclarations(src);
		expect(fns.length).toBeGreaterThan(0);
		for (const { name, body } of fns) {
			expect(body, name).toMatch(/await requireUser\(\)/);
		}
	});
});
