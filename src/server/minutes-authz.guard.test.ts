/**
 * The minutes-editing capability boundary the Ballot Counter grant must not
 * cross (#510). `resolveVoteCounterAuthz` hands a non-admin Vote Counter
 * exactly FIVE capabilities — `addTableTopics` / `removeTableTopics` /
 * `moveTableTopics` / `setMinutesAward` / `clearMinutesAward` — via
 * `requireVoteCounterCapability`. `setAttendance` / `addMinutesGuest` /
 * `removeMinutesGuest` must keep calling the unrelated, narrower `gateAdmin`:
 * a Ballot Counter has no business editing the roster's attendance or the
 * club's guest records, and #464 is the standing reminder that capability
 * grants get enumerated, not widened.
 *
 * Two directions, two source-reading strategies (see `guard-source.ts`):
 *  - "must call the right gate" is a must-BE-present check, read through
 *    `readSource` (comment-blind) — a comment merely naming the gate would
 *    otherwise satisfy a raw-source check with the real call deleted.
 *  - "must NOT call the wider gate" is an offenders-must-be-EMPTY check, read
 *    from the RAW file — stripping comments there could only ever LOOSEN it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const PATH = "src/server/minutes.ts";
const SOURCE = readSource(PATH);
const RAW = readFileSync(PATH, "utf8");

// Every exported server fn in minutes.ts, IN FILE ORDER. Bounding each body
// slice to the NEXT export (or EOF for the last) — rather than a fixed-length
// window — matters: `voting-authz.guard.test.ts` found that a fixed offset
// bleeds into the following export's body and can match ITS call instead of
// noticing the removal from this export's own body.
const ALL_EXPORTS = [
	"getMinutes",
	"setAttendance",
	"addMinutesGuest",
	"removeMinutesGuest",
	"addTableTopics",
	"removeTableTopics",
	"moveTableTopics",
	"setMinutesAward",
	"clearMinutesAward",
];

const VOTE_COUNTER_GATED = [
	"addTableTopics",
	"removeTableTopics",
	"moveTableTopics",
	"setMinutesAward",
	"clearMinutesAward",
];

const ADMIN_ONLY = ["setAttendance", "addMinutesGuest", "removeMinutesGuest"];

/** The slice of `source` covering just `name`'s export — from its
 *  `export const` line up to whichever other listed export comes next, or EOF. */
function exportBody(source: string, name: string): string {
	const start = source.indexOf(`export const ${name} =`);
	expect(start, `${name} not found in ${PATH}`).toBeGreaterThan(-1);
	const next = ALL_EXPORTS.map((n) =>
		n === name ? -1 : source.indexOf(`export const ${n} =`),
	)
		.concat(source.length)
		.filter((i) => i > start)
		.sort((a, b) => a - b)[0];
	return source.slice(start, next);
}

describe("minutes capability boundary (#510)", () => {
	for (const name of VOTE_COUNTER_GATED) {
		it(`${name} calls requireVoteCounterCapability`, () => {
			expect(exportBody(SOURCE, name)).toContain(
				"requireVoteCounterCapability(",
			);
		});
	}

	for (const name of ADMIN_ONLY) {
		it(`${name} still calls gateAdmin`, () => {
			expect(exportBody(SOURCE, name)).toContain("gateAdmin(");
		});

		it(`${name} does NOT call the wider Ballot Counter gate`, () => {
			expect(exportBody(RAW, name)).not.toContain(
				"requireVoteCounterCapability(",
			);
		});
	}
});
