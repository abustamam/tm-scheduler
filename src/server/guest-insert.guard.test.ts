/**
 * Source guard: **a `guests` row is inserted in exactly one place,
 * `createGuestRecord`** (#1124, ADR-0031).
 *
 * A guest is a Person, so the row that records them carries `person_id`, and the
 * Person has to exist first. `createGuestRecord` mints both in one transaction,
 * which is what keeps a failed guest insert from leaving an orphan Person behind
 * and a successful one from leaving a guest with no Person. A sixth hand-written
 * `.insert(guests)` is the way the column goes back to being null on new rows,
 * and nothing at runtime would say so: the column is nullable until #1125.
 *
 * The scan covers every non-test source under `src/` and `scripts/`. Test files
 * and `src/test/` are exempt on purpose: a fixture may insert a guest directly,
 * including one with a null `person_id`, which is how the old container's rows
 * and `ensureGuestPerson`'s repair are exercised.
 *
 * It is matched by SHAPE, like `person-email-writers.guard.test.ts`, because the
 * obvious spellings are not the only ones: the table through an aliased or
 * namespaced import, and raw SQL.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const ROOTS = [SRC, join(SRC, "..", "scripts")];

/** The one file, and the one function in it, that may insert a guest. */
const WRITER_FILE = "server/guests-logic.ts";
const WRITER_FN = "createGuestRecord";

/** Non-test `.ts`/`.tsx` sources, keyed relative to `src/`. */
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
				// Fixtures live here; the scan is for shipped code.
				if (full === join(SRC, "test")) continue;
				walk(full);
				continue;
			}
			if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
			if (entry.includes(".test.") || entry.endsWith(".d.ts")) continue;
			out.push({ key: relative(SRC, full), text: readFileSync(full, "utf8") });
		}
	};
	for (const root of ROOTS) walk(root);
	return out;
}

/** The local binding(s) for `#/db/schema`'s `guests`, so an alias cannot hide it. */
function guestsBindings(src: string): string[] {
	const names = ["guests"];
	const alias = /import\s*\{[^}]*\bguests\s+as\s+(\w+)/.exec(src);
	if (alias?.[1]) names.push(alias[1]);
	return names;
}

/** Insert sites for the `guests` table in `source`, matched by shape. */
function guestInsertSites(source: string): string[] {
	const hits: string[] = [];
	// RAW, comments and all, per the header of `src/test/guard-source.ts`: this is
	// an "the offender list must be empty" guard, and for that form stripping
	// comments only LOOSENS it. A lexical stripper that does not track strings
	// reads the `//` in `"http://x"` as a comment and blanks the rest of the line,
	// which is how an `.insert(guests)` written after a URL on one line would
	// vanish. A comment that names the call is a false failure a human sees at
	// once; a hidden insert is a false pass nobody sees.
	const src = source;
	for (const name of guestsBindings(source)) {
		// `guests`, `schema.guests`, `guests as any`: whatever is inside the call.
		const re = new RegExp(
			`\\.insert\\(\\s*(?:\\w+\\.)?${name}(?:\\s+as\\s+\\w+)?\\s*\\)`,
			"g",
		);
		for (const _ of src.matchAll(re)) hits.push("insert(guests)");
	}
	// Raw SQL, by its text, wherever it is written.
	for (const m of src.matchAll(
		/`([^`]*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g,
	)) {
		const text = m[1] ?? m[2] ?? m[3] ?? "";
		if (/insert\s+into\s+(?:"?public"?\.)?"?guests"?(?![\w])/i.test(text)) {
			hits.push("raw SQL insert into guests");
		}
	}
	return hits;
}

describe("the matcher itself", () => {
	const flags = (src: string) => guestInsertSites(src).length;

	it("flags an insert of the table", () => {
		expect(flags("await tx.insert(guests).values({ clubId, name });")).toBe(1);
	});

	it("flags it however it is spaced, cast or qualified", () => {
		expect(flags("await tx.insert( guests ).values(row);")).toBe(1);
		expect(flags("await tx.insert(schema.guests).values(row);")).toBe(1);
		expect(flags("await tx.insert(guests as any).values(row);")).toBe(1);
		expect(
			flags(
				`import { guests as g } from "#/db/schema";\nawait tx.insert(g).values(row);`,
			),
		).toBe(1);
	});

	it("flags raw SQL however it is written", () => {
		expect(
			flags("await db.execute(sql`insert into guests (name) values ('x')`);"),
		).toBe(1);
		expect(
			flags('await db.$client.query("INSERT INTO public.guests (name) …");'),
		).toBe(1);
	});

	it("does NOT flag a read, an update, or a sibling table", () => {
		expect(flags("await tx.select().from(guests);")).toBe(0);
		expect(flags("await tx.update(guests).set({ stage });")).toBe(0);
		expect(flags("await tx.insert(guestInvites).values(row);")).toBe(0);
		expect(flags("await tx.insert(meetingBallotGuests).values(row);")).toBe(0);
		expect(flags("await tx.insert(people).values({ name });")).toBe(0);
	});

	it("reads source RAW: a comment that names the call is flagged, and a // inside a string hides nothing", () => {
		// The false failure the raw read accepts: prose naming the call.
		expect(flags("// never .insert(guests) here\nconst x = 1;")).toBe(1);
		expect(flags("/* .insert(guests) */\nconst x = 1;")).toBe(1);
		// The false PASS a comment-stripping read would have produced: the `//` in
		// a URL opens a "comment" that swallows the insert after it on the line.
		expect(
			flags(
				'const url = "http://example.test"; await tx.insert(guests).values(row);',
			),
		).toBe(1);
	});
});

describe("guest rows are inserted only by createGuestRecord (#1124)", () => {
	it("scans a non-trivial number of files", () => {
		// A scan that silently matched nothing would make every assertion below
		// vacuous, which is how an enumeration stops being one.
		expect(sources().length).toBeGreaterThan(50);
	});

	it("no non-test source inserts a guest outside the writer file", () => {
		const offenders: string[] = [];
		for (const { key, text } of sources()) {
			if (key === WRITER_FILE) continue;
			for (const hit of guestInsertSites(text))
				offenders.push(`${key}: ${hit}`);
		}
		expect(
			offenders,
			`A guests row must be created through createGuestRecord (${WRITER_FILE}), ` +
				`which mints the guest's Person in the same transaction (#1124, ADR-0031).`,
		).toEqual([]);
	});

	it("the writer file has exactly one insert, and it is inside createGuestRecord", () => {
		const file = sources().find((s) => s.key === WRITER_FILE);
		expect(file, `${WRITER_FILE} is gone or moved`).toBeDefined();
		const text = file?.text ?? "";
		expect(guestInsertSites(text)).toHaveLength(1);

		const start = text.search(
			new RegExp(`export async function ${WRITER_FN}\\b`),
		);
		expect(start, `${WRITER_FN} is gone or renamed`).toBeGreaterThanOrEqual(0);
		// A top-level function ends at the first closing brace in column 0. An
		// `indexOf` miss is -1, and `slice(start, -1)` is then nearly the whole file
		// rather than the function, which would let a stray insert beside it pass.
		const end = text.indexOf("\n}\n", start);
		expect(end, `${WRITER_FN}'s closing brace was not found`).toBeGreaterThan(
			start,
		);
		const body = text.slice(start, end);
		expect(body, "the slice is not the function").toMatch(
			/conn\.transaction\(/,
		);
		expect(
			guestInsertSites(body),
			`the guests insert in ${WRITER_FILE} is not inside ${WRITER_FN}`,
		).toHaveLength(1);
	});
});
