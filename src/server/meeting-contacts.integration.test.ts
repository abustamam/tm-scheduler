import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, guests, members, people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import {
	loadHolderContacts,
	loadRosterWithContact,
} from "./meeting-contacts-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

async function addMember(
	clubId: string,
	name: string,
	opts: {
		phone?: string | null;
		email?: string | null;
		status?: "active" | "inactive";
		preferredName?: string | null;
	} = {},
): Promise<string> {
	const personId = await seedPerson({ name });
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId,
			name,
			clubRole: "member",
			status: opts.status ?? "active",
			phone: opts.phone ?? null,
			email: opts.email ?? null,
			preferredName: opts.preferredName ?? null,
		})
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

async function addGuest(
	clubId: string,
	name: string,
	opts: {
		phone?: string | null;
		email?: string | null;
		preferredName?: string | null;
	} = {},
): Promise<string> {
	const [row] = await testDb
		.insert(guests)
		.values({
			clubId,
			name,
			phone: opts.phone ?? null,
			email: opts.email ?? null,
			preferredName: opts.preferredName ?? null,
		})
		.returning({ id: guests.id });
	if (!row) throw new Error("guest insert failed");
	return row.id;
}

describe.skipIf(!hasTestDb)("meeting contacts (integration)", () => {
	let seeded: SeededClub;

	beforeEach(async () => {
		seeded = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	});

	it("loadRosterWithContact returns active members with phone/email", async () => {
		// Stored as E.164 (already has a country code) → passed through as-is.
		await addMember(seeded.clubId, "Has Both", {
			phone: "+14155550001",
			email: "both@x.io",
		});
		await addMember(seeded.clubId, "Inactive", {
			phone: "+14155550002",
			status: "inactive",
		});

		const roster = await loadRosterWithContact(seeded.clubId);
		const names = roster.map((r) => r.name);
		expect(names).toContain("Has Both");
		expect(names).not.toContain("Inactive");
		const both = roster.find((r) => r.name === "Has Both");
		expect(both?.phone).toBe("+14155550001");
		expect(both?.email).toBe("both@x.io");
	});

	it("normalizes a country-code-less phone with the club default (#295)", async () => {
		await testDb
			.update(clubs)
			.set({ defaultCountryCode: "+1" })
			.where(eq(clubs.id, seeded.clubId));
		const memberId = await addMember(seeded.clubId, "Local Number", {
			phone: "(415) 555-2671",
		});

		const roster = await loadRosterWithContact(seeded.clubId);
		expect(roster.find((r) => r.name === "Local Number")?.phone).toBe(
			"+14155552671",
		);

		const map = await loadHolderContacts(seeded.clubId, [memberId], []);
		expect(map.get(`member:${memberId}`)?.phone).toBe("+14155552671");
	});

	it("falls back to the app default country code when the club has no default (#397)", async () => {
		await addMember(seeded.clubId, "No CC", { phone: "415-555-2671" });
		const roster = await loadRosterWithContact(seeded.clubId);
		// A club that never set a country code is assumed to be on the app default
		// rather than losing the number entirely — the same substitution the write
		// paths make, so read and write agree.
		expect(roster.find((r) => r.name === "No CC")?.phone).toBe("+14155552671");
	});

	it("drops a digit-less phone to null instead of coalescing it (nudge payload)", async () => {
		// PINS THE BARE `toE164` in meeting-contacts-logic.ts. These three sites
		// deliberately do NOT use `coalesceToE164`, and the ~15 lines of comment
		// arguing why were pinned by nothing: aliasing the import
		// (`import { coalesceToE164 as toE164 }`) left the whole suite green.
		//
		// `toStoredPhone` stores digit-less input verbatim so the member can still
		// read and edit it, so "call the office" is reachable in normal use. This
		// payload is a DIAL TARGET, never rendered text — `null` is what makes
		// `nudge-recruit-picker.tsx`'s `!t.phone && !t.email` test show the honest
		// "no contact" badge. Coalescing would make it truthy and SUPPRESS that
		// badge for someone nobody can message, while adding no working link
		// (`whatsappHref` is null for a digit-less value either way).
		const memberId = await addMember(seeded.clubId, "Words Not Digits", {
			phone: "call the office",
		});
		const guestId = await addGuest(seeded.clubId, "Guest Words", {
			phone: "ask at the door",
		});

		const roster = await loadRosterWithContact(seeded.clubId);
		expect(
			roster.find((r) => r.name === "Words Not Digits")?.phone,
			"loadRosterWithContact preserved a digit-less phone — that is " +
				"`coalesceToE164` behaviour, and it suppresses the recruit picker's " +
				'"no contact" badge for a member nobody can message.',
		).toBe(null);

		const map = await loadHolderContacts(seeded.clubId, [memberId], [guestId]);
		expect(
			map.get(`member:${memberId}`)?.phone,
			"loadHolderContacts (member branch) preserved a digit-less phone — see above.",
		).toBe(null);
		expect(
			map.get(`guest:${guestId}`)?.phone,
			"loadHolderContacts (guest branch) preserved a digit-less phone — see above.",
		).toBe(null);
	});

	it("loadHolderContacts resolves member and guest contact by id", async () => {
		const memberId = await addMember(seeded.clubId, "Holder M", {
			phone: "+14155550003",
			email: "m@x.io",
		});
		const guestId = await addGuest(seeded.clubId, "Holder G", {
			email: "g@x.io",
		});

		const map = await loadHolderContacts(seeded.clubId, [memberId], [guestId]);
		expect(map.get(`member:${memberId}`)).toEqual({
			phone: "+14155550003",
			email: "m@x.io",
			preferredName: null,
		});
		expect(map.get(`guest:${guestId}`)).toEqual({
			phone: null,
			email: "g@x.io",
			preferredName: null,
		});
	});

	it("carries the goes-by name for a member and a guest holder (#486)", async () => {
		// The nudge greeting reads this off the holder contact, so it has to
		// survive the same query that fetches phone/email.
		const memberId = await addMember(seeded.clubId, "Abdul-Rasheed Bustamam", {
			phone: "+14155550004",
			preferredName: "Rasheed",
		});
		const guestId = await addGuest(seeded.clubId, "Robert Smith", {
			email: "bob@x.io",
			preferredName: "Bob",
		});

		const map = await loadHolderContacts(seeded.clubId, [memberId], [guestId]);
		expect(map.get(`member:${memberId}`)?.preferredName).toBe("Rasheed");
		expect(map.get(`guest:${guestId}`)?.preferredName).toBe("Bob");
	});

	it("falls back to the Person's goes-by name when the membership has none", async () => {
		// The cross-club case (#486): someone records "Rasheed" in club A, then
		// joins club B. Club B's membership row is created by a path with no such
		// field to copy (CSV import, onboarding), so it is NULL — the Person's
		// value has to carry the greeting. Resolved at READ so every creation
		// path is covered at once.
		const personId = await seedPerson({ name: "Abdul-Rasheed Bustamam" });
		await testDb
			.update(people)
			.set({ preferredName: "Rasheed" })
			.where(eq(people.id, personId));
		const [row] = await testDb
			.insert(members)
			.values({
				clubId: seeded.clubId,
				personId,
				name: "Abdul-Rasheed Bustamam",
				phone: "+14155550007",
				preferredName: null,
			})
			.returning({ id: members.id });
		const memberId = row?.id ?? "";

		const map = await loadHolderContacts(seeded.clubId, [memberId], []);
		expect(map.get(`member:${memberId}`)?.preferredName).toBe("Rasheed");
		const roster = await loadRosterWithContact(seeded.clubId);
		expect(roster.find((r) => r.id === memberId)?.preferredName).toBe(
			"Rasheed",
		);
	});

	it("lets this club's goes-by name win over the Person's", async () => {
		// A club that records a different name for the same human keeps its own.
		const personId = await seedPerson({ name: "Robert Smith" });
		await testDb
			.update(people)
			.set({ preferredName: "Bob" })
			.where(eq(people.id, personId));
		const [row] = await testDb
			.insert(members)
			.values({
				clubId: seeded.clubId,
				personId,
				name: "Robert Smith",
				phone: "+14155550008",
				preferredName: "Rob",
			})
			.returning({ id: members.id });
		const memberId = row?.id ?? "";

		const map = await loadHolderContacts(seeded.clubId, [memberId], []);
		expect(map.get(`member:${memberId}`)?.preferredName).toBe("Rob");
	});

	it("loadRosterWithContact carries the goes-by name for the recruit picker", async () => {
		await addMember(seeded.clubId, "Abdul-Rasheed Bustamam", {
			phone: "+14155550005",
			preferredName: "Rasheed",
		});
		await addMember(seeded.clubId, "Plain Member", { phone: "+14155550006" });

		const roster = await loadRosterWithContact(seeded.clubId);
		expect(
			roster.find((r) => r.name === "Abdul-Rasheed Bustamam")?.preferredName,
		).toBe("Rasheed");
		// Nobody recorded one ⇒ null, and `greetingName` falls back to the first
		// token. The loader must not invent a value here.
		expect(roster.find((r) => r.name === "Plain Member")?.preferredName).toBe(
			null,
		);
	});

	it("loadHolderContacts excludes ids from a different club (PII scope)", async () => {
		const other = await seedClub();
		const foreignMemberId = await addMember(other.clubId, "Other Club Member", {
			phone: "14155559999",
			email: "other@x.io",
		});
		const map = await loadHolderContacts(seeded.clubId, [foreignMemberId], []);
		expect(map.size).toBe(0);
		await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
	});

	it("loadHolderContacts returns an empty map for empty inputs (no query)", async () => {
		// Assert the observable the guard actually controls, not the result:
		// Drizzle compiles an empty `inArray(col, [])` to `false`, so the map is
		// empty whether or not the short-circuit runs — a result-only assertion
		// passes with the guard deleted (CLAUDE.md coverage trap 3).
		const spy = vi.spyOn(testDb, "select");
		const map = await loadHolderContacts(seeded.clubId, [], []);
		expect(map.size).toBe(0);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("loadHolderContacts skips the guests query when only members are asked for", async () => {
		// Same shape one level down: the per-list `if (…length > 0)` guards are
		// invisible to a result assertion. Assert by COMPARISON rather than a
		// fixed count — the function also selects the club's default country
		// code, so the absolute number isn't the interesting part.
		const memberId = await addMember(seeded.clubId, "Only Member", {
			email: "only@x.io",
		});
		const guestId = await addGuest(seeded.clubId, "A Guest", {
			email: "g2@x.io",
		});

		const membersOnly = vi.spyOn(testDb, "select");
		await loadHolderContacts(seeded.clubId, [memberId], []);
		const withoutGuests = membersOnly.mock.calls.length;
		membersOnly.mockRestore();

		const both = vi.spyOn(testDb, "select");
		await loadHolderContacts(seeded.clubId, [memberId], [guestId]);
		const withGuests = both.mock.calls.length;
		both.mockRestore();

		// Exactly one more round trip when a guest is actually asked for.
		expect(withGuests).toBe(withoutGuests + 1);
	});
});
