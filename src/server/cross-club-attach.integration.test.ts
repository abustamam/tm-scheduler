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
import { guests, members, people, user } from "#/db/schema";
import type { MappedMember } from "#/lib/members-csv";
import {
	ADDRESS_CONFLICT_NOTE,
	FOREIGN_SKIP_NOTE,
} from "#/lib/members-import-plan";
import { toStoredPhone } from "#/lib/phone";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
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
const { applyConvertGuestToMember, captureGuestVisit, lockClubConverts } =
	await import("./guest-pipeline-logic");
const { bindVerifiedPerson } = await import("./account-link-logic");
const { applyMemberRemove } = await import("./members-logic");

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

		it("skips a Person no club holds when no club released them, for every club (#855)", async () => {
			// An orphan with no removal record: a deleted club, an undone convert,
			// or a removal from before #855. Nobody may attach them by file, and
			// the refusal writes nothing, so the Customer ID cannot collide.
			const orphan = await person(null, { customerId: `PN-O-${n}` });

			for (const clubId of [attackerClub.clubId, victimClub.clubId]) {
				const stats = await importPeopleAndMembers(clubId, [
					row({ customerId: `PN-O-${n}`, name: "Orphan" }),
				]);
				expect(stats.foreignSkipped).toBe(1);
				expect(stats.peopleCreated).toBe(0);
				expect(stats.membersCreated).toBe(0);
			}
			expect(await clubsHolding(orphan)).toEqual([]);
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

		it("reports a linked subject's fill that locks out a hidden member who has not signed in", async () => {
			// The linked Person keeps their own sign-in, but the victim in another
			// club, whose roster row already carries the address, can now never
			// bind: arm 3 of the bind rule sees a second Person carrying it.
			const shared = `linked-${n}@x.io`;
			const victim = await person(victimClub.clubId, { rosterEmail: shared });
			const userId = await account(`own-${n}@x.io`);
			await person(attackerClub.clubId, {
				customerId: `PN-K-${n}`,
				userId,
			});

			const stats = await importPeopleAndMembers(attackerClub.clubId, [
				row({ customerId: `PN-K-${n}`, name: "Linked", email: shared }),
			]);

			expect(stats.membersUpdated).toBe(1);
			expect(stats.addressConflicts).toBe(1);
			// The lockout the report names is real, not hypothetical.
			const victimUser = await account(shared);
			expect(
				await bindVerifiedPerson({ personId: victim, userId: victimUser }),
			).toBe(false);
		});

		it("reports no conflict when everyone carrying the address is already bound", async () => {
			const shared = `bound-${n}@x.io`;
			const other = await account(`other-${n}@x.io`);
			await person(victimClub.clubId, { rosterEmail: shared, userId: other });
			const userId = await account(`own-${n}@x.io`);
			await person(attackerClub.clubId, {
				customerId: `PN-K-${n}`,
				userId,
			});

			const stats = await importPeopleAndMembers(attackerClub.clubId, [
				row({ customerId: `PN-K-${n}`, name: "Linked", email: shared }),
			]);

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

		it("skips a foreign Customer ID whose email is shared in the file, without throwing", async () => {
			// Before the review fix the shared-email override ran first, the row
			// became an INSERT carrying an existing Customer ID, and the unique
			// index threw partway through the file.
			await person(victimClub.clubId, { customerId: `PN-V-${n}` });
			const fam = `fam-${n}@x.io`;
			const text = csv([
				{ customerId: `PN-V-${n}`, name: "Victim", email: fam },
				{ name: `Sam ${n}`, email: fam },
			]);

			const preview = await previewMemberImport(attackerClub.clubId, text);
			const { stats } = await commitMemberImport(attackerClub.clubId, text);

			expect(preview.summary.foreignSkipped).toBe(1);
			expect(stats.foreignSkipped).toBe(1);
			expect(stats.membersCreated).toBe(preview.summary.toInsert);
			for (const m of await rosterOf(attackerClub.clubId)) {
				personIds.push(m.personId);
			}
		});

		it("reports an address two same-named rows give two Persons, preview and commit alike", async () => {
			const text = csv([
				{
					customerId: `PN-1-${n}`,
					name: "Alex Smith",
					email: `alex-${n}@x.io`,
				},
				{
					customerId: `PN-2-${n}`,
					name: "Alex Smith",
					email: `alex-${n}@x.io`,
				},
			]);

			const preview = await previewMemberImport(attackerClub.clubId, text);
			const { stats } = await commitMemberImport(attackerClub.clubId, text);

			expect(preview.summary.addressConflicts).toBe(1);
			expect(stats.addressConflicts).toBe(1);
			expect(stats.peopleCreated).toBe(2);
			for (const m of await rosterOf(attackerClub.clubId)) {
				personIds.push(m.personId);
			}
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

	/**
	 * A Person no club holds (#855). Removing an unlinked member leaves one
	 * behind, and the roster row an import would mint is then their ONLY
	 * membership, so it alone vouches for a bind. Only the club whose removal
	 * is the latest naming them may attach them by file.
	 */
	describe("CSV import of a removed member (#855)", () => {
		/** Remove `personId`'s roster row in `clubId` the way the roster does. */
		async function removeFrom(clubId: string, personId: string) {
			const [m] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(and(eq(members.clubId, clubId), eq(members.personId, personId)));
			if (!m) throw new Error("no roster row to remove");
			await applyMemberRemove({ clubId, memberId: m.id, actorMemberId: null });
		}

		it("lets the removing club re-import by Customer ID: no new Person, one roster row", async () => {
			const removed = await person(victimClub.clubId, {
				customerId: `PN-R-${n}`,
			});
			await removeFrom(victimClub.clubId, removed);

			for (const _run of [1, 2]) {
				const stats = await importPeopleAndMembers(victimClub.clubId, [
					row({ customerId: `PN-R-${n}`, name: "Returning" }),
				]);
				expect(stats.foreignSkipped).toBe(0);
				expect(stats.peopleCreated).toBe(0);
				expect(stats.peopleMatchedByCustomerId).toBe(1);
			}
			expect(await clubsHolding(removed)).toEqual([victimClub.clubId]);
		});

		it("lets the removing club re-import by person-level email", async () => {
			const email = `returning-${n}@x.io`;
			const removed = await person(victimClub.clubId, { personEmail: email });
			await removeFrom(victimClub.clubId, removed);

			const stats = await importPeopleAndMembers(victimClub.clubId, [
				row({ name: "Returning", email: email.toUpperCase() }),
			]);

			expect(stats.foreignSkipped).toBe(0);
			expect(stats.peopleCreated).toBe(0);
			expect(stats.peopleMatchedByEmail).toBe(1);
			expect(stats.membersCreated).toBe(1);
			expect(await clubsHolding(removed)).toEqual([victimClub.clubId]);
		});

		it("gives any other club nothing to match, by Customer ID or by email", async () => {
			const email = `released-${n}@x.io`;
			const byCid = await person(victimClub.clubId, {
				customerId: `PN-R-${n}`,
			});
			const byEmail = await person(victimClub.clubId, {
				name: `Other ${n}`,
				personEmail: email,
			});
			await removeFrom(victimClub.clubId, byCid);
			await removeFrom(victimClub.clubId, byEmail);

			const stats = await importPeopleAndMembers(attackerClub.clubId, [
				row({
					customerId: `PN-R-${n}`,
					name: "Returning",
					email: `attacker-${n}@x.io`,
				}),
				row({ name: `Other ${n}`, email }),
			]);

			expect(stats.foreignSkipped).toBe(2);
			expect(stats.peopleCreated).toBe(0);
			expect(stats.membersCreated).toBe(0);
			expect(await clubsHolding(byCid)).toEqual([]);
			expect(await clubsHolding(byEmail)).toEqual([]);
		});

		it("follows the LATEST removal: removed by A, re-added and removed by B, is B's alone", async () => {
			const moved = await person(victimClub.clubId, {
				customerId: `PN-M-${n}`,
			});
			await removeFrom(victimClub.clubId, moved);
			// Re-added by hand in B, not by file, then removed there too.
			await testDb.insert(members).values({
				clubId: attackerClub.clubId,
				personId: moved,
				name: "Moved",
			});
			await removeFrom(attackerClub.clubId, moved);
			const rows = [row({ customerId: `PN-M-${n}`, name: "Moved" })];

			const fromA = await importPeopleAndMembers(victimClub.clubId, rows);
			expect(fromA.foreignSkipped).toBe(1);
			expect(await clubsHolding(moved)).toEqual([]);

			const fromB = await importPeopleAndMembers(attackerClub.clubId, rows);
			expect(fromB.foreignSkipped).toBe(0);
			expect(fromB.membersCreated).toBe(1);
			expect(await clubsHolding(moved)).toEqual([attackerClub.clubId]);
		});

		it("previews exactly what the commit then does, for both clubs", async () => {
			const removed = await person(victimClub.clubId, {
				customerId: `PN-R-${n}`,
			});
			await removeFrom(victimClub.clubId, removed);
			const text = csv([{ customerId: `PN-R-${n}`, name: "Returning" }]);

			const foreign = await previewMemberImport(attackerClub.clubId, text);
			expect(foreign.summary.foreignSkipped).toBe(1);
			expect(foreign.rows[0]).toMatchObject({
				action: "skip",
				note: FOREIGN_SKIP_NOTE.customerId,
			});
			const foreignCommit = await commitMemberImport(attackerClub.clubId, text);
			expect(foreignCommit.stats.foreignSkipped).toBe(1);
			expect(foreignCommit.stats.membersCreated).toBe(0);

			const home = await previewMemberImport(victimClub.clubId, text);
			expect(home.summary.foreignSkipped).toBe(0);
			expect(home.summary.peopleMatched).toBe(1);
			expect(home.summary.toInsert).toBe(1);
			const homeCommit = await commitMemberImport(victimClub.clubId, text);
			expect(homeCommit.stats.foreignSkipped).toBe(0);
			expect(homeCommit.stats.peopleCreated).toBe(0);
			expect(homeCommit.stats.membersCreated).toBe(home.summary.toInsert);
		});

		it("leaves an account on the other club's typed address unable to bind the orphan", async () => {
			// The whole point, on the outcome. Before #855 the attacker's import
			// minted the orphan's only roster row, carrying this address, and
			// that row alone vouched for the bind.
			const typed = `attacker-${n}@x.io`;
			const removed = await person(victimClub.clubId, {
				customerId: `PN-R-${n}`,
			});
			await removeFrom(victimClub.clubId, removed);

			await importPeopleAndMembers(attackerClub.clubId, [
				row({ customerId: `PN-R-${n}`, name: "Returning", email: typed }),
			]);

			expect(await clubsHolding(removed)).toEqual([]);
			const userId = await account(typed);
			expect(await bindVerifiedPerson({ personId: removed, userId })).toBe(
				false,
			);
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

		it("waits for a concurrent convert in the same club instead of duplicating the visitor", async () => {
			// Dedup sees only COMMITTED roster rows here, so two converts of one
			// visitor from two guest cards, run at once, each minted a Person. The
			// blocker below plays the first convert: it holds the club's convert
			// lock and has an uncommitted roster row for the visitor.
			const email = `concurrent-${n}@x.io`;
			const name = `Concurrent ${n}`;
			// Captured BEFORE the blocker opens: the guest book takes a club row
			// lock, which would wait on the blocker's roster-row FK lock.
			const { guestId } = await captureGuestVisit({
				clubId: attackerClub.clubId,
				name,
				email,
			});
			let firstPerson = "";
			const first = await openBlockingTx(async (tx) => {
				await lockClubConverts(tx, attackerClub.clubId);
				const [p] = await tx
					.insert(people)
					.values({ name, email })
					.returning({ id: people.id });
				firstPerson = p?.id ?? "";
				await tx.insert(members).values({
					clubId: attackerClub.clubId,
					personId: firstPerson,
					name,
					email,
				});
			});

			const second = applyConvertGuestToMember({
				clubId: attackerClub.clubId,
				guestId,
				actorMemberId: attackerClub.adminMemberId,
			});
			// Without the lock this never blocks: it mints a second Person at once.
			await waitForLockWait("pg_advisory_xact_lock", first.pid);
			// And while it waits it holds NOTHING — in particular not its guest row.
			// Taking the guest lock first let a slot reassignment onto this guest
			// deadlock against two converts (#854 review). NOWAIT errors at once if
			// the row is locked, instead of hanging the test.
			await testDb.transaction(async (tx) => {
				await tx
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.id, guestId))
					.for("update", { noWait: true });
			});
			await first.commit();

			const res = await second;
			expect(res.personId).toBe(firstPerson);
			const rows = (await rosterOf(attackerClub.clubId)).filter(
				(m) => m.name === name,
			);
			expect(rows).toHaveLength(1);
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
