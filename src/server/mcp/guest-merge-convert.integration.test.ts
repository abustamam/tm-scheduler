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
import {
	apiTokens,
	guests,
	meetingAttendance,
	meetingGuestRsvps,
	meetings,
	members,
	officerTerms,
	people,
	roleSlots,
	speeches,
} from "#/db/schema";
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
const {
	GUEST_MERGE_CONVERTED_MESSAGE,
	GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE,
	GUEST_MERGE_PERSON_LINKED_MESSAGE,
} = await import("#/server/guest-merge-logic");
const { GUEST_ALREADY_CONVERTED_MESSAGE } = await import(
	"#/server/guest-pipeline-logic"
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
	extra: Partial<typeof guests.$inferInsert> & {
		email?: string;
		phone?: string;
	} = {},
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
			expect(
				(o.err as { detail?: { blocking?: unknown } }).detail?.blocking,
			).toEqual([
				{ code: "CONVERT_REFUSED", message: CONVERT_NAME_CLASH_MESSAGE },
			]);
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

async function pastMeeting(clubId: string, daysAgo: number): Promise<string> {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() - daysAgo * 86_400_000),
			status: "completed",
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("seed meeting failed");
	return m.id;
}

const personOf = async (guestId: string) => {
	const g = await guestRow(guestId);
	if (!g) throw new Error("no guest");
	return g.personId;
};

describe.skipIf(!hasTestDb)("merge_guests, review round (#1664)", () => {
	it("moves the absorbed guest's visits and RSVP: plan counts and both visit counts, then the kept guest holds them", async () => {
		const { s, token } = await setup();
		const keep = await mkGuest(s.clubId, "David Kim");
		const absorb = await mkGuest(s.clubId, "Dave Kim");
		const m1 = await pastMeeting(s.clubId, 3);
		const m2 = await pastMeeting(s.clubId, 10);
		await testDb.insert(meetingAttendance).values([
			{ meetingId: m1, guestId: absorb, status: "present" },
			{ meetingId: m2, guestId: absorb, status: "present" },
		]);
		await testDb.insert(meetingGuestRsvps).values({
			clubId: s.clubId,
			meetingId: s.meetingId,
			guestId: absorb,
			clientKey: randomUUID(),
		});
		const input = {
			clubId: s.clubId,
			keepGuestId: keep,
			absorbGuestId: absorb,
		};

		const p = (await merge(token, input)) as Preview;
		expect(p.plan.moved.meeting_attendance).toBe(2);
		expect(p.plan.moved.meeting_guest_rsvps).toBe(1);
		expect(p.plan.absorb.visitCount).toBe(2);
		expect(p.plan.keep.visitCount).toBe(0);

		await merge(token, { ...input, planHash: p.planHash });
		const rows = await testDb
			.select()
			.from(meetingAttendance)
			.where(eq(meetingAttendance.guestId, keep));
		expect(rows).toHaveLength(2);
		const rsvps = await testDb
			.select()
			.from(meetingGuestRsvps)
			.where(eq(meetingGuestRsvps.guestId, keep));
		expect(rsvps).toHaveLength(1);
		expect(await guestRow(absorb)).toBeUndefined();
	});

	it("a change to the KEPT record after the preview is PLAN_STALE", async () => {
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
			.set({ name: "David K. Kim" })
			.where(eq(guests.id, keep));
		const o = await outcome(merge(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) expect(o.code).toBe("PLAN_STALE");
		expect(await guestRow(absorb)).toBeDefined();
	});

	it("a raw email change that leaves the masked form unchanged is PLAN_STALE", async () => {
		const { s, token } = await setup();
		const keep = await mkGuest(s.clubId, "David Kim", {
			email: "jane@x.com",
		});
		const absorb = await mkGuest(s.clubId, "Dave Kim");
		const input = {
			clubId: s.clubId,
			keepGuestId: keep,
			absorbGuestId: absorb,
		};
		const p = (await merge(token, input)) as Preview;
		expect(p.plan.keep.emailMasked).toBe("j•••@x.com");
		await testDb
			.update(people)
			.set({ email: "julia@x.com" })
			.where(eq(people.id, await personOf(keep)));
		const o = await outcome(merge(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) {
			expect(o.code).toBe("PLAN_STALE");
			// The fresh plan still shows the same masked form: only the raw differs.
			const fresh = (o.err as { detail?: { plan?: Preview["plan"] } }).detail;
			expect(fresh?.plan?.keep.emailMasked).toBe("j•••@x.com");
		}
		expect(await guestRow(absorb)).toBeDefined();
	});

	it("two different people is a blocking item with the app's sentence and apply is BLOCKED", async () => {
		const { s, token } = await setup();
		const { s: other } = await setup();
		const keep = await mkGuest(s.clubId, "David Kim");
		const absorb = await mkGuest(s.clubId, "Dave Kim");
		// Another guest row (another club) names the absorbed guest's Person.
		await mkGuest(other.clubId, "Dave Kim", {
			personId: await personOf(absorb),
		});
		const input = {
			clubId: s.clubId,
			keepGuestId: keep,
			absorbGuestId: absorb,
		};
		const p = (await merge(token, input)) as Preview;
		expect(p.plan.blocking).toEqual([
			{
				code: "MERGE_REFUSED",
				message: GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE,
			},
		]);
		const o = await outcome(merge(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) {
			expect(o.code).toBe("BLOCKED");
			expect(
				(o.err as { detail?: { blocking?: unknown } }).detail?.blocking,
			).toEqual([
				{
					code: "MERGE_REFUSED",
					message: GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE,
				},
			]);
		}
		expect(await guestRow(absorb)).toBeDefined();
	});

	it("a person-linked guest (a speech on their Person) is blocking and apply is BLOCKED", async () => {
		const { s, token } = await setup();
		const keep = await mkGuest(s.clubId, "David Kim");
		const absorb = await mkGuest(s.clubId, "Dave Kim");
		await testDb
			.insert(speeches)
			.values({ personId: await personOf(absorb), title: "Person-owned" });
		const input = {
			clubId: s.clubId,
			keepGuestId: keep,
			absorbGuestId: absorb,
		};
		const p = (await merge(token, input)) as Preview;
		expect(p.plan.blocking).toEqual([
			{
				code: "MERGE_REFUSED",
				message: GUEST_MERGE_PERSON_LINKED_MESSAGE,
			},
		]);
		const o = await outcome(merge(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) expect(o.code).toBe("BLOCKED");
		expect(await guestRow(absorb)).toBeDefined();
	});
});

describe.skipIf(!hasTestDb)("convert_guest, review round (#1664)", () => {
	/** A guest who dedupes onto the seeded member (phone + name agree). */
	async function reuseSetup(memberPatch: Partial<typeof members.$inferInsert>) {
		const { s, token } = await setup();
		await testDb
			.update(people)
			.set({ phone: "+15550001111" })
			.where(eq(people.id, s.personId));
		if (Object.keys(memberPatch).length > 0) {
			await testDb
				.update(members)
				.set(memberPatch)
				.where(eq(members.id, s.memberId));
		}
		const g = await mkGuest(s.clubId, "Member User", { phone: "+15550001111" });
		await holdSlot(s.slotId, g);
		return { s, token, g };
	}
	const membershipRow = async (id: string) =>
		(await testDb.select().from(members).where(eq(members.id, id)))[0];

	it("preview of a lapsed ADMIN with an open officer term shows reactivation, demotion and the closing term, and writes nothing", async () => {
		const { s, token, g } = await reuseSetup({
			status: "former",
			endedAt: "2024-05-01",
			clubRole: "admin",
		});
		await testDb
			.insert(officerTerms)
			.values({ membershipId: s.memberId, position: "president" });
		const p = (await convert(token, {
			clubId: s.clubId,
			guestId: g,
		})) as Preview;

		expect(p.plan.membership).toMatchObject({
			kind: "reuse_existing_membership",
			membershipId: s.memberId,
			priorStatus: "former",
			priorClubRole: "admin",
			reactivatedFrom: "former",
			priorEndedAt: "2024-05-01",
			demotedFrom: "admin",
			closedOfficerPositions: ["president"],
		});
		// Nothing written: membership, officer term, guest and slot as seeded.
		const m = await membershipRow(s.memberId);
		expect(m?.status).toBe("former");
		expect(m?.clubRole).toBe("admin");
		expect(m?.endedAt).toBe("2024-05-01");
		const terms = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, s.memberId));
		expect(terms).toHaveLength(1);
		expect(terms[0]?.termEnd).toBeNull();
		expect((await guestRow(g))?.stage).not.toBe("joined");
		expect((await guestRow(g))?.convertedMembershipId).toBeNull();
		const [slot] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, s.slotId));
		expect(slot?.assignedGuestId).toBe(g);
		expect(slot?.assignedMemberId).toBeNull();
	});

	it("applying that preview's hash does the reactivation, demotion and term close it showed", async () => {
		const { s, token, g } = await reuseSetup({
			status: "inactive",
			clubRole: "admin",
		});
		await testDb
			.insert(officerTerms)
			.values({ membershipId: s.memberId, position: "treasurer" });
		const input = { clubId: s.clubId, guestId: g };
		const p = (await convert(token, input)) as Preview;
		const r = (await convert(token, { ...input, planHash: p.planHash })) as {
			reactivated: boolean;
			demotedFrom: string | null;
			closedOfficerPositions: string[];
			memberId: string;
		};
		expect(r).toMatchObject({
			reactivated: true,
			demotedFrom: "admin",
			closedOfficerPositions: ["treasurer"],
			memberId: s.memberId,
		});
		const m = await membershipRow(s.memberId);
		expect(m?.status).toBe("active");
		expect(m?.clubRole).toBe("member");
		expect((await guestRow(g))?.stage).toBe("joined");
	});

	it("a new member preview says new_member and a roster name clash is a blocking item, not an error", async () => {
		const { s, token } = await setup();
		const fresh = await mkGuest(s.clubId, "Brand New");
		const p1 = (await convert(token, {
			clubId: s.clubId,
			guestId: fresh,
		})) as Preview;
		expect(p1.plan.membership).toEqual({ kind: "new_member" });

		const clash = await mkGuest(s.clubId, "Member User");
		const p2 = (await convert(token, {
			clubId: s.clubId,
			guestId: clash,
		})) as Preview;
		expect(p2.plan.blocking).toEqual([
			{ code: "CONVERT_REFUSED", message: CONVERT_NAME_CLASH_MESSAGE },
		]);
		expect(p2.plan.membership).toBeNull();
	});

	it("an already-converted guest is blocking with the app's sentence", async () => {
		const { s, token } = await setup();
		const g = await mkGuest(s.clubId, "Priya Raman", {
			stage: "joined",
			convertedMembershipId: s.memberId,
		});
		const p = (await convert(token, {
			clubId: s.clubId,
			guestId: g,
		})) as Preview;
		expect(p.plan.blocking).toEqual([
			{
				code: "GUEST_ALREADY_CONVERTED",
				message: GUEST_ALREADY_CONVERTED_MESSAGE,
			},
		]);
	});

	it("a change to the guest's RAW email that keeps the masked form is PLAN_STALE", async () => {
		const { s, token } = await setup();
		const g = await mkGuest(s.clubId, "Priya Raman", { email: "jane@x.com" });
		const input = { clubId: s.clubId, guestId: g };
		const p = (await convert(token, input)) as Preview;
		expect(p.plan.guest.emailMasked).toBe("j•••@x.com");
		await testDb
			.update(people)
			.set({ email: "julia@x.com" })
			.where(eq(people.id, await personOf(g)));
		const o = await outcome(convert(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) expect(o.code).toBe("PLAN_STALE");
		expect((await guestRow(g))?.stage).not.toBe("joined");
	});

	it("a reused member's raw email change after the preview is PLAN_STALE", async () => {
		const { s, token, g } = await reuseSetup({});
		const input = { clubId: s.clubId, guestId: g };
		const p = (await convert(token, input)) as Preview;
		await testDb
			.update(people)
			.set({ email: "changed@x.com" })
			.where(eq(people.id, s.personId));
		const o = await outcome(convert(token, { ...input, planHash: p.planHash }));
		expect(o.ok).toBe(false);
		if (!o.ok) expect(o.code).toBe("PLAN_STALE");
	});

	it("cross-club: another club's guest, or another club's member, is NOT_FOUND and nothing is written", async () => {
		const { s, token } = await setup();
		const { s: other } = await setup();
		const mine = await mkGuest(s.clubId, "Priya Raman");
		const foreign = await mkGuest(other.clubId, "Zed Foreign");
		const a = await outcome(
			convert(token, { clubId: s.clubId, guestId: foreign }),
		);
		const b = await outcome(
			convert(token, {
				clubId: s.clubId,
				guestId: mine,
				memberId: other.memberId,
			}),
		);
		for (const o of [a, b]) {
			expect(o.ok).toBe(false);
			if (!o.ok) expect(o.code).toBe("NOT_FOUND");
		}
		expect((await guestRow(foreign))?.stage).not.toBe("joined");
		expect((await guestRow(mine))?.convertedMembershipId).toBeNull();
	});
});
