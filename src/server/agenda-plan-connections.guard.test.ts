/**
 * Which CONNECTION each piece of `upsert_agendas`' work runs on (#808).
 *
 * Two rules, one subject. The schedule top-up must run OUTSIDE any transaction
 * (AC4), and every write inside the locked apply must be threaded with that
 * transaction's handle. Both are properties of a connection, and the pool hands
 * out whichever is free — so a test that counts rows sees the same rows either
 * way, and a test that counts statements is blind to anything issued on a
 * checked-out client. Source assertions are what is left.
 *
 * ## Rule 1 — the top-up runs once, before planning, outside any transaction
 *
 * `ensureScheduleToppedUp` imports `db` directly and takes no connection, so a
 * call from inside the apply transaction would run on a SECOND pooled
 * connection while the club's advisory lock is held on the first. Two
 * consequences, and both are invisible to a behavioural test: the writes would
 * not be covered by the lock the apply took, and they would not roll back with
 * the batch — an apply that refused would still have materialised meetings.
 * `lock.ts` allows a 5s wait on a pool of 10 shared by the whole app, so it is
 * also the shape that starves unrelated requests.
 *
 * A source grep, because the property is about WHICH CONNECTION a write went
 * out on, and the pool hands out whichever is free — a test counting rows sees
 * the same rows either way.
 *
 * The other half of rule 1 is that it is called AT ALL. A club's recurrence rule
 * materialises future meetings on authenticated reads (ADR-0021), which token
 * calls never reach, so without this an LLM planning three months out proposes
 * CREATING meetings the club is about to generate for itself.
 * `list-meetings.ts` is the standing precedent.
 *
 * ## Rule 2 — every write in the locked apply is threaded with `tx`
 *
 * `applyMeetingMetaPatch` takes `conn: DbOrTx = db`, and that default is a
 * TRAP, measured on this repo before: a seam with an optional connection fails
 * silently wrong when a caller inside a transaction forgets to pass its handle.
 * It opens a transaction of its own on a second pooled connection, so the write
 * lands OUTSIDE the batch the caller is assembling — and if the caller already
 * holds a row lock on the same meeting, it instead blocks until the lock
 * timeout, dying of a timeout that names neither connections nor pools.
 *
 * Neither failure is visible to a behavioural test of the happy path, and both
 * are one forgotten argument away. `agenda-plan-confirm.integration.test.ts`
 * measures that a threaded call rolls back with its caller and an unthreaded
 * one does not; this pins that the apply passes the handle at every call site.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = resolve(HERE, "mcp/tools/upsert-agendas.ts");
const PLANNER = resolve(HERE, "agenda-plan.ts");
const APPLY = resolve(HERE, "agenda-plan-apply.ts");
const PAGE_LOGIC = resolve(HERE, "agenda-plan-pending-logic.ts");

const CALL = /\bensureScheduleToppedUp\s*\(/;

describe("rule 1 — the agenda top-up (#808, AC4)", () => {
	it("the tool calls it", () => {
		// Comment-blind: this is the "must BE present" class, and the tool's own
		// header explains the call at length in prose that a raw read would
		// accept in place of the call itself.
		const src = readSource(TOOL);
		expect(src.length, "the tool module is missing or empty").toBeGreaterThan(
			0,
		);
		expect(
			CALL.test(src),
			"upsert-agendas.ts does not call ensureScheduleToppedUp. Without it a token caller sees a calendar the browser does not, and proposes creating meetings the club's own rule is about to materialise (ADR-0021).",
		).toBe(true);
	});

	it("calls it exactly once, before anything is read or written", () => {
		const src = readSource(TOOL);
		const calls = [...src.matchAll(/\bensureScheduleToppedUp\s*\(/g)];
		expect(calls).toHaveLength(1);
		// Before `plan(` and before the insert — a top-up AFTER planning would
		// hand the page a plan built against a calendar that no longer exists.
		const topUpAt = src.search(CALL);
		expect(topUpAt).toBeGreaterThan(-1);
		expect(
			src.indexOf("await plan("),
			"the top-up must run before the plan is built",
		).toBeGreaterThan(topUpAt);
		expect(
			src.indexOf(".insert(mcpPendingPlans)"),
			"the top-up must run before the pending row is written",
		).toBeGreaterThan(topUpAt);
	});

	it("is NOT inside a transaction in the module that calls it", () => {
		// RAW, not stripped: this is the "must be ABSENT" class, where blanking
		// comments can only ever hide a real offender.
		const raw = readFileSync(TOOL, "utf8");
		expect(
			/\btransaction\s*\(/.test(raw),
			"upsert-agendas.ts opened a transaction. The top-up takes no connection and writes on `db`, so a call inside one runs on a second connection while a lock is held — and its writes do not roll back with the caller.",
		).toBe(false);
	});

	it("is not called from the planner, the apply, or the page's logic", () => {
		// The apply is the one that matters — it runs inside
		// `applyPendingPlanLocked`, holding the club's advisory lock. The other
		// two are swept because `plan()` is called FROM the apply, so a top-up
		// added there would reach the same place by a longer route.
		for (const [label, path] of [
			["agenda-plan.ts", PLANNER],
			["agenda-plan-apply.ts", APPLY],
			["agenda-plan-pending-logic.ts", PAGE_LOGIC],
		] as const) {
			const raw = readFileSync(path, "utf8");
			expect(
				CALL.test(raw),
				`${label} calls ensureScheduleToppedUp. Every path through it reaches the locked apply transaction, where a second connection's writes are outside the lock and outside the rollback.`,
			).toBe(false);
		}
	});

	it("the predicates can fail", () => {
		// Mutation verification, per the repo's convention: prove the greps flag a
		// non-compliant module rather than by breaking a real one. Without this
		// every case above passes whether or not the patterns work.
		const compliant =
			"await ensureScheduleToppedUp(club.clubId);\nawait plan(db, c, e);";
		const missing = "await plan(db, c, e);";
		const wrapped =
			"await db.transaction(async (tx) => { await ensureScheduleToppedUp(id); });";
		expect(CALL.test(compliant)).toBe(true);
		expect(CALL.test(missing)).toBe(false);
		expect(/\btransaction\s*\(/.test(compliant)).toBe(false);
		expect(/\btransaction\s*\(/.test(wrapped)).toBe(true);
	});
});

describe("rule 2 — the locked apply threads its transaction (#808)", () => {
	/**
	 * Every seam the apply body calls that WRITES, and the argument position its
	 * transaction handle must occupy.
	 *
	 * Listed by hand because no regex can infer which parameter is a connection;
	 * the sweep below derives the CALL SITES from the file, so a seam called
	 * twice is checked twice and a new call to a listed seam is covered the day
	 * it is written.
	 */
	const THREADED: { fn: string; position: "first" | "second" }[] = [
		// `applyMeetingMetaPatch(input, conn)` — the one with the defaulted
		// parameter, and so the only one a caller can get wrong silently.
		{ fn: "applyMeetingMetaPatch", position: "second" },
		// These two take the connection FIRST and have no default, so `tsc`
		// already catches an omission. They are swept anyway: the rule is "this
		// body writes only through its own transaction", and a reader checking
		// that should not have to know which seams happen to be type-safe.
		{ fn: "insertMeetingWithSlots", position: "first" },
		{ fn: "logActivity", position: "first" },
	];

	const apply = readSource(APPLY);

	it("reads the apply module at all", () => {
		// Vacuity floor: an empty read would pass every case below.
		expect(apply.length).toBeGreaterThan(500);
		expect(apply).toContain("applyPendingPlanLocked");
	});

	for (const { fn, position } of THREADED) {
		it(`${fn} is called with tx`, () => {
			// The arguments of each call, sliced to its own parentheses. Comment-
			// blind, so prose naming the seam is not mistaken for a call.
			const calls = [
				...apply.matchAll(new RegExp(`\\b${fn}\\s*\\(([^;]*?)\\)\\s*;`, "gs")),
			].map((m) => m[1] as string);
			expect(
				calls.length,
				`${fn} is not called in agenda-plan-apply.ts. Either it moved — re-point this guard — or the apply no longer writes through it.`,
			).toBeGreaterThan(0);

			for (const args of calls) {
				const threaded =
					position === "first"
						? /^\s*tx\s*,/.test(args)
						: /,\s*(?:\/\/[^\n]*\n\s*)*tx\s*,?\s*$/.test(
								args.replace(/\/\*[\s\S]*?\*\//g, ""),
							);
				expect(
					threaded,
					`a ${fn} call in agenda-plan-apply.ts does not pass tx as its ${position} argument. It would run on a second pooled connection: outside the club lock this transaction holds, and outside its rollback — so a refused batch would still have written that row.`,
				).toBe(true);
			}
		});
	}

	it("the apply never reaches for the pool directly", () => {
		// RAW — the "must be ABSENT" class. A bare `db.` anywhere in this body is
		// the same bug by a shorter route.
		const raw = readFileSync(APPLY, "utf8");
		expect(
			/\bdb\s*\.(?:select|insert|update|delete|transaction|query)\b/.test(raw),
			"agenda-plan-apply.ts touches `db` directly. Everything inside applyPendingPlanLocked must go through the `tx` it is handed.",
		).toBe(false);
	});

	it("the predicates can fail", () => {
		// Mutation verification against synthetic call sites, not by breaking the
		// real ones — without this the sweep passes whether or not the patterns
		// work, which is the failure shape it exists to prevent.
		const second = (args: string) =>
			/,\s*(?:\/\/[^\n]*\n\s*)*tx\s*,?\s*$/.test(args);
		const first = (args: string) => /^\s*tx\s*,/.test(args);
		expect(second("\n\t{ meetingId: id },\n\ttx,\n")).toBe(true);
		expect(second("\n\t{ meetingId: id },\n")).toBe(false);
		expect(first("\n\ttx,\n\t{ clubId },\n")).toBe(true);
		expect(first("\n\tdb,\n\t{ clubId },\n")).toBe(false);
	});
});
