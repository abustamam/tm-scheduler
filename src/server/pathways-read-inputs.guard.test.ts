/**
 * The two Pathways reads that decide what a former member's record shows must
 * receive the inputs that decision reads.
 *
 * ## Why this is a source guard
 *
 * A `createServerFn` cannot be invoked from vitest, and every route test mocks
 * `#/server/pathways-read` wholesale, so the transport between a loader and the
 * logic is invisible to the suite. Two regressions live exactly there, and both
 * leave every other test green:
 *
 * - `includeFormer` dropped from `listClubMemberPathways`' zod schema. Zod
 *   strips unknown keys, so the roster's request arrives without it and the
 *   officer's toggle silently does nothing. The route test sees the loader pass
 *   it; the integration test calls `listClubMemberPathwaysFor` directly.
 * - `getMemberPathways` no longer handing the viewer to `pathwaysForMember`.
 *   Then the member page withholds a former member's paths from EVERY viewer,
 *   officers included, because the logic answers `[]` without a session. The
 *   integration test passes the viewer in itself and cannot see this.
 */
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const SRC = readSource("src/server/pathways-read.ts");

/** The object literal handed to the `z.object(...)` a server fn's schema names. */
function schemaBody(name: string): string {
	const start = SRC.indexOf(`const ${name} = z.object({`);
	expect(start, `no ${name} schema in pathways-read.ts`).toBeGreaterThan(-1);
	return SRC.slice(start, SRC.indexOf("});", start));
}

describe("the former-member Pathways reads receive what they decide on", () => {
	it("listClubMemberPathways' schema keeps includeFormer", () => {
		const fn = serverFnBody(SRC, "listClubMemberPathways");
		const schema = fn.match(
			/\.validator\(\s*\([^)]*\)\s*=>\s*(\w+)\.parse/,
		)?.[1];
		expect(schema, "listClubMemberPathways no longer parses a schema").toBe(
			"clubSchema",
		);
		expect(schemaBody("clubSchema")).toMatch(
			/includeFormer:\s*z\.boolean\(\)\.optional\(\)/,
		);
	});

	it("listClubMemberPathways forwards the parsed input whole", () => {
		const fn = serverFnBody(SRC, "listClubMemberPathways");
		expect(fn).toMatch(/listClubMemberPathwaysFor\(\s*user\.id,\s*data\s*\)/);
	});

	it("getMemberPathways hands the session viewer to pathwaysForMember", () => {
		const fn = serverFnBody(SRC, "getMemberPathways");
		expect(fn).toMatch(/const viewer = await getSessionUser\(\)/);
		expect(fn).toMatch(
			/pathwaysForMember\(\s*data\.clubId,\s*data\.memberId,\s*viewer\?\.id \?\? null\s*,?\s*\)/,
		);
	});
});
