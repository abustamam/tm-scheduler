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
		const call = AUTHED.slice(AUTHED.indexOf("shellPropsFromContext({"));
		expect(call.slice(0, call.indexOf("});"))).toContain("viewAs,");
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
});
