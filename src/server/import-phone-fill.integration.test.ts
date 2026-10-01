/**
 * The CSV importer's Person phone write is a real FILL (#906 review).
 *
 * The plan decides from a snapshot of every candidate Person loaded once at the
 * start of the file. Writing its `set.phone` unconditionally would put the
 * snapshot's value back over a number an officer set while the import ran —
 * and the phone is shared by every club holding the Person. So the write is
 * gated on the plan having filled it AND on `people.phone IS NULL` in the
 * statement itself.
 *
 * The concurrent edit is injected deterministically through the importer's own
 * `write` seam: it lands after the snapshot and immediately before the Person
 * write, which is exactly the window the gate exists for.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, people } from "#/db/schema";
import type { MappedMember } from "#/lib/members-csv";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { importPeopleAndMembers } = await import("./import-members-logic");

function row(over: Partial<MappedMember>): MappedMember {
	return {
		customerId: null,
		name: "Import Person",
		email: null,
		phone: null,
		joinedAt: null,
		originalJoinDate: null,
		officerPosition: null,
		currentPosition: null,
		...over,
	};
}

async function phoneOf(personId: string): Promise<string | null> {
	const [p] = await testDb
		.select({ phone: people.phone })
		.from(people)
		.where(eq(people.id, personId));
	return p?.phone ?? null;
}

describe.skipIf(!hasTestDb)(
	"import fills a Person phone, never overwrites (#906)",
	() => {
		let seed: SeededClub;
		let customerId: string;
		let personId: string;

		beforeEach(async () => {
			seed = await seedClub();
			customerId = `PN-906-${randomUUID().slice(0, 8)}`;
			// A Person this club holds, with NO phone — so the plan fills it.
			personId = await seedPerson({ name: "Import Person", customerId });
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId,
				name: "Import Person",
				clubRole: "member",
				status: "active",
			});
		});
		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		it("fills a blank phone", async () => {
			await importPeopleAndMembers(seed.clubId, [
				row({ customerId, phone: "+14155550301" }),
			]);
			expect(await phoneOf(personId)).toBe("+14155550301");
		});

		it("does not overwrite a phone an officer set after the plan's snapshot", async () => {
			const edited = "+14155550399";
			await importPeopleAndMembers(
				seed.clubId,
				[row({ customerId, phone: "+14155550302" })],
				{
					write: async (kind, _rowIndex, _id, work) => {
						if (kind === "person") {
							// The concurrent edit, landing between snapshot and write.
							await testDb
								.update(people)
								.set({ phone: edited })
								.where(eq(people.id, personId));
						}
						return work(testDb);
					},
				},
			);
			expect(await phoneOf(personId)).toBe(edited);
		});

		it("leaves a phone already on file alone", async () => {
			await testDb
				.update(people)
				.set({ phone: "+14155550303" })
				.where(eq(people.id, personId));
			await importPeopleAndMembers(seed.clubId, [
				row({ customerId, phone: "+14155550304" }),
			]);
			expect(await phoneOf(personId)).toBe("+14155550303");
		});
	},
);
