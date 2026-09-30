/**
 * A guest's kind, home club and introducer (#1050), against a real database.
 *
 * The three columns came with #1046; this is the write path and the two reads
 * VP Membership and the guest edit dialog use. The claim with a boundary in it
 * is the introducer: `guests.introduced_by_member_id` is a bare FK to
 * `members`, which the DATABASE does not tie to the guest's club, so the only
 * thing refusing another club's member is `applyUpdateGuestProfile`. The read
 * side of the same boundary is `loadGuestProfiles`' club-scoped join.
 *
 * Authorization follows `guest-edit-authz.integration.test.ts`: a server fn has
 * no session under vitest, so this file executes the GATE `updateGuestProfile`
 * runs against seeded rows, and `guest-profile-authz.guard.test.ts` pins that
 * the handler still runs it.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, members, people } from "#/db/schema";
import { HOME_CLUB_TOO_LONG_MESSAGE } from "#/lib/guest-profile";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { NO_PERMISSION_MESSAGE, NOT_A_MEMBER_MESSAGE, requireClubRole } =
	await import("#/server/guards");
const {
	applyUpdateGuestProfile,
	GUEST_CANNOT_INTRODUCE_SELF_MESSAGE,
	INTRODUCER_NOT_IN_CLUB_MESSAGE,
	loadGuestProfile,
	loadGuestProfiles,
} = await import("#/server/guests-logic");

describe.skipIf(!hasTestDb)(
	"guest kind, home club and introducer (#1050)",
	() => {
		let seed: SeededClub;
		/** A second club, for the cross-club cases. */
		let other: SeededClub;
		let guestId: string;
		/** Per-run suffix, so names never collide with a parallel suite's. */
		let run: string;

		async function seedGuest(clubId: string, name: string): Promise<string> {
			const [row] = await testDb
				.insert(guests)
				.values({ clubId, name: `${name} ${run}` })
				.returning({ id: guests.id });
			if (!row) throw new Error("failed to seed guest");
			return row.id;
		}

		async function stored(id: string) {
			const [row] = await testDb
				.select({
					kind: guests.kind,
					homeClub: guests.homeClub,
					introducedByMemberId: guests.introducedByMemberId,
				})
				.from(guests)
				.where(eq(guests.id, id));
			return row;
		}

		/** An INACTIVE membership of `clubId` (a lapsed member). */
		async function seedInactiveMember(clubId: string): Promise<string> {
			const personId = await seedPerson({ name: `Lapsed ${run}` });
			const [row] = await testDb
				.insert(members)
				.values({
					clubId,
					personId,
					name: `Lapsed ${run}`,
					status: "inactive",
				})
				.returning({ id: members.id });
			if (!row) throw new Error("failed to seed member");
			return row.id;
		}

		beforeEach(async () => {
			run = randomUUID().slice(0, 8);
			seed = await seedClub();
			other = await seedClub();
			guestId = await seedGuest(seed.clubId, "Nadia Farouk");
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		});

		it("saves all three fields", async () => {
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "guest_speaker",
				homeClub: "Laguna Speakers #1234",
				introducedByMemberId: seed.memberId,
			});
			expect(await stored(guestId)).toEqual({
				kind: "guest_speaker",
				homeClub: "Laguna Speakers #1234",
				introducedByMemberId: seed.memberId,
			});
		});

		it("trims the home club, and stores a blank one as null", async () => {
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visiting_toastmaster",
				homeClub: "   Downtown Speakers  ",
			});
			expect((await stored(guestId))?.homeClub).toBe("Downtown Speakers");

			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visiting_toastmaster",
				homeClub: "    ",
			});
			expect((await stored(guestId))?.homeClub).toBeNull();
		});

		it("CLEARS a home club on a Visitor — the invalid combination", async () => {
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visiting_toastmaster",
				homeClub: "Downtown Speakers",
			});
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visitor",
				homeClub: "Downtown Speakers",
			});
			expect(await stored(guestId)).toMatchObject({
				kind: "visitor",
				homeClub: null,
			});
		});

		it("CLEARS, rather than refuses, an over-long home club on a Visitor", async () => {
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visitor",
				homeClub: "x".repeat(500),
			});
			expect(await stored(guestId)).toMatchObject({
				kind: "visitor",
				homeClub: null,
			});
		});

		it("does not deadlock against a member delete that nulls this guest's introducer", async () => {
			// The deadlock shape: the delete holds the member row, this write
			// waits on it, and then the delete's ON DELETE SET NULL needs THIS
			// guest's row. If the write had locked the guest first (the old
			// order), the two would wait on each other and Postgres would abort
			// one with 40P01. Member-then-guest means the delete finishes, and the
			// write then finds the member gone and refuses cleanly.
			const personId = await seedPerson({ name: `Departing ${run}` });
			const [departing] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name: `Departing ${run}` })
				.returning({ id: members.id });
			if (!departing) throw new Error("failed to seed member");
			// The guest already points at them, so the delete's SET NULL touches it.
			await testDb
				.update(guests)
				.set({ introducedByMemberId: departing.id })
				.where(eq(guests.id, guestId));

			let release!: () => void;
			const gate = new Promise<void>((r) => {
				release = r;
			});
			let locked!: (pid: number) => void;
			const pidReady = new Promise<number>((r) => {
				locked = r;
			});
			try {
				// Step 1 of the delete: hold the member row, as `delete` does first.
				const deleter = testDb.transaction(async (tx) => {
					const res = await tx.execute(sql`select pg_backend_pid() as pid`);
					await tx
						.select({ id: members.id })
						.from(members)
						.where(eq(members.id, departing.id))
						.for("update");
					locked(Number((res.rows[0] as { pid: number }).pid));
					await gate;
					// Step 2: the delete itself, whose SET NULL updates the guest.
					await tx.delete(members).where(eq(members.id, departing.id));
				});
				deleter.catch(() => {});
				const pid = await pidReady;

				const write = applyUpdateGuestProfile({
					clubId: seed.clubId,
					guestId,
					kind: "guest_speaker",
					homeClub: "Elsewhere",
					introducedByMemberId: departing.id,
				});
				write.catch(() => {});
				// The write is parked on the member row, holding nothing on the guest.
				await waitForLockWait("for share", pid);
				release();

				// The delete completes; had the write held the guest row, this is
				// where one side would die with a deadlock.
				await expect(deleter).resolves.toBeUndefined();
				const outcome = await write.then(
					() => "ok",
					(e: unknown) => (e instanceof Error ? e.message : String(e)),
				);
				expect(outcome).not.toMatch(/deadlock/i);
				expect(outcome).toBe(INTRODUCER_NOT_IN_CLUB_MESSAGE);
				expect(await stored(guestId)).toEqual({
					kind: "visitor",
					homeClub: null,
					introducedByMemberId: null,
				});
			} finally {
				release();
				await testDb.delete(people).where(eq(people.id, personId));
			}
		});

		it("an introducer deleted mid-write is refused with the message, not a raw FK error", async () => {
			// The member row is read FOR SHARE inside the write's transaction. A
			// concurrent delete holding that row makes the check WAIT; once the
			// delete commits the check finds nothing and refuses cleanly. Without
			// the lock the check reads the row as still there and the UPDATE then
			// dies on the foreign key, SQL and parameters in the officer's toast.
			const personId = await seedPerson({ name: `Leaving ${run}` });
			const [leaving] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name: `Leaving ${run}` })
				.returning({ id: members.id });
			if (!leaving) throw new Error("failed to seed member");
			try {
				const blocker = await openBlockingTx(async (tx) => {
					await tx.delete(members).where(eq(members.id, leaving.id));
				});
				const write = applyUpdateGuestProfile({
					clubId: seed.clubId,
					guestId,
					kind: "visitor",
					introducedByMemberId: leaving.id,
				});
				write.catch(() => {});
				await waitForLockWait("for share", blocker.pid);
				await blocker.commit();
				await expect(write).rejects.toThrow(INTRODUCER_NOT_IN_CLUB_MESSAGE);
				expect((await stored(guestId))?.introducedByMemberId).toBeNull();
			} finally {
				// Its membership is gone, so `cleanup` cannot find this person.
				await testDb.delete(people).where(eq(people.id, personId));
			}
		});

		it("refuses a joined guest as their own introducer", async () => {
			await testDb
				.update(guests)
				.set({ convertedMembershipId: seed.memberId, stage: "joined" })
				.where(eq(guests.id, guestId));
			await expect(
				applyUpdateGuestProfile({
					clubId: seed.clubId,
					guestId,
					kind: "visitor",
					introducedByMemberId: seed.memberId,
				}),
			).rejects.toThrow(GUEST_CANNOT_INTRODUCE_SELF_MESSAGE);
			// Anyone else on the roster is still fine.
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visitor",
				introducedByMemberId: seed.adminMemberId,
			});
			expect((await stored(guestId))?.introducedByMemberId).toBe(
				seed.adminMemberId,
			);
		});

		it("refuses a home club over the cap, and writes nothing", async () => {
			// The schema caps it too; this is the logic's own re-check, for a caller
			// that did not go through the schema.
			await expect(
				applyUpdateGuestProfile({
					clubId: seed.clubId,
					guestId,
					kind: "guest_speaker",
					homeClub: "x".repeat(121),
				}),
			).rejects.toThrow(HOME_CLUB_TOO_LONG_MESSAGE);
			expect(await stored(guestId)).toMatchObject({
				kind: "visitor",
				homeClub: null,
			});
			// Exactly at the cap is fine, and trailing spaces do not count toward it.
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "guest_speaker",
				homeClub: `${"x".repeat(120)}   `,
			});
			expect((await stored(guestId))?.homeClub).toHaveLength(120);
		});

		it("REFUSES an introducer from another club, and leaves the row as it was", async () => {
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visitor",
				introducedByMemberId: seed.memberId,
			});
			await expect(
				applyUpdateGuestProfile({
					clubId: seed.clubId,
					guestId,
					kind: "guest_speaker",
					homeClub: "Elsewhere",
					introducedByMemberId: other.memberId,
				}),
			).rejects.toThrow(INTRODUCER_NOT_IN_CLUB_MESSAGE);
			// Refused whole: neither the introducer nor the other two fields moved.
			expect(await stored(guestId)).toEqual({
				kind: "visitor",
				homeClub: null,
				introducedByMemberId: seed.memberId,
			});
		});

		it("REFUSES an introducer id that is no membership at all", async () => {
			await expect(
				applyUpdateGuestProfile({
					clubId: seed.clubId,
					guestId,
					kind: "visitor",
					introducedByMemberId: randomUUID(),
				}),
			).rejects.toThrow(INTRODUCER_NOT_IN_CLUB_MESSAGE);
		});

		it("ACCEPTS an inactive member of the same club — the roster-picker rule", async () => {
			// Any membership row of THIS club counts, as it does for
			// `applyLinkGuestToMember` and its picker: a lapsed member still brought
			// the guest they brought.
			const lapsed = await seedInactiveMember(seed.clubId);
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visitor",
				introducedByMemberId: lapsed,
			});
			expect((await stored(guestId))?.introducedByMemberId).toBe(lapsed);
		});

		it("clears the introducer when sent null or omitted", async () => {
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visitor",
				introducedByMemberId: seed.memberId,
			});
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visitor",
				introducedByMemberId: null,
			});
			expect((await stored(guestId))?.introducedByMemberId).toBeNull();

			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visitor",
				introducedByMemberId: seed.memberId,
			});
			await applyUpdateGuestProfile({
				clubId: seed.clubId,
				guestId,
				kind: "visitor",
			});
			expect((await stored(guestId))?.introducedByMemberId).toBeNull();
		});

		it("refuses another club's guest, even with that club's own member", async () => {
			const theirs = await seedGuest(other.clubId, "Their Guest");
			await expect(
				applyUpdateGuestProfile({
					clubId: seed.clubId,
					guestId: theirs,
					kind: "guest_speaker",
					introducedByMemberId: seed.memberId,
				}),
			).rejects.toThrow(/not found in this club/);
			expect(await stored(theirs)).toMatchObject({
				kind: "visitor",
				introducedByMemberId: null,
			});
		});

		describe("loadGuestProfiles", () => {
			it("the per-member brought count matches the rows", async () => {
				const lapsed = await seedInactiveMember(seed.clubId);
				const g2 = await seedGuest(seed.clubId, "Omar Haddad");
				const g3 = await seedGuest(seed.clubId, "Lena Park");
				const g4 = await seedGuest(seed.clubId, "Nobody Brought");
				await testDb
					.update(guests)
					.set({ introducedByMemberId: seed.memberId })
					.where(inArray(guests.id, [guestId, g2]));
				await testDb
					.update(guests)
					.set({ introducedByMemberId: lapsed })
					.where(eq(guests.id, g3));

				const { rows, brought } = await loadGuestProfiles(seed.clubId);
				expect(rows.map((r) => r.guestId).sort()).toEqual(
					[guestId, g2, g3, g4].sort(),
				);
				expect(brought).toEqual([
					{ memberId: seed.memberId, name: "Member User", count: 2 },
					{ memberId: lapsed, name: `Lapsed ${run}`, count: 1 },
				]);
				// And the invariant, stated against the rows rather than restated.
				for (const b of brought) {
					expect(
						rows.filter((r) => r.introducedByMemberId === b.memberId),
					).toHaveLength(b.count);
				}
				expect(rows.find((r) => r.guestId === g2)?.introducedByName).toBe(
					"Member User",
				);
			});

			it("names nobody, and counts nobody, for a cross-club introducer written around the check", async () => {
				// The DB accepts this (no constraint ties the FK to the club); the
				// write path refuses it, and the read must not surface another club's
				// member if a row like this exists anyway.
				await testDb
					.update(guests)
					.set({ introducedByMemberId: other.memberId })
					.where(eq(guests.id, guestId));
				const { rows, brought } = await loadGuestProfiles(seed.clubId);
				const row = rows.find((r) => r.guestId === guestId);
				expect(row?.introducedByName).toBeNull();
				// The id does not leak either: the client never learns another
				// club's membership id.
				expect(row?.introducedByMemberId).toBeNull();
				expect(brought).toEqual([]);
				// Nor through the dialog's read — which is also why such a guest
				// loads as "no introducer" and saves without a refusal the officer
				// could not explain.
				const profile = await loadGuestProfile(seed.clubId, guestId);
				expect(profile?.introducedByMemberId).toBeNull();
				await applyUpdateGuestProfile({
					clubId: seed.clubId,
					guestId,
					kind: profile?.kind ?? "visitor",
					homeClub: profile?.homeClub ?? null,
					introducedByMemberId: profile?.introducedByMemberId ?? null,
				});
				expect((await stored(guestId))?.introducedByMemberId).toBeNull();
			});

			it("returns only this club's guests", async () => {
				const theirs = await seedGuest(other.clubId, "Their Guest");
				const { rows } = await loadGuestProfiles(seed.clubId);
				expect(rows.map((r) => r.guestId)).not.toContain(theirs);
			});
		});

		describe("loadGuestProfile", () => {
			it("returns the stored three and the whole roster, inactive included", async () => {
				const lapsed = await seedInactiveMember(seed.clubId);
				await applyUpdateGuestProfile({
					clubId: seed.clubId,
					guestId,
					kind: "visiting_toastmaster",
					homeClub: "Downtown Speakers",
					introducedByMemberId: lapsed,
				});
				const profile = await loadGuestProfile(seed.clubId, guestId);
				expect(profile).toMatchObject({
					kind: "visiting_toastmaster",
					homeClub: "Downtown Speakers",
					introducedByMemberId: lapsed,
				});
				expect(profile?.roster.map((m) => m.id).sort()).toEqual(
					[seed.adminMemberId, seed.memberId, lapsed].sort(),
				);
				expect(profile?.roster.find((m) => m.id === lapsed)?.status).toBe(
					"inactive",
				);
			});

			it("is null for another club's guest", async () => {
				const theirs = await seedGuest(other.clubId, "Their Guest");
				expect(await loadGuestProfile(seed.clubId, theirs)).toBeNull();
			});
		});

		describe("who may write it", () => {
			it("REJECTS a plain member at the gate updateGuestProfile runs", async () => {
				await expect(
					requireClubRole(seed.memberUserId, seed.clubId, ["admin"]),
				).rejects.toThrow(NO_PERMISSION_MESSAGE);
				// Nothing was written on the way to the refusal.
				expect(await stored(guestId)).toEqual({
					kind: "visitor",
					homeClub: null,
					introducedByMemberId: null,
				});
			});

			it("REJECTS another club's admin — the payload names the club", async () => {
				await expect(
					requireClubRole(other.adminUserId, seed.clubId, ["admin"]),
				).rejects.toThrow(NOT_A_MEMBER_MESSAGE);
			});

			it("ACCEPTS the club's admin (positive control)", async () => {
				await expect(
					requireClubRole(seed.adminUserId, seed.clubId, ["admin"]),
				).resolves.toBeTruthy();
			});
		});
	},
);
