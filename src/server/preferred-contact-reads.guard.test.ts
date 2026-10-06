/**
 * `people.preferred_contact` is read only through `effectivePreferredContact`
 * (#1093), and the has-a-digit test it shares with the roster has one copy.
 *
 * The column can hold a STALE value — SMS chosen, then the phone removed — and
 * that is kept on purpose so restoring the phone brings it back. A surface that
 * reads the column raw shows "prefers SMS" for a member with no phone, and
 * nothing else fails: the value is a valid enum, typecheck is happy, and every
 * existing test's fixture has a phone.
 *
 * What this guard checks, in the files allowed to name the column:
 *  - every `people.preferredContact` in them is a select key with an alias
 *    (`stored: people.preferredContact`);
 *  - each file is cut into top-level DECLARATIONS (`function`, `const`, `let`,
 *    `var`, `class`, optionally `export`/`async`), and every aliased select
 *    falls inside one of them — the count inside slices must equal the count
 *    in the file, so nothing sits outside a slice;
 *  - inside the declaration that selects it, the alias is passed to
 *    `effectivePreferredContact(` at least once, and every other mention of
 *    the alias as a word is one of: the select key itself; an argument to
 *    `effectivePreferredContact(` (bare or as `x.alias`); or a name bound by a
 *    real destructuring — `const|let|var { … } =`, or an arrow parameter
 *    `({ … }) =>`. An object LITERAL such as `{ alias, ...rest }` is not one.
 *
 * What it does NOT see, so the integration suites (`*preferred-contact*`) are
 * the behavioural gate for these:
 *  - a whole selected row spread or returned (`{ ...row }`, `return row`), or
 *    the alias read by a non-identifier route (`row["stored"]`): the value
 *    leaves without its alias being mentioned;
 *  - a destructured binding RENAMED (`{ stored: s }`) and then used as `s`;
 *  - a `select()` of the whole `people` row, which carries the column without
 *    naming it. The merge reconcile does that and only WRITES the value back
 *    (`people-merge-logic.ts`); no such reader returns it to a client today.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readSource } from "#/test/guard-source";

vi.mock("#/db", () => ({ db: {} }));

const SRC = resolve(__dirname, "..");

/** Every non-test source file under `src/`. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
		else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
			out.push(full);
	}
	return out;
}

const COLUMN = /people\.preferredContact\b|preferred_contact/;

/** Each file allowed to name the column, and what it does with it. */
const ALLOWED: Record<string, "declares" | "reads"> = {
	"db/schema.ts": "declares",
	"server/contact-preference-logic.ts": "reads",
	"server/club-logic.ts": "reads",
	// The admin writer's locked read, logged as the effective value.
	"server/members-logic.ts": "reads",
};

/**
 * Top-level declarations of a comment-stripped source, as `[name, body]`. A
 * body runs from its declaration to the next top-level declaration (or EOF),
 * so every byte after the import preamble belongs to exactly one slice.
 */
const DECLARATION =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+(\w+)/gm;

function topLevelDeclarations(src: string): [string, string][] {
	const starts = [...src.matchAll(DECLARATION)].map((m) => ({
		name: m[1] ?? "",
		at: m.index ?? 0,
	}));
	return starts.map((s, i) => [
		s.name,
		src.slice(s.at, starts[i + 1]?.at ?? src.length),
	]);
}

const ALIASED_SELECT = /\b(\w+)\s*:\s*people\.preferredContact\b/g;

/** Every mention of `alias` in `body` that is NOT allowed by the rule. */
function rawReads(body: string, alias: string): string[] {
	const out: string[] = [];
	const mention = new RegExp(`\\b${alias}\\b`, "g");
	for (const m of body.matchAll(mention)) {
		const at = m.index ?? 0;
		const before = body.slice(Math.max(0, at - 80), at);
		const after = body.slice(at + alias.length, at + alias.length + 80);
		const isSelectKey = /^\s*:\s*people\.preferredContact\b/.test(after);
		const isArgument = /effectivePreferredContact\(\s*(?:\w+\.)?$/.test(before);
		// A real destructuring BINDING, never an object literal: the pattern's
		// braces must open after `const|let|var` and close into `=`, or open an
		// arrow's parameter list and close into `) =>`.
		const isDeclDestructure =
			/\b(?:const|let|var)\s*\{[^{}]*$/.test(before) &&
			/^[^{}]*\}\s*=(?!=|>)/.test(after);
		const isParamDestructure =
			/\(\s*\{[^{}]*$/.test(before) && /^[^{}]*\}\s*\)\s*=>/.test(after);
		if (
			!isSelectKey &&
			!isArgument &&
			!isDeclDestructure &&
			!isParamDestructure
		) {
			out.push(`${before.slice(-30)}⟨${alias}⟩${after.slice(0, 20)}`);
		}
	}
	return out;
}

describe("preferred contact reads (#1093)", () => {
	const files = sourceFiles(SRC);

	it("only the known files name the column", () => {
		expect(files.length).toBeGreaterThan(100);
		const naming = files
			.filter((f) => COLUMN.test(readSource(f)))
			.map((f) => relative(SRC, f))
			.sort();
		expect(naming).toEqual(Object.keys(ALLOWED).sort());
	});

	it("every select of the column is aliased and resolved in the same declaration", () => {
		let selects = 0;
		for (const [file, role] of Object.entries(ALLOWED)) {
			if (role !== "reads") continue;
			const src = readSource(join(SRC, file));
			const bare = [...src.matchAll(/people\.preferredContact\b/g)].length;
			const aliased = [...src.matchAll(ALIASED_SELECT)].length;
			expect(aliased, `${file}: unaliased read`).toBe(bare);
			let inSlices = 0;
			for (const [decl, body] of topLevelDeclarations(src)) {
				for (const m of body.matchAll(ALIASED_SELECT)) {
					const alias = m[1] ?? "";
					inSlices++;
					expect(
						body,
						`${file} ${decl}: ${alias} never reaches effectivePreferredContact`,
					).toMatch(
						new RegExp(
							`effectivePreferredContact\\(\\s*(?:\\w+\\.)?${alias}\\b`,
						),
					);
					expect(rawReads(body, alias), `${file} ${decl}`).toEqual([]);
				}
			}
			// Complete enrollment: no aliased select outside every slice.
			expect(inSlices, `${file}: a select sits outside any declaration`).toBe(
				aliased,
			);
			selects += inSlices;
		}
		// loadMyContactPreference, loadClubContactPreferences, loadClubMembers,
		// loadMemberProfile and applyMemberEdit's locked read today. A floor, not
		// the enrollment proof (that is the per-file equality above): a slicing
		// bug that found none would pass every other check.
		expect(selects).toBeGreaterThanOrEqual(5);
	});

	it("rawReads tells a destructuring binding from an object literal", () => {
		const ok = [
			"const { stored, ...rest } = row; f(effectivePreferredContact(stored, rest));",
			"rows.map(({ stored, ...r }) => effectivePreferredContact(stored, r));",
		];
		for (const body of ok) expect(rawReads(body, "stored"), body).toEqual([]);
		const bad = [
			"return { stored, ...rest };",
			"return ({ stored, ...rest });",
			"const x = { stored, ...rest };",
			"return { preferredContact: row.stored };",
		];
		for (const body of bad)
			expect(rawReads(body, "stored").length, body).toBeGreaterThan(0);
	});

	it("hasDialablePhone is declared once, in the shared module, and the roster imports it", () => {
		const declaring = files
			.filter((f) =>
				/\bfunction\s+hasDialablePhone\b|\bhasDialablePhone\s*=/.test(
					readSource(f),
				),
			)
			.map((f) => relative(SRC, f));
		expect(declaring).toEqual(["lib/preferred-contact.ts"]);
		const roster = readSource(join(SRC, "routes/_authed/roster.tsx"));
		expect(roster).toMatch(
			/import\s*\{[^}]*\bhasDialablePhone\b[^}]*\}\s*from\s*"#\/lib\/preferred-contact"/,
		);
	});

	it("the pg enum is built from CONTACT_METHODS, which imports nothing", async () => {
		const { CONTACT_METHODS } = await import("#/lib/preferred-contact");
		const { contactMethodEnum, people } = await import("#/db/schema");
		expect([...contactMethodEnum.enumValues]).toEqual([...CONTACT_METHODS]);
		expect(people.preferredContact.enumValues).toEqual([...CONTACT_METHODS]);
		// schema.ts is read by drizzle-kit and bundled into the standalone
		// runners, so a module it value-imports must pull in no graph.
		const lib = readSource(join(SRC, "lib/preferred-contact.ts"));
		expect(lib).not.toMatch(/^\s*import\b/m);
		expect(readSource(join(SRC, "db/schema.ts"))).toMatch(
			/pgEnum\("contact_method",\s*CONTACT_METHODS\)/,
		);
	});
});
