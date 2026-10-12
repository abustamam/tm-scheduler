/**
 * Guest conversion and the Person's address (#907, ADR-0029).
 *
 * A guest converted onto an EXISTING Person never writes that Person's
 * address — not even a blank one. The guest book is an anonymous public form,
 * and `people.email` is the key a sign-in binds on, so a fill would let anyone
 * who knows a member's name and phone take their account. Only a FRESH Person
 * created by the conversion carries the guest's address.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/guest-convert-email.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, members, people, roleSlots, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	setGuestContact,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { captureGuestVisit, applyConvertGuestToMember } = await import(
	"./guest-pipeline-logic"
);
const { linkPersonToUser } = await import("./account-link-logic");
const { RECORD_CHANGED_MESSAGE } = await import("./guests-logic");

describe.skipIf(!hasTestDb)(
	"guest convert fills a blank address only (#907)",
	() => {
		let club: SeededClub;
		let other: SeededClub;
		let userIds: string[];
		let n: string;

		beforeEach(async () => {
			club = await seedClub();
			other = await seedClub();
			userIds = [];
			n = randomUUID().slice(0, 8);
		});
		afterEach(async () => {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
			if (userIds.length > 0) {
				await testDb.delete(user).where(inArray(user.id, userIds));
			}
		});

		/** A Person on this club's roster, matchable by phone + name. */
		async function rosterPerson(opts: {
			email: string | null;
			bound?: boolean;
			alsoInOtherClub?: boolean;
		}): Promise<{ personId: string; name: string; phone: string }> {
			const name = `Returning ${n}`;
			// A per-run number: the phone arm is club-scoped, but keep it unique.
			const digits = String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
			const phone = `+1415${digits}`;
			let userId: string | null = null;
			if (opts.bound) {
				userId = randomUUID();
				await testDb.insert(user).values({
					id: userId,
					name,
					email: `bound-${userId}@test.example`,
					emailVerified: true,
				});
				userIds.push(userId);
			}
			const [p] = await testDb
				.insert(people)
				.values({ name, email: opts.email, phone, userId })
				.returning({ id: people.id });
			if (!p) throw new Error("person insert failed");
			await testDb
				.insert(members)
				.values({ clubId: club.clubId, personId: p.id, name });
			if (opts.alsoInOtherClub) {
				await testDb
					.insert(members)
					.values({ clubId: other.clubId, personId: p.id, name });
			}
			return { personId: p.id, name, phone };
		}

		async function convert(name: string, phone: string, email: string) {
			const { guestId } = await captureGuestVisit({
				clubId: club.clubId,
				name,
				phone,
				email,
			});
			return applyConvertGuestToMember({
				clubId: club.clubId,
				guestId,
				actorMemberId: club.adminMemberId,
			});
		}

		async function emailOf(personId: string): Promise<string | null> {
			const [row] = await testDb
				.select({ email: people.email })
				.from(people)
				.where(eq(people.id, personId));
			return row?.email ?? null;
		}

		it("never writes a guest-book address onto an EXISTING Person, even a blank one", async () => {
			// The guest book is an anonymous public form. A visitor who signs it
			// with a member's name and phone and THEIR OWN email would otherwise
			// have that address filled onto the member's Person on conversion —
			// the key a sign-in binds on — and could then take the member's
			// account, club role included, with one magic link.
			const p = await rosterPerson({ email: null });
			const addr = `guest-${n}@test.example`;

			const res = await convert(p.name, p.phone, addr);

			expect(res.personId).toBe(p.personId);
			expect(await emailOf(p.personId)).toBeNull();
		});

		it("never overwrites an address already on file", async () => {
			const kept = `kept-${n}@test.example`;
			const p = await rosterPerson({ email: kept });

			const res = await convert(p.name, p.phone, `guest-${n}@test.example`);

			expect(res.personId).toBe(p.personId);
			expect(await emailOf(p.personId)).toBe(kept);
		});

		it("leaves a BOUND Person's address alone, even a blank one", async () => {
			const p = await rosterPerson({ email: null, bound: true });

			const res = await convert(p.name, p.phone, `guest-${n}@test.example`);

			expect(res.personId).toBe(p.personId);
			expect(await emailOf(p.personId)).toBeNull();
		});

		it("leaves a MULTI-CLUB unbound Person's blank address null", async () => {
			const p = await rosterPerson({ email: null, alsoInOtherClub: true });

			const res = await convert(p.name, p.phone, `guest-${n}@test.example`);

			expect(res.personId).toBe(p.personId);
			expect(await emailOf(p.personId)).toBeNull();
		});
	},
);

/**
 * #1157: an address typed on the public guest book is the club's unconfirmed
 * note on the guest row (`guests.book_email`). Convert uses it only when an
 * officer confirms it (`confirmedEmail`), and it plays no part in which existing
 * member a convert matches.
 */
describe.skipIf(!hasTestDb)(
	"convert and the unconfirmed guest-book address (#1157)",
	() => {
		let club: SeededClub;
		let userIds: string[];
		let strayPeople: string[];
		let n: string;

		beforeEach(async () => {
			club = await seedClub();
			userIds = [];
			strayPeople = [];
			n = randomUUID().slice(0, 8);
		});
		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
			if (userIds.length > 0) {
				await testDb.delete(user).where(inArray(user.id, userIds));
			}
			if (strayPeople.length > 0) {
				await testDb.delete(people).where(inArray(people.id, strayPeople));
			}
		});

		async function bookGuest(name: string, email: string) {
			const { guestId } = await captureGuestVisit({
				clubId: club.clubId,
				name,
				email,
			});
			return guestId;
		}

		async function personEmail(personId: string): Promise<string | null> {
			const [row] = await testDb
				.select({ email: people.email })
				.from(people)
				.where(eq(people.id, personId));
			return row?.email ?? null;
		}

		async function bookEmailOf(guestId: string): Promise<string | null> {
			const [row] = await testDb
				.select({ bookEmail: guests.bookEmail })
				.from(guests)
				.where(eq(guests.id, guestId));
			return row?.bookEmail ?? null;
		}

		/** A verified account whose address is `email`. */
		async function accountFor(email: string): Promise<string> {
			const id = randomUUID();
			await testDb
				.insert(user)
				.values({ id, name: `Acct ${n}`, email, emailVerified: true });
			userIds.push(id);
			return id;
		}

		// protects=converting a guest whose only address is the book note, with no confirmation, makes a member Person with no email, so an account with that address links nothing;
		// fails_when=convertIdentity reads guests.book_email, so the unconfirmed address becomes the new member's sign-in key;
		// no_claim=the confirmed path (next test); the account is a seeded user row, not a real magic-link sign-in.
		it("converts without confirmation: the member Person has no email and nothing links (AC 5)", async () => {
			const email = `note-${n}@test.example`;
			const guestId = await bookGuest(`Noted ${n}`, email);

			const res = await applyConvertGuestToMember({
				clubId: club.clubId,
				guestId,
				actorMemberId: club.adminMemberId,
			});

			expect(await personEmail(res.personId)).toBeNull();
			expect(await bookEmailOf(guestId)).toBe(email);
			const { linkedPersonIds } = await linkPersonToUser(
				await accountFor(email),
			);
			expect(linkedPersonIds).toEqual([]);
		});

		// protects=a confirmedEmail is written to the member Person, clears the note, and then links exactly that Person;
		// fails_when=confirmedEmail is ignored, or is written but the note is left behind;
		// no_claim=that the officer asked the guest; the confirmation is an input here.
		it("converts with confirmedEmail: written to the Person, note cleared, links that Person (AC 6)", async () => {
			const email = `note-${n}@test.example`;
			const guestId = await bookGuest(`Confirmed ${n}`, email);

			const res = await applyConvertGuestToMember({
				clubId: club.clubId,
				guestId,
				actorMemberId: club.adminMemberId,
				confirmedEmail: email,
			});

			expect(await personEmail(res.personId)).toBe(email);
			expect(await bookEmailOf(guestId)).toBeNull();
			const { linkedPersonIds } = await linkPersonToUser(
				await accountFor(email),
			);
			expect(linkedPersonIds).toEqual([res.personId]);
		});

		// protects=a confirmedEmail that disagrees with the guest's vouched address is refused and nothing is written;
		// fails_when=the officer's field overrides an address another officer already vouched, or the convert half-writes before throwing;
		// no_claim=a confirmedEmail equal to the vouched address (accepted, not tested separately here).
		it("refuses a confirmedEmail that differs from the vouched address, writing nothing (AC 7)", async () => {
			const name = `Vouched ${n}`;
			const guestId = await bookGuest(name, `typed-${n}@test.example`);
			const vouched = `vouched-${n}@test.example`;
			await setGuestContact(guestId, { email: vouched });
			const membersBefore = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.clubId, club.clubId));

			await expect(
				applyConvertGuestToMember({
					clubId: club.clubId,
					guestId,
					actorMemberId: club.adminMemberId,
					confirmedEmail: `other-${n}@test.example`,
				}),
			).rejects.toThrow(RECORD_CHANGED_MESSAGE);

			const membersAfter = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.clubId, club.clubId));
			expect(membersAfter).toHaveLength(membersBefore.length);
			const [g] = await testDb
				.select({ stage: guests.stage, personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g?.stage).not.toBe("joined");
			expect(await personEmail(g!.personId)).toBe(vouched);
		});

		// protects=a guest whose book note equals an existing member's address is NOT deduped onto that member: a new Person is minted, the member's lapsed row stays lapsed, and a slot held by that member is not re-pointed;
		// fails_when=matchClubMemberPerson is fed the book note, so a convert matches the existing member by the unconfirmed address (the membership is reused, reactivated, or its slot moved);
		// no_claim=dedup by a confirmed or vouched address, nor by phone+name (existing #488 tests).
		it("a book note equal to a member's address never dedups onto that member (AC 8)", async () => {
			const email = `member-${n}@test.example`;
			const [m] = await testDb
				.insert(people)
				.values({ name: `Existing ${n}`, email })
				.returning({ id: people.id });
			strayPeople.push(m!.id);
			const [mem] = await testDb
				.insert(members)
				.values({
					clubId: club.clubId,
					personId: m!.id,
					name: `Existing ${n}`,
					status: "inactive",
				})
				.returning({ id: members.id });
			// A slot the existing member holds: the convert must leave it where it is.
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: mem!.id, status: "confirmed" })
				.where(eq(roleSlots.id, club.slotId));
			const guestId = await bookGuest(`Visitor ${n}`, email);

			const res = await applyConvertGuestToMember({
				clubId: club.clubId,
				guestId,
				actorMemberId: club.adminMemberId,
			});

			expect(res.personId).not.toBe(m!.id);
			expect(res.membershipId).not.toBe(mem!.id);
			expect(res.reactivated).toBe(false);
			const [after] = await testDb
				.select({ status: members.status })
				.from(members)
				.where(eq(members.id, mem!.id));
			expect(after?.status).toBe("inactive");
			expect(await personEmail(m!.id)).toBe(email);
			const [slot] = await testDb
				.select({
					memberId: roleSlots.assignedMemberId,
					guestId: roleSlots.assignedGuestId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, club.slotId));
			expect(slot).toEqual({ memberId: mem!.id, guestId: null });
		});

		// protects=a convert whose confirmedEmail leads onto an existing member (by phone and name) writes NO address to that member and leaves the guest's note as it was;
		// fails_when=the matched-member branch writes the confirmation onto the member's Person, or clears the note though nothing was written;
		// no_claim=the new-Person branches (AC 5, AC 6); the match is by phone+name, seeded here.
		it("a confirmedEmail that dedups onto an existing member writes no email and keeps the note", async () => {
			const name = `Roster ${n}`;
			const phone = `+1415${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
			const [m] = await testDb
				.insert(people)
				.values({ name, phone })
				.returning({ id: people.id });
			strayPeople.push(m!.id);
			await testDb
				.insert(members)
				.values({ clubId: club.clubId, personId: m!.id, name });
			const typed = `typed-${n}@test.example`;
			const { guestId } = await captureGuestVisit({
				clubId: club.clubId,
				name,
				phone,
				email: typed,
			});

			const res = await applyConvertGuestToMember({
				clubId: club.clubId,
				guestId,
				actorMemberId: club.adminMemberId,
				confirmedEmail: typed,
			});

			expect(res.personId).toBe(m!.id);
			expect(await personEmail(m!.id)).toBeNull();
			expect(await bookEmailOf(guestId)).toBe(typed);
		});
	},
);
