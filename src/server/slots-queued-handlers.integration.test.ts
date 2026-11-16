/**
 * The REAL claimSlot / releaseSlot / reassignSlot handlers on a queued write
 * (#1638), against the test database, with only the session mocked
 * (`getSessionUser`) and the Start adapter reduced to "validate, then handle".
 *
 * protects=R4 at the handler, where the refusals that block a meeting's queue
 *   are raised BEFORE the transaction: an ended target (claim, reassign) and an
 *   archived club (release, reassign) answer `refused` and write nothing, but
 *   only for a caller whose session is established; a signed-out caller still
 *   hears the sign-in throw. R2 at the server: a `queuedBy` that is not the
 *   session's actor throws (the op stays queued) and writes nothing, an
 *   impersonating superadmin is compared by user id. P5: a plain Error that is
 *   not a known refusal (a dropped connection) still throws.
 * fails_when=a permanent cause is not mapped (the op wedges the queue), a
 *   transient cause or a sign-in refusal is mapped (the op is dropped), the
 *   ownership check is skipped or runs after a `refused` answer, or a plain
 *   Error is converted by type instead of by its known message.
 * no_claim=the online path's other cases (its own suites) and the holder
 *   comparison (slots-expected-holder.integration.test.ts).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	impersonationSessions,
	members,
	roleSlots,
	user,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { ROLE_OP_OTHER_USER_MESSAGE } from "#/lib/role-op-owner";
import {
	MEMBER_NOT_ELIGIBLE_MESSAGE,
	SIGN_IN_REQUIRED_MESSAGE,
} from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
	}),
}));
vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));
const archiveGate = vi.hoisted(() => ({ failWith: null as Error | null }));
vi.mock("#/server/guards", async (importOriginal) => {
	const original = await importOriginal<typeof import("#/server/guards")>();
	return {
		...original,
		getSessionUser: async () => session.user,
		assertClubNotArchived: async (
			...args: Parameters<typeof original.assertClubNotArchived>
		) => {
			if (archiveGate.failWith) throw archiveGate.failWith;
			return original.assertClubNotArchived(...args);
		},
	};
});

const { claimSlot, releaseSlot, reassignSlot } = await import("#/server/slots");

// The adapter above makes each server fn a plain `({ data }) => result`.
type Fn = (input: { data: Record<string, unknown> }) => Promise<{
	ok: boolean;
	reason?: string;
	message?: string;
}>;
const claim = claimSlot as unknown as Fn;
const release = releaseSlot as unknown as Fn;
const reassign = reassignSlot as unknown as Fn;

let seeded: SeededClub | null = null;
const extraUsers: string[] = [];

beforeEach(() => {
	session.user = null;
	archiveGate.failWith = null;
});

afterEach(async () => {
	if (seeded) {
		await cleanup(seeded.clubId, [
			seeded.adminUserId,
			seeded.memberUserId,
			...extraUsers,
		]);
		seeded = null;
		extraUsers.length = 0;
	}
});

async function seedLiveClub(): Promise<SeededClub> {
	const s = await seedClub();
	seeded = s;
	return s;
}

const holderOf = async (slotId: string) =>
	(
		await testDb
			.select({ m: roleSlots.assignedMemberId, status: roleSlots.status })
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId))
	)[0];

const hold = (slotId: string, memberId: string | null) =>
	testDb
		.update(roleSlots)
		.set({ assignedMemberId: memberId, status: memberId ? "claimed" : "open" })
		.where(eq(roleSlots.id, slotId));

const endMember = (memberId: string) =>
	testDb
		.update(members)
		.set({ status: "inactive" })
		.where(eq(members.id, memberId));

const archive = (clubId: string) =>
	testDb
		.update(clubs)
		.set({ archivedAt: new Date() })
		.where(eq(clubs.id, clubId));

describe.skipIf(!hasTestDb)(
	"queued role writes at the handlers (#1638)",
	() => {
		// protects=R4/P1 for the target checks raised before the transaction;
		// fails_when=requireMemberInClub's throw is not mapped on the queued path;
		// no_claim=a signed-out claim (the anonymous name-pick is a legitimate caller).
		it("an ended member: a queued claim and a queued reassign answer refused and write nothing", async () => {
			const s = await seedLiveClub();
			session.user = { id: s.adminUserId };
			await endMember(s.memberId);

			const c = await claim({
				data: {
					slotId: s.slotId,
					memberId: s.memberId,
					actorMemberId: s.adminMemberId,
					expectedHolder: null,
				},
			});
			expect(c).toMatchObject({
				ok: false,
				reason: "refused",
				message: MEMBER_NOT_ELIGIBLE_MESSAGE,
			});
			expect((await holderOf(s.slotId))?.m ?? null).toBeNull();

			await hold(s.slotId, s.adminMemberId);
			const r = await reassign({
				data: {
					slotId: s.slotId,
					memberId: s.memberId,
					expectedHolder: `m:${s.adminMemberId}`,
				},
			});
			expect(r).toMatchObject({
				ok: false,
				reason: "refused",
				message: MEMBER_NOT_ELIGIBLE_MESSAGE,
			});
			expect((await holderOf(s.slotId))?.m).toBe(s.adminMemberId);
		});

		it("the online path (no expectedHolder) still throws for an ended member", async () => {
			const s = await seedLiveClub();
			session.user = { id: s.adminUserId };
			await endMember(s.memberId);
			await expect(
				claim({
					data: {
						slotId: s.slotId,
						memberId: s.memberId,
						actorMemberId: s.adminMemberId,
					},
				}),
			).rejects.toThrow(MEMBER_NOT_ELIGIBLE_MESSAGE);
		});

		// protects=R4/P1 for the archive refusal raised by requireSessionActor;
		// fails_when=it is not mapped (the op wedges the queue) or is answered
		//   before the session is established (a signed-out caller learns the club
		//   is archived);
		// no_claim=a non-member's refusal (not on this roster), which stays a throw.
		it("an archived club: a queued release and reassign answer refused when signed in; signed out still throws sign-in", async () => {
			const s = await seedLiveClub();
			await hold(s.slotId, s.adminMemberId);
			await archive(s.clubId);
			const expectedHolder = `m:${s.adminMemberId}`;

			session.user = null;
			await expect(
				release({ data: { slotId: s.slotId, expectedHolder } }),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);
			await expect(
				reassign({
					data: { slotId: s.slotId, memberId: s.memberId, expectedHolder },
				}),
			).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);

			session.user = { id: s.adminUserId };
			const a = await release({ data: { slotId: s.slotId, expectedHolder } });
			expect(a).toMatchObject({
				ok: false,
				reason: "refused",
				message: CLUB_ARCHIVED_MESSAGE,
			});
			const b = await reassign({
				data: { slotId: s.slotId, memberId: s.memberId, expectedHolder },
			});
			expect(b).toMatchObject({
				ok: false,
				reason: "refused",
				message: CLUB_ARCHIVED_MESSAGE,
			});
			expect((await holderOf(s.slotId))?.m).toBe(s.adminMemberId);
		});

		it("a signed-in user with no membership here still throws, not refused", async () => {
			const s = await seedLiveClub();
			await hold(s.slotId, s.adminMemberId);
			await archive(s.clubId);
			const outsider = `outsider-${s.clubId}`;
			await testDb.insert(user).values({
				id: outsider,
				name: "Outsider",
				email: `${outsider}@test.example`,
				emailVerified: true,
			});
			extraUsers.push(outsider);
			session.user = { id: outsider };
			await expect(
				release({
					data: { slotId: s.slotId, expectedHolder: `m:${s.adminMemberId}` },
				}),
			).rejects.toThrow();
			expect((await holderOf(s.slotId))?.m).toBe(s.adminMemberId);
		});

		// protects=R2 at the server: the op replays only under the member who
		//   queued it; the throw keeps the op queued;
		// fails_when=the comparison is dropped or inverted, or runs after the write;
		// no_claim=the client's own check (use-offline-minutes tests).
		it("queuedBy: a mismatch throws and writes nothing; a match proceeds", async () => {
			const s = await seedLiveClub();
			session.user = { id: s.adminUserId };
			await hold(s.slotId, s.adminMemberId);
			const base = { slotId: s.slotId, expectedHolder: `m:${s.adminMemberId}` };
			const other = { queuedBy: s.memberId, queuedByUserId: s.memberUserId };

			await expect(release({ data: { ...base, ...other } })).rejects.toThrow(
				ROLE_OP_OTHER_USER_MESSAGE,
			);
			await expect(
				reassign({ data: { ...base, memberId: s.memberId, ...other } }),
			).rejects.toThrow(ROLE_OP_OTHER_USER_MESSAGE);
			expect((await holderOf(s.slotId))?.m).toBe(s.adminMemberId);

			const ok = await release({
				data: {
					...base,
					queuedBy: s.adminMemberId,
					queuedByUserId: s.adminUserId,
				},
			});
			expect(ok).toEqual({ ok: true });
			expect((await holderOf(s.slotId))?.status).toBe("open");
		});

		it("queuedBy: another member's claim throws before a refused answer for an ended target", async () => {
			const s = await seedLiveClub();
			session.user = { id: s.adminUserId };
			await endMember(s.memberId);
			await expect(
				claim({
					data: {
						slotId: s.slotId,
						memberId: s.memberId,
						actorMemberId: s.adminMemberId,
						expectedHolder: null,
						queuedBy: s.memberId,
						queuedByUserId: s.memberUserId,
					},
				}),
			).rejects.toThrow(ROLE_OP_OTHER_USER_MESSAGE);
		});

		it("queuedBy on an archived club: another user's op throws instead of answering refused", async () => {
			const s = await seedLiveClub();
			await hold(s.slotId, s.adminMemberId);
			await archive(s.clubId);
			session.user = { id: s.adminUserId };
			await expect(
				release({
					data: {
						slotId: s.slotId,
						expectedHolder: `m:${s.adminMemberId}`,
						queuedBy: s.memberId,
						queuedByUserId: s.memberUserId,
					},
				}),
			).rejects.toThrow(ROLE_OP_OTHER_USER_MESSAGE);
		});

		// protects=the superadmin impersonator has no member; both sides are null
		//   and the identity is the USER id;
		// fails_when=null === null is read as "the same person", so any other
		//   memberless superadmin could replay the op.
		// no_claim=a read-only impersonation (write-blind, refused earlier).
		it("an impersonating superadmin is compared by user id", async () => {
			const s = await seedLiveClub();
			const su = `su-${s.clubId}`;
			const other = `su2-${s.clubId}`;
			await testDb.insert(user).values([
				{
					id: su,
					name: "SU",
					email: `${su}@test.example`,
					emailVerified: true,
					isSuperadmin: true,
				},
				{
					id: other,
					name: "SU2",
					email: `${other}@test.example`,
					emailVerified: true,
					isSuperadmin: true,
				},
			]);
			extraUsers.push(su, other);
			await testDb.insert(impersonationSessions).values({
				superadminUserId: su,
				clubId: s.clubId,
				mode: "read_write",
				reason: "test",
				expiresAt: new Date(Date.now() + 3600_000),
			});
			session.user = { id: su };
			await hold(s.slotId, s.adminMemberId);
			const base = {
				slotId: s.slotId,
				expectedHolder: `m:${s.adminMemberId}`,
				queuedBy: null,
			};

			await expect(
				release({ data: { ...base, queuedByUserId: other } }),
			).rejects.toThrow(ROLE_OP_OTHER_USER_MESSAGE);
			expect((await holderOf(s.slotId))?.m).toBe(s.adminMemberId);

			expect(await release({ data: { ...base, queuedByUserId: su } })).toEqual({
				ok: true,
			});
			expect((await holderOf(s.slotId))?.status).toBe("open");
		});

		// protects=P5: only a KNOWN refusal is permanent; a dropped connection, or a
		//   plain Error with any other message, still throws so the op stays queued;
		// fails_when=refusedBy converts every plain Error again.
		it("a plain Error inside a wrapped step still throws; a known refusal message is converted", async () => {
			const s = await seedLiveClub();
			session.user = { id: s.adminUserId };
			await hold(s.slotId, s.adminMemberId);
			const args = { slotId: s.slotId, expectedHolder: `m:${s.adminMemberId}` };

			archiveGate.failWith = new Error("Connection terminated unexpectedly");
			await expect(release({ data: args })).rejects.toThrow(
				"Connection terminated",
			);
			expect((await holderOf(s.slotId))?.m).toBe(s.adminMemberId);

			archiveGate.failWith = new Error(CLUB_ARCHIVED_MESSAGE);
			expect(await release({ data: args })).toMatchObject({
				ok: false,
				reason: "refused",
				message: CLUB_ARCHIVED_MESSAGE,
			});
		});
	},
);
