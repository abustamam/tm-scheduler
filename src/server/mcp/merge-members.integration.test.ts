/**
 * DB-backed tests for `merge_members` (#1665).
 *
 * protects=the preview writes nothing, the apply goes through the app's own
 * `applyMemberMerge` only with the hash the preview returned, and only a club
 * admin may call it; fails_when=a preview writes, an apply without or with a
 * stale hash writes, a refusal the app gives is not blocked, a member of another
 * club is reachable, an officer who is not an admin can merge, or a raw email or
 * phone is returned; no_claim=the writer's own lock order and re-pointing, which
 * `member-merge*.integration.test.ts` and `membership-collapse*` own.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubs,
	members,
	officerTerms,
	roleSlots,
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

const { mergeMembersTool } = await import("#/server/mcp/tools/merge-members");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { NOT_OFFICER_MESSAGE } = await import("#/server/mcp/authz-logic");
const {
	applyMemberMerge,
	MEMBER_MERGE_SAME_MESSAGE,
	MEMBER_MERGE_SIGNED_IN_MESSAGE,
} = await import("#/server/members-logic");
const { NO_PERMISSION_MESSAGE } = await import("#/lib/permission-message");
const { CLUB_ARCHIVED_MESSAGE } = await import("#/lib/club-archive");

const seeded: SeededClub[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

const merge = (token: string, input: Record<string, unknown>) =>
	mergeMembersTool.handler(input, {
		rawToken: token,
		audience: mergeMembersTool.audience,
	});

async function outcome(p: Promise<unknown>) {
	try {
		return { ok: true as const, value: await p };
	} catch (e) {
		const err = e as { code?: string; message: string; detail?: unknown };
		return { ok: false as const, code: err.code, message: err.message, err };
	}
}

interface Preview {
	applied: boolean;
	planHash: string;
	// biome-ignore lint/suspicious/noExplicitAny: plan shape asserted per test
	plan: any;
}

async function setup() {
	const s = await seedClub();
	seeded.push(s);
	return { s, token: await tokenFor(s.adminUserId) };
}

async function mkMember(
	clubId: string,
	name: string,
	contact: { email?: string; phone?: string } = {},
) {
	const personId = await seedPerson({ name, ...contact });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	if (!m) throw new Error("seed member failed");
	return m.id;
}

const memberExists = async (id: string) =>
	(await testDb.select().from(members).where(eq(members.id, id))).length === 1;

const counts = async (clubId: string) => ({
	members: (
		await testDb.select().from(members).where(eq(members.clubId, clubId))
	).length,
	activity: (
		await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.clubId, clubId))
	).length,
});

const holdSlot = (slotId: string, memberId: string) =>
	testDb
		.update(roleSlots)
		.set({ assignedMemberId: memberId })
		.where(eq(roleSlots.id, slotId));

describe.skipIf(!hasTestDb)("merge_members (#1665)", () => {
	it("a preview writes nothing; apply with its hash merges exactly as applyMemberMerge does", async () => {
		const a = await setup();
		const keepA = await mkMember(a.s.clubId, "David Kim");
		const absorbA = await mkMember(a.s.clubId, "Dave Kim");
		await holdSlot(a.s.slotId, absorbA);
		const input = {
			clubId: a.s.clubId,
			keepMemberId: keepA,
			absorbMemberId: absorbA,
		};

		const before = await counts(a.s.clubId);
		const p = (await merge(a.token, input)) as Preview;
		expect(p.applied).toBe(false);
		expect(p.plan.keep.name).toBe("David Kim");
		expect(p.plan.absorb.name).toBe("Dave Kim");
		expect(p.plan.moved["role_slots.assigned_member_id"]).toBe(1);
		expect(p.plan.blocking).toEqual([]);
		expect(await counts(a.s.clubId)).toEqual(before);
		expect(await memberExists(absorbA)).toBe(true);

		const r = (await merge(a.token, { ...input, planHash: p.planHash })) as {
			applied: boolean;
		};
		expect(r.applied).toBe(true);

		// The same seed through the writer directly.
		const b = await setup();
		const keepB = await mkMember(b.s.clubId, "David Kim");
		const absorbB = await mkMember(b.s.clubId, "Dave Kim");
		await holdSlot(b.s.slotId, absorbB);
		await applyMemberMerge({
			clubId: b.s.clubId,
			keeperId: keepB,
			absorbedId: absorbB,
			actorMemberId: b.s.adminMemberId,
		});

		expect(await counts(a.s.clubId)).toEqual(await counts(b.s.clubId));
		expect(await memberExists(absorbA)).toBe(false);
		expect(await memberExists(absorbB)).toBe(false);
		const slotA = (
			await testDb.select().from(roleSlots).where(eq(roleSlots.id, a.s.slotId))
		)[0];
		const slotB = (
			await testDb.select().from(roleSlots).where(eq(roleSlots.id, b.s.slotId))
		)[0];
		expect(slotA?.assignedMemberId).toBe(keepA);
		expect(slotB?.assignedMemberId).toBe(keepB);
		const logs = (clubId: string) =>
			testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, clubId),
						eq(activityLog.action, "member_merge"),
					),
				);
		expect((await logs(a.s.clubId)).length).toBe(1);
		expect((await logs(b.s.clubId)).length).toBe(1);
	});

	it("an apply after either member changed is PLAN_STALE and writes nothing", async () => {
		const { s, token } = await setup();
		const keep = await mkMember(s.clubId, "David Kim");
		const absorb = await mkMember(s.clubId, "Dave Kim");
		const input = {
			clubId: s.clubId,
			keepMemberId: keep,
			absorbMemberId: absorb,
		};
		const p = (await merge(token, input)) as Preview;
		await testDb
			.update(members)
			.set({ name: "Davey Kim" })
			.where(eq(members.id, absorb));
		const before = await counts(s.clubId);
		const o = await outcome(merge(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) {
			expect(o.code).toBe("PLAN_STALE");
			expect(
				(o.err as { detail?: { plan?: unknown } }).detail?.plan,
			).toBeDefined();
		}
		expect(await counts(s.clubId)).toEqual(before);
	});

	it("a changed raw email behind the same mask is PLAN_STALE", async () => {
		const { s, token } = await setup();
		const keep = await mkMember(s.clubId, "A One");
		const absorb = await mkMember(s.clubId, "B Two", { email: "bob@x.com" });
		const input = {
			clubId: s.clubId,
			keepMemberId: keep,
			absorbMemberId: absorb,
		};
		const p = (await merge(token, input)) as Preview;
		const { people } = await import("#/db/schema");
		await testDb
			.update(people)
			.set({ email: "bab@x.com" })
			.where(eq(people.email, "bob@x.com"));
		const o = await outcome(merge(token, { ...input, planHash: p.planHash }));
		expect(o).toMatchObject({ ok: false, code: "PLAN_STALE" });
		expect(await memberExists(absorb)).toBe(true);
	});

	it("absorbing a signed-in member is blocked with the app's sentence; apply is BLOCKED and writes nothing", async () => {
		const { s, token } = await setup();
		const keep = await mkMember(s.clubId, "Plain Keeper");
		const input = {
			clubId: s.clubId,
			keepMemberId: keep,
			absorbMemberId: s.memberId,
		};
		const p = (await merge(token, input)) as Preview;
		expect(p.plan.blocking).toEqual([
			{ code: "MERGE_REFUSED", message: MEMBER_MERGE_SIGNED_IN_MESSAGE },
		]);
		const before = await counts(s.clubId);
		const o = await outcome(merge(token, { ...input, planHash: p.planHash }));
		expect(o).toMatchObject({
			ok: false,
			code: "BLOCKED",
		});
		expect(await counts(s.clubId)).toEqual(before);
		expect(await memberExists(s.memberId)).toBe(true);
	});

	it("the same member on both sides is blocked", async () => {
		const { s, token } = await setup();
		const m = await mkMember(s.clubId, "Solo");
		const input = { clubId: s.clubId, keepMemberId: m, absorbMemberId: m };
		const p = (await merge(token, input)) as Preview;
		expect(p.plan.blocking).toEqual([
			{ code: "MERGE_REFUSED", message: MEMBER_MERGE_SAME_MESSAGE },
		]);
		const o = await outcome(merge(token, { ...input, planHash: p.planHash }));
		expect(o).toMatchObject({ ok: false, code: "BLOCKED" });
		expect(await memberExists(m)).toBe(true);
	});

	it("a member of another club is NOT_FOUND", async () => {
		const { s, token } = await setup();
		const other = await seedClub();
		seeded.push(other);
		const keep = await mkMember(s.clubId, "Mine");
		const theirs = await mkMember(other.clubId, "Theirs");
		const o = await outcome(
			merge(token, {
				clubId: s.clubId,
				keepMemberId: keep,
				absorbMemberId: theirs,
			}),
		);
		expect(o).toMatchObject({ ok: false, code: "NOT_FOUND" });
		expect(await memberExists(theirs)).toBe(true);
	});

	it("an officer who is not an admin is refused, in preview and apply", async () => {
		const { s } = await setup();
		await testDb.insert(officerTerms).values({
			membershipId: s.memberId,
			position: "vp_education",
			termStart: new Date(Date.now() - 86_400_000),
			termEnd: null,
		});
		const officerToken = await tokenFor(s.memberUserId);
		const keep = await mkMember(s.clubId, "K");
		const absorb = await mkMember(s.clubId, "A");
		const input = {
			clubId: s.clubId,
			keepMemberId: keep,
			absorbMemberId: absorb,
		};
		const o = await outcome(merge(officerToken, input));
		expect(o).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
			message: NO_PERMISSION_MESSAGE,
		});
		const o2 = await outcome(
			merge(officerToken, { ...input, planHash: "0".repeat(64) }),
		);
		expect(o2).toMatchObject({ ok: false, code: "FORBIDDEN" });
		expect(await memberExists(absorb)).toBe(true);
	});

	it("a plain member is refused as for any officer tool", async () => {
		const { s } = await setup();
		const o = await outcome(
			merge(await tokenFor(s.memberUserId), {
				clubId: s.clubId,
				keepMemberId: s.adminMemberId,
				absorbMemberId: s.memberId,
			}),
		);
		expect(o).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
			message: NOT_OFFICER_MESSAGE,
		});
	});

	it("an archived club is refused", async () => {
		const { s, token } = await setup();
		const keep = await mkMember(s.clubId, "K");
		const absorb = await mkMember(s.clubId, "A");
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, s.clubId));
		const o = await outcome(
			merge(token, {
				clubId: s.clubId,
				keepMemberId: keep,
				absorbMemberId: absorb,
			}),
		);
		expect(o).toMatchObject({
			ok: false,
			code: "ARCHIVED",
			message: CLUB_ARCHIVED_MESSAGE,
		});
	});

	it("never returns a raw email or phone", async () => {
		const { s, token } = await setup();
		const keep = await mkMember(s.clubId, "K", {
			email: "keeper.address@example.com",
			phone: "+15551234567",
		});
		const absorb = await mkMember(s.clubId, "A", {
			email: "absorb.address@example.com",
			phone: "+15559876543",
		});
		const input = {
			clubId: s.clubId,
			keepMemberId: keep,
			absorbMemberId: absorb,
		};
		const p = (await merge(token, input)) as Preview;
		const r = await merge(token, { ...input, planHash: p.planHash });
		for (const body of [JSON.stringify(p), JSON.stringify(r)]) {
			expect(body).not.toContain("keeper.address@example.com");
			expect(body).not.toContain("absorb.address@example.com");
			expect(body).not.toContain("5551234567");
			expect(body).not.toContain("5559876543");
		}
		expect(p.plan.keep.emailMasked).toBe("k•••@example.com");
		expect(p.plan.absorb.phoneMasked).toBe("•••-6543");
	});
});
