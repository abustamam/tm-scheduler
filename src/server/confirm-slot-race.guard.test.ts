/**
 * The self arm's conditional UPDATE must re-assert the holder (#661).
 *
 * ## Why this is a source guard and not an integration test
 *
 * The defect is a check-then-act window. `confirmSlotCore` reads the slot
 * OUTSIDE its transaction and takes no `FOR UPDATE`, so `resolveConfirmGrant`
 * decides on a snapshot; the write then has to re-assert what the snapshot
 * claimed. Reaching that window from vitest means landing a reassignment
 * between the read and the UPDATE of another in-flight call — a race the suite
 * can only lose or win by timing, which is a flaky test rather than a gate.
 *
 * The sequential version of the scenario does NOT exercise this clause: reassign
 * first and the pre-transaction read already sees the new holder, so
 * `resolveConfirmGrant` rejects with `NOT_THE_SLOT_HOLDER` and the UPDATE is
 * never reached. `slots-confirm.integration.test.ts` covers that path. So the
 * clause is unreachable from execution in both directions, and the source is the
 * only place it can be pinned.
 *
 * ## What it is protecting
 *
 * Status alone does not close the window, because a reassignment is not a
 * release. `reassignSlotCore` sets `assignedMemberId` to the new holder and
 * leaves `status` at `'claimed'`, so an `id` + `status` match still fires.
 * Without the holder predicate, Alice confirming while the VPE reassigns to Bob
 * flips BOB's slot to `confirmed` — a role he never accepted, rendering as
 * `Coming · assumed` — and writes the `coming` plan row for ALICE, who by then
 * holds nothing. Found by the authorization review pass on PR #696.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SRC = "src/server/slots-logic.ts";

/** The `confirmSlotCore` body, comment-blind so prose cannot satisfy a match. */
function confirmSlotCoreBody(): string {
	const src = readSource(SRC);
	const start = src.indexOf("async function confirmSlotCore");
	expect(start, `no confirmSlotCore declaration in ${SRC}`).toBeGreaterThan(-1);
	// Stop at the next top-level declaration so a sibling function's UPDATE can
	// never be miscredited to this one — the body-slicing lesson #565 recorded.
	const rest = src.slice(start + 1);
	const nextDecl = rest.search(
		/\n(?:export )?(?:async )?function |\ntype |\nconst /,
	);
	return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

describe("confirmSlot's self arm closes its check-then-act window (#661)", () => {
	it("re-asserts the holder inside the conditional UPDATE", () => {
		const body = confirmSlotCoreBody();
		// The grant is the only thing that carries a VERIFIED holder id, so the
		// predicate must read from it rather than from the pre-transaction row —
		// `slot.assignedMemberId` is exactly the stale value the window is about.
		expect(body).toMatch(
			/eq\(\s*roleSlots\.assignedMemberId\s*,\s*grant\.holderMemberId\s*\)/,
		);
		expect(body).not.toMatch(
			/eq\(\s*roleSlots\.assignedMemberId\s*,\s*slot\.assignedMemberId\s*\)/,
		);
	});

	it("still gates the flip on 'claimed', so a concurrent release wins", () => {
		const body = confirmSlotCoreBody();
		expect(body).toMatch(/eq\(\s*roleSlots\.status\s*,\s*"claimed"\s*\)/);
	});

	it("can actually fail — the slicer finds the body it claims to read", () => {
		// Without this the two assertions above pass whether or not the slicer
		// works: an empty body would fail them, but a body that silently swept in
		// the WHOLE module would pass them for the wrong reason, matching some
		// other function's predicates. Pin a string only this function carries.
		const body = confirmSlotCoreBody();
		expect(body).toContain("grantedVia: grant.via");
		expect(body.length).toBeLessThan(readSource(SRC).length);
	});
});
