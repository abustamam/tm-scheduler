import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * The two facts about the Absent release (#1256) a behavioural test cannot
 * reach from outside: the stale-tab default on the wire schema, and that the
 * roll write and the release commit together under the attendance lock.
 * `absent-release.integration.test.ts` runs the handler; these pin the source
 * shapes whose deletion that suite would not see (a default flipped to `true`
 * still passes every case that sends the field explicitly).
 *
 * Comment-blind reads (`readSource`): both are "must BE present" assertions.
 */
const MINUTES = readSource(resolve(__dirname, "minutes.ts"));
const LOGIC = readSource(resolve(__dirname, "minutes-logic.ts"));

/** One `export async function <name>` body, up to the next top-level export. */
function functionBody(source: string, name: string): string {
	const start = source.indexOf(`export async function ${name}`);
	if (start === -1) {
		throw new Error(
			`${name} not found in minutes-logic.ts — renamed or removed. Re-point this guard rather than deleting the case.`,
		);
	}
	const next = source.indexOf("\nexport ", start + 1);
	return source.slice(start, next === -1 ? source.length : next);
}

describe("the Absent release wiring (#1256)", () => {
	it("releaseHeldRoles is `.default(false)` on setPresenceSchema, and the flag is refused with any other status", () => {
		// protects=the stale-tab rule (#663): a tab from before the deploy cannot send
		//   the field, so it must read as false and free nothing
		// fails_when=the default becomes `true` (or is dropped to `.optional()`), or the
		//   absent-only refinement is deleted
		// no_claim=behaviour: the integration suite sends the field both ways and
		//   omitted, this only pins the schema text
		const schema = MINUTES.slice(
			MINUTES.indexOf("const setPresenceSchema"),
			MINUTES.indexOf("export const setAttendance"),
		);
		expect(schema).toMatch(
			/releaseHeldRoles:\s*z\.boolean\(\)\.default\(false\)/,
		);
		expect(schema).toMatch(
			/\.refine\(\(d\)\s*=>\s*!d\.releaseHeldRoles\s*\|\|\s*d\.status\s*===\s*"absent"/,
		);
	});

	it("the Absent upsert and the release run in ONE transaction, after both locks, in that order", () => {
		// protects=an asserted claim cannot re-take a freed role in a gap, and an
		//   Absent write cannot commit while the release fails (or the reverse)
		// fails_when=the upsert is called without the tx (its own statement on the
		//   pool), the release moves outside `db.transaction`, or a lock is dropped or
		//   reordered (merge lock, then attendance lock, then the writes)
		// no_claim=that the locks serialise against a real concurrent claim (needs two
		//   connections; the #1259 suite owns the claim side)
		const body = functionBody(LOGIC, "setMemberAbsentReleasingRoles");
		const order = [
			"db.transaction(",
			"lockMembershipsAgainstMerge(tx",
			"lockMemberAttendance(tx",
			"setMemberPresence(",
			"releaseHeldSlots(tx",
		].map((needle) => body.indexOf(needle));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		// The upsert is handed the transaction, not left on the pool.
		expect(body).toMatch(/setMemberPresence\([^)]*,\s*tx\s*\)/s);
		// And the handler reaches the writer instead of upserting then releasing.
		const handler = MINUTES.slice(
			MINUTES.indexOf("export const setAttendance"),
			MINUTES.indexOf("const addGuestSchema"),
		);
		expect(handler).toContain("setMemberAbsentReleasingRoles(");
	});
});
