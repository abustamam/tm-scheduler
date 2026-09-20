/**
 * The schedule top-up runs ONCE, before planning, and never inside a
 * transaction (#808, AC4).
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
 * The other half is that it is called AT ALL. A club's recurrence rule
 * materialises future meetings on authenticated reads (ADR-0021), which token
 * calls never reach, so without this an LLM planning three months out proposes
 * CREATING meetings the club is about to generate for itself.
 * `list-meetings.ts` is the standing precedent.
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

describe("the agenda top-up (#808, AC4)", () => {
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
