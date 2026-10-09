/**
 * Source guard: **nothing in shipped code reads or writes `guests.email` or
 * `guests.phone`** (#1125, ADR-0031).
 *
 * Since this change `schema.ts` does not declare the two columns at all: they
 * still exist in the database, dead, until #1126 drops them in SQL. So a Drizzle
 * reference no longer type-checks, and what this guard adds is raw SQL and an
 * `alias()`/`as` spelling that a cast could still get past.
 *
 * A guest's email and phone live on their Person (`people.email` / `people.phone`).
 * The two `guests` columns are kept for one release only so the old container,
 * still serving while a deploy swaps, never reads a column that was dropped; #1126
 * drops them. Until then they are dead: no reader and no writer. A reference that
 * crept back would read a value nothing updates any more (a stale address on a
 * card, in an export, in the minutes email recipient list), and nothing at runtime
 * would say so, because the column still exists and is simply never right.
 *
 * ## What it scans, and the comment decision
 *
 * Every non-test `.ts` / `.tsx` under `src/` and `scripts/`. It reads THROUGH `stripComments`:
 * several files that are not this change's to edit still MENTION the column in a
 * comment, and a prose mention is not a reference. That is the loosening a
 * "the offender list must be empty" guard normally refuses (see the header of
 * `src/test/guard-source.ts`), taken deliberately and with its cost named: the
 * stripper is lexical, so a `//` inside a string literal blanks the rest of that
 * line, and a reference written after one on the same line would be missed. The
 * raw-SQL arm below reads the SAME stripped text, so it has the same blind spot.
 *
 * ## The shapes
 *
 * - **A Drizzle reference**: `guests.email`, `schema.guests.email`, and the same
 *   through an aliased import (`import { guests as g }`) or an aliased table
 *   (`alias(guests, "held_guest")`).
 * - **Raw SQL naming the column**: `guests.email`, `"guests"."email"`,
 *   `guests."email"`, `"public"."guests"."email"`, likewise `phone`.
 *
 * ## What it cannot see
 *
 * Raw SQL that selects `email` from `guests` without qualifying it
 * (`select email from guests`) names the column nowhere in the shapes above. A
 * whole-row Drizzle read can no longer carry the columns (they are not declared),
 * so that old blind spot is closed by the schema, not by this scan.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "#/test/guard-source";

const SRC = join(import.meta.dirname, "..");
/** `scripts/` too: a one-off that updates the dead column is still a writer. */
const ROOTS = [SRC, join(SRC, "..", "scripts")];

/** Non-test `.ts`/`.tsx` sources under `src/`, comments blanked, keyed relative to it. */
function sources(): Array<{ key: string; text: string }> {
	const out: Array<{ key: string; text: string }> = [];
	const walk = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return; // `scripts/` may not exist in every checkout shape
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
			if (entry.includes(".test.") || entry.endsWith(".d.ts")) continue;
			out.push({
				key: relative(SRC, full),
				text: stripComments(readFileSync(full, "utf8")),
			});
		}
	};
	for (const root of ROOTS) walk(root);
	return out;
}

/** The local names `guests` goes by in `src`: itself, an `as` import, an `alias()` table. */
function guestNames(src: string): string[] {
	const names = new Set(["guests"]);
	for (const m of src.matchAll(/\bguests\s+as\s+(\w+)/g)) {
		if (m[1]) names.add(m[1]);
	}
	for (const m of src.matchAll(
		/\b(\w+)\s*=\s*alias\(\s*(?:\w+\.)?guests\s*,/g,
	)) {
		if (m[1]) names.add(m[1]);
	}
	return [...names];
}

/** The references to `guests.email` / `guests.phone` in `source`, by shape. */
function contactColumnReferences(source: string): string[] {
	const hits: string[] = [];
	for (const name of guestNames(source)) {
		// `guests.email`, `schema.guests.email`, raw `guests."email"`, and the
		// quoted-table forms `"guests"."email"` / `"public"."guests"."email"`. Not
		// preceded by a word character, so `notguests.email` is somebody else's.
		const table = name === "guests" ? `(?:"guests"|guests)` : name;
		const re = new RegExp(
			`(?<![\\w])${table}\\s*\\.\\s*"?(?:email|phone)"?(?![\\w"])`,
			"g",
		);
		for (const m of source.matchAll(re)) hits.push(m[0]);
	}
	return hits;
}

describe("the matcher itself", () => {
	const hits = (src: string) => contactColumnReferences(src).length;

	it("flags a Drizzle reference to either column", () => {
		expect(hits("const x = { email: guests.email };")).toBe(1);
		expect(hits("select({ phone: guests.phone }).from(guests)")).toBe(1);
	});

	it("flags a namespaced reference", () => {
		expect(hits("select({ e: schema.guests.email })")).toBe(1);
	});

	it("flags a reference through an aliased import or an aliased table", () => {
		expect(
			hits(`import { guests as g } from "#/db/schema";\nconst e = g.email;`),
		).toBe(1);
		expect(
			hits(
				`const heldGuest = alias(guests, "held_guest");\nconst p = heldGuest.phone;`,
			),
		).toBe(1);
	});

	it("flags raw SQL however it quotes the names", () => {
		expect(hits("sql`select guests.email from guests`")).toBe(1);
		expect(hits(`sql\`select "guests"."email" from "guests"\``)).toBe(1);
		expect(hits(`sql\`select guests."phone" from guests\``)).toBe(1);
		expect(hits(`sql\`select "public"."guests"."phone" from guests\``)).toBe(1);
	});

	it("does NOT flag the Person's columns, or other guest columns", () => {
		expect(hits("const e = people.email; const p = people.phone;")).toBe(0);
		expect(hits("const n = guests.name; const s = guests.stage;")).toBe(0);
		expect(hits("const e = guests.emailVerified;")).toBe(0);
		expect(hits("const e = noguests.email;")).toBe(0);
	});

	it("does NOT flag a comment, which the scan blanks before matching", () => {
		const text = stripComments(
			"// the dead `guests.email` column\nconst x = 1; /* guests.phone */",
		);
		expect(hits(text)).toBe(0);
	});
});

describe("guests.email and guests.phone have no readers and no writers", () => {
	it("scans a non-trivial number of files", () => {
		// A scan that silently matched nothing would make the assertion below vacuous.
		expect(sources().length).toBeGreaterThan(100);
	});

	it("names neither column anywhere in shipped code", () => {
		const offenders: string[] = [];
		for (const { key, text } of sources()) {
			for (const hit of contactColumnReferences(text)) {
				offenders.push(`${key}: ${hit}`);
			}
		}
		expect(
			offenders,
			`A guest's email and phone are their Person's (#1125): read and write ` +
				`people.email / people.phone through guests.person_id. The guests ` +
				`columns are dead until #1126 drops them.`,
		).toEqual([]);
	});
});
