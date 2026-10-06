/**
 * `people.preferred_contact` is read only through `effectivePreferredContact`
 * (#1093), and the has-a-digit test it shares with the roster has one copy.
 *
 * The column can hold a STALE value — SMS chosen, then the phone removed — and
 * that is kept on purpose so restoring the phone brings it back. A surface that
 * reads the column raw shows "prefers SMS" for a member with no phone, and
 * nothing else fails: the value is a valid enum, typecheck is happy, and every
 * existing test's fixture has a phone. So the set of files naming the column is
 * pinned here, and each reader in it must resolve through the helper.
 *
 * What this does NOT see: a `select()` of the whole `people` row, which carries
 * the column without naming it. No such reader returns it to a client today;
 * the behavioural gates are `member-preferred-contact.integration.test.ts` and
 * `find-people-preferred-contact.integration.test.ts`.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

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
const ALLOWED: Record<string, "declares" | "reads" | "writes"> = {
	"db/schema.ts": "declares",
	"server/contact-preference-logic.ts": "reads",
	"server/club-logic.ts": "reads",
	"server/members-logic.ts": "writes",
};

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

	it("every file that reads or logs it resolves through effectivePreferredContact", () => {
		for (const [file, role] of Object.entries(ALLOWED)) {
			if (role === "declares") continue;
			const src = readSource(join(SRC, file));
			expect(src, file).toMatch(/\beffectivePreferredContact\(/);
		}
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
});
