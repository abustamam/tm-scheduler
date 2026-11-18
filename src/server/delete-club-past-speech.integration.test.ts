/**
 * Permanent club delete (#914) and a past speech (#1656): the Person whose only
 * remaining history is a past speech ANOTHER club recorded is kept, with the
 * speech. `personsWithOtherClubHistory` used to look only through
 * `role_slots`, and a past speech has no slot.
 *
 * Own file, because `delete-club-permanently.integration.test.ts` wraps `#/db`
 * for failure injection this does not need.
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, members, people, speeches, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("#/lib/auth", () => ({
	auth: { api: { getSession: async () => null } },
}));

const { addPastSpeech } = await import("./past-speeches-logic");
const { deleteClubPermanently } = await import("./onboarding-logic");

describe.skipIf(!hasTestDb)(
	"club delete keeps a past speech of another club (#1656)",
	() => {
		let a: SeededClub;
		let b: SeededClub;
		afterEach(async () => {
			// The kept Person is club-less; remove them and their account by hand.
			await testDb.delete(speeches).where(eq(speeches.personId, a.personId));
			await cleanup(b.clubId, [b.adminUserId, b.memberUserId]);
			await testDb.delete(people).where(eq(people.id, a.personId));
			await testDb.delete(user).where(eq(user.id, a.memberUserId));
			await cleanup(a.clubId, [a.adminUserId]);
		});

		async function setup() {
			a = await seedClub();
			b = await seedClub();
			// M (a's member) also belongs to B; B records a past speech for them, then
			// removes their seat there. A is archived and deleted.
			const [mb] = await testDb
				.insert(members)
				.values({
					clubId: b.clubId,
					personId: a.personId,
					name: "Member User",
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			if (!mb) throw new Error("member of B");
			const { speechId } = await addPastSpeech({
				memberId: mb.id,
				actorUserId: b.adminUserId,
				input: {
					speakerDetails: { speechTitle: "Ice Breaker" },
					deliveredYear: 2023,
				},
			});
			await testDb.delete(members).where(eq(members.id, mb.id));
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, a.clubId));
			const [named] = await testDb
				.select({ name: clubs.name })
				.from(clubs)
				.where(eq(clubs.id, a.clubId));
			return { speechId, clubName: named?.name ?? "" };
		}

		// protects=a Person is not deleted, and their speech not cascaded away, while
		//   another club's past speech still names them
		// fails_when=personsWithOtherClubHistory stops counting a past speech with a
		//   recording club (it counts only role_slots)
		// no_claim=a Person with no history elsewhere (the next test)
		it("keeps the Person and the speech when B recorded a past speech and A is deleted", async () => {
			const { speechId, clubName } = await setup();
			const res = await deleteClubPermanently(a.clubId, clubName);
			expect(res.peopleKept).toBeGreaterThanOrEqual(1);
			const [p] = await testDb
				.select({ id: people.id })
				.from(people)
				.where(eq(people.id, a.personId));
			expect(p?.id).toBe(a.personId);
			const [s] = await testDb
				.select({ recorded: speeches.recordedClubId })
				.from(speeches)
				.where(eq(speeches.id, speechId));
			expect(s?.recorded).toBe(b.clubId);
		});

		// A past speech recorded by the deleted club itself was SET NULL with its row:
		// it is this club's history and goes with a Person who has nothing elsewhere,
		// as a speech given at this club's meeting does.
		it("still deletes a Person whose only past speech was recorded by the deleted club", async () => {
			a = await seedClub();
			b = await seedClub();
			const { speechId } = await addPastSpeech({
				memberId: a.memberId,
				actorUserId: a.adminUserId,
				input: { speakerDetails: { speechTitle: "Ice Breaker" } },
			});
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, a.clubId));
			const [named] = await testDb
				.select({ name: clubs.name })
				.from(clubs)
				.where(eq(clubs.id, a.clubId));
			await deleteClubPermanently(a.clubId, named?.name ?? "");
			expect(
				await testDb.select().from(people).where(eq(people.id, a.personId)),
			).toEqual([]);
			expect(
				await testDb.select().from(speeches).where(eq(speeches.id, speechId)),
			).toEqual([]);
		});
	},
);
