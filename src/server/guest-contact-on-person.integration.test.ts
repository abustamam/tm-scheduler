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
import { updateGuestSchema } from "#/server/guest-pipeline-schemas";
import {
	cleanup,
	guestContactOf,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	setGuestContact,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyConvertGuestToMember,
	applyLinkGuestToMember,
	applySetGuestStage,
	applyUnlinkGuestFromMember,
	applyUpdateGuest,
	captureGuestVisit,
	loadGuestPipeline,
} = await import("#/server/guest-pipeline-logic");
const { loadActivity } = await import("#/server/activity-feed-logic");
const { mergePeople } = await import("#/server/people-merge-logic");
const { createGuestRecord, loadGuestProfile } = await import(
	"#/server/guests-logic"
);
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
const { applyMemberEdit, applyMemberRemove } = await import(
	"#/server/members-logic"
);

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

			// Each arm of `noMemberHistory` on its own. The Person holds no membership and
			// nobody has signed in, so it reads guest-only; but it was a member's, its
			// contact is the member's, and a roster re-import re-attaches it (#875): an
			// address typed on the anonymous book OR rewritten through a guest card would
			// become that member's sign-in key. Neither writer may touch it, the reason
			// is `former_member`, and identity matching still SEES it.
			const arms: Array<[string, (personId: string) => Promise<void>]> = [
				["a removal naming it", async (p) => released(p, seed.clubId)],
				[
					"a Toastmasters customer id",
					async (p) => {
						await testDb
							.update(people)
							.set({ customerId: `PN-${randomUUID()}` })
							.where(eq(people.id, p));
					},
				],
				[
					"a Base Camp user id",
					async (p) => {
						await testDb
							.update(people)
							.set({ basecampUserId: `bc-${randomUUID()}` })
							.where(eq(people.id, p));
					},
				],
				[
					"an original join date",
					async (p) => {
						await testDb
							.update(people)
							.set({ originalJoinDate: new Date("2015-03-01") })
							.where(eq(people.id, p));
					},
				],
				[
					"an invite stamp",
					async (p) => {
						await testDb
							.update(people)
							.set({ invitedAt: new Date("2025-01-01") })
							.where(eq(people.id, p));
					},
				],
			];
			for (const [what, give] of arms) {
				it(`a Person with ${what} is neither writable nor fillable, is refused as a former member, and is still seen by identity matching`, async () => {
					const email = address("former");
					const { personId } = await newGuest(uniq("Former"), { email });
					await give(personId);
					expect(
						await matches(personId, guestContactWritable(seed.clubId)),
					).toBe(false);
					expect(
						await matches(personId, guestContactFillable(seed.clubId)),
					).toBe(false);
					expect(await guestContactRefusalFor(personId, seed.clubId)).toBe(
						"former_member",
					);
					expect(await findBestPersonByEmail(email)).toBe(personId);
					expect(
						(await loadPersonCandidates(seed.clubId)).map((c) => c.id),
					).toContain(personId);
				});
			}

			it("an unrelated removal (naming another Person) does not count as a past", async () => {
				const { personId } = await newGuest(uniq("Not Former"));
				await released(randomUUID(), seed.clubId);
				expect(await matches(personId, guestContactWritable(seed.clubId))).toBe(
					true,
				);
				expect(await matches(personId, guestContactFillable(seed.clubId))).toBe(
					true,
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
					[
						"anchored",
						async (p) => {
							await testDb
								.update(people)
								.set({ customerId: `PN-${randomUUID()}` })
								.where(eq(people.id, p));
						},
					],
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
		// The Edit guest dialog's read.
		// -----------------------------------------------------------------------
		describe("loadGuestProfile carries the reason the dialog shows the contact read-only", () => {
			it("is null for a guest-only, unbound Person, and names each of the three refusals", async () => {
				const clubB = await makeClub();
				const plain = await newGuest(uniq("Profile Plain"));
				const signedIn = await newGuest(uniq("Profile Signed In"));
				await testDb
					.update(people)
					.set({ userId: await makeUser() })
					.where(eq(people.id, signedIn.personId));
				const here = await newGuest(uniq("Profile Here"));
				await member(seed.clubId, here.personId);
				const elsewhere = await newGuest(uniq("Profile Elsewhere"));
				await member(clubB, elsewhere.personId);

				const reason = async (guestId: string) =>
					(await loadGuestProfile(seed.clubId, guestId))?.contactRefusal;
				expect(await reason(plain.guestId)).toBeNull();
				expect(await reason(signedIn.guestId)).toBe("signed_in");
				expect(await reason(here.guestId)).toBe("member_here");
				expect(await reason(elsewhere.guestId)).toBe("member_elsewhere");
			});

			it("is the same reason the board carries and the edit throws", async () => {
				const name = uniq("Profile Same");
				const personId = await makePerson({ name, email: address("theirs") });
				await member(seed.clubId, personId, name);
				const guestId = await guestOn(personId, seed.clubId, name);

				const profile = await loadGuestProfile(seed.clubId, guestId);
				const board = await loadGuestPipeline(seed.clubId);

				expect(profile?.contactRefusal).toBe("member_here");
				expect(board.find((g) => g.id === guestId)?.contactRefusal).toBe(
					profile?.contactRefusal,
				);
				await expect(
					edit(guestId, name, { email: address("other") }),
				).rejects.toThrow(
					GUEST_CONTACT_REFUSAL_MESSAGES[
						profile?.contactRefusal ?? "member_here"
					],
				);
			});

			it("is null for another club's guest (the profile is club-scoped)", async () => {
				const clubB = await makeClub();
				const theirs = await newGuest(uniq("Theirs"), {}, clubB);
				expect(await loadGuestProfile(seed.clubId, theirs.guestId)).toBeNull();
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

		// -----------------------------------------------------------------------
		// Convert never carries somebody else's contact onto a new membership.
		// -----------------------------------------------------------------------
		describe("convert carries contact only from a Person that is the guest's own", () => {
			it("Alice's card wrongly linked to Bob, Bob removed, Alice converted: Bob signing in does NOT bind Alice's new membership", async () => {
				const bobEmail = address("bob");
				const aliceEmail = address("alice");
				const bobPerson = await makePerson({
					name: uniq("Bob Member"),
					email: bobEmail,
				});
				const bobMembership = await member(seed.clubId, bobPerson, "Bob");
				// Alice is a visitor with her own address on her own Person.
				const alice = await newGuest(uniq("Alice Visitor"), {
					email: aliceEmail,
				});
				// The officer links Alice's card to Bob by mistake; Bob is then removed
				// and the card goes back to following up.
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: alice.guestId,
					memberId: bobMembership,
					actorMemberId: seed.adminMemberId,
				});
				await applyMemberRemove({
					clubId: seed.clubId,
					memberId: bobMembership,
					actorMemberId: seed.adminMemberId,
				});
				await applySetGuestStage({
					clubId: seed.clubId,
					guestId: alice.guestId,
					stage: "following_up",
				});

				const res = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId: alice.guestId,
					actorMemberId: seed.adminMemberId,
				});

				// Bob's Person has a removal on record: his address is not Alice's to
				// carry, so her new Person has none, and Bob's sign-in cannot bind it.
				expect((await personRow(res.personId))?.email).toBeNull();
				expect(res.personId).not.toBe(bobPerson);
				extraPeople.push(res.personId);
				const bobUser = await makeUser(bobEmail);
				expect(
					await bindVerifiedPerson({ personId: res.personId, userId: bobUser }),
				).toBe(false);
				expect((await personRow(res.personId))?.userId).toBeNull();
			});

			it("a guest's own contact still travels: the fresh Person for a guest-only Person that gained a speech keeps its address", async () => {
				const email = address("own");
				const g = await newGuest(uniq("Own Contact"), {
					email,
					phone: "+15550007001",
				});
				// A second guest row in another club makes it not pristine, but it is
				// still a guest's own Person with no past as a member.
				const clubB = await makeClub();
				await guestOn(g.personId, clubB);

				const res = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId: g.guestId,
					actorMemberId: seed.adminMemberId,
				});

				expect(res.personId).not.toBe(g.personId);
				extraPeople.push(res.personId);
				const fresh = await personRow(res.personId);
				expect(fresh?.email).toBe(email);
				expect(fresh?.phone).toBe("+15550007001");
			});
		});

		// -----------------------------------------------------------------------
		// A link takes the guest's contact with its Person; an unlink gives it back.
		// -----------------------------------------------------------------------
		describe("link then unlink keeps the guest's own contact", () => {
			it("the contact the link abandoned is restored onto the Person the unlink mints", async () => {
				const name = uniq("Link Me");
				const email = address("link");
				const phone = "+15550007002";
				const g = await newGuest(name, { email, phone });
				const memberPerson = await makePerson({
					name: uniq("The Member"),
					email: address("member"),
				});
				const membershipId = await member(
					seed.clubId,
					memberPerson,
					"The Member",
				);

				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: g.guestId,
					memberId: membershipId,
					actorMemberId: seed.adminMemberId,
				});
				// The guest's own Person went with the link, and the guest now reads the
				// member's contact.
				expect(await personRow(g.personId)).toBeUndefined();
				expect((await guestContactOf(g.guestId)).email).not.toBe(email);

				await applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId: g.guestId,
					actorMemberId: seed.adminMemberId,
				});

				expect(await guestContactOf(g.guestId)).toEqual({ email, phone });
				const now = await guestRow(g.guestId);
				expect(now.personId).not.toBe(memberPerson);
				extraPeople.push(now.personId);
				// The member's own Person was never written.
				expect((await personRow(memberPerson))?.email).not.toBe(email);
			});

			it("a guest with no contact is unlinked to a name-only Person, and the record carries no contact key", async () => {
				const g = await newGuest(uniq("No Contact"));
				const memberPerson = await makePerson({ name: uniq("M2") });
				const membershipId = await member(seed.clubId, memberPerson, "M2");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: g.guestId,
					memberId: membershipId,
					actorMemberId: seed.adminMemberId,
				});
				const [row] = await testDb
					.select({ detail: activityLog.detail })
					.from(activityLog)
					.where(
						and(
							eq(activityLog.clubId, seed.clubId),
							eq(activityLog.action, "member_merge"),
							eq(activityLog.targetId, membershipId),
						),
					);
				expect(row?.detail).not.toHaveProperty("guestContact");

				await applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId: g.guestId,
					actorMemberId: seed.adminMemberId,
				});
				expect(await guestContactOf(g.guestId)).toEqual({
					email: null,
					phone: null,
				});
				extraPeople.push((await guestRow(g.guestId)).personId);
			});

			it("the recorded contact is not readable through the activity feed", async () => {
				const email = address("feed");
				const g = await newGuest(uniq("Feed Guest"), {
					email,
					phone: "+15550007003",
				});
				const memberPerson = await makePerson({ name: uniq("M3") });
				const membershipId = await member(seed.clubId, memberPerson, "M3");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: g.guestId,
					memberId: membershipId,
					actorMemberId: seed.adminMemberId,
				});
				// It IS in the row (that is what the unlink reads)...
				const [row] = await testDb
					.select({ detail: activityLog.detail })
					.from(activityLog)
					.where(
						and(
							eq(activityLog.clubId, seed.clubId),
							eq(activityLog.action, "member_merge"),
							eq(activityLog.targetId, membershipId),
						),
					);
				expect(row?.detail).toMatchObject({ guestContact: { email } });
				// ...and nowhere in what the feed hands a club's members.
				const feed = await loadActivity({ clubId: seed.clubId });
				expect(JSON.stringify(feed)).not.toContain(email);
				expect(JSON.stringify(feed)).not.toContain("+15550007003");
				await applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId: g.guestId,
					actorMemberId: seed.adminMemberId,
				});
				extraPeople.push((await guestRow(g.guestId)).personId);
			});
		});

		// -----------------------------------------------------------------------
		// A merge never carries a guest's contact into a member's blank.
		// -----------------------------------------------------------------------
		describe("mergePeople does not carry a guest-only Person's contact onto a member", () => {
			it("a guest-only absorbed Person's email and phone are NOT adopted by a keeper that holds a membership", async () => {
				const keeper = await makePerson({ name: uniq("Member Keeper") });
				await member(seed.clubId, keeper, "Member Keeper");
				const g = await newGuest(uniq("Guest Absorbed"), {
					email: address("typed"),
					phone: "+15550007004",
				});

				await mergePeople({
					keeperPersonId: keeper,
					absorbedPersonId: g.personId,
				});

				const k = await personRow(keeper);
				expect(k?.email).toBeNull();
				expect(k?.phone).toBeNull();
				// The guest row moved to the keeper, so it now reads the member's contact.
				expect((await guestRow(g.guestId)).personId).toBe(keeper);
			});

			it("control: a guest-only keeper still adopts a guest-only absorbed Person's contact, and a member absorbed Person's contact still fills a member keeper", async () => {
				const keeperGuest = await newGuest(uniq("Guest Keeper"));
				const absorbedGuest = await newGuest(uniq("Guest Absorbed 2"), {
					email: address("fill"),
				});
				await mergePeople({
					keeperPersonId: keeperGuest.personId,
					absorbedPersonId: absorbedGuest.personId,
				});
				expect((await personRow(keeperGuest.personId))?.email).not.toBeNull();

				const memberKeeper = await makePerson({ name: uniq("MK") });
				await member(seed.clubId, memberKeeper, "MK");
				const memberAbsorbed = await makePerson({
					name: uniq("MA"),
					email: address("ma"),
				});
				const clubB = await makeClub();
				await member(clubB, memberAbsorbed, "MA");
				await mergePeople({
					keeperPersonId: memberKeeper,
					absorbedPersonId: memberAbsorbed,
				});
				expect((await personRow(memberKeeper))?.email).not.toBeNull();
			});
		});

		// -----------------------------------------------------------------------
		// Omitted contact means "leave it".
		// -----------------------------------------------------------------------
		describe("an edit that leaves the contact out", () => {
			it("a name-only save on a locked card with a malformed stored email succeeds, and the email is untouched", async () => {
				const name = uniq("Malformed");
				const bad = "not-an-address (legacy)";
				const personId = await makePerson({
					name,
					email: bad,
					phone: "+15550007005",
				});
				await member(seed.clubId, personId, name);
				const guestId = await guestOn(personId, seed.clubId, name);

				// The schema's format check only runs on a SUBMITTED email, so a payload
				// with the contact left out passes it.
				expect(() =>
					updateGuestSchema.parse({
						clubId: seed.clubId,
						guestId,
						name: `${name} Fixed`,
					}),
				).not.toThrow();
				await applyUpdateGuest({
					clubId: seed.clubId,
					guestId,
					name: `${name} Fixed`,
				});

				expect((await guestRow(guestId)).name).toBe(`${name} Fixed`);
				const p = await personRow(personId);
				expect(p?.email).toBe(bad);
				expect(p?.phone).toBe("+15550007005");
			});

			it("a stale copy cannot overwrite a newer value: the omitted field keeps what is stored NOW", async () => {
				const name = uniq("Stale");
				const g = await newGuest(name, {
					email: address("old"),
					phone: "+15550007006",
				});
				// Somebody else edits the contact after this officer's dialog loaded.
				const newer = address("newer");
				await edit(g.guestId, name, { email: newer, phone: "+15550007007" });

				// The officer's dialog (loaded with the old values) fixes the NAME only and,
				// as it now does, leaves the contact out.
				await applyUpdateGuest({
					clubId: seed.clubId,
					guestId: g.guestId,
					name: `${name} B`,
				});

				expect(await guestContactOf(g.guestId)).toEqual({
					email: newer,
					phone: "+15550007007",
				});
			});

			it("sending only the email leaves the phone alone, and null still clears", async () => {
				const name = uniq("One Field");
				const g = await newGuest(name, {
					email: address("a"),
					phone: "+15550007008",
				});
				const b = address("b");
				await applyUpdateGuest({
					clubId: seed.clubId,
					guestId: g.guestId,
					name,
					email: b,
				});
				expect(await guestContactOf(g.guestId)).toEqual({
					email: b,
					phone: "+15550007008",
				});
				await applyUpdateGuest({
					clubId: seed.clubId,
					guestId: g.guestId,
					name,
					phone: null,
				});
				expect(await guestContactOf(g.guestId)).toEqual({
					email: b,
					phone: null,
				});
			});

			it("the clash check runs only on a submitted change", async () => {
				const email = address("dup");
				const first = await newGuest(uniq("First"), { email });
				const second = await newGuest(uniq("Second"));
				// A legacy duplicate: put the same address on the second guest's Person
				// directly, as an old import could have.
				await setGuestContact(second.guestId, { email });
				// A name fix leaves the stored (duplicate) address alone and saves...
				await applyUpdateGuest({
					clubId: seed.clubId,
					guestId: second.guestId,
					name: "Second Fixed",
				});
				// ...and so does a change to the OTHER key: the phone is edited, the stored
				// duplicate email is not re-checked.
				await applyUpdateGuest({
					clubId: seed.clubId,
					guestId: second.guestId,
					name: "Second Fixed",
					phone: "+15550007009",
				});
				expect((await guestContactOf(second.guestId)).phone).toBe(
					"+15550007009",
				);
				// ...but SUBMITTING a different guest's address is still refused.
				const third = await newGuest(uniq("Third"));
				await expect(
					applyUpdateGuest({
						clubId: seed.clubId,
						guestId: third.guestId,
						name: "Third",
						email,
					}),
				).rejects.toThrow(/already has that phone number or email/);
				expect(first.guestId).not.toBe(second.guestId);
			});
		});
	},
);
