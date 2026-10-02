/**
 * Guest conversion and the Person's address (#907, ADR-0029).
 *
 * A guest converted onto an EXISTING Person (matched by phone and name — a
 * Person matched by email already carries it) may fill that Person's address
 * only when it is blank, nobody has signed in as them, and the converting club
 * is their sole holder. Everything else leaves the address exactly as it was.
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

		it("fills a blank address on an unbound Person this club alone holds", async () => {
			const p = await rosterPerson({ email: null });
			const addr = `guest-${n}@test.example`;

			const res = await convert(p.name, p.phone, addr);

			expect(res.personId).toBe(p.personId);
			expect(await emailOf(p.personId)).toBe(addr);
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
