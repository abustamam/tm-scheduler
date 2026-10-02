/**
 * A phone number is a Person fact (#906): `people.phone` is the only phone
 * column, so an edit in one club is the number every club holding that Person
 * shows, and the number guest conversion dedupes on is the one officers edit.
 *
 * #561 was the divergence this closes: the roster edited `members.phone` while
 * convert matched on `people.phone`, so once the two differed a returning
 * member converted from the guest book minted a second Person.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, guests, members, people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	memberPhone,
	type SeededClub,
	seedClub,
	setMemberPhone,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMemberEdit } = await import("./members-logic");
const { applyConvertGuestToMember } = await import("./guest-pipeline-logic");
const { loadClubMembers, loadMemberProfile } = await import("./club-logic");
const { loadRosterWithContact } = await import("./meeting-contacts-logic");

/** A number no other run of this file uses, in E.164 so it stores verbatim. */
function uniquePhone(): string {
	const n = Number.parseInt(randomUUID().replace(/-/g, "").slice(0, 8), 16);
	return `+1415${String(n % 10_000_000).padStart(7, "0")}`;
}

async function addGuest(
	clubId: string,
	g: { name: string; email?: string | null; phone?: string | null },
): Promise<string> {
	const [row] = await testDb
		.insert(guests)
		.values({
			clubId,
			name: g.name,
			email: g.email ?? null,
			phone: g.phone ?? null,
			stage: "prospect",
		})
		.returning({ id: guests.id });
	if (!row) throw new Error("guest insert failed");
	return row.id;
}

async function memberEmail(memberId: string): Promise<string> {
	const [m] = await testDb
		.select({ email: people.email })
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(eq(members.id, memberId));
	if (!m?.email) throw new Error("seeded member has no email");
	return m.email;
}

describe.skipIf(!hasTestDb)("people.phone is the one phone (#906)", () => {
	let a: SeededClub;
	let b: SeededClub;

	beforeEach(async () => {
		a = await seedClub();
		b = await seedClub();
	});
	afterEach(async () => {
		await cleanup(a.clubId, [a.adminUserId, a.memberUserId]);
		await cleanup(b.clubId, [b.adminUserId, b.memberUserId]);
	});

	it("club A's edit is the number club B reads for the same Person", async () => {
		// Club A's member joins club B too: one Person, two memberships.
		const [inB] = await testDb
			.insert(members)
			.values({
				clubId: b.clubId,
				personId: a.personId,
				name: "Member User",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		if (!inB) throw new Error("membership insert failed");
		const next = uniquePhone();

		await applyMemberEdit({
			clubId: a.clubId,
			memberId: a.memberId,
			actorMemberId: a.adminMemberId,
			name: "Member User",
			email: await memberEmail(a.memberId),
			phone: next,
		});

		const rows = await loadClubMembers(b.clubId);
		expect(rows.find((r) => r.id === inB.id)?.phone).toBe(next);
		expect((await loadMemberProfile(b.clubId, inB.id))?.phoneRaw).toBe(next);
		const roster = await loadRosterWithContact(b.clubId);
		expect(roster.find((r) => r.id === inB.id)?.phone).toBe(next);
	});

	it("writes the Person, keyed by the membership's own person_id", async () => {
		// Club B's member must not move: the write is scoped to the edited
		// membership's Person, not to every Person or to a membership row.
		const before = uniquePhone();
		await setMemberPhone(b.memberId, before);
		const next = uniquePhone();

		await applyMemberEdit({
			clubId: a.clubId,
			memberId: a.memberId,
			actorMemberId: a.adminMemberId,
			name: "Member User",
			email: await memberEmail(a.memberId),
			phone: next,
		});

		const [p] = await testDb
			.select({ phone: people.phone })
			.from(people)
			.where(eq(people.id, a.personId));
		expect(p?.phone).toBe(next);
		expect(await memberPhone(b.memberId)).toBe(before);
	});

	it("an OMITTED phone leaves the Person's number alone — another club's correction survives", async () => {
		// The stale-form case: club B corrects the shared number, then club A
		// saves a NAME change from a page loaded before that. The form sends no
		// phone key when the field is untouched, and the edit must not write.
		const [inB] = await testDb
			.insert(members)
			.values({
				clubId: b.clubId,
				personId: a.personId,
				name: "Member User",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		if (!inB) throw new Error("membership insert failed");
		const corrected = uniquePhone();
		await applyMemberEdit({
			clubId: b.clubId,
			memberId: inB.id,
			actorMemberId: b.adminMemberId,
			name: "Member User",
			phone: corrected,
		});

		await applyMemberEdit({
			clubId: a.clubId,
			memberId: a.memberId,
			actorMemberId: a.adminMemberId,
			name: "Member Renamed",
			email: await memberEmail(a.memberId),
		});

		expect(await memberPhone(a.memberId)).toBe(corrected);
		const [log] = await testDb
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, a.clubId),
					eq(activityLog.action, "member_edit"),
				),
			)
			.orderBy(desc(activityLog.createdAt))
			.limit(1);
		const detail = log?.detail as {
			before: Record<string, unknown>;
			after: Record<string, unknown>;
		};
		expect(detail.before).not.toHaveProperty("phone");
		expect(detail.after).not.toHaveProperty("phone");
	});

	it("an explicit null clears the Person's phone", async () => {
		await setMemberPhone(a.memberId, uniquePhone());

		await applyMemberEdit({
			clubId: a.clubId,
			memberId: a.memberId,
			actorMemberId: a.adminMemberId,
			name: "Member User",
			email: await memberEmail(a.memberId),
			phone: null,
		});

		expect(await memberPhone(a.memberId)).toBeNull();
	});

	it("logs the Person's phone before and after the edit", async () => {
		const before = uniquePhone();
		await setMemberPhone(a.memberId, before);
		const next = uniquePhone();

		await applyMemberEdit({
			clubId: a.clubId,
			memberId: a.memberId,
			actorMemberId: a.adminMemberId,
			name: "Member User",
			email: await memberEmail(a.memberId),
			phone: next,
		});

		const [log] = await testDb
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, a.clubId),
					eq(activityLog.action, "member_edit"),
				),
			)
			.orderBy(desc(activityLog.createdAt))
			.limit(1);
		const detail = log?.detail as {
			before: { phone: string | null };
			after: { phone: string | null };
		};
		expect(detail.before.phone).toBe(before);
		expect(detail.after.phone).toBe(next);
	});

	it("#561: a guest carrying the EDITED number dedupes onto that member's Person", async () => {
		await setMemberPhone(a.memberId, uniquePhone());
		const next = uniquePhone();
		await applyMemberEdit({
			clubId: a.clubId,
			memberId: a.memberId,
			actorMemberId: a.adminMemberId,
			name: "Member User",
			email: await memberEmail(a.memberId),
			phone: next,
		});
		// No email, so only the phone arm can match — the one #561 broke.
		const guestId = await addGuest(a.clubId, {
			name: "Member User",
			phone: next,
		});

		await applyConvertGuestToMember({
			clubId: a.clubId,
			guestId,
			actorMemberId: a.adminMemberId,
		});

		const rows = await testDb
			.select({ id: members.id, personId: members.personId })
			.from(members)
			.where(
				and(eq(members.clubId, a.clubId), eq(members.name, "Member User")),
			);
		expect(rows).toEqual([{ id: a.memberId, personId: a.personId }]);
	});

	it("converting onto an existing Person with a phone leaves it unchanged", async () => {
		const onFile = uniquePhone();
		await setMemberPhone(a.memberId, onFile);
		const guestId = await addGuest(a.clubId, {
			name: "Member User",
			email: await memberEmail(a.memberId),
			phone: uniquePhone(),
		});

		await applyConvertGuestToMember({
			clubId: a.clubId,
			guestId,
			actorMemberId: a.adminMemberId,
		});

		expect(await memberPhone(a.memberId)).toBe(onFile);
	});

	it("converting onto an existing Person with NO phone fills it", async () => {
		await setMemberPhone(a.memberId, null);
		const guestPhone = uniquePhone();
		const guestId = await addGuest(a.clubId, {
			name: "Member User",
			email: await memberEmail(a.memberId),
			phone: guestPhone,
		});

		await applyConvertGuestToMember({
			clubId: a.clubId,
			guestId,
			actorMemberId: a.adminMemberId,
		});

		expect(await memberPhone(a.memberId)).toBe(guestPhone);
	});

	it("converting a guest with no phone leaves a Person's blank phone blank", async () => {
		await setMemberPhone(a.memberId, null);
		const guestId = await addGuest(a.clubId, {
			name: "Member User",
			email: await memberEmail(a.memberId),
		});

		await applyConvertGuestToMember({
			clubId: a.clubId,
			guestId,
			actorMemberId: a.adminMemberId,
		});

		expect(await memberPhone(a.memberId)).toBeNull();
	});
});
