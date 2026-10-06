/**
 * DB-backed tests for the ADMIN's writer of `people.preferred_contact` — the
 * roster edit, `applyMemberEdit` (#1093) — and for the two roster readers
 * (`loadMemberProfile`, `loadClubMembers`) that show it.
 *
 * Three rules, each in the preference UPDATE's own WHERE and each with a case
 * here that fails without it:
 *  - the method's data exists, judged against the row as THIS edit leaves it
 *    (so clearing the phone and choosing SMS in one save is refused);
 *  - the Person has not signed in (`isNull(people.userId)`); once they have,
 *    the choice is theirs, and sending it refuses the whole edit;
 *  - a refusal writes NOTHING from that save.
 */
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, members, people } from "#/db/schema";
import {
	CONTACT_METHOD_UNAVAILABLE_MESSAGE,
	CONTACT_METHODS,
	CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE,
	CONTACT_PREFERENCE_MULTI_CLUB_MESSAGE,
	type ContactMethod,
} from "#/lib/preferred-contact";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMemberEdit, editSchema } = await import("./members-logic");
const { loadClubMembers, loadMemberProfile } = await import("./club-logic");

const PHONE = "+14155552671";

async function person(personId: string) {
	const [row] = await testDb
		.select({
			phone: people.phone,
			email: people.email,
			preferredContact: people.preferredContact,
		})
		.from(people)
		.where(eq(people.id, personId));
	if (!row) throw new Error("person gone");
	return row;
}

async function memberName(memberId: string): Promise<string | undefined> {
	const [row] = await testDb
		.select({ name: members.name })
		.from(members)
		.where(eq(members.id, memberId));
	return row?.name;
}

describe.skipIf(!hasTestDb)(
	"applyMemberEdit: preferred contact (#1093)",
	() => {
		let seed: SeededClub;
		/** An unlinked roster member: nobody has signed in as their Person. */
		let unlinked: { personId: string; memberId: string };

		beforeEach(async () => {
			seed = await seedClub();
			const personId = await seedPerson({
				name: "Una Linked",
				email: "una@example.com",
				phone: PHONE,
			});
			const [m] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name: "Una Linked" })
				.returning({ id: members.id });
			if (!m) throw new Error("insert failed");
			unlinked = { personId, memberId: m.id };
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		function edit(
			memberId: string,
			extra: {
				name?: string;
				phone?: string | null;
				email?: string | null;
				preferredContact?: ContactMethod | null;
			},
		) {
			return applyMemberEdit({
				clubId: seed.clubId,
				memberId,
				name: extra.name ?? "Una Linked",
				actorMemberId: seed.adminMemberId,
				...extra,
			});
		}

		it("accepts the field through the edit schema", () => {
			const parsed = editSchema.parse({
				clubId: seed.clubId,
				memberId: unlinked.memberId,
				name: "X",
				preferredContact: "sms",
			});
			expect(parsed.preferredContact).toBe("sms");
			expect(() =>
				editSchema.parse({
					clubId: seed.clubId,
					memberId: unlinked.memberId,
					name: "X",
					preferredContact: "pigeon",
				}),
			).toThrow();
		});

		it("saves every available method and null on an unlinked Person, and logs it", async () => {
			for (const m of CONTACT_METHODS) {
				await edit(unlinked.memberId, { preferredContact: m });
				expect((await person(unlinked.personId)).preferredContact).toBe(m);
			}
			await edit(unlinked.memberId, { preferredContact: null });
			expect((await person(unlinked.personId)).preferredContact).toBeNull();

			const [log] = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_edit"),
						eq(activityLog.targetId, unlinked.memberId),
					),
				)
				.orderBy(desc(activityLog.createdAt))
				.limit(1);
			expect(log?.detail).toMatchObject({
				before: { preferredContact: "whatsapp" },
				after: { preferredContact: null },
			});
		});

		it("refuses a method whose data is missing, and writes nothing from that save", async () => {
			await testDb
				.update(people)
				.set({ phone: null })
				.where(eq(people.id, unlinked.personId));
			for (const m of ["call", "sms", "whatsapp"] as const) {
				await expect(
					edit(unlinked.memberId, { name: "Renamed", preferredContact: m }),
				).rejects.toThrow(CONTACT_METHOD_UNAVAILABLE_MESSAGE);
			}
			expect((await person(unlinked.personId)).preferredContact).toBeNull();
			expect(await memberName(unlinked.memberId)).toBe("Una Linked");

			await testDb
				.update(people)
				.set({ email: null, phone: PHONE })
				.where(eq(people.id, unlinked.personId));
			await expect(
				edit(unlinked.memberId, { name: "Renamed", preferredContact: "email" }),
			).rejects.toThrow(CONTACT_METHOD_UNAVAILABLE_MESSAGE);
			expect((await person(unlinked.personId)).preferredContact).toBeNull();
			expect(await memberName(unlinked.memberId)).toBe("Una Linked");
		});

		it("refuses email when the address is only whitespace JS .trim() removes", async () => {
			for (const email of ["\t", "\n", "\u00a0", "\ufeff"]) {
				await testDb
					.update(people)
					.set({ email, phone: PHONE })
					.where(eq(people.id, unlinked.personId));
				await expect(
					edit(unlinked.memberId, {
						name: "Renamed",
						preferredContact: "email",
					}),
				).rejects.toThrow(CONTACT_METHOD_UNAVAILABLE_MESSAGE);
				expect((await person(unlinked.personId)).preferredContact).toBeNull();
				expect(await memberName(unlinked.memberId)).toBe("Una Linked");
			}
		});

		it("refuses the WHOLE edit for a Person another club also holds, writing nothing", async () => {
			const other = await seedClub();
			try {
				await testDb.insert(members).values({
					clubId: other.clubId,
					personId: unlinked.personId,
					name: "Una Linked",
				});
				await expect(
					edit(unlinked.memberId, { name: "Renamed", preferredContact: "sms" }),
				).rejects.toThrow(CONTACT_PREFERENCE_MULTI_CLUB_MESSAGE);
				expect((await person(unlinked.personId)).preferredContact).toBeNull();
				expect(await memberName(unlinked.memberId)).toBe("Una Linked");
				// The profile says so, so the form can lock the field.
				expect(
					(await loadMemberProfile(seed.clubId, unlinked.memberId))
						?.contactPreferenceRefusal,
				).toBe("multi_club");

				// The same edit without the field saves.
				await edit(unlinked.memberId, { name: "Renamed" });
				expect(await memberName(unlinked.memberId)).toBe("Renamed");
			} finally {
				// Only the membership this test added: `cleanup` deletes the Persons
				// of the club it is handed, and this Person belongs to the seed club.
				await testDb
					.delete(members)
					.where(
						and(
							eq(members.clubId, other.clubId),
							eq(members.personId, unlinked.personId),
						),
					);
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("allows the SOLE holding club, and the profile says it may", async () => {
			expect(
				(await loadMemberProfile(seed.clubId, unlinked.memberId))
					?.contactPreferenceRefusal,
			).toBeNull();
			await edit(unlinked.memberId, { preferredContact: "call" });
			expect((await person(unlinked.personId)).preferredContact).toBe("call");
		});

		it("names the real reason when the email write is refused and email is chosen", async () => {
			// Another club holds this Person, so the new address is refused
			// (`multi_club`) and the Person still has no email. The preference
			// must say "another club", not "add an email".
			await testDb
				.update(people)
				.set({ email: null })
				.where(eq(people.id, unlinked.personId));
			const other = await seedClub();
			try {
				await testDb.insert(members).values({
					clubId: other.clubId,
					personId: unlinked.personId,
					name: "Una Linked",
				});
				const attempt = edit(unlinked.memberId, {
					email: "new@example.com",
					preferredContact: "email",
				});
				await expect(attempt).rejects.toThrow(
					CONTACT_PREFERENCE_MULTI_CLUB_MESSAGE,
				);
				await expect(attempt).rejects.not.toThrow(
					CONTACT_METHOD_UNAVAILABLE_MESSAGE,
				);
				expect((await person(unlinked.personId)).email).toBeNull();
			} finally {
				// Only the membership this test added: `cleanup` deletes the Persons
				// of the club it is handed, and this Person belongs to the seed club.
				await testDb
					.delete(members)
					.where(
						and(
							eq(members.clubId, other.clubId),
							eq(members.personId, unlinked.personId),
						),
					);
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("refuses clearing the phone and choosing SMS in one save, writing nothing", async () => {
			await expect(
				edit(unlinked.memberId, {
					name: "Renamed",
					phone: null,
					preferredContact: "sms",
				}),
			).rejects.toThrow(CONTACT_METHOD_UNAVAILABLE_MESSAGE);

			const after = await person(unlinked.personId);
			// The phone clear rolled back with the rest of the save.
			expect(after.phone).toBe(PHONE);
			expect(after.preferredContact).toBeNull();
			expect(await memberName(unlinked.memberId)).toBe("Una Linked");
		});

		it("accepts adding the phone and choosing SMS in one save", async () => {
			await testDb
				.update(people)
				.set({ phone: null })
				.where(eq(people.id, unlinked.personId));
			await edit(unlinked.memberId, { phone: PHONE, preferredContact: "sms" });
			expect((await person(unlinked.personId)).preferredContact).toBe("sms");
		});

		it("refuses the WHOLE edit for a Person who has signed in, writing nothing", async () => {
			// seed.memberId's Person carries seed.memberUserId, and an email, so
			// `email` is available: the refusal is about ownership alone.
			await expect(
				edit(seed.memberId, { name: "Renamed", preferredContact: "email" }),
			).rejects.toThrow(CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE);
			await expect(
				edit(seed.memberId, { name: "Renamed", preferredContact: null }),
			).rejects.toThrow(CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE);
			expect((await person(seed.personId)).preferredContact).toBeNull();
			expect(await memberName(seed.memberId)).toBe("Member User");

			// The same admin's edit WITHOUT the field saves.
			await edit(seed.memberId, { name: "Renamed" });
			expect(await memberName(seed.memberId)).toBe("Renamed");

			// And the same admin may set it on an unlinked Person.
			await edit(unlinked.memberId, { preferredContact: "email" });
			expect((await person(unlinked.personId)).preferredContact).toBe("email");
		});

		it("keeps a stale choice and shows none until the phone returns", async () => {
			await edit(unlinked.memberId, { preferredContact: "sms" });
			const profile = () => loadMemberProfile(seed.clubId, unlinked.memberId);
			const rosterRow = async () =>
				(await loadClubMembers(seed.clubId)).find(
					(r) => r.id === unlinked.memberId,
				);
			expect((await profile())?.preferredContact).toBe("sms");
			expect((await rosterRow())?.preferredContact).toBe("sms");

			await edit(unlinked.memberId, { phone: null });
			expect((await person(unlinked.personId)).preferredContact).toBe("sms");
			expect((await profile())?.preferredContact).toBeNull();
			expect((await rosterRow())?.preferredContact).toBeNull();

			await edit(unlinked.memberId, { phone: PHONE });
			expect((await profile())?.preferredContact).toBe("sms");
			expect((await rosterRow())?.preferredContact).toBe("sms");
		});

		it("never returns the raw column from the readers", async () => {
			const p = await loadMemberProfile(seed.clubId, unlinked.memberId);
			expect(p && "storedPreferredContact" in p).toBe(false);
			const rows = await loadClubMembers(seed.clubId);
			expect(rows.some((r) => "storedPreferredContact" in r)).toBe(false);
		});
	},
);
