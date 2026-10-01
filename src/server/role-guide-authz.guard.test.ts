/**
 * Who may write a role's Before/During guide (#933).
 *
 * Two kinds of writer exist, and this file lists both by name:
 *
 * 1. EDITING: `applyRoleDefinitionUpdate`, reached only through
 *    `updateClubRole`, which gates on `requireClubRole(…, ["admin"])` before it
 *    writes — the same gate as `description`.
 * 2. SEEDING: inserts that copy a standard role out of `ROLE_TEMPLATE`
 *    (onboarding a new club, the dev seed, the agenda importer's Vote Counter
 *    backfill). They write the template's default text into a club's own new
 *    rows and never touch an existing row.
 *
 * A `createServerFn` handler cannot be invoked from vitest, so these are
 * source guards. The write sweep reads every non-test module under the
 * writing layers, finds each `.set(` / `.values(` call and `set:` object, and
 * fails on any that names a guide column (or spreads the patch helper, or a
 * template row) from a file/kind pair not on the allowlist below.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const FNS = readSource("src/server/role-definitions.ts");
const LOGIC = readSource("src/server/role-definitions-logic.ts");

/** The layers that write to the database. */
const WRITING_ROOTS = ["src/server", "src/db", "src/routes", "scripts"];

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
		else if (
			/\.(ts|tsx)$/.test(name) &&
			!/\.test\.tsx?$/.test(name) &&
			!name.endsWith(".gen.ts")
		)
			out.push(path);
	}
	return out;
}

/** The balanced `(…)` or `{…}` starting at `open`. */
function balanced(src: string, open: number): string {
	const openCh = src[open];
	const closeCh = openCh === "(" ? ")" : "}";
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === openCh) depth++;
		else if (src[i] === closeCh) {
			depth--;
			if (depth === 0) return src.slice(open, i + 1);
		}
	}
	return src.slice(open);
}

/** What a write names that puts guide text in a row. */
const GUIDE_WRITE =
	/\bbeforeNotes\b|\bduringNotes\b|before_notes|during_notes|guideNotesPatch\(|ROLE_TEMPLATE|roleSeed\(/;

type Write = { file: string; kind: "set" | "values"; arg: string };

function guideWrites(): Write[] {
	const writes: Write[] = [];
	for (const root of WRITING_ROOTS) {
		for (const file of sourceFiles(root)) {
			const src = readSource(file);
			for (const m of src.matchAll(/\.(set|values)\(|\bset:\s*\{/g)) {
				const open = (m.index ?? 0) + m[0].length - 1;
				const arg = balanced(src, open);
				const kind = m[0].includes("values") ? "values" : "set";
				if (GUIDE_WRITE.test(arg)) writes.push({ file, kind, arg });
			}
		}
	}
	return writes;
}

/**
 * Every place allowed to write guide text. `file` + `kind` + a fragment the
 * argument must contain, so a second write in an allowed file is still caught.
 */
const ALLOWED: { file: string; kind: Write["kind"]; contains: string }[] = [
	// Editing — admin-gated through `updateClubRole` (asserted below).
	{
		file: "src/server/role-definitions-logic.ts",
		kind: "set",
		contains: "guideNotesPatch(input)",
	},
	// Seeding — a new club's standard roles, copied from ROLE_TEMPLATE.
	{
		file: "src/server/onboarding-logic.ts",
		kind: "values",
		contains: "ROLE_TEMPLATE",
	},
	{ file: "src/db/seed.ts", kind: "values", contains: "ROLE_TEMPLATE" },
	// Seeding — a STANDARD role minted back into a club that lacks it
	// (`materializeTemplateRoles`, #910): the stock guide, by key.
	{
		file: "src/server/meeting-templates-logic.ts",
		kind: "values",
		contains: "beforeNotes: stock?.beforeNotes ?? null",
	},
];

/**
 * Template rows can also reach an insert through a variable, which the sweep
 * above cannot follow. So every module that reads the template's rows at all
 * is listed too; a new one fails here until someone decides it may.
 */
const TEMPLATE_READERS = new Set([
	"src/lib/role-template.ts", // the definition
	"src/server/onboarding-logic.ts", // seeding: new club
	"src/db/seed.ts", // seeding: dev data
	"scripts/import-agendas-logic.ts", // seeding: Vote Counter backfill
	"src/server/meeting-templates-logic.ts", // seeding: a minted standard role (#910)
]);

describe("role guide writers (#933)", () => {
	it("updateClubRole requires an admin before writing", () => {
		const body = serverFnBody(FNS, "updateClubRole");
		const gate = body.indexOf(
			'requireClubRole(currentUser.id, data.clubId, ["admin"])',
		);
		const write = body.indexOf("applyRoleDefinitionUpdate(data)");
		expect(gate).toBeGreaterThan(-1);
		expect(write).toBeGreaterThan(gate);
	});

	it("writes guide text only from the update path and the template-seeding inserts", () => {
		const writes = guideWrites();
		// Non-empty: a sweep that finds nothing proves nothing.
		expect(writes.length).toBeGreaterThanOrEqual(ALLOWED.length);
		const stray = writes.filter(
			(w) =>
				!ALLOWED.some(
					(a) =>
						a.file === w.file &&
						a.kind === w.kind &&
						w.arg.includes(a.contains),
				),
		);
		expect(
			stray.map((w) => `${w.file}: .${w.kind}${w.arg.slice(0, 80)}`),
		).toEqual([]);
		// And every allowed writer is still there, so a stale entry is noticed.
		for (const a of ALLOWED) {
			expect(
				writes.some(
					(w) =>
						w.file === a.file &&
						w.kind === a.kind &&
						w.arg.includes(a.contains),
				),
				`${a.file} .${a.kind}(… ${a.contains} …)`,
			).toBe(true);
		}
	});

	it("reads template rows only in the listed seeding modules", () => {
		const readers = WRITING_ROOTS.concat("src/lib")
			.flatMap(sourceFiles)
			.filter((f) => /\bROLE_TEMPLATE\b|\broleSeed\(/.test(readSource(f)))
			.filter((f) => !TEMPLATE_READERS.has(f));
		expect(readers).toEqual([]);
	});

	it("custom roles start blank: create takes no guide fields", () => {
		const create = LOGIC.slice(
			LOGIC.indexOf("export const createRoleSchema"),
			LOGIC.indexOf("export type CreateRoleInput"),
		);
		expect(create.length).toBeGreaterThan(0);
		expect(create).not.toContain("beforeNotes");
		expect(create).not.toContain("duringNotes");
	});
});
