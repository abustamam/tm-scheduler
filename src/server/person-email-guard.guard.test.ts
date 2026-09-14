/**
 * Source guard: every writer of `people.email` goes through the shared
 * predicate, and the predicate says what it is supposed to say.
 *
 * Why a SOURCE test rather than a behavioural one. `people.email` is the
 * identity key — `linkPersonToUser` binds a sign-in to whatever it says — so
 * the rule has to hold at EVERY writer, and this branch learned the hard way
 * that guarding a subset just moves the takeover to the unguarded path: three
 * review rounds each found the fix complete and each was wrong, because the
 * enumeration was wrong. A behavioural test proves one writer behaves; only an
 * enumeration can prove none was missed, and the failure mode being defended
 * against is a NEW writer added later by someone who never reads this file.
 *
 * So: the list below is the claim. Adding an `update(people).set({ email })`
 * anywhere in `src/server` fails this test until it is either routed through
 * `personEmailWritable` or added here with a reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SERVER_DIR = join(import.meta.dirname);

/**
 * Writers that set `people.email` WITHOUT the shared predicate, each with the
 * reason it is allowed to. Every entry is a liability: keep it short, and
 * prefer routing a writer through the guard over adding a row here.
 */
const WAIVERS: Record<string, string> = {
	// Superadmin-only console repair for a club's FIRST admin, and the one
	// person-level repair surface that exists when the blast-radius rule refuses
	// a legitimate correction (a Person two clubs share). It carries its own
	// `user_id` check and is not reachable by a club admin.
	"onboarding-logic.ts": "superadmin console, first-admin repair surface",
	// Merges two Person rows; only ever FILLS a null keeper address
	// (`keeper.email ?? absorbed.email`), never moves a set one, and is
	// superadmin-gated.
	"people-merge-logic.ts": "superadmin merge, fill-only on the keeper",
	// The guard module itself.
	"person-email-guard.ts": "defines the predicate",
};

function serverSources(): string[] {
	return readdirSync(SERVER_DIR)
		.filter((f) => f.endsWith(".ts"))
		.filter((f) => !f.includes(".test.") && !f.endsWith(".d.ts"));
}

describe("people.email writers (identity key)", () => {
	it("every writer outside the waiver list uses the shared predicate", () => {
		const offenders: string[] = [];
		for (const file of serverSources()) {
			if (WAIVERS[file]) continue;
			const src = readFileSync(join(SERVER_DIR, file), "utf8");
			// PER WRITE SITE, never per file. A file-level "does it mention the
			// guard anywhere" check is satisfied by ONE guarded sibling while another
			// writer in the same file goes unguarded — verified by unguarding the
			// invite seed and watching a file-level version of this test stay green,
			// because `bindPerson` below it still named the guard. Same shape as the
			// #565 over-capture bug.
			//
			// A write of the column is `email` in the SET clause — the span between
			// `.update(people)` and its `.where(`. Scoped that tightly on purpose:
			// `account-link-logic` sets `userId` while MATCHING on
			// `lower(people.email)`, so a looser span flags the one module that only
			// READS the column. Reading it is not the hazard; writing it is.
			const sites = [
				...src.matchAll(
					/\.update\(people\)([\s\S]*?)\.where\(([\s\S]{0,300})/g,
				),
			];
			for (const [, setClause = "", whereClause = ""] of sites) {
				if (!/\bemail\b/.test(setClause)) continue;
				if (!whereClause.includes("personEmailWritable")) {
					offenders.push(
						`${file} (a people.email write with an unguarded WHERE)`,
					);
				}
			}
		}
		expect(
			offenders,
			`These files write people.email without personEmailWritable from ` +
				`#/server/person-email-guard. people.email is the identity key: ` +
				`linkPersonToUser binds a sign-in to whatever it says, so an ` +
				`unguarded writer is a cross-club account takeover, not a data-quality ` +
				`bug. Route it through the guard, or add it to WAIVERS with a reason.`,
		).toEqual([]);
	});

	it("the predicate still carries both halves of the rule", () => {
		const src = readFileSync(join(SERVER_DIR, "person-email-guard.ts"), "utf8");
		// Weakening either half silently re-opens a takeover that this branch
		// reproduced end to end, and no behavioural test in a single-club fixture
		// can see the second one.
		expect(src, "the no-account half is gone").toMatch(
			/isNull\(\s*people\.userId\s*\)/,
		);
		expect(src, "the no-other-club half is gone").toMatch(/notExists\(/);
		expect(src, "the other-club comparison is gone").toMatch(
			/ne\(\s*members\.clubId/,
		);
	});

	it("names every waiver, so a silent exemption cannot accrete", () => {
		for (const [file, reason] of Object.entries(WAIVERS)) {
			expect(
				reason.length,
				`${file} has an empty waiver reason`,
			).toBeGreaterThan(10);
			expect(
				serverSources().includes(file),
				`${file} is waived but no longer exists — drop the waiver`,
			).toBe(true);
		}
	});
});
