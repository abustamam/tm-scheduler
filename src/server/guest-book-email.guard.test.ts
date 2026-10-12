/**
 * Source guard: **an address typed without an officer's session
 * (`guests.book_email`) never reaches a Person, and is written only where the
 * rule allows** (#1157, ADR-0029 amendment).
 *
 * The public guest book has no session. What it types is a club's unconfirmed
 * note on its own guest row, and it becomes a Person fact (`people.email`, the key
 * a magic-link sign-in binds on) only when an officer confirms it, at convert or in
 * the Edit guest dialog. Three things hold that, and each is a way the rule was
 * lost in the shape it replaced:
 *
 * 1. NO STATEMENT THAT WRITES `people` NAMES THE NOTE. An `update(people)` or
 *    `insert(people)` (or the raw SQL for either) whose text reaches `bookEmail` /
 *    `book_email` is the whole bug.
 * 2. THE NOTE IS WRITTEN IN FIVE PLACES AND NO OTHER: the capture's create and its
 *    fill-only fill write the typed address; the officer's two writes (convert,
 *    Edit guest) clear it with NULL; an unlink restores a recorded address as a
 *    note. Every `bookEmail` key counts, whatever its value; a sixth writer is a
 *    decision, so it fails here until it is named.
 * 3. THE CONVERT NEVER READS IT. Its identity (`convertEmail`, `convertIdentity`,
 *    `matchClubMemberPerson`, `guestOwnContact`) is the vouched address or the
 *    officer's confirmation; the one mention of the column in
 *    `applyConvertGuestToMember` is the clear.
 *
 * The scan is over `src/` and `scripts/` non-test source, comments stripped. It
 * is a source test, so it pins SHAPE; the behaviour is in the integration suites
 * (`guest-pipeline.integration.test.ts`, `guest-convert-email.integration.test.ts`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
const ROOTS = [SRC, join(SRC, "..", "scripts")];

function sourceFiles(): Array<{ file: string; text: string }> {
	const out: Array<{ file: string; text: string }> = [];
	const walk = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			if (name === "node_modules" || name.startsWith(".")) continue;
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
			out.push({
				file: relative(join(SRC, ".."), full),
				text: readFileSync(full, "utf8"),
			});
		}
	};
	for (const root of ROOTS) walk(root);
	return out;
}

/**
 * Comments out, string and template literals kept. A regex pass over `/* ... *\/`
 * eats from a glob such as `src/**\/x` inside a string to the next real comment
 * end, which would hide real source from this scan; so this walks the text.
 */
function withoutComments(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i] as string;
		const next = src[i + 1];
		if (c === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
		} else if (c === "/" && next === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end === -1 ? src.length : end + 2;
			out += " ";
		} else if (c === '"' || c === "'" || c === "`") {
			let j = i + 1;
			while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
			out += src.slice(i, j + 1);
			i = j + 1;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

const NOTE = /\bbookEmail\b|\bbook_email\b/;

/** The text of every statement that writes `people`: from the verb to the next `;`. */
function peopleWriteStatements(src: string): string[] {
	const out: string[] = [];
	const patterns = [
		/\.(?:update|insert)\(\s*people\s*\)/g,
		/\bupdate\s+"?people"?\b/gi,
		/\binsert\s+into\s+"?people"?\b/gi,
	];
	for (const re of patterns) {
		for (const m of src.matchAll(re)) {
			const end = src.indexOf(";", m.index);
			out.push(src.slice(m.index, end === -1 ? undefined : end));
		}
	}
	return out;
}

/** Calls whose argument is a write: a key inside any of them is never a read. */
const WRITE_CALLS = new Set([
	"set",
	"values",
	"update",
	"insert",
	"onConflictDoUpdate",
	"createGuestRecord",
]);

/**
 * Every place the source NAMES the note as an object key (`bookEmail: v`, the
 * shorthand `{ bookEmail }`, or a quoted `"bookEmail": v`), whatever the value is,
 * with the top-level function it sits in and the calls it is nested inside. A
 * value-shaped exemption would let `{ bookEmail: other.bookEmail }` or
 * `createGuestRecord(tx, { bookEmail: input.bookEmail })` through, so a key is a
 * write unless it is one of the shapes that cannot write: the column itself
 * (`guests.bookEmail`), a row mapper's copy (`r.bookEmail`) or the schema's column
 * declaration, each outside every write call. Components (`.tsx`) are not
 * scanned for writes: they reach the database only through a server function,
 * whose schema is what this guard reads.
 */
function noteKeys(
	src: string,
): Array<{ fn: string; value: string; calls: string[]; read: boolean }> {
	const out: Array<{
		fn: string;
		value: string;
		calls: string[];
		read: boolean;
	}> = [];
	// Open brackets, each with the callee name for a `(`; strings and templates
	// are skipped so a bracket inside one cannot unbalance the stack.
	const stack: string[] = [];
	let fn = "(top level)";
	let i = 0;
	while (i < src.length) {
		const c = src[i] as string;
		if (c === '"' || c === "'" || c === "`") {
			let j = i + 1;
			while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
			i = j + 1;
			continue;
		}
		if (c === "(") {
			const callee = /(\w+)\s*$/.exec(src.slice(Math.max(0, i - 60), i));
			stack.push(callee?.[1] ?? "");
		} else if (c === "{" || c === "[") {
			stack.push("");
		} else if (c === ")" || c === "}" || c === "]") {
			stack.pop();
		} else if (c === "\n") {
			const decl = /^(?:export )?(?:async )?function (\w+)/.exec(
				src.slice(i + 1, i + 80),
			);
			if (decl) fn = decl[1] as string;
		}
		if (c === "b" && src.startsWith("bookEmail", i) && src[i - 1] !== ".") {
			const after = /^bookEmail\s*(:|(?=[,}]))\s*([^,}\n]*)/.exec(
				src.slice(i, i + 200),
			);
			if (after) {
				const value =
					after[1] === ":" ? (after[2] ?? "").trim() : "(shorthand)";
				const calls = stack.filter(Boolean);
				const inWrite = calls.some((k) => WRITE_CALLS.has(k));
				out.push({
					fn,
					value,
					calls,
					// The column projected (`guests.bookEmail`), a row mapper's copy
					// (`r.bookEmail`) and the schema's own column declaration cannot
					// write unless they sit inside a write call.
					read:
						!inWrite &&
						(value === "guests.bookEmail" ||
							value === "r.bookEmail" ||
							/^text\(/.test(value)),
				});
			}
		}
		i++;
	}
	// A quoted key, `{ "bookEmail": v }`, is a write the scan above cannot see as
	// an identifier; count it too, with no call context.
	for (const m of src.matchAll(/["']bookEmail["']\s*:\s*([^,}\n]*)/g)) {
		out.push({
			fn: "(quoted key)",
			value: m[1]?.trim() ?? "",
			calls: [],
			read: false,
		});
	}
	return out;
}

/** The sites that write the note: every key that is not a read shape. */
function noteWrites(src: string): Array<{ fn: string; value: string }> {
	return noteKeys(src)
		.filter((k) => !k.read)
		.map(({ fn, value }) => ({ fn, value }));
}

/** Text of a top-level function, from its `function` line to the closing `}`. */
function functionBody(source: string, fn: string): string {
	const start = new RegExp(
		`(?:^|\\n)(?:export )?(?:async )?function ${fn}\\b`,
	).exec(source);
	if (!start) return "";
	const end = source.indexOf("\n}\n", start.index + 1);
	return source.slice(start.index, end === -1 ? undefined : end + 3);
}

const files = sourceFiles().map((f) => ({
	...f,
	text: withoutComments(f.text),
}));
const pipeline = files.find(
	(f) => f.file === "src/server/guest-pipeline-logic.ts",
);

describe("guests.book_email never reaches a Person (#1157)", () => {
	it("scans real source", () => {
		// protects=the other tests in this file reading the real server source, not
		//   an empty or moved tree (a guard over zero files is always green);
		// fails_when=fewer than 200 source files are read, or
		//   guest-pipeline-logic.ts is not among them;
		// no_claim=anything about what the source says; the tests below do that.
		expect(files.length).toBeGreaterThan(200);
		expect(
			pipeline,
			"guest-pipeline-logic.ts moved or was renamed",
		).toBeTruthy();
	});

	it("no statement that writes `people` names the note", () => {
		// protects=the unconfirmed note staying off the Person (the sign-in key);
		// fails_when=any update/insert of `people` reaches bookEmail/book_email,
		//   in the builder or in raw SQL;
		// no_claim=a write reaching the Person through a variable built elsewhere is
		//   not seen here; the integration tests read the Person's email back.
		const offenders: string[] = [];
		for (const f of files) {
			for (const stmt of peopleWriteStatements(f.text)) {
				if (NOTE.test(stmt)) {
					offenders.push(
						`${f.file}: ${stmt.replace(/\s+/g, " ").slice(0, 120)}`,
					);
				}
			}
		}
		expect(offenders, "a people write reads the guest book's note").toEqual([]);
	});

	it("the note is written only by the capture (create, fill), the officer's two clears and the unlink restore", () => {
		// protects=a sixth writer of `book_email` not being added without a decision;
		// fails_when=a `bookEmail` key (any value, shorthand included) in a `.ts` file appears in a
		//   write position anywhere but captureInTransaction (create),
		//   fillBlankGuestContact (fill-only), applyUpdateGuest and
		//   applyConvertGuestToMember (both NULL) and applyUnlinkGuestFromMember
		//   (restore), or `book_email` appears in source outside the schema;
		// no_claim=that each write is correct (the integration tests do that); an
		//   object built elsewhere and spread into a write is not seen.
		const writes: string[] = [];
		for (const f of files.filter((x) => x.file.endsWith(".ts"))) {
			for (const w of noteWrites(f.text)) {
				writes.push(`${f.file} :: ${w.fn} :: ${w.value}`);
			}
		}
		expect(writes.sort()).toEqual(
			[
				"src/server/guest-pipeline-logic.ts :: applyConvertGuestToMember :: null",
				"src/server/guest-pipeline-logic.ts :: applyUpdateGuest :: null",
				"src/server/guest-pipeline-logic.ts :: captureInTransaction :: email",
				"src/server/guest-pipeline-logic.ts :: fillBlankGuestContact :: contact.email",
				"src/server/guest-pipeline-logic.ts :: applyUnlinkGuestFromMember :: recordedEmail",
			].sort(),
		);
		const rawColumn = files
			.filter((f) => /\bbook_email\b/.test(f.text))
			.map((f) => f.file);
		expect(rawColumn, "the raw column name belongs to the schema").toEqual([
			"src/db/schema.ts",
		]);
	});

	it("the convert never reads the note into the identity", () => {
		// protects=an address nobody vouched for becoming the new member's sign-in
		// key, or playing any part in which existing member a convert matches;
		// fails_when=bookEmail appears in the identity helpers, or anywhere in
		//   applyConvertGuestToMember but its one NULL clear;
		// no_claim=that the officer's confirmedEmail is handled right (the
		//   integration suite).
		const src = pipeline?.text ?? "";
		for (const fn of [
			"convertEmail",
			"convertIdentity",
			"matchClubMemberPerson",
			"guestOwnContact",
		]) {
			const body = functionBody(src, fn);
			expect(body, `${fn} is gone or renamed`).not.toBe("");
			expect(body, `${fn} reads the guest book's note`).not.toMatch(NOTE);
		}
		const convert = functionBody(src, "applyConvertGuestToMember");
		expect(convert, "applyConvertGuestToMember is gone").not.toBe("");
		expect(
			[...convert.matchAll(/\bbookEmail\b/g)],
			"the convert may mention the note once: the clear",
		).toHaveLength(1);
		expect(convert).toMatch(/\{\s*bookEmail:\s*null\s*\}/);
	});

	it("the matcher and the helpers are shown to catch what they claim to", () => {
		// protects=this guard being able to fail (a guard that only ever sees clean
		//   source cannot be trusted);
		// fails_when=a helper stops flagging the shape it exists for;
		// no_claim=anything about production source.
		expect(
			peopleWriteStatements(
				"await tx.update(people).set({ email: g.bookEmail }).where(x);",
			).some((s) => NOTE.test(s)),
		).toBe(true);
		expect(
			peopleWriteStatements(
				"await tx.execute(sql`update people set email = g.book_email`);",
			).some((s) => NOTE.test(s)),
		).toBe(true);
		expect(
			peopleWriteStatements("await tx.update(guests).set({ bookEmail: x });"),
		).toEqual([]);
		expect(
			noteWrites(
				"\nfunction a() { tx.set({ bookEmail: x }); r = { bookEmail: guests.bookEmail, y: 1 }; }",
			),
		).toEqual([{ fn: "a", value: "x" }]);
		// A value shaped like a read is still a write inside a write call, and a
		// shorthand key is one too.
		expect(
			noteWrites(
				"\nfunction b() { tx.update(guests).set({ bookEmail: o.bookEmail }); }",
			),
		).toEqual([{ fn: "b", value: "o.bookEmail" }]);
		expect(
			noteWrites(
				"\nfunction c() { return createGuestRecord(tx, { bookEmail: input.bookEmail }); }",
			),
		).toEqual([{ fn: "c", value: "input.bookEmail" }]);
		expect(
			noteWrites("\nfunction d() { tx.insert(guests).values({ bookEmail }); }"),
		).toEqual([{ fn: "d", value: "(shorthand)" }]);
		// The read shapes are not writes.
		expect(
			noteWrites(
				"\nfunction e() { db.select({ bookEmail: guests.bookEmail }).from(guests); return rows.map((r) => ({ bookEmail: r.bookEmail })); }",
			),
		).toEqual([]);
	});
});
