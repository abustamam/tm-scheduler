// `getClubLogoMeta` is a GET; the logo mutations are POST (#504 item 2).
//
// This is the only mechanism that can hold that decision. A `createServerFn`
// wrapper cannot be invoked from vitest (no session, no RPC layer), and all six
// call sites `vi.mock("#/server/club-logo")` wholesale, so every one of them
// passes with either method and proves nothing about the transport. The whole of
// #504 item 2 is therefore invisible to 5,500 tests, typecheck and lint alike —
// a silent revert to POST, or a future read-shaped fn added on POST beside the
// two mutations, would be caught by nothing.
//
// The flip is not free to get wrong. The server enforces the declared method
// strictly (405 with an `Allow` header), and a server fn's URL is derived from
// file-and-export name rather than content, so the URL is byte-identical across
// a deploy: a tab left open across the change keeps calling the old method on
// the new server. Five of the six call sites already `.catch(() => null)`;
// #504 added the sixth so a stale client degrades to "no logo" instead of
// blanking the settings page.
//
// Comment-blind (`#/test/guard-source`) on both halves: these are all "the
// pattern must BE present" assertions, where a comment quoting the declaration
// would otherwise be a false PASS — and this file's own header quotes neither
// spelling for exactly that reason.
import { readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(SELF, "../../..");
const MODULE = resolve(ROOT, "src/server/club-logo.ts");

/**
 * Read-shaped names that are declared POST on purpose, as `<module>: <fn>`,
 * each with the reason. A name belongs here only if its declaration says so
 * too, and the stale-waiver case below fails a key that no longer names a real
 * POST declaration, so a waiver cannot outlive the fn it excuses.
 */
const POST_WAIVERS: Record<string, string> = {
	"areas.ts: findUserForDirector":
		"a GET would put a third party's email in the URL",
};

const declaration = (name: string, method: string) =>
	new RegExp(
		`export const ${name} = createServerFn\\(\\{\\s*method:\\s*"${method}"\\s*\\}\\)`,
	);

describe("club-logo server fn methods (#504)", () => {
	it("getClubLogoMeta is declared GET", () => {
		expect(
			declaration("getClubLogoMeta", "GET").test(readSource(MODULE)),
			"getClubLogoMeta only runs a select, so it must be a GET. Reverting it " +
				"to POST 405s every client loaded before the deploy — the server-fn " +
				"URL does not change with the method.",
		).toBe(true);
	});

	it("the two logo mutations stay POST", () => {
		const src = readSource(MODULE);
		for (const fn of ["uploadClubLogo", "removeClubLogoFn"]) {
			expect(
				declaration(fn, "POST").test(src),
				`${fn} writes, so it must stay POST — a mutation on GET is reachable ` +
					"by prefetch, a link and an <img src>.",
			).toBe(true);
		}
	});

	it("no read-shaped server fn anywhere is left on POST", () => {
		// The claim `club-logo.ts`'s doc comment makes, re-derived rather than
		// stated as a number: an earlier draft of that comment said "~51" when the
		// real figure was 68, which is precisely why this is a test and not prose.
		const READ_SHAPED =
			/export const ((?:get|load|list|resolve|fetch|read|search|count|find)[A-Z]\w*) = createServerFn\(\{\s*method:\s*"POST"\s*\}\)/g;
		const offenders: string[] = [];
		for (const file of serverModules()) {
			for (const m of readSource(file).matchAll(READ_SHAPED)) {
				const key = `${basename(file)}: ${m[1]}`;
				if (!(key in POST_WAIVERS)) offenders.push(key);
			}
		}
		expect(
			offenders,
			"These read-shaped server fns are declared POST: " +
				`${JSON.stringify(offenders)}. A fn that only reads should be a GET, ` +
				"which is the convention #504 brought getClubLogoMeta into line with. " +
				"If one genuinely needs POST (an oversized payload, say), say so at " +
				"its declaration and add it to POST_WAIVERS in this test.",
		).toEqual([]);
	});

	it("every POST waiver still names a real POST declaration, with a reason", () => {
		const waivers = Object.entries(POST_WAIVERS);
		// Vacuity floor: an emptied map would make the loop below check nothing.
		expect(waivers.length).toBeGreaterThan(0);
		for (const [key, reason] of waivers) {
			const [file, fn] = key.split(": ") as [string, string];
			expect(reason.trim(), `${key} has no reason`).not.toBe("");
			expect(
				declaration(fn, "POST").test(
					readSource(resolve(ROOT, "src/server", file)),
				),
				`${key} is waived as a read-shaped POST, but ${file} no longer ` +
					`declares ${fn} as a POST. Delete the waiver or re-point it.`,
			).toBe(true);
		}
	});
});

function serverModules(): string[] {
	return readdirSync(resolve(ROOT, "src/server"))
		.filter((f) => f.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(f))
		.map((f) => resolve(ROOT, "src/server", f));
}
