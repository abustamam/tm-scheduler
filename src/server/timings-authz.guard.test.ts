/**
 * The timing write's authorization ladder, ENUMERATED (#730).
 *
 * `timings.integration.test.ts` next door executes every arm against a real
 * database and is the stronger of the two gates. What it cannot see is the
 * SHAPE of the decision, and the shape is where this class of change goes
 * wrong: an arm added to the ladder, a gate deleted from the writer, or the
 * whole decision inlined into the `createServerFn` handler — where a
 * `createServerFn` cannot be invoked from vitest, so the integration suite
 * would go green with nothing left to test.
 *
 * Three claims, each with a failure behind it:
 *
 *  1. The ladder has EXACTLY three arms, and their ORDER is officer → tmod →
 *     timer. Order is load-bearing: only the manager arms may overwrite, so a
 *     person who is both an admin and this meeting's Timer must be credited as
 *     the officer they are. Putting the Timer arm first would swallow the
 *     officer arm for exactly that person, and the integration suite's
 *     "officer wins" case is the only thing that would notice.
 *  2. The four gates the writer runs — archive, meeting window, timeable role,
 *     actor — are all present, and the ROUTE does not run them instead. #573 is
 *     the standing reminder that neither `/review-pr` axis asks who may now
 *     write or delete another person's record.
 *  3. Capability resolution goes through the shared `find*Slot` resolvers and
 *     never through a hand-rolled key comparison. `TIMER_ROLE_KEY`'s own
 *     docblock says why: the key comes FIRST and the exact canonical name only
 *     backs a NULL key, and a caller that assembles those two halves in the
 *     wrong order hands the Timer's capability to a club-invented look-alike
 *     with nothing failing.
 *
 * Two source-reading strategies (see `guard-source.ts`): "must BE present" is
 * read comment-blind, because these files carry long headers naming most of
 * what follows and a raw read would be satisfied by the prose after the call
 * was deleted. "Must be ABSENT" is read RAW, because stripping comments there
 * could only ever LOOSEN the check.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const LOGIC = "src/server/timings-logic.ts";
const FN = "src/server/timings.ts";
const LOGIC_SOURCE = readSource(LOGIC);
const LOGIC_RAW = readFileSync(LOGIC, "utf8");
const FN_SOURCE = readSource(FN);
const FN_RAW = readFileSync(FN, "utf8");

/** The body of the ladder, from its declaration to the next top-level one.
 *  Anchored INSIDE the construct it is about — an `indexOf` from byte zero
 *  finds the first same-named thing in the file, which in a module with a long
 *  header is almost never the one you want. */
function ladderBody(): string {
	const start = LOGIC_SOURCE.indexOf(
		"export async function resolveTimingActor",
	);
	expect(start, "the ladder must exist to be enumerated").toBeGreaterThan(-1);
	const end = LOGIC_SOURCE.indexOf("\nexport ", start + 1);
	const body = LOGIC_SOURCE.slice(start, end === -1 ? undefined : end);
	// Vacuity floor on a COMPUTED slice, per CODING_STANDARDS: every false pass
	// this repo has had from a source guard was an empty or mis-anchored slice.
	expect(body.length).toBeGreaterThan(200);
	expect(body).toContain("getSessionUser");
	return body;
}

describe("the ladder has three arms, in this order", () => {
	it("returns exactly the three declared arms and no fourth", () => {
		const arms = [...ladderBody().matchAll(/via: "(\w+)"/g)].map((m) => m[1]);
		expect(arms).toEqual(["officer", "tmod", "self"]);
	});

	it("credits only the two MANAGER arms with the overwrite capability", () => {
		// `viaManager` is what the floor reads. A third `true` here would let a
		// self-asserted Timer replace another actor's record, which is the whole
		// thing the floor exists to prevent.
		const flags = [...ladderBody().matchAll(/viaManager: (true|false)/g)].map(
			(m) => m[1],
		);
		expect(flags).toEqual(["true", "true", "false"]);
	});

	it("the officer arm reads a real session and a real club role", () => {
		// Not a flag off the payload: this is the one arm a client cannot assert.
		expect(ladderBody()).toContain("getSessionUser()");
		expect(ladderBody()).toMatch(
			/requireClubRole\(user\.id, args\.clubId, \["admin"\]\)/,
		);
	});

	it("refuses everyone else rather than falling through to a default actor", () => {
		// The attendance ladder's self arm defaults an unnamed caller TO THE
		// SUBJECT. A timing has no subject, so the same shape here would admit
		// any anonymous request; the ladder must end in a throw.
		expect(ladderBody()).toContain(
			"throw new Error(TIMING_NOT_PERMITTED_MESSAGE)",
		);
	});
});

describe("capability resolution goes through the shared resolvers", () => {
	it("uses findTimerSlot and findTmodSlot", () => {
		expect(LOGIC_SOURCE).toContain('from "#/lib/meeting-roles"');
		expect(LOGIC_SOURCE).toContain("findTimerSlot(args.slots)");
		expect(LOGIC_SOURCE).toContain("findTmodSlot(args.slots)");
	});

	it("never compares a role key by hand", () => {
		// RAW negatives. Each of these type-checks, reads fine, and silently
		// denies a standard slot whose key predates the #368 backfill while
		// admitting a club-invented look-alike (#464).
		for (const offender of [
			/roleKey\s*===\s*["']timer["']/,
			/roleKey\s*===\s*["']toastmaster_of_the_day["']/,
			/roleName\s*===\s*["']Timer["']/,
		]) {
			expect(LOGIC_RAW, `must not match ${offender}`).not.toMatch(offender);
		}
	});
});

describe("the writer runs every gate, in this order", () => {
	function writerBody(): string {
		const start = LOGIC_SOURCE.indexOf(
			"export async function recordMeetingTiming",
		);
		expect(start, "the writer must exist").toBeGreaterThan(-1);
		const end = LOGIC_SOURCE.indexOf("\nexport ", start + 1);
		const body = LOGIC_SOURCE.slice(start, end === -1 ? undefined : end);
		expect(body.length).toBeGreaterThan(400);
		return body;
	}

	it("gates the archive, the meeting window, the ROW and the ACTOR", () => {
		const body = writerBody();
		expect(body).toContain("assertClubNotArchived(meeting.clubId)");
		expect(body).toContain('meeting.status === "cancelled"');
		expect(body).toContain("isTimeableRole(slot)");
		expect(body).toContain("resolveTimingActor({");
	});

	it("puts the ARCHIVE gate before every other refusal", () => {
		// Takedown outranks every other reason to refuse. With the window checked
		// first, an archived club's cancelled meeting answers differently from its
		// scheduled one, which both discloses meeting state and defeats the point
		// of the takedown — the same ordering the agenda resolvers state.
		const body = writerBody();
		const archive = body.indexOf("assertClubNotArchived");
		const cancelled = body.indexOf('meeting.status === "cancelled"');
		const timeable = body.indexOf("isTimeableRole(slot)");
		const actor = body.indexOf("resolveTimingActor({");
		expect(archive).toBeGreaterThan(-1);
		expect(archive).toBeLessThan(cancelled);
		expect(cancelled).toBeLessThan(timeable);
		// WHAT before WHO: telling a Timer they are not permitted, when the real
		// answer is that a Table Topics segment has no one speaker, sends them
		// looking for a permissions problem that does not exist.
		expect(timeable).toBeLessThan(actor);
	});

	it("does NOT reuse the agenda lock", () => {
		// A completed meeting refuses every AGENDA mutation. Minutes are written
		// AFTER the meeting by definition, so borrowing `assertMeetingNotLocked`
		// here would make this record unwritable at exactly the moment it is meant
		// to be written.
		expect(LOGIC_RAW).not.toContain("assertMeetingNotLocked");
	});

	it("floors the overwrite as a PREDICATE, not a read-then-write", () => {
		// The enforcement has to be a `setWhere` Postgres evaluates against the
		// live row: a check made before the write cannot see a second write that
		// lands between the two, and the same reasoning is why `setPlanStatus`'s
		// `demoteFrom` is a predicate. A read is fine BESIDE it (it is what
		// produces a message the Timer can read) and fatal INSTEAD of it.
		const body = writerBody();
		expect(body).toContain("setWhere: floor");
		expect(body).toMatch(
			/const floor =[\s\S]{0,200}eq\(meetingTimings\.recordedByMemberId, actor\.actorMemberId\)/,
		);
		// `undefined` on the manager arms, so an officer or the Toastmaster is
		// not floored by the predicate meant for the self-asserted Timer.
		expect(body).toContain("actor.viaManager || actor.actorMemberId === null");
	});

	it("raises the overwrite refusal in exactly ONE place", () => {
		// A read-then-write in front of the predicate is the shape this had in its
		// first cut, and it did real harm: it duplicated the refusal somewhere
		// that could drift from the predicate, and because it threw FIRST every
		// serial overwrite test passed with `setWhere` deleted — leaving the
		// safety-critical half held by one race test alone. A second occurrence of
		// the message here is that shape coming back.
		const body = writerBody();
		expect([...body.matchAll(/TIMING_OVERWRITE_MESSAGE/g)]).toHaveLength(1);
		// …and it is raised off the WRITE's own result, not off a prior read.
		expect(body).toMatch(
			/if \(!written\)[\s\S]{0,600}TIMING_OVERWRITE_MESSAGE/,
		);
		// Keyed on the SELECT, not on the column name: the upsert's `returning`
		// legitimately names `recordedByMemberId`, so a negative on the column
		// would fail on correct code — the false-FAIL half of the guard traps in
		// CODING_STANDARDS. The writer reads this table nowhere.
		expect(body, "no read-then-write in front of the predicate").not.toContain(
			".from(meetingTimings)",
		);
	});

	it("names the ON CONFLICT arbiter explicitly", () => {
		// A unique index alone only proves an insert FAILS; naming `slot_id` as
		// the conflict target is what makes a second recording an UPDATE rather
		// than an error the Timer cannot get past.
		expect(writerBody()).toMatch(
			/onConflictDoUpdate\(\{[\s\S]{0,80}target: meetingTimings\.slotId/,
		);
	});

	it("writes the row and the activity row in ONE transaction", () => {
		// An audit trail that can be missing for a row that landed is not one.
		const body = writerBody();
		expect(body).toContain("db.transaction(");
		expect(body).toMatch(/logActivity\(tx, \{/);
		expect(body).toMatch(/action: "timing_record"/);
		expect(body).toMatch(/grantedVia: actor\.via/);
	});
});

describe("the server-fn module is a wrapper and nothing else", () => {
	it("delegates to the seam rather than deciding anything itself", () => {
		// A rule that lives inside a `createServerFn` handler is unreachable from
		// vitest — it can be neither integration-tested nor guarded, which is the
		// gap #544 and #560 both were.
		expect(FN_SOURCE).toContain("recordMeetingTiming({");
		// The payload's `actorMemberId` is a CLAIM and reaches the seam under the
		// name the resolver uses. Spelling it out rather than spreading `data` is
		// what stops a future field riding into the seam unnoticed, and it is the
		// read `actor-provenance.guard.test.ts` sanctions.
		expect(FN_SOURCE).toContain("claimedActorMemberId: data.actorMemberId");
		for (const gate of [
			"assertClubNotArchived",
			"requireClubRole",
			"findTimerSlot",
			"isTimeableRole",
			"resolveTimingActor",
		]) {
			expect(FN_RAW, `${gate} belongs in the seam`).not.toContain(gate);
		}
	});

	it("requires a slot id, so a subject-less request never reaches the writer", () => {
		expect(FN_SOURCE).toMatch(/slotId: uuid,/);
		expect(FN_SOURCE).not.toMatch(/slotId: uuid\.optional\(\)/);
		expect(FN_SOURCE).not.toMatch(/slotId: uuid\.nullable\(\)/);
	});

	it("bounds the duration at BOTH ends before it reaches the column", () => {
		// The column is an `integer`: a value past 2^31 makes Postgres throw a
		// range error the caller sees as a 500 rather than as "that is not a
		// time". The lower bound is duplicated by the check constraint on
		// purpose — this endpoint takes a number off a public request.
		expect(FN_SOURCE).toMatch(
			/elapsedSeconds: z\.number\(\)\.int\(\)\.min\(0\)\.max\(MAX_ELAPSED_SECONDS\)/,
		);
		expect(FN_SOURCE).toMatch(/const MAX_ELAPSED_SECONDS = 12 \* 60 \* 60/);
	});

	it("stays a POST", () => {
		// A server fn's URL is derived from its file and export name, so flipping
		// the method is a breaking change for every tab already open: the URL is
		// byte-identical across the deploy while the server enforces the new verb
		// with a 405 the router surfaces as a blank page (#504).
		expect(FN_SOURCE).toContain('createServerFn({ method: "POST" })');
	});
});
