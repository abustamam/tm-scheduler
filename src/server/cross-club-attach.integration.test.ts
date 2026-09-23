/**
 * The cross-club attach gate (#759), end to end against real Postgres.
 *
 * The attack: a club admin (or any elected officer) names another club's member
 * in a CSV row, or in a guest they convert, and the importer or the convert
 * resolves that Person GLOBALLY and mints a membership for them in the
 * attacker's club. A Person two clubs hold cannot bind an account by any route
 * (`rosterPermitsBind` arm 2), so the victim is locked out of sign-in from a
 * club neither they nor their own officers can see.
 *
 * Each case seeds the victim in club A and acts from club B. The proof that
 * matters is the last import case: the victim can still BIND afterwards,
 * asserted through `bindVerifiedPerson` rather than by counting rows.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/cross-club-attach.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, people, user } from "#/db/schema";
import type { MappedMember } from "#/lib/members-csv";
import {
	ADDRESS_CONFLICT_NOTE,
	FOREIGN_SKIP_NOTE,
} from "#/lib/members-import-plan";
import { toStoredPhone } from "#/lib/phone";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// The upload path's officer-approval pass reads the request for a session;
// nothing here approves an office, so it only has to not be reached.
vi.mock("@tanstack/react-start/server", () => ({
	getRequest: () => {
		throw new Error("no request");
	},
}));

const { importPeopleAndMembers } = await import("./import-members-logic");
const { previewMemberImport, commitMemberImport } = await import(
	"./upload-members-logic"
);
const { applyConvertGuestToMember, captureGuestVisit } = await import(
	"./guest-pipeline-logic"
);
const { bindVerifiedPerson } = await import("./account-link-logic");

/** Minimal mapped-CSV row builder (all fields default to null). */
function row(over: Partial<MappedMember>): MappedMember {
	return {
		customerId: null,
		name: "Unnamed",
		email: null,
		phone: null,
		joinedAt: null,
		originalJoinDate: null,
		officerPosition: null,
		currentPosition: null,
		...over,
	};
}

/** A Toastmasters export with the columns `mapRow` reads. */
function csv(
	rows: { customerId?: string; name: string; email?: string }[],
): string {
	const body = rows
		.map((r) => `${r.customerId ?? ""},${r.name},${r.email ?? ""},PaidMember,`)
		.join("\n");
	return `Customer ID,Name,Email,Status (*),Current Position\n${body}\n`;
}

describe.skipIf(!hasTestDb)("cross-club attach gate (#759)", () => {
	let victimClub: SeededClub;
	let attackerClub: SeededClub;
	let n: string;
	let userIds: string[];
	let personIds: string[];

	beforeEach(async () => {
		victimClub = await seedClub();
		attackerClub = await seedClub();
		n = randomUUID().slice(0, 8);
		userIds = [];
		personIds = [];
	});

	afterEach(async () => {
		await cleanup(attackerClub.clubId, [
			attackerClub.adminUserId,
			attackerClub.memberUserId,
		]);
		await cleanup(victimClub.clubId, [
			victimClub.adminUserId,
			victimClub.memberUserId,
		]);
		if (personIds.length > 0) {
			await testDb.delete(people).where(inArray(people.id, personIds));
		}
		if (userIds.length > 0) {
			await testDb.delete(user).where(inArray(user.id, userIds));
		}
	});

	/** A Person with a roster row in `clubId` — or in no club at all. */
	async function person(
		clubId: string | null,
		over: {
			name?: string;
			customerId?: string | null;
			personEmail?: string | null;
			rosterEmail?: string | null;
			phone?: string | null;
			status?: "active" | "inactive";
			userId?: string | null;
		} = {},
	): Promise<string> {
		const name = over.name ?? `Victim ${n}`;
		const [p] = await testDb
			.insert(people)
			.values({
				name,
				customerId: over.customerId ?? null,
				email: over.personEmail ?? null,
				phone: over.phone ?? null,
				userId: over.userId ?? null,
			})
			.returning({ id: people.id });
		if (!p) throw new Error("person insert failed");
		personIds.push(p.id);
		if (clubId) {
			await testDb.insert(members).values({
				clubId,
				personId: p.id,
				name,
				email: over.rosterEmail ?? null,
				phone: over.phone ?? null,
				status: over.status ?? "active",
			});
		}
		return p.id;
	}

	async function account(email: string): Promise<string> {
		const id = randomUUID();
		await testDb
			.insert(user)
			.values({ id, name: "Signed In", email, emailVerified: true });
		userIds.push(id);
		return id;
	}

	async function rosterOf(clubId: string) {
		return testDb
			.select({
				personId: members.personId,
				email: members.email,
				name: members.name,
			})
			.from(members)
			.where(eq(members.clubId, clubId));
	}

	/** Every club holding `personId`. */
	async function clubsHolding(personId: string): Promise<string[]> {
		const rows = await testDb
			.select({ clubId: members.clubId })
			.from(members)
			.where(eq(members.personId, personId));
		return rows.map((r) => r.clubId);
	}

	describe("CSV import", () => {
		it("writes nothing for a Customer ID only another club holds, on every run", async () => {
			const victim = await person(victimClub.clubId, {
				customerId: `PN-V-${n}`,
				rosterEmail: `victim-${n}@x.io`,
			});
			const before = await rosterOf(attackerClub.clubId);
			const attack = [
				row({
					customerId: `PN-V-${n}`,
					name: "Victim",
					email: `attacker-${n}@x.io`,
				}),
			];

			for (const _run of [1, 2]) {
				const stats = await importPeopleAndMembers(attackerClub.clubId, attack);
				expect(stats.foreignSkipped).toBe(1);
				expect(stats.peopleCreated).toBe(0);
				expect(stats.membersCreated).toBe(0);
				expect(stats.membersUpdated).toBe(0);
				// Its own counter — the blank-name one keeps its meaning.
				expect(stats.skippedBlankName).toBe(0);
			}

			expect(await clubsHolding(victim)).toEqual([victimClub.clubId]);
			expect(await rosterOf(attackerClub.clubId)).toEqual(before);
			const withCid = await testDb
				.select({ id: people.id })
				.from(people)
				.where(eq(people.customerId, `PN-V-${n}`));
			expect(withCid).toHaveLength(1);
		});

		it("writes nothing for a person-level email only another club holds", async () => {
			const email = `signed-in-${n}@x.io`;
			const victim = await person(victimClub.clubId, { personEmail: email });

			const stats = await importPeopleAndMembers(attackerClub.clubId, [
				row({ name: "Victim", email }),
			]);

			expect(stats.foreignSkipped).toBe(1);
			expect(stats.peopleCreated).toBe(0);
			expect(stats.membersCreated).toBe(0);
			expect(await clubsHolding(victim)).toEqual([victimClub.clubId]);
		});

		it("refuses a foreign Customer ID even when its email matches a LOCAL member", async () => {
			// Falling through to the email arm would attach the attacking row to a
			// DIFFERENT member of this club, silently.
			await person(victimClub.clubId, { customerId: `PN-V-${n}` });
			const localEmail = `local-${n}@x.io`;
			const local = await person(attackerClub.clubId, {
				name: `Local ${n}`,
				personEmail: localEmail,
			});

			const stats = await importPeopleAndMembers(attackerClub.clubId, [
				row({ customerId: `PN-V-${n}`, name: "Victim", email: localEmail }),
			]);

			expect(stats.foreignSkipped).toBe(1);
			expect(stats.peopleMatchedByEmail).toBe(0);
			expect(stats.membersUpdated).toBe(0);
			const [p] = await testDb
				.select({ customerId: people.customerId })
				.from(people)
				.where(eq(people.id, local));
			expect(p?.customerId, "the local member was re-keyed").toBeNull();
		});

		it("still matches a Person no club holds, without colliding on the Customer ID", async () => {
			// An orphan left by a member removal or an undone convert. Refusing it
			// would make the writer INSERT a row carrying this Customer ID, which
			// `people_customer_id_unique` rejects mid-file with no transaction.
			const orphan = await person(null, { customerId: `PN-O-${n}` });

			for (const _run of [1, 2]) {
				const stats = await importPeopleAndMembers(attackerClub.clubId, [
					row({ customerId: `PN-O-${n}`, name: "Orphan" }),
				]);
				expect(stats.foreignSkipped).toBe(0);
				expect(stats.peopleCreated).toBe(0);
				expect(stats.peopleMatchedByCustomerId).toBe(1);
			}
			expect(await clubsHolding(orphan)).toEqual([attackerClub.clubId]);
		});

		it("still matches this club's own INACTIVE member", async () => {
			const lapsed = await person(attackerClub.clubId, {
				customerId: `PN-L-${n}`,
				status: "inactive",
			});

			const stats = await importPeopleAndMembers(attackerClub.clubId, [
				row({ customerId: `PN-L-${n}`, name: "Lapsed" }),
			]);

			expect(stats.foreignSkipped).toBe(0);
			expect(stats.peopleMatchedByCustomerId).toBe(1);
			expect(stats.membersUpdated).toBe(1);
			expect(await clubsHolding(lapsed)).toEqual([attackerClub.clubId]);
		});

		it("resolves a new person named twice in one file to one Person and one roster row", async () => {
			const stats = await importPeopleAndMembers(attackerClub.clubId, [
				row({ customerId: `PN-N-${n}`, name: "Twice" }),
				row({ customerId: `PN-N-${n}`, name: "Twice" }),
			]);

			expect(stats.foreignSkipped).toBe(0);
			expect(stats.peopleCreated).toBe(1);
			expect(stats.membersCreated).toBe(1);
			expect(stats.membersUpdated).toBe(1);
			const created = await testDb
				.select({ id: people.id })
				.from(people)
				.where(eq(people.customerId, `PN-N-${n}`));
			expect(created).toHaveLength(1);
			personIds.push(...created.map((c) => c.id));
		});

		it("imports a row whose address another club's member carries, and counts it", async () => {
			const shared = `shared-${n}@x.io`;
			await person(victimClub.clubId, { rosterEmail: shared });

			const stats = await importPeopleAndMembers(attackerClub.clubId, [
				row({ name: `Newcomer ${n}`, email: shared.toUpperCase() }),
			]);

			// Reported, never refused — the edit form's policy.
			expect(stats.membersCreated).toBe(1);
			expect(stats.addressConflicts).toBe(1);
		});

		it("reports no conflict re-importing a club's own unchanged roster", async () => {
			const rows = [
				row({ customerId: `PN-A-${n}`, name: "Ada", email: `ada-${n}@x.io` }),
				row({ name: "Bo", email: `bo-${n}@x.io` }),
			];
			await importPeopleAndMembers(attackerClub.clubId, rows);
			const second = await importPeopleAndMembers(attackerClub.clubId, rows);

			expect(second.addressConflicts).toBe(0);
			expect(second.peopleCreated).toBe(0);
			expect(second.membersCreated).toBe(0);
			for (const m of await rosterOf(attackerClub.clubId)) {
				personIds.push(m.personId);
			}
		});

		it("reports no conflict for a row resolving to a Person already linked to an account", async () => {
			const shared = `linked-${n}@x.io`;
			await person(victimClub.clubId, { rosterEmail: shared });
			const userId = await account(`own-${n}@x.io`);
			await person(attackerClub.clubId, {
				customerId: `PN-K-${n}`,
				userId,
			});

			const stats = await importPeopleAndMembers(attackerClub.clubId, [
				row({ customerId: `PN-K-${n}`, name: "Linked", email: shared }),
			]);

			// The fill DOES happen — nothing a CSV writes can move a linked
			// Person's sign-in, which is why it is not reported.
			expect(stats.membersUpdated).toBe(1);
			expect(stats.addressConflicts).toBe(0);
		});

		it("reports no conflict when fill-only leaves the roster row's own address", async () => {
			const taken = `taken-${n}@x.io`;
			await person(victimClub.clubId, { rosterEmail: taken });
			await person(attackerClub.clubId, {
				customerId: `PN-F-${n}`,
				rosterEmail: `own-${n}@x.io`,
			});

			const stats = await importPeopleAndMembers(attackerClub.clubId, [
				row({ customerId: `PN-F-${n}`, name: "Filled", email: taken }),
			]);

			expect(stats.membersUpdated).toBe(1);
			expect(stats.addressConflicts).toBe(0);
		});

		it("previews exactly what the commit then does", async () => {
			await person(victimClub.clubId, { customerId: `PN-V-${n}` });
			const shared = `shared-${n}@x.io`;
			await person(victimClub.clubId, {
				name: `Holder ${n}`,
				rosterEmail: shared,
			});
			const text = csv([
				{ customerId: `PN-V-${n}`, name: "Victim" },
				{ name: `Shares ${n}`, email: shared },
				{ name: `Plain ${n}`, email: `plain-${n}@x.io` },
			]);

			const preview = await previewMemberImport(attackerClub.clubId, text);
			expect(preview.summary.foreignSkipped).toBe(1);
			expect(preview.summary.addressConflicts).toBe(1);
			expect(preview.summary.toSkip).toBe(0);
			expect(preview.rows[0]).toMatchObject({
				action: "skip",
				note: FOREIGN_SKIP_NOTE.customerId,
			});
			expect(preview.rows[1]?.note).toBe(ADDRESS_CONFLICT_NOTE);

			const { stats } = await commitMemberImport(attackerClub.clubId, text);
			expect(stats.foreignSkipped).toBe(preview.summary.foreignSkipped);
			expect(stats.addressConflicts).toBe(preview.summary.addressConflicts);
			expect(stats.membersCreated).toBe(preview.summary.toInsert);
			for (const m of await rosterOf(attackerClub.clubId)) {
				personIds.push(m.personId);
			}
		});

		it("leaves the victim able to bind after the attacker's import runs", async () => {
			// The whole point, asserted on the outcome rather than on rows. Before
			// #759 the import minted a membership in the attacker's club, arm 2 of
			// `rosterPermitsBind` counted two clubs, and this returned false.
			const address = `victim-${n}@x.io`;
			const victim = await person(victimClub.clubId, {
				customerId: `PN-V-${n}`,
				rosterEmail: address,
			});

			await importPeopleAndMembers(attackerClub.clubId, [
				row({
					customerId: `PN-V-${n}`,
					name: "Victim",
					email: `attacker-${n}@x.io`,
				}),
			]);

			const userId = await account(address);
			expect(await bindVerifiedPerson({ personId: victim, userId })).toBe(true);
		});
	});

	describe("guest convert", () => {
		async function convertGuest(guest: {
			name: string;
			email?: string;
			phone?: string;
		}) {
			const { guestId } = await captureGuestVisit({
				clubId: attackerClub.clubId,
				...guest,
			});
			return applyConvertGuestToMember({
				clubId: attackerClub.clubId,
				guestId,
				actorMemberId: attackerClub.adminMemberId,
			});
		}

		it("does not dedup onto another club's Person by person-level email", async () => {
			const email = `signed-in-${n}@x.io`;
			const victim = await person(victimClub.clubId, { personEmail: email });

			const res = await convertGuest({ name: `Victim ${n}`, email });
			personIds.push(res.personId);

			expect(res.personId).not.toBe(victim);
			expect(await clubsHolding(victim)).toEqual([victimClub.clubId]);
		});

		it("does not dedup onto another club's Person by phone and name", async () => {
			const phone = `555${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "0")}`;
			const victim = await person(victimClub.clubId, {
				phone: toStoredPhone(phone, "1"),
			});

			const res = await convertGuest({ name: `Victim ${n}`, phone });
			personIds.push(res.personId);

			expect(res.personId).not.toBe(victim);
			expect(await clubsHolding(victim)).toEqual([victimClub.clubId]);
		});

		it("does not dedup onto a Person no club holds", async () => {
			// An orphan's history (speeches, Pathways) would otherwise be one bind
			// away from whoever this club's new roster row vouches for.
			const phone = `555${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "0")}`;
			const orphan = await person(null, { phone: toStoredPhone(phone, "1") });

			const res = await convertGuest({ name: `Victim ${n}`, phone });
			personIds.push(res.personId);

			expect(res.personId).not.toBe(orphan);
			expect(await clubsHolding(orphan)).toEqual([]);
		});

		it("reports a fresh roster row whose address another Person carries", async () => {
			// Computed after commit. Asked inside the transaction, the read runs on
			// another pooled connection, cannot see the membership just inserted,
			// answers `no_vouching_row`, and the conflict goes unreported.
			const email = `shared-${n}@x.io`;
			await person(victimClub.clubId, { rosterEmail: email });

			const res = await convertGuest({ name: `Newcomer ${n}`, email });
			personIds.push(res.personId);

			expect(res.reactivated).toBe(false);
			expect(res.rosterConflict).toBe("shared_address");
		});

		it("reports nothing when the address is the new member's alone", async () => {
			const res = await convertGuest({
				name: `Alone ${n}`,
				email: `alone-${n}@x.io`,
			});
			personIds.push(res.personId);

			expect(res).not.toHaveProperty("rosterConflict");
			const [m] = await testDb
				.select({ email: members.email })
				.from(members)
				.where(
					and(
						eq(members.clubId, attackerClub.clubId),
						eq(members.personId, res.personId),
					),
				);
			expect(m?.email).toBe(`alone-${n}@x.io`);
		});
	});
});
