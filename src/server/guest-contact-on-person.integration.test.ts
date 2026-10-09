/**
 * A guest's email and phone live on their Person (#1125, ADR-0031).
 *
 * What the six regression suites cannot see, in five groups:
 *   - the two predicates (`guestContactWritable`, `guestContactFillable`) and the
 *     refusal reason that is their read form agree, state by state;
 *   - an officer's edit writes `people`, shows in every club that holds a guest
 *     row on the Person, and is refused, with the whole edit rolled back and one
 *     named reason, for a Person who has signed in or is a member somewhere;
 *   - the anonymous guest book fills a blank only where the stricter predicate
 *     allows, and writes nothing in each refusal shape;
 *   - a guest-only Person carrying a member's address is invisible to every path
 *     that matches `people` by address (the bind, the CSV importer, the new-club
 *     lookup, the email-change collision check, the invite);
 *   - a roster edit of a member's email is not blocked by a guest row in another
 *     club: a guest row is never a holder.
 *
 * Every name and address carries a per-run suffix and every assertion is scoped to
 * ids this file created: vitest runs test FILES in parallel against one database.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, clubs, guests, members, people, user } from "#/db/schema";
import { GUEST_CONTACT_REFUSAL_MESSAGES } from "#/lib/guest-contact";
import { toStoredPhone } from "#/lib/phone";
import {
	cleanup,
	guestContactOf,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyUpdateGuest, captureGuestVisit, loadGuestPipeline } = await import(
	"#/server/guest-pipeline-logic"
);
const { createGuestRecord } = await import("#/server/guests-logic");
const {
	addressHeldByAnother,
	bindVerifiedPerson,
	guestContactFillable,
	guestContactRefusalFor,
	guestContactRefusalSql,
	guestContactWritable,
	rosterConflictFor,
} = await import("#/server/account-link-logic");
const { importPeopleAndMembers, loadAddressHolders, loadPersonCandidates } =
	await import("#/server/import-members-logic");
const { findBestPersonByEmail } = await import("#/server/people-logic");
const { prepareMemberInvite } = await import("#/server/account-invite-logic");
const { applyMemberEdit } = await import("#/server/members-logic");

const uniq = (stem: string) => `${stem} ${randomUUID().slice(0, 8)}`;
const address = (stem: string) => `${stem}-${randomUUID()}@example.test`;

function uniquePhone(): string {
	const digits = randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "0");
	return `555${digits}`;
}

describe.skipIf(!hasTestDb)(
	"a guest's contact lives on their Person (#1125)",
	() => {
		let seed: SeededClub;
		let extraClubs: string[] = [];
		let extraPeople: string[] = [];
		let extraUsers: string[] = [];

		beforeEach(async () => {
			seed = await seedClub();
			extraClubs = [];
			extraPeople = [];
			extraUsers = [];
		});

		afterEach(async () => {
			// Read before the cascade deletes the rows that name them.
			const clubIds = [seed.clubId, ...extraClubs];
			const named = await testDb
				.selectDistinct({ id: guests.personId })
				.from(guests)
				.where(inArray(guests.clubId, clubIds));
			const memberPeople = await testDb
				.selectDistinct({ id: members.personId })
				.from(members)
				.where(
					inArray(
						members.clubId,
						extraClubs.length ? extraClubs : [seed.clubId],
					),
				);
			const toRemove = [
				...new Set([
					...extraPeople,
					...named.map((g) => g.id),
					...memberPeople.map((m) => m.id),
				]),
			];
			if (extraClubs.length > 0) {
				await testDb.delete(clubs).where(inArray(clubs.id, extraClubs));
			}
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			for (const id of toRemove) {
				await testDb
					.delete(people)
					.where(eq(people.id, id))
					.catch(() => {});
			}
			if (extraUsers.length > 0) {
				await testDb.delete(user).where(inArray(user.id, extraUsers));
			}
		});

		async function makeClub() {
			const id = randomUUID();
			await testDb.insert(clubs).values({
				id,
				name: uniq("Club"),
				slug: `gc-1125-${id}`,
			});
			extraClubs.push(id);
			return id;
		}

		async function makeUser(email?: string) {
			const id = randomUUID();
			await testDb.insert(user).values({
				id,
				name: "U",
				email: email ?? `u-${id}@test.example`,
				emailVerified: true,
			});
			extraUsers.push(id);
			return id;
		}

		async function makePerson(
			values: {
				name?: string;
				email?: string | null;
				phone?: string | null;
			} = {},
		) {
			const id = await seedPerson({ name: uniq("Person"), ...values });
			extraPeople.push(id);
			return id;
		}

		/** A guest in `clubId` through the one writer, its contact on its Person. */
		async function newGuest(
			name: string,
			contact: { email?: string | null; phone?: string | null } = {},
			clubId = seed.clubId,
		) {
			const { id } = await createGuestRecord(testDb, {
				clubId,
				name,
				email: contact.email ?? null,
				phone: contact.phone ?? null,
			});
			const [row] = await testDb
				.select({ personId: guests.personId })
				.from(guests)
				.where(eq(guests.id, id));
			return { guestId: id, personId: row?.personId as string };
		}

		/** A guest row in `clubId` that names an EXISTING Person. */
		async function guestOn(
			personId: string,
			clubId: string,
			name = uniq("Guest"),
		) {
			const { id } = await createGuestRecord(testDb, {
				clubId,
				name,
				personId,
			});
			return id;
		}

		async function member(clubId: string, personId: string, name = uniq("M")) {
			const [m] = await testDb
				.insert(members)
				.values({ clubId, personId, name })
				.returning({ id: members.id });
			if (!m) throw new Error("fixture");
			return m.id;
		}

		async function personRow(personId: string) {
			const [row] = await testDb
				.select()
				.from(people)
				.where(eq(people.id, personId));
			return row;
		}

		async function guestRow(guestId: string) {
			const [row] = await testDb
				.select()
				.from(guests)
				.where(eq(guests.id, guestId));
			if (!row) throw new Error("no guest");
			return row;
		}

		/** Does this predicate match the Person, as it does inside an UPDATE's WHERE? */
		async function matches(
			personId: string,
			predicate: ReturnType<typeof guestContactWritable>,
		) {
			const rows = await testDb
				.select({ id: people.id })
				.from(people)
				.where(and(eq(people.id, personId), predicate));
			return rows.length === 1;
		}

		/** A removed member's Person: a `member_remove` names it, and no membership. */
		async function released(personId: string, clubId: string) {
			await testDb.insert(activityLog).values({
				clubId,
				action: "member_remove",
				targetType: "member",
				targetId: randomUUID(),
				detail: { name: "Removed", personId },
			});
		}

		const edit = (
			guestId: string,
			name: string,
			contact: { email?: string | null; phone?: string | null },
			clubId = seed.clubId,
		) =>
			applyUpdateGuest({
				clubId,
				guestId,
				name,
				email: contact.email,
				phone: contact.phone,
			});

		// -----------------------------------------------------------------------
		// The predicates, and the refusal that is their read form.
		// -----------------------------------------------------------------------
		describe("guestContactWritable, guestContactFillable and the refusal agree", () => {
			it("a guest-only, unbound Person this club holds a guest row on is writable and fillable, with no refusal", async () => {
				const { personId } = await newGuest(uniq("Plain"));
				expect(await matches(personId, guestContactWritable(seed.clubId))).toBe(
					true,
				);
				expect(await matches(personId, guestContactFillable(seed.clubId))).toBe(
					true,
				);
				expect(await guestContactRefusalFor(personId, seed.clubId)).toBeNull();
			});

			it("a Person this club holds NO guest row on is neither writable nor fillable for it", async () => {
				const clubB = await makeClub();
				const { personId } = await newGuest(uniq("Elsewhere"), {}, clubB);
				expect(await matches(personId, guestContactWritable(seed.clubId))).toBe(
					false,
				);
				expect(await matches(personId, guestContactFillable(seed.clubId))).toBe(
					false,
				);
				expect(await matches(personId, guestContactWritable(clubB))).toBe(true);
			});

			it("a Person another club also holds a guest row on is writable but NOT fillable (the public rule is stricter)", async () => {
				const clubB = await makeClub();
				const { personId } = await newGuest(uniq("Two Clubs"));
				await guestOn(personId, clubB);
				expect(await matches(personId, guestContactWritable(seed.clubId))).toBe(
					true,
				);
				expect(await matches(personId, guestContactWritable(clubB))).toBe(true);
				expect(await matches(personId, guestContactFillable(seed.clubId))).toBe(
					false,
				);
				expect(await matches(personId, guestContactFillable(clubB))).toBe(
					false,
				);
			});

			it("a Person somebody has signed in as is neither, and the reason is `signed_in`", async () => {
				const { personId } = await newGuest(uniq("Signed In"));
				await testDb
					.update(people)
					.set({ userId: await makeUser() })
					.where(eq(people.id, personId));
				expect(await matches(personId, guestContactWritable(seed.clubId))).toBe(
					false,
				);
				expect(await matches(personId, guestContactFillable(seed.clubId))).toBe(
					false,
				);
				expect(await guestContactRefusalFor(personId, seed.clubId)).toBe(
					"signed_in",
				);
			});

			it("a Person that holds a membership HERE is neither, and the reason is `member_here`", async () => {
				const { personId } = await newGuest(uniq("Member Here"));
				await member(seed.clubId, personId);
				expect(await matches(personId, guestContactWritable(seed.clubId))).toBe(
					false,
				);
				expect(await matches(personId, guestContactFillable(seed.clubId))).toBe(
					false,
				);
				expect(await guestContactRefusalFor(personId, seed.clubId)).toBe(
					"member_here",
				);
			});

			it("a Person that holds a membership in ANOTHER club is neither, and the reason is `member_elsewhere`", async () => {
				const clubB = await makeClub();
				const { personId } = await newGuest(uniq("Member Elsewhere"));
				await member(clubB, personId);
				expect(await matches(personId, guestContactWritable(seed.clubId))).toBe(
					false,
				);
				expect(await matches(personId, guestContactFillable(seed.clubId))).toBe(
					false,
				);
				expect(await guestContactRefusalFor(personId, seed.clubId)).toBe(
					"member_elsewhere",
				);
			});

			it("when several reasons apply the FIRST wins: signed in, then a member here, then elsewhere", async () => {
				const clubB = await makeClub();
				const { personId } = await newGuest(uniq("All Three"));
				await member(seed.clubId, personId);
				await member(clubB, personId);
				expect(await guestContactRefusalFor(personId, seed.clubId)).toBe(
					"member_here",
				);
				await testDb
					.update(people)
					.set({ userId: await makeUser() })
					.where(eq(people.id, personId));
				expect(await guestContactRefusalFor(personId, seed.clubId)).toBe(
					"signed_in",
				);
			});

			it("a removed member's Person is writable for an officer but NOT fillable from the public book", async () => {
				// No membership, so it reads guest-only; a removal names it, so it is the
				// Person a roster re-import re-attaches (#875), and an address typed on the
				// anonymous book must never land on it.
				const { personId } = await newGuest(uniq("Former"));
				await released(personId, seed.clubId);
				expect(await matches(personId, guestContactWritable(seed.clubId))).toBe(
					true,
				);
				expect(await matches(personId, guestContactFillable(seed.clubId))).toBe(
					false,
				);
			});

			it("a Person carrying a roster-identity column is not fillable from the public book either", async () => {
				const { personId } = await newGuest(uniq("Anchored"));
				await testDb
					.update(people)
					.set({ customerId: `PN-${randomUUID()}` })
					.where(eq(people.id, personId));
				expect(await matches(personId, guestContactWritable(seed.clubId))).toBe(
					true,
				);
				expect(await matches(personId, guestContactFillable(seed.clubId))).toBe(
					false,
				);
			});

			it("the refusal expression is null exactly where the writable predicate matches, for every state above", async () => {
				const clubB = await makeClub();
				const states: Array<[string, (personId: string) => Promise<void>]> = [
					["plain", async () => {}],
					[
						"signed in",
						async (p) => {
							await testDb
								.update(people)
								.set({ userId: await makeUser() })
								.where(eq(people.id, p));
						},
					],
					["member here", async (p) => void (await member(seed.clubId, p))],
					["member elsewhere", async (p) => void (await member(clubB, p))],
					[
						"second club guest row",
						async (p) => void (await guestOn(p, clubB)),
					],
					["released", async (p) => released(p, seed.clubId)],
				];
				for (const [what, apply] of states) {
					const { personId } = await newGuest(uniq(what));
					await apply(personId);
					const [row] = await testDb
						.select({ refusal: guestContactRefusalSql(seed.clubId) })
						.from(people)
						.where(eq(people.id, personId));
					const writable = await matches(
						personId,
						guestContactWritable(seed.clubId),
					);
					expect(
						row?.refusal === null,
						`${what}: the reason says ${row?.refusal} but writable is ${writable}`,
					).toBe(writable);
				}
			});

			it("the board carries the same reason on each card (contactRefusal)", async () => {
				const clubB = await makeClub();
				const plain = await newGuest(uniq("Card Plain"));
				const signedIn = await newGuest(uniq("Card Signed In"));
				await testDb
					.update(people)
					.set({ userId: await makeUser() })
					.where(eq(people.id, signedIn.personId));
				const here = await newGuest(uniq("Card Here"));
				await member(seed.clubId, here.personId);
				const elsewhere = await newGuest(uniq("Card Elsewhere"));
				await member(clubB, elsewhere.personId);

				const board = await loadGuestPipeline(seed.clubId);
				const byId = new Map(board.map((g) => [g.id, g.contactRefusal]));
				expect(byId.get(plain.guestId)).toBeNull();
				expect(byId.get(signedIn.guestId)).toBe("signed_in");
				expect(byId.get(here.guestId)).toBe("member_here");
				expect(byId.get(elsewhere.guestId)).toBe("member_elsewhere");
			});
		});

		// -----------------------------------------------------------------------
		// The one writer of a guest row.
		// -----------------------------------------------------------------------
		describe("createGuestRecord writes the contact onto the Person it mints", () => {
			it("the fresh Person carries the email and phone, and the guests columns stay null", async () => {
				const name = uniq("Fresh");
				const email = address("fresh");
				const { guestId, personId } = await newGuest(name, {
					email,
					phone: "+15550004321",
				});
				const p = await personRow(personId);
				expect(p?.email).toBe(email);
				expect(p?.phone).toBe("+15550004321");
				const g = await guestRow(guestId);
				expect(g.email).toBeNull();
				expect(g.phone).toBeNull();
				expect(await guestContactOf(guestId)).toEqual({
					email,
					phone: "+15550004321",
				});
			});

			it("a Person the caller names keeps its own contact: a guest row never writes a member's", async () => {
				const email = address("theirs");
				const personId = await makePerson({ email, phone: "+15550009999" });
				await member(seed.clubId, personId);

				const { id } = await createGuestRecord(testDb, {
					clubId: seed.clubId,
					name: uniq("Names A Person"),
					email: address("typed"),
					phone: "+15550001234",
					personId,
				});

				expect(await guestContactOf(id)).toEqual({
					email,
					phone: "+15550009999",
				});
			});
		});

		// -----------------------------------------------------------------------
		// An officer's edit.
		// -----------------------------------------------------------------------
		describe("an officer's edit of a guest's contact (applyUpdateGuest)", () => {
			it("writes the Person's email and phone, the name on the guest row, and nothing on the dead columns", async () => {
				const name = uniq("Edit Me");
				const { guestId, personId } = await newGuest(name, {
					email: address("old"),
				});
				const email = address("new");
				const raw = uniquePhone();

				await edit(guestId, `${name} Fixed`, { email, phone: raw });

				const p = await personRow(personId);
				expect(p?.email).toBe(email);
				expect(p?.phone).toBe(toStoredPhone(raw, "1"));
				// The name is per club, and stays on the guest row.
				expect((await guestRow(guestId)).name).toBe(`${name} Fixed`);
				expect(p?.name).toBe(name);
				const g = await guestRow(guestId);
				expect(g.email).toBeNull();
				expect(g.phone).toBeNull();
			});

			it("shows in every club that holds a guest row on the Person", async () => {
				const clubB = await makeClub();
				const name = uniq("Two Clubs");
				const { guestId, personId } = await newGuest(name, {
					email: address("typo"),
				});
				const bGuest = await guestOn(personId, clubB, uniq("Named In B"));
				const fixed = address("fixed");

				await edit(guestId, name, { email: fixed });

				expect((await guestContactOf(bGuest)).email).toBe(fixed);
				const boardB = await loadGuestPipeline(clubB);
				expect(boardB.find((g) => g.id === bGuest)?.email).toBe(fixed);
				// Club B edits the same Person too: one person, one address.
				const again = address("again");
				await edit(bGuest, "Named In B", { email: again }, clubB);
				expect((await personRow(personId))?.email).toBe(again);
				expect((await guestContactOf(guestId)).email).toBe(again);
			});

			it("clears the contact when the edit sends empty values", async () => {
				const name = uniq("Clear Me");
				const { guestId, personId } = await newGuest(name, {
					email: address("c"),
					phone: "+15550001111",
				});
				await edit(guestId, name, { email: null, phone: null });
				const p = await personRow(personId);
				expect(p?.email).toBeNull();
				expect(p?.phone).toBeNull();
			});

			it("is refused for a Person who has signed in, with that reason, and rolls the NAME back too", async () => {
				const name = uniq("Signed In Guest");
				const email = address("theirs");
				const { guestId, personId } = await newGuest(name, { email });
				await testDb
					.update(people)
					.set({ userId: await makeUser() })
					.where(eq(people.id, personId));

				await expect(
					edit(guestId, `${name} Renamed`, { email: address("other") }),
				).rejects.toThrow(GUEST_CONTACT_REFUSAL_MESSAGES.signed_in);

				expect((await personRow(personId))?.email).toBe(email);
				expect((await guestRow(guestId)).name).toBe(name);
			});

			it("is refused for a member of THIS club, with that reason", async () => {
				const name = uniq("Member Guest");
				const email = address("roster");
				const personId = await makePerson({ name, email });
				await member(seed.clubId, personId, name);
				const guestId = await guestOn(personId, seed.clubId, name);

				await expect(
					edit(guestId, `${name} Renamed`, { email: address("other") }),
				).rejects.toThrow(GUEST_CONTACT_REFUSAL_MESSAGES.member_here);

				expect((await personRow(personId))?.email).toBe(email);
				expect((await guestRow(guestId)).name).toBe(name);
			});

			it("is refused for a member of ANOTHER club, with that reason", async () => {
				const clubB = await makeClub();
				const name = uniq("Elsewhere Guest");
				const email = address("theirs");
				const personId = await makePerson({ name, email });
				await member(clubB, personId, name);
				const guestId = await guestOn(personId, seed.clubId, name);

				await expect(
					edit(guestId, name, { email: address("other") }),
				).rejects.toThrow(GUEST_CONTACT_REFUSAL_MESSAGES.member_elsewhere);

				expect((await personRow(personId))?.email).toBe(email);
			});

			it("names the first reason when more than one applies (signed in before member)", async () => {
				const name = uniq("Both");
				const personId = await makePerson({ name, email: address("both") });
				await member(seed.clubId, personId, name);
				await testDb
					.update(people)
					.set({ userId: await makeUser() })
					.where(eq(people.id, personId));
				const guestId = await guestOn(personId, seed.clubId, name);

				await expect(
					edit(guestId, name, { email: address("other") }),
				).rejects.toThrow(GUEST_CONTACT_REFUSAL_MESSAGES.signed_in);
			});

			it("a form that only fixes the NAME of a member's guest card still saves: an unchanged contact attempts no contact write", async () => {
				const name = uniq("Name Only");
				const email = address("roster");
				const phone = "+15550007777";
				const personId = await makePerson({ name, email, phone });
				await member(seed.clubId, personId, name);
				const guestId = await guestOn(personId, seed.clubId, name);

				// The dialog resends what it displayed: the Person's own contact.
				await edit(guestId, `${name} Fixed`, { email, phone });

				expect((await guestRow(guestId)).name).toBe(`${name} Fixed`);
				const p = await personRow(personId);
				expect(p?.email).toBe(email);
				expect(p?.phone).toBe(phone);
			});

			it("another guest row on the SAME Person is not a clash, a different human with that address still is", async () => {
				const name = uniq("Same Person");
				const email = address("shared");
				const { guestId, personId } = await newGuest(name, { email });
				// A second guest row in this club on the same Person (several converted
				// guest rows can share one member Person, #635).
				await guestOn(personId, seed.clubId, uniq("Same Person Twin"));
				await edit(guestId, `${name} Fixed`, { email });
				expect((await guestRow(guestId)).name).toBe(`${name} Fixed`);

				const other = await newGuest(uniq("Other Human"));
				await expect(
					edit(other.guestId, "Other Human", { email }),
				).rejects.toThrow(/already has that phone number or email/);
			});
		});

		// -----------------------------------------------------------------------
		// The anonymous guest book.
		// -----------------------------------------------------------------------
		describe("the public guest book fills a blank contact (captureGuestVisit)", () => {
			/** A returning visit: same name and phone as the card, plus a new email. */
			async function revisit(name: string, phone: string, email: string) {
				return captureGuestVisit({ clubId: seed.clubId, name, phone, email });
			}

			it("fills a blank email on a guest-only, unbound Person only this club holds", async () => {
				const name = uniq("Returning");
				const phone = uniquePhone();
				const { guestId, personId } = await newGuest(name, {
					phone: toStoredPhone(phone, "1"),
				});
				const email = address("filled");

				const res = await revisit(name, phone, email);

				expect(res.guestId).toBe(guestId);
				expect(res.created).toBe(false);
				expect((await personRow(personId))?.email).toBe(email);
				expect((await guestRow(guestId)).email).toBeNull();
			});

			it("never replaces a value that is already there", async () => {
				const name = uniq("Has Email");
				const phone = uniquePhone();
				const had = address("had");
				const { personId } = await newGuest(name, {
					email: had,
					phone: toStoredPhone(phone, "1"),
				});

				await revisit(name, phone, address("late"));

				expect((await personRow(personId))?.email).toBe(had);
			});

			it("writes nothing when another club holds a guest row on the Person", async () => {
				const clubB = await makeClub();
				const name = uniq("Seen Elsewhere");
				const phone = uniquePhone();
				const { personId } = await newGuest(name, {
					phone: toStoredPhone(phone, "1"),
				});
				await guestOn(personId, clubB);

				await revisit(name, phone, address("nope"));

				expect((await personRow(personId))?.email).toBeNull();
			});

			it("writes nothing when the Person holds a membership", async () => {
				const clubB = await makeClub();
				const name = uniq("Is A Member");
				const phone = uniquePhone();
				const { personId } = await newGuest(name, {
					phone: toStoredPhone(phone, "1"),
				});
				await member(clubB, personId);

				const res = await revisit(name, phone, address("nope"));

				expect(res.created).toBe(false);
				expect((await personRow(personId))?.email).toBeNull();
			});

			it("writes nothing when somebody has signed in as the Person", async () => {
				const name = uniq("Bound");
				const phone = uniquePhone();
				const { personId } = await newGuest(name, {
					phone: toStoredPhone(phone, "1"),
				});
				await testDb
					.update(people)
					.set({ userId: await makeUser() })
					.where(eq(people.id, personId));

				await revisit(name, phone, address("nope"));

				expect((await personRow(personId))?.email).toBeNull();
			});

			it("writes nothing on a removed member's Person, even when its email is blank", async () => {
				const name = uniq("Former Member");
				const phone = uniquePhone();
				const { personId } = await newGuest(name, {
					phone: toStoredPhone(phone, "1"),
				});
				await released(personId, seed.clubId);

				await revisit(name, phone, address("mallory"));

				expect((await personRow(personId))?.email).toBeNull();
			});
		});

		// -----------------------------------------------------------------------
		// Member-identity paths ignore a guest-only Person.
		// -----------------------------------------------------------------------
		describe("a guest-only Person carrying a member's address is ignored by every identity path", () => {
			/** A member of this club with `email`, and a guest-only Person with the same. */
			async function memberAndGuestWithSameAddress() {
				const email = address("shared");
				const memberPerson = await makePerson({
					name: uniq("Real Member"),
					email,
				});
				const membershipId = await member(seed.clubId, memberPerson);
				const guest = await newGuest(uniq("Visitor"), { email });
				return { email, memberPerson, membershipId, guest };
			}

			it("does not block the member's sign-in (rosterPermitsBind)", async () => {
				const { email, memberPerson } = await memberAndGuestWithSameAddress();
				const userId = await makeUser(email);

				expect(
					await bindVerifiedPerson({ personId: memberPerson, userId }),
				).toBe(true);
			});

			it("is not a roster conflict for the invite", async () => {
				const { email, memberPerson, membershipId } =
					await memberAndGuestWithSameAddress();

				expect(await rosterConflictFor(memberPerson, email)).toBeNull();
				const prep = await prepareMemberInvite({
					clubId: seed.clubId,
					memberId: membershipId,
				});
				expect(prep.outcome).toBe("ready");
			});

			it("does not trip the email-change collision check", async () => {
				// An address only a guest-only Person carries is nobody's: a member may move
				// their sign-in to it. (A member who carried it WOULD be a holder.)
				const email = address("change-to");
				const guest = await newGuest(uniq("Visitor"), { email });
				const someoneElse = await makeUser();

				expect(
					await addressHeldByAnother(email.toLowerCase(), someoneElse),
				).toBe(false);

				// Control: the same address on a Person that IS somebody (a member) does.
				const memberPerson = await makePerson({ email });
				await member(seed.clubId, memberPerson);
				expect(
					await addressHeldByAnother(email.toLowerCase(), someoneElse),
				).toBe(true);
				expect(guest.personId).not.toBe(memberPerson);
			});

			it("is not a candidate for the CSV importer, and not in its address-holder map", async () => {
				const email = address("csv");
				const guest = await newGuest(uniq("Csv Visitor"), { email });

				const candidates = await loadPersonCandidates(seed.clubId);
				expect(candidates.map((c) => c.id)).not.toContain(guest.personId);
				const holders = await loadAddressHolders([email]);
				expect(holders.get(email.toLowerCase()) ?? []).toEqual([]);
			});

			it("lets the importer add a roster row carrying that address instead of skipping it", async () => {
				const email = address("csv-row");
				const guest = await newGuest(uniq("Csv Visitor"), { email });
				const name = uniq("Imported Member");

				const stats = await importPeopleAndMembers(seed.clubId, [
					{
						customerId: null,
						name,
						email,
						phone: null,
						joinedAt: new Date("2024-01-01"),
						originalJoinDate: null,
						officerPosition: null,
						currentPosition: null,
					},
				]);

				// A row matching a Person nobody holds is REFUSED and skipped outright
				// (#855); this one inserts its own Person.
				expect(stats.foreignSkipped).toBe(0);
				expect(stats.peopleCreated).toBe(1);
				const [created] = await testDb
					.select({ personId: members.personId })
					.from(members)
					.where(and(eq(members.clubId, seed.clubId), eq(members.name, name)));
				expect(created).toBeDefined();
				extraPeople.push(created?.personId as string);
				expect(created?.personId).not.toBe(guest.personId);
				// The visitor's Person is untouched.
				expect((await personRow(guest.personId))?.email).toBe(email);
			});

			it("is not returned by the new-club lookup (findBestPersonByEmail)", async () => {
				const email = address("rule-b");
				await newGuest(uniq("Rule B Visitor"), { email });
				expect(await findBestPersonByEmail(email)).toBeNull();

				// A member with the same address IS found: the lookup still works.
				const memberPerson = await makePerson({ email });
				await member(seed.clubId, memberPerson);
				expect(await findBestPersonByEmail(email)).toBe(memberPerson);
			});

			it("still sees a Person that shows a past as a member (a removal, or a customer id)", async () => {
				const emailA = address("released");
				const a = await newGuest(uniq("Released"), { email: emailA });
				await released(a.personId, seed.clubId);
				expect(await findBestPersonByEmail(emailA)).toBe(a.personId);
				expect(
					(await loadPersonCandidates(seed.clubId)).map((c) => c.id),
				).toContain(a.personId);

				const emailB = address("anchored");
				const b = await newGuest(uniq("Anchored"), { email: emailB });
				await testDb
					.update(people)
					.set({ customerId: `PN-${randomUUID()}` })
					.where(eq(people.id, b.personId));
				expect(await findBestPersonByEmail(emailB)).toBe(b.personId);
				expect(
					(await loadPersonCandidates(seed.clubId)).map((c) => c.id),
				).toContain(b.personId);
			});
		});

		// -----------------------------------------------------------------------
		// A guest row is never a holder.
		// -----------------------------------------------------------------------
		describe("a roster edit of a member's email is not blocked by a guest row in another club", () => {
			it("a guest row in another club naming the member's Person does not stop the sole holding club", async () => {
				const clubB = await makeClub();
				const name = uniq("Sole Holder");
				const personId = await makePerson({ name, email: address("typo") });
				const membershipId = await member(seed.clubId, personId, name);
				// Another club has a guest row on the same Person: a visit, not a membership.
				await guestOn(personId, clubB);
				const fixed = address("fixed");

				const res = await applyMemberEdit({
					clubId: seed.clubId,
					memberId: membershipId,
					name,
					email: fixed,
					actorMemberId: seed.adminMemberId,
				});

				expect(res.emailRefused).toBeNull();
				expect((await personRow(personId))?.email).toBe(fixed);
			});
		});
	},
);
