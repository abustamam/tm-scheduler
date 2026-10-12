/**
 * Every mount of the app shell must carry `viewAs` to it (#1113).
 *
 * `ShellContext.viewAs` is typed optional so older hand-built fixtures keep
 * compiling, which means the compiler cannot catch a mount that forgets it. The
 * failure is silent and has no way out: an admin in preview is no longer
 * `isOfficer`, so a shell that never hears `viewAs` shows neither the banner nor
 * the "Preview as member" button. `_authed.tsx` builds its context field by
 * field, so it is the mount that can drop it; the other two spread the whole
 * `authCtx` that `getAuthContext` returned.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const AUTHED = readSource("src/routes/_authed.tsx");

describe("view-as wiring (#1113)", () => {
	it("_authed.tsx returns viewAs from beforeLoad", () => {
		expect(AUTHED).toContain("viewAs: ctx.viewAs,");
	});

	it("_authed.tsx reads it from the route context", () => {
		expect(AUTHED).toMatch(
			/const \{[^}]*\bviewAs,[^}]*\} = Route\.useRouteContext\(\)/s,
		);
	});

	it("_authed.tsx passes it into shellPropsFromContext", () => {
		const start = AUTHED.indexOf("shellPropsFromContext({");
		expect(start, "shellPropsFromContext({ not found").toBeGreaterThanOrEqual(
			0,
		);
		const call = AUTHED.slice(start);
		const end = call.indexOf("});");
		expect(end, "end of the call not found").toBeGreaterThanOrEqual(0);
		expect(call.slice(0, end)).toContain("viewAs,");
	});

	it("the other two mounts spread the whole auth context", () => {
		expect(readSource("src/routes/club.$clubId.tsx")).toContain(
			"{...shellPropsFromContext(authCtx)}",
		);
		expect(
			readSource("src/components/resources/resources-shell.tsx"),
		).toContain("{...shellPropsFromContext(authCtx)}");
	});

	it("shellPropsFromContext hands the shell the context's viewAs", () => {
		expect(readSource("src/components/app-shell.tsx")).toContain(
			"viewAs: ctx.viewAs ?? null,",
		);
	});

	// The server-fn half (#1113). `season-grid-logic` and `minutes-logic` are
	// pure and tested with an explicit `asMember`; what no behavioural test sees
	// is the WRAPPER feeding the cookie into them, since none sets one. Delete the
	// argument and every suite stays green while the preview stops hiding data.
	describe("the data wrappers feed the cookie into the decision", () => {
		function exportSlice(path: string, name: string): string {
			const src = readSource(path);
			const start = src.indexOf(`export const ${name} =`);
			expect(start, `${name} not found in ${path}`).toBeGreaterThanOrEqual(0);
			const rest = src.slice(start + 1);
			const next = rest.indexOf("\nexport const ");
			const body = next === -1 ? rest : rest.slice(0, next);
			expect(body.length).toBeGreaterThan(0);
			return body;
		}
		const COOKIE_READ =
			/asMember\s*=\s*parseViewAs\(\s*getCookie\(VIEW_AS_COOKIE\)\s*\)\s*===\s*"member"/;

		it("getSeasonGrid: includeOutreach takes asMember", () => {
			const body = exportSlice("src/server/season-grid.ts", "getSeasonGrid");
			expect(body).toMatch(COOKIE_READ);
			expect(body).toMatch(
				/includeOutreach:\s*seasonGridIncludesOutreach\(\{[^}]*\basMember\b[^}]*\}\)/,
			);
		});

		it("getMinutes: the cookie read feeds minutesAccess", () => {
			const body = exportSlice("src/server/minutes.ts", "getMinutes");
			expect(body).toMatch(COOKIE_READ);
			expect(body).toMatch(/minutesAccess\(\{[^}]*\basMember\b[^}]*\}\)/);
		});
	});
});
