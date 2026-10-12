/**
 * Which CONNECTION `applySpeechLogEdit` reads on, inside its transaction (#1159).
 *
 * The transaction takes the meeting lock and the slot's row lock, then asks
 * who the actor is. A read through the global `db` from in there checks out a
 * SECOND pooled connection while the first holds the locks, and nothing bounds
 * a pool wait (`guards.ts`, #806 / #809). It is also invisible to a behavioural
 * test: the pool hands out whichever connection is free and the rows read are
 * the same either way. `requireClubRole`, `requireMembership` and
 * `userPersonIds` all read through `db`; `assertStillClubAdmin(tx, ...)`,
 * `getMembership(..., tx)` and `isSpeakerOfSpeech(tx, ...)` are their `tx`
 * counterparts. Source assertions are what is left, as in
 * `agenda-plan-connections.guard.test.ts`.
 *
 * Comment-blind ("must BE present" for the tx calls); the ABSENT checks are
 * made on the same comment-blind text, which can only miss an offender hidden
 * in a comment, and a comment is not a call.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const MODULE = resolve(__dirname, "speech-log-edit-logic.ts");
const TX_OPEN = /\bdb\.transaction\(\s*async\s*\(\s*tx\s*\)\s*=>\s*\{/;

/** The text after `db.transaction(async (tx) => {` to the end of the module:
 *  `applySpeechLogEdit` is the last function, and its transaction is the last
 *  thing in it. */
function splitAtTransaction(src: string) {
	const at = src.search(TX_OPEN);
	return { before: src.slice(0, at), inside: src.slice(at), at };
}

describe("applySpeechLogEdit reads inside its transaction on `tx` (#1159)", () => {
	const src = readSource(MODULE);
	const { before, inside, at } = splitAtTransaction(src);

	it("opens a transaction at all", () => {
		expect(
			at,
			"no `db.transaction(async (tx) =>` in the module",
		).toBeGreaterThan(-1);
		expect(src.match(new RegExp(TX_OPEN.source, "g"))).toHaveLength(1);
	});

	it.each([
		["the speaker check", /\bisSpeakerOfSpeech\(\s*tx\s*,/],
		["the admin re-check", /\bassertStillClubAdmin\(\s*tx\s*,/],
		["the membership read", /\bgetMembership\([^)]*,\s*tx\s*\)/],
		["the slot read", /\breadSlot\(\s*tx\s*,/],
		["the meeting lock", /\blockMeetingForSlotEdit\(\s*tx\s*,/],
		["the archive check", /\bassertClubNotArchived\([^)]*,\s*tx\s*\)/],
	])("%s runs on tx", (_label, pattern) => {
		expect(pattern.test(inside), String(pattern)).toBe(true);
	});

	it("nothing in the transaction reads through the pool", () => {
		for (const offender of [
			/\bdb\b/,
			/\brequireClubRole\b/,
			/\brequireMembership\b/,
			/\buserPersonIds\b/,
		]) {
			// `db.transaction(` itself is the opener, which `inside` starts with.
			const rest = inside.replace(TX_OPEN, "");
			expect(
				offender.test(rest),
				`${offender} appears inside the transaction: a read there takes a second pooled connection while the meeting lock is held`,
			).toBe(false);
		}
	});

	it("the up-front authorization, before the transaction, does use the pool", () => {
		// The preferred shape: refuse before taking any lock.
		expect(/\bisSpeakerOfSpeech\(\s*db\s*,/.test(before)).toBe(true);
		expect(/\brequireClubRole\(/.test(before)).toBe(true);
	});

	it("the predicates can fail", () => {
		const bad =
			"await db.transaction(async (tx) => {\n isSpeakerOfSpeech(db, a, s);\n requireClubRole(a, c, []);\n});";
		const { inside: badInside } = splitAtTransaction(bad);
		expect(/\bisSpeakerOfSpeech\(\s*tx\s*,/.test(badInside)).toBe(false);
		expect(/\bdb\b/.test(badInside.replace(TX_OPEN, ""))).toBe(true);
		expect(/\brequireClubRole\b/.test(badInside)).toBe(true);
	});
});
