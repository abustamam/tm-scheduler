import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

// `listClubMembers` and `getMemberProfile` put member CONTACT on their payloads
// (email since #266, phone since the WhatsApp-links change). Both must stay
// behind `requireClubViewAccess` — the club's own signed-in members, never a
// public caller. A `createServerFn` cannot be invoked from a test (no session,
// no RPC layer), so the gate has no behavioural surface here and this source
// guard is what holds it.
//
// Two limits worth knowing before trusting it. It is ORDER-BLIND: a `toContain`
// on the handler text still passes if the gate is moved BELOW the loader call,
// which would fetch contact and then throw rather than never fetching it. That
// is inherent to a source grep — the behavioural check would need a session.
// And the second block's scan covers `src/` only, so an importer under
// `scripts/` would not be seen.
const SERVER_DIR = __dirname;

// Read comment-blind: these are "this pattern must BE present" assertions, and a
// comment merely NAMING `requireClubViewAccess` would satisfy a raw read while
// the real call was gone. That is the opposite direction from an
// offender-list-must-be-empty guard, which must read raw (see the second
// describe block below and `#/test/guard-source`).
const source = readSource(resolve(SERVER_DIR, "club.ts"));

/** Start of the next TOP-LEVEL declaration after `from`, or -1. */
function nextTopLevel(from: number): number {
	const re =
		/\n(?:export\s+)?(?:const|function|async function|type|interface)\s/g;
	re.lastIndex = from + 1;
	return re.exec(source)?.index ?? -1;
}

/** The body of a named `createServerFn` export, up to the next declaration. */
function handlerOf(name: string): string {
	const start = source.indexOf(`export const ${name} =`);
	expect(start, `${name} not found in club.ts`).toBeGreaterThan(-1);
	const next = nextTopLevel(start);
	return source.slice(start, next === -1 ? undefined : next);
}

describe("club.ts contact payloads stay behind the club view gate", () => {
	it.each([
		"listClubMembers",
		"getMemberProfile",
	])("%s calls requireClubViewAccess", (name) => {
		expect(handlerOf(name)).toContain("requireClubViewAccess");
	});

	it.each([
		"listClubMembers",
		"getMemberProfile",
	])("%s is a payload the gate above is protecting — it carries phone", (name) => {
		// Pins WHICH functions the gate protects — if phone moves to an ungated
		// export, this fails rather than the gate silently covering nothing.
		expect(handlerOf(name)).toMatch(/phone:\s*\w+\.phone/);
	});
});

// The normalization itself lives in `club-logic.ts`, whose `loadClubMembers` /
// `loadMemberProfile` are plain exported functions with NO gate of their own —
// the gate is the caller's. So the boundary above only holds while `club.ts` is
// the only place that imports them. A public route importing `loadClubMembers`
// directly would put the whole roster's email + phone on an unauthenticated
// payload without touching a single line this guard's first block reads.
//
// Deliberately raw (`readFileSync`, not `readSource`): this asserts an offender
// list is EMPTY, so a comment can only ever add a false offender — a failure a
// human sees immediately — never hide a real one. Blanking comments would loosen
// it. Matching the import specifier rather than the bare word keeps prose that
// merely names the module (like this paragraph) out of the count.
//
// `import(` and `require(` are matched alongside `from`, because a static import
// is not the only way in and the DYNAMIC form is the one a future author is most
// likely to copy: `club-contact.integration.test.ts` reaches these loaders with
// `await import("#/server/club-logic")` (it must, to land after the `vi.mock`).
// A `from`-only pattern left a file doing exactly that scoring 0 offenders while
// the static form failed correctly — the leak shape most likely to appear was
// the one shape not covered. Over-matching is the safe direction for an
// offender-list guard, so the alternation is deliberately loose.
const IMPORTS_CLUB_LOGIC =
	/(?:from\s+|import\(|require\()\s*["'][^"']*club-logic["']/;
const ALLOWED_IMPORTERS = new Set(["src/server/club.ts"]);

function sourceFilesUnder(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFilesUnder(full);
		return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
			? [full]
			: [];
	});
}

describe("club-logic's ungated contact loaders have exactly one caller", () => {
	it("only club.ts imports #/server/club-logic", () => {
		const root = resolve(SERVER_DIR, "../..");
		const importers = sourceFilesUnder(resolve(root, "src"))
			.filter((f) => IMPORTS_CLUB_LOGIC.test(readFileSync(f, "utf8")))
			.map((f) => f.slice(root.length + 1));
		expect(
			importers.filter((f) => !ALLOWED_IMPORTERS.has(f)),
			"a new importer of club-logic must carry its own auth gate — contact " +
				"(email + phone) is only for the club's own signed-in members",
		).toEqual([]);
		// And the allowed one really does import it, so this can't pass vacuously
		// after the extraction is undone.
		expect(importers).toContain("src/server/club.ts");
	});
});
