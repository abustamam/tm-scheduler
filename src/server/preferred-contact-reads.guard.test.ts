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
 * So, per FUNCTION rather than per file (#1093 review: a file-level "calls the
 * helper somewhere" passed with one reader resolving and its neighbour not):
 * every select of the column must alias it (`stored: people.preferredContact`),
 * and inside the function that selects it, every other mention of that alias
 * must be either a destructuring binding or an argument to
 * `effectivePreferredContact(`. A destructured binding is itself a mention of
 * the alias, so it is held to the same rule wherever it is used.
 *
 * What this does NOT see: a `select()` of the whole `people` row, which carries
 * the column without naming it. The merge reconcile does that and only WRITES
 * the value back (`people-merge-logic.ts`); no such reader returns it to a
 * client today. The behavioural gates are the `*preferred-contact*`
 * integration suites.
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
 * Top-level functions of a comment-stripped source, as `[name, body]`. A body
 * runs from its declaration to the next top-level declaration, which is
 * enough here: the checks below only look INSIDE a function for mentions of
 * an alias it selected, and the next declaration's text is never one of them.
 */
function topLevelFunctions(src: string): [string, string][] {
	const decl = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm;
	const starts = [...src.matchAll(decl)].map((m) => ({
		name: m[1] ?? "",
		at: m.index ?? 0,
	}));
	return starts.map((s, i) => [
		s.name,
		src.slice(s.at, starts[i + 1]?.at ?? src.length),
	]);
}

/** Every mention of `alias` in `body` that is NOT allowed by the rule. */
function rawReads(body: string, alias: string): string[] {
	const out: string[] = [];
	const mention = new RegExp(`\\b${alias}\\b`, "g");
	for (const m of body.matchAll(mention)) {
		const at = m.index ?? 0;
		const before = body.slice(Math.max(0, at - 60), at);
		const after = body.slice(at + alias.length, at + alias.length + 40);
		const isSelectKey = /^\s*:\s*people\.preferredContact\b/.test(after);
		const isArgument = /effectivePreferredContact\(\s*(?:\w+\.)?$/.test(before);
		const isDestructure =
			/[{,]\s*$/.test(before) && /^\s*,\s*\.\.\.\w+\s*}/.test(after);
		if (!isSelectKey && !isArgument && !isDestructure) {
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

	it("every select of the column is aliased and resolved in the same function", () => {
		let selects = 0;
		for (const [file, role] of Object.entries(ALLOWED)) {
			if (role !== "reads") continue;
			const src = readSource(join(SRC, file));
			// Every mention of the column in a reader is an aliased select.
			const bare = [...src.matchAll(/people\.preferredContact\b/g)].length;
			const aliased = [
				...src.matchAll(/\b(\w+)\s*:\s*people\.preferredContact\b/g),
			];
			expect(aliased.length, `${file}: unaliased read`).toBe(bare);
			for (const [fn, body] of topLevelFunctions(src)) {
				for (const m of body.matchAll(
					/\b(\w+)\s*:\s*people\.preferredContact\b/g,
				)) {
					const alias = m[1] ?? "";
					selects++;
					expect(
						body,
						`${file} ${fn}: ${alias} never reaches effectivePreferredContact`,
					).toMatch(
						new RegExp(
							`effectivePreferredContact\\(\\s*(?:\\w+\\.)?${alias}\\b`,
						),
					);
					expect(rawReads(body, alias), `${file} ${fn}`).toEqual([]);
				}
			}
		}
		// loadMyContactPreference, loadClubContactPreferences, loadClubMembers,
		// loadMemberProfile and applyMemberEdit's locked read. A slicing bug
		// that found none would pass every check above.
		expect(selects).toBe(5);
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
