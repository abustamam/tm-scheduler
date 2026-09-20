/**
 * The shared pending-plan lifecycle's pure half (#812).
 *
 * The expiry/grace/cutoff cases are NOT duplicated here. They live in
 * `guest-book-pending.test.ts`, which imports them through the re-export this
 * change left behind — so those cases now prove both the arithmetic and AC8's
 * claim that no importer needed an edit. Copying them would leave the re-export
 * untested by anything, which is the half that can silently break.
 *
 * What is here is what the move ADDED: the tool vocabulary, the sweep's report,
 * and an identity check that the re-export really is the same symbol.
 */
import { describe, expect, it } from "vitest";
import * as guestBook from "./guest-book-pending";
import {
	describePendingSweep,
	isPendingPlanExpired,
	MCP_PENDING_TOOLS,
	PENDING_PLAN_GRACE_MS,
	PENDING_PLAN_TTL_MS,
	pendingPlanExpiresAt,
	pendingPlanSweepCutoff,
} from "./pending-plan";

describe("the tool vocabulary", () => {
	it("names both tools that own a pending plan", () => {
		// `upsert_agendas` is declared before #808 builds it, and deliberately:
		// merging the tables means an id no longer says which tool made it, so the
		// assertion that a guest-book id opened with the AGENDA tool answers
		// not_found needs the second value to exist today. It is exercised by
		// `guest-book-confirm.integration.test.ts`, not dead.
		expect([...MCP_PENDING_TOOLS]).toEqual([
			"record_guest_book",
			"upsert_agendas",
		]);
		// Distinct, and that is the whole property: a discriminator whose members
		// collide discriminates nothing.
		expect(new Set(MCP_PENDING_TOOLS).size).toBe(MCP_PENDING_TOOLS.length);
	});
});

describe("the sweep's report", () => {
	it("says nothing when it removed nothing", () => {
		// A tick that swept nothing is the common case — the poller runs on a
		// timer and rows expire on a 48-hour scale — so a line every tick would
		// bury the ones that matter.
		expect(describePendingSweep({ deleted: 0, byTool: {} })).toBeNull();
	});

	it("breaks the count down by tool", () => {
		const line = describePendingSweep({
			deleted: 4,
			byTool: { upsert_agendas: 1, record_guest_book: 3 },
		});
		expect(line).toContain("4");
		expect(line).toContain("record_guest_book 3");
		expect(line).toContain("upsert_agendas 1");
		// Sorted by NAME. The line is read across ticks, and a count-ordered
		// breakdown reorders itself between two runs that swept the same tools.
		expect(line?.indexOf("record_guest_book")).toBeLessThan(
			line?.indexOf("upsert_agendas") ?? -1,
		);
	});

	it("reports a tool this release has never heard of", () => {
		// Migrations apply at container startup with no drain, so a row written by
		// the NEXT release is swept by this one. This sweep is the only thing in
		// the system that deletes a pending plan, and a breakdown that silently
		// dropped an unknown key would under-report exactly that.
		const line = describePendingSweep({
			deleted: 2,
			byTool: { record_guest_book: 1, some_future_tool: 1 },
		});
		expect(line).toContain("some_future_tool 1");
	});
});

describe("the re-export the guest book kept (#812 AC8)", () => {
	it("is the same symbol, not a copy", () => {
		// IDENTITY, not equality of behaviour. Two spellings of the expiry window
		// that merely agree today are two windows; one symbol cannot drift. This
		// is what makes it safe for `guest-book-pending.test.ts` to keep testing
		// the arithmetic through the guest-book module.
		expect(guestBook.PENDING_PLAN_TTL_MS).toBe(PENDING_PLAN_TTL_MS);
		expect(guestBook.PENDING_PLAN_GRACE_MS).toBe(PENDING_PLAN_GRACE_MS);
		expect(guestBook.isPendingPlanExpired).toBe(isPendingPlanExpired);
		expect(guestBook.pendingPlanExpiresAt).toBe(pendingPlanExpiresAt);
		expect(guestBook.pendingPlanSweepCutoff).toBe(pendingPlanSweepCutoff);
	});
});

describe("the two refusal sentences the double-apply guard needs", () => {
	it("do not read the same", () => {
		// MEASURED, and the reason it is asserted rather than trusted: #806
		// shipped twice with these identical, and that made the LOCKED guard
		// untestable. `applyPendingPlan`'s cheap pre-check short-circuits every
		// serial case, so an assertion matching both sentences passed without the
		// locked guard ever running. A test can only prove it fires if it says
		// something only it says — which is a property of the PAIR, so it is
		// stated where both are declared.
		expect(guestBook.ALREADY_RECORDED_MESSAGE).not.toBe(
			guestBook.RECORDED_WHILE_OPEN_MESSAGE,
		);
		// And neither is empty, which would satisfy "not equal" while telling the
		// person who clicked nothing at all.
		expect(guestBook.ALREADY_RECORDED_MESSAGE.length).toBeGreaterThan(10);
		expect(guestBook.RECORDED_WHILE_OPEN_MESSAGE.length).toBeGreaterThan(10);
		// Same for the two expiry sentences, for the same reason: the pre-check
		// and the in-lock refusal are different events.
		expect(guestBook.EXPIRED_MESSAGE).not.toBe(
			guestBook.EXPIRED_IN_LOCK_MESSAGE,
		);
	});
});
