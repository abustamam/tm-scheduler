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

		// WHO may write and WHEN it may be written are separate questions, and
		// only the first was ever asked here. `gateAdmin` is `requireUser` +
		// `requireClubRole(admin)` and says nothing about the date, so an officer
		// could record attendance on a meeting weeks away — and the row is not
		// inert: `meeting_attendance` feeds the minutes PDF, the minutes email and
		// the reporting derivations, so a future-dated row is a false fact that
		// propagates. The guest path already refused to write one; these three
		// did not.
		//
		// Source-guarded because the call sits inside a `createServerFn` handler,
		// which vitest cannot invoke. The seam's own behaviour (which dates pass,
		// which are refused) is covered in `minutes.integration.test.ts`; this
		// only proves the handler calls it, and the gap between those two is
		// where the hole would come back.
		it(`${name} also gates on the meeting date`, () => {
			expect(
				exportBody(SOURCE, name),
				`${name} must call assertAttendanceRecordable — without it, attendance is writable on a meeting that has not happened, and the row reaches the minutes PDF, the minutes email and the reporting derivations.`,
			).toContain("assertAttendanceRecordable(");
		});
	}
});

/**
 * Archive takedown on the minutes surface (#560).
 *
 * `getMinutes` resolves membership with a bare `getMembership` instead of a
 * `require*` gate, so it never reaches the read gates' `assertClubNotArchived`,
 * and a `createServerFn` is addressable directly with no router — the meeting page
 * 404ing for an archived club gates the CALLER, not this endpoint. An archived club
 * served its full minutes (roster names by attendance status, guest names, awards,
 * action items) to its own signed-in members until the `isReadableClub` call below.
 *
 * A source guard because the fix lives inside a `createServerFn` handler, which is
 * unreachable from vitest. Comment-blind: this is a must-BE-present check, so a
 * comment naming the gate would otherwise satisfy it with the real call deleted.
 *
 * `public-readers-archive-gate.guard.test.ts` is the derived sweep that should have
 * caught this and did not: it ends a declaration at `\n});`, but this repo's
 * handlers close at one tab (`\t});`), so its slice for `getMinutes` overran into
 * `gateAdmin` and matched THAT function's `requireUser` — classifying the fn as
 * session-guarded and skipping it. Fixing that slicer is filed separately; this
 * guard does not depend on it.
 */
describe("minutes archive gate (#560)", () => {
	it("getMinutes gates on isReadableClub", () => {
		expect(exportBody(SOURCE, "getMinutes")).toContain("isReadableClub(");
	});

	it("gates on the NEGATION — polarity, not just presence", () => {
		// `toContain("isReadableClub(")` passes on the inverted gate
		// (`if (await isReadableClub(clubId)) return empty;`), which serves archived
		// clubs and withholds live ones — worse than no gate at all. Same for the PDF
		// route below. Pin the `!`.
		expect(exportBody(SOURCE, "getMinutes")).toMatch(
			/if\s*\(!\(await isReadableClub\(/,
		);
		expect(readSource("src/routes/api/meetings.$id.minutes.pdf.ts")).toMatch(
			/if\s*\(!\(await isReadableClub\(/,
		);
	});

	it("gates BEFORE it resolves a membership or reads any minutes", () => {
		const body = exportBody(SOURCE, "getMinutes");
		const gateAt = body.indexOf("isReadableClub(");
		expect(gateAt).toBeGreaterThan(-1);
		// Ordering is the property, not mere presence: a gate placed after
		// `loadMinutes` would leak the payload it exists to withhold.
		for (const after of [
			"getMembership(",
			"loadMinutes(",
			"loadMinutesProgram(",
		]) {
			const at = body.indexOf(after);
			expect(at, `${after} not found in getMinutes`).toBeGreaterThan(-1);
			expect(gateAt, `isReadableClub must run before ${after}`).toBeLessThan(
				at,
			);
		}
	});

	it("the minutes PDF route gates too — same hole, a surface no sweep walks", () => {
		// `public-readers-archive-gate.guard.test.ts` walks `src/server/*.ts` only, and
		// the new read-gate guard reads `guards.ts` only, so nothing enrolls
		// `src/routes/api/**`. This route is a plain authed GET URL: a pre-takedown
		// bookmark works with just a session cookie and no router.
		const route = readSource("src/routes/api/meetings.$id.minutes.pdf.ts");
		expect(route).toContain("isReadableClub(");
		const gateAt = route.indexOf("isReadableClub(");
		const renderAt = route.indexOf("renderMinutesPdf(");
		expect(renderAt).toBeGreaterThan(-1);
		expect(gateAt).toBeLessThan(renderAt);
		// And a LAPSED member must not download an active club's minutes either.
		expect(route).toMatch(/membership\.status !== "active"/);
	});
});
