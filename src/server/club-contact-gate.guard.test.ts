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

/**
 * Every `createServerFn` exported from `club.ts`, as (name, body) pairs.
 *
 * ENUMERATED, not listed. The first version of this guard hard-coded
 * `["listClubMembers", "getMemberProfile"]`, which meant it only ever checked
 * the two handlers that already had the gate — adding a THIRD server fn calling
 * `loadClubMembers` without one published the whole roster's email and phone
 * with the guard fully green. A gate test that cannot see a new ungated caller
 * is testing the past.
 *
 * The body runs to the next top-level declaration, which is also what bounds a
 * handler for the `requireClubViewAccess` check below.
 */
function serverFns(): { name: string; body: string }[] {
	const re = /export const (\w+) = createServerFn/g;
	const out: { name: string; body: string }[] = [];
	for (const m of source.matchAll(re)) {
		const next = nextTopLevel(m.index);
		out.push({
			name: m[1] as string,
			body: source.slice(m.index, next === -1 ? undefined : next),
		});
	}
	return out;
}

/**
 * The ungated contact loaders in `club-logic.ts`. A handler that calls either
 * one is serving member email + phone and must gate.
 */
const CONTACT_LOADERS = ["loadClubMembers", "loadMemberProfile"];

const ALL_FNS = serverFns();
const CONTACT_FNS = ALL_FNS.filter((fn) =>
	CONTACT_LOADERS.some((loader) => fn.body.includes(loader)),
);

describe("club.ts contact payloads stay behind the club view gate", () => {
	it("finds the known contact handlers (so the enumeration can't pass vacuously)", () => {
		// Anti-vacuity in BOTH directions. A regex that matched nothing — after a
		// rename, a reformat, or a switch to another factory — would leave
		// `CONTACT_FNS` empty and every `it.each` below silently vacuous, which is
		// the failure mode that made the hard-coded version worth replacing in the
		// first place. Naming the two handlers here (rather than driving the checks
		// from them) keeps the enumeration honest without narrowing it.
		expect(ALL_FNS.map((fn) => fn.name)).toEqual(
			expect.arrayContaining(["listClubMembers", "getMemberProfile"]),
		);
		expect(CONTACT_FNS.map((fn) => fn.name).sort()).toEqual([
			"getMemberProfile",
			"listClubMembers",
		]);
	});

	it.each(
		CONTACT_FNS.map((fn) => fn.name),
	)("%s calls requireClubViewAccess", (name) => {
		const fn = CONTACT_FNS.find((f) => f.name === name);
		expect(
			fn?.body,
			`${name} reads member contact through club-logic but does not call ` +
				"requireClubViewAccess. Email and phone are for the club's own " +
				"signed-in members, never a public caller.",
		).toContain("requireClubViewAccess");
	});

	// Deliberately scoped to the two KNOWN handlers rather than to every entry in
	// `CONTACT_FNS`. This is an anti-vacuity assertion — it proves the gate above
	// is protecting real contact PII rather than two handlers that stopped serving
	// any — and a future gated handler is free to return the loader's rows
	// wholesale without ever spelling `phone: x.phone`. Enumerating here would
	// fail that handler for a style choice; the GATE check is the one that must
	// see everything.
	it.each([
		"listClubMembers",
		"getMemberProfile",
	])("%s still carries phone, so the gate is protecting something", (name) => {
		const fn = ALL_FNS.find((f) => f.name === name);
		expect(fn, `${name} not found in club.ts`).toBeDefined();
		expect(fn?.body).toMatch(/phone:\s*\w+\.phone/);
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
