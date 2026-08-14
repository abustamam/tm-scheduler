/**
 * DB-backed integration tests for superadmin read-only impersonation (#185):
 * the session lifecycle (start/end/expiry, one-active-per-superadmin), the audit
 * row, and — the security-critical guarantee — that an active session grants the
 * READ-access guards but the WRITE guards (`requireClubRole` / `requireMembership`)
 * still reject the impersonating superadmin by construction.
 *
 * Runs against a real Postgres identified by TEST_DATABASE_URL; skipped when unset.
 *
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test_185 \
 *     bunx vitest run src/server/impersonation.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	impersonationSessions,
	members,
	user,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

import { logActivity } from "./activity";
import {
	canManageClub,
	requireClubAdminView,
	requireClubRole,
	requireClubViewAccess,
	requireMembership,
} from "./guards";
import {
	endImpersonation,
	getActiveImpersonation,
	getActiveImpersonationForUser,
	IMPERSONATION_RW_TTL_MS,
	IMPERSONATION_TTL_MS,
	startImpersonation,
} from "./impersonation-logic";

const extraClubs: string[] = [];
const extraUsers: string[] = [];

async function seedSuperadmin(): Promise<{ id: string; email: string }> {
	const id = randomUUID();
	const email = `super-${id}@test.example`;
	await testDb.insert(user).values({
		id,
		name: "Super Admin",
		email,
		emailVerified: true,
		isSuperadmin: true,
	});
	extraUsers.push(id);
	return { id, email };
}

async function seedBareClub(): Promise<string> {
	const id = randomUUID();
	await testDb
		.insert(clubs)
		.values({ id, name: "Other Club", slug: `other-${id}` });
	extraClubs.push(id);
	return id;
}

describe.skipIf(!hasTestDb)("superadmin impersonation (integration)", () => {
	let seeded: SeededClub;

	beforeEach(async () => {
		seeded = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		for (const c of extraClubs.splice(0)) {
			await testDb.delete(clubs).where(eq(clubs.id, c));
		}
		for (const u of extraUsers.splice(0)) {
			await testDb.delete(user).where(eq(user.id, u));
		}
	});

	it("grants read access to real members/admins via 'member'", async () => {
		const view = await requireClubViewAccess(
			seeded.memberUserId,
			seeded.clubId,
		);
		expect(view.via).toBe("member");
		expect(view.impersonating).toBe(false);

		const admin = await requireClubAdminView(seeded.adminUserId, seeded.clubId);
		expect(admin.via).toBe("member");

		// A plain member is not an admin and has no session → admin view rejects.
		await expect(
			requireClubAdminView(seeded.memberUserId, seeded.clubId),
		).rejects.toThrow(/permission/i);
	});

	it("an active session grants READ access but WRITE guards still reject", async () => {
		const su = await seedSuperadmin();

		// No session yet → no read access, no ambient bypass.
		expect(await getActiveImpersonation(su.id, seeded.clubId)).toBeNull();
		await expect(requireClubViewAccess(su.id, seeded.clubId)).rejects.toThrow();

		await startImpersonation(su.id, { clubId: seeded.clubId });

		// Reads now pass via impersonation…
		const view = await requireClubViewAccess(su.id, seeded.clubId);
		expect(view.via).toBe("impersonation");
		expect(view.impersonating).toBe(true);
		expect(view.membership).toBeNull();
		const admin = await requireClubAdminView(su.id, seeded.clubId);
		expect(admin.via).toBe("impersonation");

		// …but the WRITE guards are impersonation-blind → writes reject.
		await expect(
			requireClubRole(su.id, seeded.clubId, ["admin"]),
		).rejects.toThrow();
		await expect(requireMembership(su.id, seeded.clubId)).rejects.toThrow();
	});

	it("an ARCHIVED club is readable by nobody — impersonation included (#560)", async () => {
		const su = await seedSuperadmin();
		await startImpersonation(su.id, { clubId: seeded.clubId });

		// Controls: while the club is live, both the member and the impersonating
		// superadmin read it. Without these the archived assertions below would pass
		// on a gate that rejects everything.
		await expect(
			requireClubViewAccess(seeded.memberUserId, seeded.clubId),
		).resolves.toMatchObject({ via: "member" });
		await expect(
			requireClubViewAccess(su.id, seeded.clubId),
		).resolves.toMatchObject({ via: "impersonation" });

		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seeded.clubId));

		// The club's own member is locked out…
		await expect(
			requireClubViewAccess(seeded.memberUserId, seeded.clubId),
		).rejects.toThrow(/archived/i);

		// …and so is a superadmin holding an active read-only session. The exemption
		// this test used to pin was dropped: the console already hides "View as this
		// club" for an archived club, so it was unreachable in the direction it was
		// meant for, and because the member arm returned first it was silently
		// overridden for an operator who was also a member — which made the two gates
		// answer OPPOSITELY for a superadmin with a plain membership. Archived means
		// no club surface serves it; `requireSuperadmin` (the console) is the way in.
		await expect(requireClubViewAccess(su.id, seeded.clubId)).rejects.toThrow(
			/archived/i,
		);
		await expect(requireClubAdminView(su.id, seeded.clubId)).rejects.toThrow(
			/archived/i,
		);

		// And the write path was already closed, for both real and impersonated actors.
		await startImpersonation(su.id, {
			clubId: seeded.clubId,
			mode: "read_write",
			reason: "reviewing a takedown appeal",
		});
		await expect(requireMembership(su.id, seeded.clubId)).rejects.toThrow(
			/archived/i,
		);
	});

	it("both read gates agree for a superadmin who is ALSO a member of the archived club (#560)", async () => {
		// The case the single-axis fixture above cannot see, and the one the dropped
		// exemption got wrong in both directions: the member arm returned before the
		// impersonation arm was consulted, so `requireClubViewAccess` threw while
		// `requireClubAdminView` — whose two member arms a plain member falls through
		// — reached the impersonation arm and GRANTED. The weaker gate denied what the
		// stronger one allowed.
		const su = await seedSuperadmin();
		const person = await seedPerson({ userId: su.id, name: "Super Member" });
		await testDb.insert(members).values({
			clubId: seeded.clubId,
			personId: person,
			name: "Super Member",
			email: `super-member-${su.id}@test.example`,
			clubRole: "member",
			status: "active",
		});
		await startImpersonation(su.id, { clubId: seeded.clubId });

		// Control: live club — the member arm grants on the view gate, and the admin
		// gate falls through to impersonation, so both resolve.
		await expect(
			requireClubViewAccess(su.id, seeded.clubId),
		).resolves.toMatchObject({ via: "member" });
		await expect(
			requireClubAdminView(su.id, seeded.clubId),
		).resolves.toMatchObject({ via: "impersonation" });

		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seeded.clubId));

		// Archived: both gates now give the SAME answer. Asserted as a pair on
		// purpose — the defect was the disagreement, not either verdict alone.
		await expect(requireClubViewAccess(su.id, seeded.clubId)).rejects.toThrow(
			/archived/i,
		);
		await expect(requireClubAdminView(su.id, seeded.clubId)).rejects.toThrow(
			/archived/i,
		);
	});

	it("scopes the session to one club and revokes on end + expiry", async () => {
		const su = await seedSuperadmin();
		const other = await seedBareClub();
		await startImpersonation(su.id, { clubId: seeded.clubId });

		// Not granted for a different club.
		expect(await getActiveImpersonation(su.id, other)).toBeNull();
		await expect(requireClubViewAccess(su.id, other)).rejects.toThrow();

		// Expired sessions don't count (simulate "now" past expiry).
		const future = new Date(Date.now() + IMPERSONATION_TTL_MS + 1000);
		expect(
			await getActiveImpersonation(su.id, seeded.clubId, future),
		).toBeNull();

		// Explicit end revokes immediately.
		await endImpersonation(su.id);
		expect(await getActiveImpersonation(su.id, seeded.clubId)).toBeNull();
		await expect(requireClubViewAccess(su.id, seeded.clubId)).rejects.toThrow();
	});

	it("keeps at most one active session per superadmin", async () => {
		const su = await seedSuperadmin();
		const clubB = await seedBareClub();
		await startImpersonation(su.id, { clubId: seeded.clubId });
		await startImpersonation(su.id, { clubId: clubB });

		const active = await getActiveImpersonationForUser(su.id);
		expect(active?.clubId).toBe(clubB);
		// The first club's session is no longer active.
		expect(await getActiveImpersonation(su.id, seeded.clubId)).toBeNull();

		const open = await testDb
			.select({ id: impersonationSessions.id })
			.from(impersonationSessions)
			.where(
				and(
					eq(impersonationSessions.superadminUserId, su.id),
					// still-open rows
					eq(impersonationSessions.mode, "read_only"),
				),
			);
		expect(open).toHaveLength(2); // both rows kept as history; only one open
	});

	it("writes a superadmin_viewed audit row on the club at start", async () => {
		const su = await seedSuperadmin();
		await startImpersonation(su.id, { clubId: seeded.clubId });

		const rows = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seeded.clubId),
					eq(activityLog.action, "superadmin_viewed"),
				),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.targetType).toBe("club");
		expect(rows[0]?.actorMemberId).toBeNull();
		expect(
			(rows[0]?.detail as { superadminUserId?: string })?.superadminUserId,
		).toBe(su.id);
	});

	// --- Read-write "act as admin" phase (#246) ---------------------------------

	it("read_write session grants the WRITE guards as a memberless effective-admin", async () => {
		const su = await seedSuperadmin();
		await startImpersonation(su.id, {
			clubId: seeded.clubId,
			mode: "read_write",
			reason: "fixing a broken agenda",
		});

		// requireMembership resolves — memberless (id null), attributed to the superadmin.
		const m = await requireMembership(su.id, seeded.clubId);
		expect(m.id).toBeNull();
		expect(m.clubRole).toBe("admin");
		expect(m.impersonatedBy).toBe(su.id);

		// requireClubRole passes for admin AND member requirements (full parity).
		const asAdmin = await requireClubRole(su.id, seeded.clubId, ["admin"]);
		expect(asAdmin.impersonatedBy).toBe(su.id);
		const asMember = await requireClubRole(su.id, seeded.clubId, ["member"]);
		expect(asMember.impersonatedBy).toBe(su.id);

		// Reads still work too.
		const view = await requireClubAdminView(su.id, seeded.clubId);
		expect(view.via).toBe("impersonation");
	});

	it("read_write requires a reason", async () => {
		const su = await seedSuperadmin();
		await expect(
			startImpersonation(su.id, { clubId: seeded.clubId, mode: "read_write" }),
		).rejects.toThrow(/reason/i);
		// And no session/audit row leaked from the failed start.
		expect(await getActiveImpersonationForUser(su.id)).toBeNull();
	});

	it("read_write uses the shorter 15-minute TTL", async () => {
		const su = await seedSuperadmin();
		const before = Date.now();
		const session = await startImpersonation(su.id, {
			clubId: seeded.clubId,
			mode: "read_write",
			reason: "support fix",
		});
		const life = session.expiresAt.getTime() - before;
		// ~15 min, and well under the 60-min read-only window.
		expect(life).toBeGreaterThan(IMPERSONATION_RW_TTL_MS - 5000);
		expect(life).toBeLessThan(IMPERSONATION_RW_TTL_MS + 5000);
		expect(life).toBeLessThan(IMPERSONATION_TTL_MS);
	});

	it("read_write start logs superadmin_acted with the reason", async () => {
		const su = await seedSuperadmin();
		await startImpersonation(su.id, {
			clubId: seeded.clubId,
			mode: "read_write",
			reason: "correcting the roster",
		});
		const rows = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seeded.clubId),
					eq(activityLog.action, "superadmin_acted"),
				),
			);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.actorMemberId).toBeNull();
		expect(rows[0]?.impersonatedBy).toBe(su.id);
		const detail = rows[0]?.detail as { reason?: string; mode?: string };
		expect(detail?.reason).toBe("correcting the roster");
		expect(detail?.mode).toBe("read_write");
	});

	it("logActivity attributes an impersonated write to the superadmin (actor null)", async () => {
		const su = await seedSuperadmin();
		// The resolved actor (from the request session in production) is passed
		// explicitly here: impersonated_by is set and actor_member_id forced null,
		// even though a member id was supplied.
		await logActivity(testDb, {
			clubId: seeded.clubId,
			actorMemberId: seeded.memberId,
			action: "member_edit",
			targetType: "member",
			targetId: seeded.memberId,
			impersonatedBy: su.id,
		});
		const [row] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seeded.clubId),
					eq(activityLog.action, "member_edit"),
				),
			);
		expect(row?.impersonatedBy).toBe(su.id);
		expect(row?.actorMemberId).toBeNull();
	});

	it("canManageClub: admin + read_write grant; member/none/read_only do not", async () => {
		const su = await seedSuperadmin();

		// Real admin manages; real plain member does not.
		expect(await canManageClub(seeded.adminUserId, seeded.clubId)).toBe(true);
		expect(await canManageClub(seeded.memberUserId, seeded.clubId)).toBe(false);

		// Superadmin with no session — no ambient management.
		expect(await canManageClub(su.id, seeded.clubId)).toBe(false);

		// read_only impersonation does NOT surface admin write affordances.
		await startImpersonation(su.id, { clubId: seeded.clubId });
		expect(await canManageClub(su.id, seeded.clubId)).toBe(false);

		// read_write impersonation does.
		await startImpersonation(su.id, {
			clubId: seeded.clubId,
			mode: "read_write",
			reason: "managing a meeting",
		});
		expect(await canManageClub(su.id, seeded.clubId)).toBe(true);
	});

	it("logActivity leaves ordinary writes unattributed to a superadmin", async () => {
		// No request/session in tests → resolveImpersonatedWriteActor returns null,
		// so a normal write keeps its member actor and no impersonated_by.
		await logActivity(testDb, {
			clubId: seeded.clubId,
			actorMemberId: seeded.adminMemberId,
			action: "member_edit",
			targetType: "member",
			targetId: seeded.memberId,
		});
		const [row] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seeded.clubId),
					eq(activityLog.action, "member_edit"),
				),
			);
		expect(row?.impersonatedBy).toBeNull();
		expect(row?.actorMemberId).toBe(seeded.adminMemberId);
	});
});
