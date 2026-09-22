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

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveSelfAssertGrant } = await import("./meeting-authz-logic");

const SLOT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

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
				sessionMembership: null,
				hasSession: false,
			}),
		).toEqual({ granted: true, actorMemberId: SLOT });
	});

	// ── The session arms ─────────────────────────────────────────────────────
	it("grants a signed-in caller whose own membership IS the slot holder", () => {
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: SLOT,
				sessionMembership: { id: SLOT },
				hasSession: true,
			}),
		).toEqual({ granted: true, actorMemberId: SLOT });
	});

	it("refuses a signed-in caller asserting somebody ELSE's id — the bug", () => {
		// An ordinary member of the club, signed in, who falls past the admin arm
		// and claims the Toastmaster's id off the public payload. Before #747 this
		// granted, and `activity_log` credited the innocent member.
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: SLOT,
				sessionMembership: { id: OTHER },
				hasSession: true,
			}),
		).toEqual({ granted: false, actorMemberId: null });
	});

	it("refuses a session with NO membership in this club", () => {
		// An outsider holding an account — and the read-only impersonating
		// superadmin with them, who has no membership here by construction. The
		// `hasSession` flag is what distinguishes this from the anonymous grant
		// above, which is why it is a separate argument from `sessionMembership`
		// rather than derived from it.
		expect(
			resolveSelfAssertGrant({
				selfMemberId: SLOT,
				slotMemberId: SLOT,
				sessionMembership: null,
				hasSession: true,
			}),
		).toEqual({ granted: false, actorMemberId: null });
	});

	// ── The slot is still what authorizes ────────────────────────────────────
	it("refuses when the claim does not match the slot, session or not", () => {
		for (const hasSession of [true, false]) {
			expect(
				resolveSelfAssertGrant({
					selfMemberId: OTHER,
					slotMemberId: SLOT,
					sessionMembership: { id: OTHER },
					hasSession,
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
				sessionMembership: { id: SLOT },
				hasSession: true,
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
					sessionMembership: { id: SLOT },
					hasSession: true,
				}),
			).toEqual({ granted: false, actorMemberId: null });
		}
	});

	// ── What it credits ──────────────────────────────────────────────────────
	it("credits the SLOT holder, never the id off the wire", () => {
		// They are equal on every granting path by construction, and that is the
		// point: `actorMemberId` is what `logActivity` stamps (#396), so it must
		// come from the row the server read, not from the payload. Pinned so a
		// future edit that returns `selfMemberId` here reads as the change it is.
		const granted = resolveSelfAssertGrant({
			selfMemberId: SLOT,
			slotMemberId: SLOT,
			sessionMembership: { id: SLOT },
			hasSession: true,
		});
		expect(granted.actorMemberId).toBe(SLOT);
		const refused = resolveSelfAssertGrant({
			selfMemberId: SLOT,
			slotMemberId: SLOT,
			sessionMembership: { id: OTHER },
			hasSession: true,
		});
		expect(refused.actorMemberId).toBeNull();
	});
});
