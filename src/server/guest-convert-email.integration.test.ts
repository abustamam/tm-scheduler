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
import { members, people, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { captureGuestVisit, applyConvertGuestToMember } = await import(
	"./guest-pipeline-logic"
);

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
