/**
 * `resolveSelfAssertGrant`'s truth table (#747, ADR-0026).
 *
 * The seam is pure, so this needs no database and runs on every `bun run test`
 * — the DB-backed half (`meeting-authz.integration.test.ts`) proves the four
 * arms actually route through it against real rows, and this proves the rule
 * those arms inherit. Split that way on purpose: the arms all share one
 * decision now, and a decision that is only ever exercised through four
 * integration fixtures is one that nobody can read as a table.
 *
 * `#/db` is mocked because importing `meeting-authz-logic.ts` pulls it in at
 * module load; nothing here reaches it.
 */
import { describe, expect, it, vi } from "vitest";
import type { SelfAssertSession } from "./meeting-authz-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveSelfAssertGrant } = await import("./meeting-authz-logic");

const SLOT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
/** The caller's SECOND membership in this club — one human, two Person rows. */
const SECOND = "33333333-3333-4333-8333-333333333333";

/** No session at all. */
const ANONYMOUS: SelfAssertSession = { present: false };
/** Signed in, holding exactly these memberships in this club. */
const signedIn = (...membershipIds: string[]): SelfAssertSession => ({
	present: true,
	membershipIds,
});

describe("resolveSelfAssertGrant (#747)", () => {
	// ── The anonymous path, unchanged ────────────────────────────────────────
	// The Toastmaster running the agenda from their phone with no account is the
	// workflow ADR-0010 built this for, and #747 does not touch it. Asserted
	// first because every refusal below is only acceptable while this holds.
	it("grants a caller with NO session whose claim matches the slot", () => {
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: SLOT,
				session: ANONYMOUS,
			}),
		).toEqual({ granted: true, actorMemberId: SLOT });
	});

	// ── The session arms ─────────────────────────────────────────────────────
	it("grants a signed-in caller whose own membership IS the slot holder", () => {
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: SLOT,
				session: signedIn(SLOT),
			}),
		).toEqual({ granted: true, actorMemberId: SLOT });
	});

	it("grants when the slot is held by the caller's OTHER membership here", () => {
		// The set, not the picked row. `people.user_id` has only a non-unique
		// index, so one human reachable through two Person rows in one club is
		// representable — and `resolveAdminGrant`'s five-key ORDER BY exists to
		// make the ADMIN answer deterministic (#804), not to say which membership
		// the human *is*. Binding against the top-ranked row alone would refuse a
		// member who genuinely holds the slot, and refuse them ONLY when signed
		// in, which is the same incoherence the lapsed-member case below rejects.
		//
		// `SECOND` is written second in the set so a "first element" binding fails
		// here rather than passing by luck.
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SECOND,
				slotMemberId: SECOND,
				session: signedIn(SLOT, SECOND),
			}),
		).toEqual({ granted: true, actorMemberId: SECOND });
	});

	it("refuses a signed-in caller asserting somebody ELSE's id — the bug", () => {
		// An ordinary member of the club, signed in, who falls past the admin arm
		// and claims the Toastmaster's id off the public payload. Before #747 this
		// granted, and `activity_log` credited the innocent member.
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: SLOT,
				session: signedIn(OTHER),
			}),
		).toEqual({ granted: false, actorMemberId: null });
	});

	it("refuses when the caller holds two memberships and NEITHER is the slot", () => {
		// The mirror of the grant above: widening the binding to a set must not
		// widen it to "any signed-in member".
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: SLOT,
				session: signedIn(OTHER, SECOND),
			}),
		).toEqual({ granted: false, actorMemberId: null });
	});

	it("refuses a session with NO membership in this club", () => {
		// An outsider holding an account — and the read-only impersonating
		// superadmin with them, who has no membership here by construction. An
		// EMPTY set with `present: true` is the case that must refuse; it is why
		// the union discriminates on presence rather than on the set being
		// non-empty.
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: SLOT,
				session: signedIn(),
			}),
		).toEqual({ granted: false, actorMemberId: null });
	});

	// ── The slot is still what authorizes ────────────────────────────────────
	it("refuses when the claim does not match the slot, session or not", () => {
		for (const session of [ANONYMOUS, signedIn(OTHER)]) {
			expect(
				resolveSelfAssertGrant({
					selfMemberId: OTHER,
					slotMemberId: SLOT,
					session,
				}),
			).toEqual({ granted: false, actorMemberId: null });
		}
	});

	it("refuses an unassigned slot even when the session matches the claim", () => {
		// ADR-0010: no TMOD assigned means no self-serve editor at all. A proven
		// session must not become a way to grant what the slot does not.
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: null,
				session: signedIn(SLOT),
			}),
		).toEqual({ granted: false, actorMemberId: null });
	});

	it("refuses a missing claim even when the session holds the slot", () => {
		// Null and undefined both, because the resolvers pass `input.selfMemberId`
		// straight through and the field is optional. A signed-in slot holder who
		// sends no claim gets nothing from this arm — the admin arm above is the
		// only one that grants without one.
		for (const selfMemberId of [null, undefined, ""]) {
			expect(
				resolveSelfAssertGrant({
					selfMemberId,
					slotMemberId: SLOT,
					session: signedIn(SLOT),
				}),
			).toEqual({ granted: false, actorMemberId: null });
		}
	});

	// ── What it credits ──────────────────────────────────────────────────────
	it("credits the verified id on a grant and nothing on a refusal", () => {
		// What this case can and cannot see, stated honestly. By the time the seam
		// credits anything, the claim and the slot are the same VALUE — the
		// equality check above is what let it through — so NO behavioural test can
		// tell "credits the slot" from "credits the payload". They are the same
		// number here.
		//
		// That is why the seam narrows to a single `verified` name past the check
		// and why `self-assert-binding.guard.test.ts` asserts, in the SOURCE, that
		// the credited expression is the slot-derived one. This case pins the half
		// that is observable: a grant credits that id, a refusal credits nobody.
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: SLOT,
				session: signedIn(SLOT),
			}).actorMemberId,
		).toBe(SLOT);
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: SLOT,
				session: signedIn(OTHER),
			}).actorMemberId,
		).toBeNull();
	});
});
