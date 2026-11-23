/**
 * DB-backed tests for `merge_guests` and `convert_guest` (#1664).
 *
 * protects=the preview writes nothing and the apply goes through the app's own
 * merge / convert / link writers, only with the hash the preview returned;
 * fails_when=a preview writes, an apply without or with a stale hash writes, a
 * refusal the app gives is not blocked, or a plain member can call either tool;
 * no_claim=the writers' own lock order and internals, which
 * `guest-merge*.integration.test.ts` and `guest-convert*.integration.test.ts` own.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiTokens, guests, members, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { mergeGuestsTool } = await import("#/server/mcp/tools/merge-guests");
const { convertGuestTool } = await import("#/server/mcp/tools/convert-guest");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { NOT_OFFICER_MESSAGE } = await import("#/server/mcp/authz-logic");
const { GUEST_MERGE_CONVERTED_MESSAGE } = await import(
	"#/server/guest-merge-logic"
);
const { LINK_ALREADY_JOINED_MESSAGE, CONVERT_NAME_CLASH_MESSAGE } =
	await import("#/lib/guest-convert");

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
	mergeGuestsTool.handler(input, {
		rawToken: token,
		audience: mergeGuestsTool.audience,
	});
const convert = (token: string, input: Record<string, unknown>) =>
	convertGuestTool.handler(input, {
		rawToken: token,
		audience: convertGuestTool.audience,
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
	// biome-ignore lint/suspicious/noExplicitAny: the two tools' plans differ
	plan: any;
}

async function setup() {
	const s = await seedClub();
	seeded.push(s);
	return { s, token: await tokenFor(s.adminUserId) };
}

async function mkGuest(
	clubId: string,
	name: string,
	extra: Partial<typeof guests.$inferInsert> & { email?: string } = {},
) {
	const [g] = await testDb
		.insert(guests)
		.values(await withGuestPerson({ clubId, name, ...extra }, testDb))
		.returning({ id: guests.id });
	if (!g) throw new Error("seed guest failed");
	return g.id;
}

const guestRow = async (id: string) =>
	(await testDb.select().from(guests).where(eq(guests.id, id)))[0];

async function holdSlot(slotId: string, guestId: string) {
	await testDb
		.update(roleSlots)
		.set({ assignedMemberId: null, assignedGuestId: guestId })
		.where(eq(roleSlots.id, slotId));
}

describe.skipIf(!hasTestDb)("merge_guests (#1664)", () => {
	it("previews without writing, then applies with the hash and moves the absorbed guest's slot", async () => {
		const { s, token } = await setup();
		const keep = await mkGuest(s.clubId, "David Kim", { email: "d@x.com" });
		const absorb = await mkGuest(s.clubId, "Dave Kim");
		await holdSlot(s.slotId, absorb);
		const input = {
			clubId: s.clubId,
			keepGuestId: keep,
			absorbGuestId: absorb,
		};

		const p = (await merge(token, input)) as Preview;
		expect(p.applied).toBe(false);
		expect(p.plan.keep.name).toBe("David Kim");
		expect(p.plan.keep.emailMasked).not.toContain("d@x.com");
		expect(p.plan.absorb.name).toBe("Dave Kim");
		expect(p.plan.moved.role_slots).toBe(1);
		expect(p.plan.blocking).toEqual([]);
		expect(await guestRow(absorb)).toBeDefined();
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, s.slotId));
		expect(slot?.assignedGuestId).toBe(absorb);

		const r = await merge(token, { ...input, planHash: p.planHash });
		expect((r as { applied: boolean }).applied).toBe(true);
		expect(await guestRow(absorb)).toBeUndefined();
		const [after] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, s.slotId));
		expect(after?.assignedGuestId).toBe(keep);
	});

	it("an apply after either record changed is PLAN_STALE and writes nothing", async () => {
		const { s, token } = await setup();
		const keep = await mkGuest(s.clubId, "David Kim");
		const absorb = await mkGuest(s.clubId, "Dave Kim");
		const input = {
			clubId: s.clubId,
			keepGuestId: keep,
			absorbGuestId: absorb,
		};
		const p = (await merge(token, input)) as Preview;

		await testDb
			.update(guests)
			.set({ name: "Davey Kim" })
			.where(eq(guests.id, absorb));
		const o = await outcome(merge(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) {
			expect(o.code).toBe("PLAN_STALE");
			expect(
				(o.err as { detail?: { plan?: unknown } }).detail?.plan,
			).toBeDefined();
		}
		expect(await guestRow(absorb)).toBeDefined();
	});

	it("an apply with no matching hash is refused, not applied", async () => {
		const { s, token } = await setup();
		const keep = await mkGuest(s.clubId, "A One");
		const absorb = await mkGuest(s.clubId, "B Two");
		const o = await outcome(
			merge(token, {
				clubId: s.clubId,
				keepGuestId: keep,
				absorbGuestId: absorb,
				planHash: "0".repeat(64),
			}),
		);
		expect(o.ok).toBe(false);
		if (!o.ok) expect(o.code).toBe("PLAN_STALE");
		expect(await guestRow(absorb)).toBeDefined();
	});

	it("a converted guest is a blocking item with the app's sentence, and apply is BLOCKED", async () => {
		const { s, token } = await setup();
		const keep = await mkGuest(s.clubId, "A One");
		const absorb = await mkGuest(s.clubId, "B Two", {
			stage: "joined",
			convertedMembershipId: s.memberId,
		});
		const input = {
			clubId: s.clubId,
			keepGuestId: keep,
			absorbGuestId: absorb,
		};
		const p = (await merge(token, input)) as Preview;
		expect(p.plan.blocking).toEqual([
			{ code: "MERGE_REFUSED", message: GUEST_MERGE_CONVERTED_MESSAGE },
		]);
		const o = await outcome(merge(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) expect(o.code).toBe("BLOCKED");
		expect(await guestRow(absorb)).toBeDefined();
	});

	it("the same guest twice is blocked, and a guest of another club is NOT_FOUND", async () => {
		const { s, token } = await setup();
		const { s: other } = await setup();
		const a = await mkGuest(s.clubId, "A One");
		const p = (await merge(token, {
			clubId: s.clubId,
			keepGuestId: a,
			absorbGuestId: a,
		})) as Preview;
		expect(p.plan.blocking).toHaveLength(1);
		const foreign = await mkGuest(other.clubId, "Zed");
		const o = await outcome(
			merge(token, {
				clubId: s.clubId,
				keepGuestId: a,
				absorbGuestId: foreign,
			}),
		);
		expect(o.ok).toBe(false);
		if (!o.ok) expect(o.code).toBe("NOT_FOUND");
	});

	it("a member-audience token cannot call it", async () => {
		const { s } = await setup();
		const memberToken = await tokenFor(s.memberUserId);
		const a = await mkGuest(s.clubId, "A One");
		const b = await mkGuest(s.clubId, "B Two");
		const o = await outcome(
			merge(memberToken, {
				clubId: s.clubId,
				keepGuestId: a,
				absorbGuestId: b,
			}),
		);
		expect(o.ok).toBe(false);
		if (!o.ok) {
			expect(o.code).toBe("FORBIDDEN");
			expect(o.message).toBe(NOT_OFFICER_MESSAGE);
		}
		expect(await guestRow(b)).toBeDefined();
	});
});

describe.skipIf(!hasTestDb)("convert_guest (#1664)", () => {
	it("previews a new member without writing, then converts with the hash", async () => {
		const { s, token } = await setup();
		const g = await mkGuest(s.clubId, "Priya Raman", { email: "p@x.com" });
		await holdSlot(s.slotId, g);
		const input = { clubId: s.clubId, guestId: g };

		const p = (await convert(token, input)) as Preview;
		expect(p.applied).toBe(false);
		expect(p.plan.mode).toBe("create_member");
		expect(p.plan.guest.heldSlotCount).toBe(1);
		expect(p.plan.guest.emailMasked).not.toContain("p@x.com");
		expect(p.plan.blocking).toEqual([]);
		expect((await guestRow(g))?.stage).not.toBe("joined");

		const r = (await convert(token, { ...input, planHash: p.planHash })) as {
			applied: boolean;
			memberId: string;
		};
		expect(r.applied).toBe(true);
		const after = await guestRow(g);
		expect(after?.stage).toBe("joined");
		expect(after?.convertedMembershipId).toBe(r.memberId);
		const [m] = await testDb
			.select()
			.from(members)
			.where(and(eq(members.id, r.memberId), eq(members.clubId, s.clubId)));
		expect(m?.name).toBe("Priya Raman");
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, s.slotId));
		expect(slot?.assignedMemberId).toBe(r.memberId);
		expect(slot?.assignedGuestId).toBeNull();
	});

	it("previews a link to an existing member, then links with the hash", async () => {
		const { s, token } = await setup();
		const g = await mkGuest(s.clubId, "Priya Raman");
		await holdSlot(s.slotId, g);
		const input = { clubId: s.clubId, guestId: g, memberId: s.memberId };

		const p = (await convert(token, input)) as Preview;
		expect(p.plan.mode).toBe("link_to_member");
		expect(p.plan.member.id).toBe(s.memberId);
		expect((await guestRow(g))?.convertedMembershipId).toBeNull();

		const r = (await convert(token, { ...input, planHash: p.planHash })) as {
			applied: boolean;
			movedSlotCount: number;
		};
		expect(r.applied).toBe(true);
		expect(r.movedSlotCount).toBe(1);
		const after = await guestRow(g);
		expect(after?.stage).toBe("joined");
		expect(after?.convertedMembershipId).toBe(s.memberId);
	});

	it("an apply after the guest changed is PLAN_STALE and writes nothing", async () => {
		const { s, token } = await setup();
		const g = await mkGuest(s.clubId, "Priya Raman");
		const input = { clubId: s.clubId, guestId: g };
		const p = (await convert(token, input)) as Preview;
		await holdSlot(s.slotId, g);
		const o = await outcome(convert(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) expect(o.code).toBe("PLAN_STALE");
		expect((await guestRow(g))?.stage).not.toBe("joined");
	});

	it("a guest already linked is blocking for a link, with the app's sentence", async () => {
		const { s, token } = await setup();
		const g = await mkGuest(s.clubId, "Priya Raman", {
			stage: "joined",
			convertedMembershipId: s.memberId,
		});
		const input = { clubId: s.clubId, guestId: g, memberId: s.adminMemberId };
		const p = (await convert(token, input)) as Preview;
		expect(p.plan.blocking).toEqual([
			{ code: "GUEST_ALREADY_CONVERTED", message: LINK_ALREADY_JOINED_MESSAGE },
		]);
		const o = await outcome(convert(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) expect(o.code).toBe("BLOCKED");
	});

	it("a former member as the link target is blocking", async () => {
		const { s, token } = await setup();
		const g = await mkGuest(s.clubId, "Priya Raman");
		await testDb
			.update(members)
			.set({ status: "former" })
			.where(eq(members.id, s.memberId));
		const p = (await convert(token, {
			clubId: s.clubId,
			guestId: g,
			memberId: s.memberId,
		})) as Preview;
		expect(p.plan.blocking.map((b: { code: string }) => b.code)).toEqual([
			"MEMBER_FORMER",
		]);
	});

	it("a name already on the roster is refused at apply as BLOCKED with the app's sentence", async () => {
		const { s, token } = await setup();
		const [m] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, s.memberId));
		const g = await mkGuest(s.clubId, m?.name ?? "x");
		const input = { clubId: s.clubId, guestId: g };
		const p = (await convert(token, input)) as Preview;
		const o = await outcome(convert(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) {
			expect(o.code).toBe("BLOCKED");
			expect(o.message).toBe(CONVERT_NAME_CLASH_MESSAGE);
		}
		expect((await guestRow(g))?.stage).not.toBe("joined");
	});

	it("unknown guest or member is NOT_FOUND", async () => {
		const { s, token } = await setup();
		const g = await mkGuest(s.clubId, "Priya Raman");
		const a = await outcome(
			convert(token, { clubId: s.clubId, guestId: randomUUID() }),
		);
		const b = await outcome(
			convert(token, { clubId: s.clubId, guestId: g, memberId: randomUUID() }),
		);
		for (const o of [a, b]) {
			expect(o.ok).toBe(false);
			if (!o.ok) expect(o.code).toBe("NOT_FOUND");
		}
	});

	it("a member-audience token cannot call it", async () => {
		const { s } = await setup();
		const memberToken = await tokenFor(s.memberUserId);
		const g = await mkGuest(s.clubId, "Priya Raman");
		const o = await outcome(
			convert(memberToken, { clubId: s.clubId, guestId: g }),
		);
		expect(o.ok).toBe(false);
		if (!o.ok) expect(o.code).toBe("FORBIDDEN");
		expect((await guestRow(g))?.stage).not.toBe("joined");
	});
});
