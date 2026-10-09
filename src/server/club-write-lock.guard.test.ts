/**
 * Pins WHERE the club write lock is taken (#925): the first statement of every
 * transaction that row-locks both a club and one of its meetings, before any
 * row lock. Taken after a row lock it orders nothing, and a passing interleaving
 * cannot see that — `club-write-lock.integration.test.ts` is the behavioural
 * half, and it drives only the pairs with a deterministic cycle. `openVote`
 * (a meeting FOR SHARE read of its status, then meeting and club FOR SHARE in
 * one statement, against a save holding the meeting and waiting on the club)
 * has none a test can force, so this is its only gate.
 *
 * Read comment-blind: every assertion is "this must BE in the code".
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * The body of `name` (exported or not), up to the next top-level `}`. Refuses
 * a slice too short to be a real function body: if the closing-brace split
 * ever lands early (a reformat, a nested top-level brace), every assertion
 * below would otherwise run against a fragment — and the negative-free ones
 * could pass on it.
 */
function body(source: string, name: string): string {
	const start = source.search(new RegExp(`\\bfunction ${name}\\(`));
	expect(start, `${name} not found`).toBeGreaterThan(-1);
	const sliced = source.slice(start).split("\n}\n")[0] ?? "";
	expect(
		sliced.length,
		`${name}'s body sliced to ${sliced.length} chars — the slicer is broken`,
	).toBeGreaterThan(200);
	return sliced;
}

const WRITERS: { file: string; fn: string; clubArg: string }[] = [
	{ file: "voting-logic.ts", fn: "joinInTransaction", clubArg: "clubId" },
	{ file: "voting-logic.ts", fn: "openVote", clubArg: "input.clubId" },
	{
		file: "guest-pipeline-logic.ts",
		fn: "captureInTransaction",
		clubArg: "input.clubId",
	},
	{
		file: "meeting-templates-logic.ts",
		fn: "saveInTransaction",
		clubArg: "clubId",
	},
];

describe("the club write lock is each writer's first statement", () => {
	for (const { file, fn, clubArg } of WRITERS) {
		it(`${fn} (${file}) takes it before anything else in its transaction`, () => {
			const src = body(readSource(`src/server/${file}`), fn);
			const txOpen = src.search(/\.transaction\(async \(tx\) => \{/);
			expect(txOpen, `${fn} opens no transaction`).toBeGreaterThan(-1);
			const inside = src.slice(txOpen);
			const firstAwait = inside.indexOf("await ");
			// -1 would slice from the END's last char and match nothing useful;
			// say so rather than let a missing `await` read as a regex miss.
			expect(firstAwait, `${fn}'s transaction awaits nothing`).toBeGreaterThan(
				-1,
			);
			expect(inside.slice(firstAwait)).toMatch(
				new RegExp(
					`^await lockClubForWrite\\(tx, ${clubArg.replace(".", "\\.")}\\);`,
				),
			);
		});
	}

	it("the public writers translate a residual deadlock", () => {
		for (const [file, fn] of [
			["voting-logic.ts", "joinBallotAsGuest"],
			["guest-pipeline-logic.ts", "captureGuestVisit"],
		] as const) {
			expect(body(readSource(`src/server/${file}`), fn)).toMatch(
				/if \(isDeadlock\(err\)\) throw new Error\(CLUB_BUSY_MESSAGE, \{ cause: err \}\);/,
			);
		}
	});
});
