/**
 * Source guard for the agenda-template and agenda-editor server fns.
 *
 * Exists because `public-readers-archive-gate.guard.test.ts` had to WAIVE TEN
 * fns: its sweep looks for a `require*` call inside the fn body and cannot see
 * through `requireMeetingTemplateEditor`, which is imported. A waiver is a
 * claim, and an unchecked claim is exactly how #560's 24 gated readers ended up
 * serving an archived club — so the claim is pinned here instead.
 *
 * That is not hypothetical for this pair of modules. There is NO backstop
 * underneath them: the `-logic` layer does its own tenant resolution and has no
 * session, so the handler's `requireMeetingTemplateEditor` is the only gate, and
 * a handler body is unreachable from vitest. Delete one line from
 * `removeAgendaRoleFn` and an anonymous caller can destroy any club's agenda
 * with the whole suite green.
 *
 * DERIVED, not listed, in both directions — the earlier version hardcoded
 * `meeting-templates.ts` alone and could not see `meeting-agenda-edit.ts` at
 * all, which is how eight new fns were waived and pinned by nothing:
 *
 *  - the fn set comes from splitting each module on `export const`, the same
 *    way `server-modules.guard.test.ts` derives its own, so a NEW server fn
 *    added to either module is enrolled automatically rather than remembered;
 *  - the MODULE set is cross-checked against the waiver file, so a waiver
 *    claiming `requireMeetingTemplateEditor` for a fn in some THIRD module
 *    fails here until that module is swept too. That is the half that makes
 *    this guard grow with the waiver instead of drifting behind it.
 *
 * Read COMMENT-BLIND (`readSource`): every assertion below is "this pattern must
 * BE present", which a comment merely naming the pattern would falsely satisfy.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/** Every module whose server fns gate through `requireMeetingTemplateEditor`.
 *  Adding one here is what enrolls it; the waiver cross-check below fails until
 *  you do. */
const GATED_MODULES = [
	"src/server/meeting-templates.ts",
	"src/server/meeting-agenda-edit.ts",
] as const;

const WAIVER_SOURCE = readSource(
	"src/server/public-readers-archive-gate.guard.test.ts",
);

/** `export const <name> = createServerFn` → the fn's name and its body, split
 *  on the export boundary the same way `server-modules.guard.test.ts` does. */
function fns(source: string): { name: string; body: string }[] {
	return source
		.split("export const")
		.slice(1)
		.filter((chunk) => chunk.includes("createServerFn"))
		.map((chunk) => ({
			name: chunk.trim().split(/[^\w]/)[0] ?? "",
			body: chunk,
		}));
}

function allFns(): { file: string; name: string; body: string }[] {
	return GATED_MODULES.flatMap((file) =>
		fns(readSource(file)).map((fn) => ({ file, ...fn })),
	);
}

describe("meeting template and agenda-editor server fns", () => {
	it("finds every fn in both modules", () => {
		// The derivation is the guard. If a rename or a formatting change made
		// this list empty, every per-fn assertion below would vacuously pass —
		// the shape CLAUDE.md records as "a silently absent gate reads exactly
		// like a passing one".
		const found = allFns();
		expect(found.length).toBeGreaterThanOrEqual(11);
		for (const file of GATED_MODULES) {
			expect(
				found.filter((f) => f.file === file).length,
				`no server fns found in ${file}`,
			).toBeGreaterThan(0);
		}
	});

	it("routes every fn through a gate that resolves a session", () => {
		for (const fn of allFns()) {
			const gated =
				fn.body.includes("requireMeetingTemplateEditor") ||
				(fn.body.includes("requireUser") &&
					fn.body.includes("requireClubRole"));
			expect(gated, `ungated server fn: ${fn.file} ${fn.name}`).toBe(true);
		}
	});

	it("asserts the club is not archived on every fn", () => {
		for (const fn of allFns()) {
			const gated =
				fn.body.includes("requireMeetingTemplateEditor") ||
				fn.body.includes("assertClubNotArchived");
			expect(gated, `no archive gate: ${fn.file} ${fn.name}`).toBe(true);
		}
	});

	it("sweeps every module the archive-gate waiver claims this helper for", () => {
		// The direction the old version of this file could not see. A waiver
		// reading "officer-gated + archive-gated inside requireMeetingTemplateEditor"
		// is a claim about a fn body; this asserts the fn actually exists in a
		// module this guard READS, so the claim is checked rather than trusted.
		// The key and its reason string, and NOTHING between them but the
		// whitespace Biome's wrapping puts there — a lazy `[\s\S]*?` would
		// happily span from any earlier key to a later entry's reason and report
		// a name that is not the one waived.
		const claimed = [
			...WAIVER_SOURCE.matchAll(
				/^\t(\w+):[ \t]*\n?[ \t]*"officer-gated \+ archive-gated inside requireMeetingTemplateEditor/gm,
			),
		].map((m) => m[1]);
		// Ten today (two conversion fns + eight agenda-editor fns). Asserted as a
		// floor so the count cannot silently collapse to zero and make the loop
		// below vacuous.
		expect(claimed.length).toBeGreaterThanOrEqual(10);
		const swept = new Set(allFns().map((f) => f.name));
		for (const name of claimed) {
			expect(
				swept.has(name ?? ""),
				`${name} is waived as gated by requireMeetingTemplateEditor, but lives in no module this guard sweeps — add its module to GATED_MODULES`,
			).toBe(true);
		}
	});

	it("keeps the shared helper's three gates intact", () => {
		// The waiver in public-readers-archive-gate names this helper by hand.
		// If any of these three is dropped, that waiver silently becomes false.
		//
		// The helper itself lives in meeting-templates-logic.ts, not here: a
		// plain value export from a module that also defines `createServerFn`s
		// is the exact leak `server-modules.guard.test.ts` exists to catch, so
		// it moved there when a second server-fn module (meeting-agenda-edit.ts)
		// needed to import it too. Re-pointed rather than deleted.
		const logicSource = readSource("src/server/meeting-templates-logic.ts");
		const helper = logicSource
			.slice(
				logicSource.indexOf(
					"export async function requireMeetingTemplateEditor",
				),
			)
			.split("\n}")[0];
		expect(helper).toContain("requireUser");
		expect(helper).toContain("assertClubNotArchived");
		expect(helper).toContain(
			'requireClubRole(user.id, meeting.clubId, ["admin"])',
		);
	});

	it("exports only server fns and types", () => {
		// The server-module rule: a plain top-level db-touching export here would
		// drag `#/db` -> `pg` -> `Buffer` into the client bundle.
		for (const file of GATED_MODULES) {
			const exportLines = readSource(file)
				.split("\n")
				.filter((l) => l.startsWith("export "));
			for (const line of exportLines) {
				const ok =
					line.startsWith("export const") ||
					line.startsWith("export type") ||
					line.startsWith("export interface");
				expect(ok, `unexpected export in ${file}: ${line}`).toBe(true);
			}
			for (const line of exportLines.filter((l) =>
				l.startsWith("export const"),
			)) {
				expect(line, file).toContain("createServerFn");
			}
		}
	});

	it("validates input with a function, matching this repo's call shape", () => {
		// `.validator(schema)` is not how any other server fn here is written
		// (`role-definitions.ts:26` passes a function).
		for (const file of GATED_MODULES) {
			const source = readSource(file);
			expect(source, file).toContain(".validator((input: unknown) =>");
			expect(source, file).not.toMatch(/\.validator\([a-zA-Z]+\)/);
		}
	});

	it("bounds every free-form field of the row patch at the zod layer", () => {
		// A schema private to a server-fn module is invisible to vitest (#519's
		// corollary), so this is the only thing that can hold the bound. `label`
		// and `detail` were unbounded strings feeding a code-point spread, and
		// the three marks were bare `z.number()` — a float reached an `integer`
		// column as a raw Postgres 500 where a 400 belongs.
		const source = readSource("src/server/meeting-agenda-edit.ts");
		const patch = source.slice(
			source.indexOf("const patchInput"),
			source.indexOf("const moveInput"),
		);
		expect(patch.length).toBeGreaterThan(0);
		for (const field of ["label", "detail", "roleKey", "repeatsRoleKey"]) {
			expect(patch, `${field} must carry a length bound`).toMatch(
				new RegExp(`${field}: z[\\s\\S]{0,120}?\\.max\\(MAX_TEMPLATE`),
			);
		}
		for (const field of ["minutes", "markGreen", "markYellow", "markRed"]) {
			expect(patch, `${field} must be an int in range`).toMatch(
				new RegExp(
					`${field}: z[\\s\\S]{0,160}?\\.int\\(\\)[\\s\\S]{0,160}?\\.max\\(MAX_BEAT_MINUTES\\)`,
				),
			);
		}
	});
});
