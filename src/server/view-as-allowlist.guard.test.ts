/**
 * "Preview as member" (#1113) changes what is SHOWN, never what a write DOES.
 * That holds only while nothing that decides a write can read the cookie. This
 * walks every file under `src/server/` and fails if one outside the allowlist
 * names the cookie or imports `#/lib/view-as`: a write guard, `canManageClub`, a
 * `meeting-authz-logic.ts` resolver or an MCP tool that grew a preview arm would
 * otherwise pass every behavioural test, since none sets the cookie.
 *
 * An offenders-must-be-EMPTY check, so it reads the RAW file: stripping comments
 * could only loosen it (`guard-source.ts`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Everything that can decide a write: the server, and the API routes (the MCP
 *  endpoint is one: a preview arm there would reach a write). */
const ROOTS = ["src/server", "src/routes/api"];

/** The only server files that may know about the preview, and why. */
const ALLOWED = new Set([
	"src/server/auth-context.ts", // applies it to the context; `setViewAs` sets it
	"src/server/season-grid.ts", // `getSeasonGrid` drops the outreach set
	"src/server/minutes.ts", // `getMinutes` drops `canEdit`
	"src/server/impersonation.ts", // `endImpersonation` deletes it
	"src/server/view-as-allowlist.guard.test.ts", // this file names what it looks for
]);

/** What marks a reader: the constant, the module, or the literal cookie name. */
const MARKERS = [
	/VIEW_AS_COOKIE/,
	/lib\/view-as(?![\w-])/,
	/["'`]view_as["'`]/,
];

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
	);
}

describe("view-as allowlist (#1113)", () => {
	it("no file under src/server/ or src/routes/api/ outside the allowlist reads the preview", () => {
		const offenders = ROOTS.flatMap(files)
			.filter((f) => /\.tsx?$/.test(f))
			.filter((f) => !ALLOWED.has(f))
			.filter((f) => {
				const src = readFileSync(f, "utf8");
				return MARKERS.some((m) => m.test(src));
			});
		expect(offenders).toEqual([]);
	});

	it("the allowlist is real: each allowed file still reads it", () => {
		const stale = [...ALLOWED]
			.filter((f) => !f.endsWith(".guard.test.ts"))
			.filter((f) => {
				const src = readFileSync(f, "utf8");
				return !MARKERS.some((m) => m.test(src));
			});
		expect(stale).toEqual([]);
	});
});
