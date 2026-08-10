/**
 * Every MUTATING vote server fn must be gated (#510).
 *
 * Reads the source rather than the module: a "must be present" guard is
 * satisfied by a comment that merely names the pattern, so it reads the real
 * text and strips comments before asserting.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SOURCE = readSource("src/server/voting.ts");

const GATED = ["openVoteFn", "closeVoteFn", "getVoteTally"];

/**
 * The slice of SOURCE covering just `name`'s export — from its `export const`
 * line up to whichever other GATED export comes next, or EOF. Bounding to the
 * NEXT export (rather than a fixed-length window) matters: mutation-testing
 * this guard found that a fixed offset here bled into the following export's
 * body and matched ITS call instead of noticing the removal from `name`'s own
 * body — a false pass. Bounding to EOF for the last-declared export is also
 * why `requireVoteCounter` is declared BEFORE these exports in voting.ts: were
 * it declared after (as after `getVoteTally`, the last export), its own
 * `async function requireVoteCounter(...` declaration text would fall inside
 * that final slice and satisfy the assertion even with the real call removed.
 */
function gatedExportBody(name: string): string {
	const start = SOURCE.indexOf(`export const ${name} =`);
	expect(start, `${name} not found`).toBeGreaterThan(-1);
	const next = GATED.map((n) =>
		n === name ? -1 : SOURCE.indexOf(`export const ${n} =`),
	)
		.concat(SOURCE.length)
		.filter((i) => i > start)
		.sort((a, b) => a - b)[0];
	return SOURCE.slice(start, next);
}

describe("voting server fns are gated (#510)", () => {
	for (const name of GATED) {
		it(`${name} calls requireVoteCounter`, () => {
			expect(gatedExportBody(name)).toContain("requireVoteCounter(");
		});
	}

	it("openVoteFn and closeVoteFn assert the meeting lock", () => {
		for (const name of ["openVoteFn", "closeVoteFn"]) {
			expect(gatedExportBody(name)).toContain("assertMeetingNotLocked(");
		}
	});
});
