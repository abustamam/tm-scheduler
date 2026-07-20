import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, members } from "#/db/schema";
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
		})
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

async function addGuest(
	clubId: string,
	name: string,
	opts: { phone?: string | null; email?: string | null } = {},
): Promise<string> {
	const [row] = await testDb
		.insert(guests)
		.values({
			clubId,
			name,
			phone: opts.phone ?? null,
			email: opts.email ?? null,
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
		await addMember(seeded.clubId, "Has Both", {
			phone: "14155550001",
			email: "both@x.io",
		});
		await addMember(seeded.clubId, "Inactive", {
			phone: "14155550002",
			status: "inactive",
		});

		const roster = await loadRosterWithContact(seeded.clubId);
		const names = roster.map((r) => r.name);
		expect(names).toContain("Has Both");
		expect(names).not.toContain("Inactive");
		const both = roster.find((r) => r.name === "Has Both");
		expect(both?.phone).toBe("14155550001");
		expect(both?.email).toBe("both@x.io");
	});

	it("loadHolderContacts resolves member and guest contact by id", async () => {
		const memberId = await addMember(seeded.clubId, "Holder M", {
			phone: "14155550003",
			email: "m@x.io",
		});
		const guestId = await addGuest(seeded.clubId, "Holder G", {
			email: "g@x.io",
		});

		const map = await loadHolderContacts([memberId], [guestId]);
		expect(map.get(`member:${memberId}`)).toEqual({
			phone: "14155550003",
			email: "m@x.io",
		});
		expect(map.get(`guest:${guestId}`)).toEqual({
			phone: null,
			email: "g@x.io",
		});
	});

	it("loadHolderContacts returns an empty map for empty inputs (no query)", async () => {
		const map = await loadHolderContacts([], []);
		expect(map.size).toBe(0);
	});
});
