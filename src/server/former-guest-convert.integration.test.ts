/**
 * #1663 review: after a member is marked former their guest record is `lost`
 * with `converted_membership_id` still set. A convert must not treat that row
 * as a fresh guest and try to give the same Person a second membership.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guests, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyConvertGuestToMember, GUEST_MEMBER_ENDED_MESSAGE } = await import(
	"#/server/guest-pipeline-logic"
);

const seeded: SeededClub[] = [];
afterEach(async () => {
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
});

describe.skipIf(!hasTestDb)("convert a former member's guest (#1663)", () => {
	async function lostGuestOfFormerMember() {
		const s = await seedClub();
		seeded.push(s);
		const [member] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, s.memberId));
		await testDb
			.update(members)
			.set({ status: "former" })
			.where(eq(members.id, s.memberId));
		const [g] = await testDb
			.insert(guests)
			.values({
				clubId: s.clubId,
				personId: member?.personId as string,
				name: "Renamed Guest",
				stage: "lost",
				convertedMembershipId: s.memberId,
			})
			.returning({ id: guests.id });
		return { s, guestId: g?.id as string };
	}
	const rosterCount = async (clubId: string) =>
		(await testDb.select().from(members).where(eq(members.clubId, clubId)))
			.length;

	it("is refused with the reactivate-on-the-roster sentence and changes nothing", async () => {
		const { s, guestId } = await lostGuestOfFormerMember();
		const before = await rosterCount(s.clubId);
		await expect(
			applyConvertGuestToMember({
				clubId: s.clubId,
				guestId,
				actorMemberId: s.adminMemberId,
			}),
		).rejects.toThrow(GUEST_MEMBER_ENDED_MESSAGE);
		expect(await rosterCount(s.clubId)).toBe(before);
		const [g] = await testDb
			.select()
			.from(guests)
			.where(eq(guests.id, guestId));
		expect([g?.stage, g?.convertedMembershipId]).toEqual(["lost", s.memberId]);
	});

	it("a stranded guest (stage lost, no pointer) can still be converted", async () => {
		const s = await seedClub();
		seeded.push(s);
		const [g] = await testDb
			.insert(guests)
			.values({
				clubId: s.clubId,
				personId: await seedPerson({ name: "Stranded Sam" }),
				name: "Stranded Sam",
				stage: "lost",
			})
			.returning({ id: guests.id });
		const res = await applyConvertGuestToMember({
			clubId: s.clubId,
			guestId: g?.id as string,
			actorMemberId: s.adminMemberId,
		});
		expect(res).toBeTruthy();
		const [after] = await testDb
			.select()
			.from(guests)
			.where(and(eq(guests.id, g?.id as string)));
		expect(after?.stage).toBe("joined");
	});
});
