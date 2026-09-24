/**
 * DB-backed tests for the CSV person/membership import (ADR-0008 / #64). Tests
 * the plain `importPeopleAndMembers` fn directly; `#/db` is redirected to the
 * test database. Exercises the dedupe precedence (Customer ID → unambiguous
 * email → new person) against real Postgres.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/import-members.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, clubs, members, officerTerms, people } from "#/db/schema";
import type { MappedMember } from "#/lib/members-csv";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	testDb,
	waitForLockWait,
} from "#/test/db";

/** Open (current) officer positions for a membership, for assertions. */
async function openOffices(membershipId: string): Promise<string[]> {
	const rows = await testDb
		.select({ position: officerTerms.position })
		.from(officerTerms)
		.where(
			and(
				eq(officerTerms.membershipId, membershipId),
				isNull(officerTerms.termEnd),
			),
		);
	return rows.map((r) => r.position);
}

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

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

async function makeClub(): Promise<string> {
	const id = randomUUID();
	await testDb
		.insert(clubs)
		.values({ id, name: "Import Test", slug: `import-${id}` });
	return id;
}

describe.skipIf(!hasTestDb)("importPeopleAndMembers (ADR-0008 dedupe)", () => {
	let importPeopleAndMembers: typeof import("#/server/import-members-logic").importPeopleAndMembers;
	const clubIds: string[] = [];

	beforeEach(async () => {
		({ importPeopleAndMembers } = await import(
			"#/server/import-members-logic"
		));
		clubIds.length = 0;
	});

	afterEach(async () => {
		for (const id of clubIds) await cleanup(id, []);
	});

	async function club(): Promise<string> {
		const id = await makeClub();
		clubIds.push(id);
		return id;
	}

	it("creates one person + one membership per fresh row", async () => {
		const clubId = await club();
		const stats = await importPeopleAndMembers(clubId, [
			row({ customerId: "PN-A", name: "Ada", email: "ada@x.io" }),
			row({ customerId: "PN-B", name: "Bob", email: "bob@x.io" }),
		]);
		expect(stats.peopleCreated).toBe(2);
		expect(stats.membersCreated).toBe(2);

		const memberRows = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.clubId, clubId));
		expect(memberRows).toHaveLength(2);
		expect(new Set(memberRows.map((m) => m.personId)).size).toBe(2);
	});

	it("is idempotent: re-import matches by Customer ID, no new people", async () => {
		const clubId = await club();
		const rows = [row({ customerId: "PN-A", name: "Ada", email: "ada@x.io" })];
		await importPeopleAndMembers(clubId, rows);
		const second = await importPeopleAndMembers(clubId, rows);

		expect(second.peopleCreated).toBe(0);
		expect(second.peopleMatchedByCustomerId).toBe(1);
		expect(second.membersUpdated).toBe(1);
		expect(second.membersCreated).toBe(0);

		const ppl = await testDb
			.select()
			.from(people)
			.where(eq(people.customerId, "PN-A"));
		expect(ppl).toHaveLength(1);
	});

	it("does NOT attach another club's Person matched by email (#759)", async () => {
		// This test used to assert the opposite — one Person, two clubs' roster
		// rows — and that shape is the attack #759 closes. A Person two clubs hold
		// cannot bind an account by any route, so a club whose CSV reached another
		// club's member by email locked them out of sign-in. The row is refused
		// (not minted as a new Person, which would duplicate the human) and
		// counted; the one genuine dual-club member in production is handled by
		// hand. The match is still case-insensitive: that is what reaches them.
		const clubA = await club();
		const clubB = await club();
		const n = randomUUID().slice(0, 8);
		await importPeopleAndMembers(clubA, [
			row({ name: "Cy", email: `cy-${n}@x.io` }),
		]);
		const statsB = await importPeopleAndMembers(clubB, [
			row({ name: "Cy", email: `CY-${n}@x.io` }),
		]);

		expect(statsB.foreignSkipped).toBe(1);
		expect(statsB.peopleMatchedByEmail).toBe(0);
		expect(statsB.peopleCreated).toBe(0);
		expect(statsB.membersCreated).toBe(0);

		const cyPeople = await testDb
			.select()
			.from(people)
			.where(eq(people.email, `cy-${n}@x.io`));
		expect(cyPeople).toHaveLength(1);
		const memberships = await testDb
			.select({ clubId: members.clubId })
			.from(members)
			.where(eq(members.personId, cyPeople[0].id));
		expect(memberships).toEqual([{ clubId: clubA }]);
	});

	it("never merges a shared email across distinct people", async () => {
		const clubId = await club();
		// Two spouses share one family email — both blank Customer ID.
		const stats = await importPeopleAndMembers(clubId, [
			row({ name: "Pat", email: "family@x.io" }),
			row({ name: "Sam", email: "family@x.io" }),
		]);
		// The shared email is detected up front, so BOTH rows become distinct
		// people (never fused) — even though they arrive in the same batch.
		expect(stats.peopleCreated).toBe(2);
		expect(stats.ambiguous).toBe(2);

		const fam = await testDb
			.select()
			.from(people)
			.where(eq(people.email, "family@x.io"));
		expect(fam).toHaveLength(2);
		// Two distinct memberships too — neither person is dropped.
		const famMembers = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.clubId, clubId));
		expect(famMembers).toHaveLength(2);
	});

	it("never seeds people.email onto a MATCHED person, even in its own club", async () => {
		// `people.email` is the verified identity address (#756): only a bind
		// against a magic-link-proved address writes it. A CSV is a file an officer
		// uploaded, so it fills the club's contact record and stops there. Person
		// CREATION still carries the address — a fresh row is nobody's identity yet,
		// and the column is the dedupe key ADR-0008 relies on — but a row that
		// already exists is left alone.
		const clubId = await club();
		// Per-run keys: vitest runs test FILES in parallel against one shared
		// `tm_test`, `people.customer_id` is globally UNIQUE, and an unscoped
		// select on `people` is order-dependent by construction (CLAUDE.md).
		const n = randomUUID().slice(0, 8);
		await importPeopleAndMembers(clubId, [
			row({ customerId: `PN-EM-${n}`, name: "Em" }),
		]);
		const stats = await importPeopleAndMembers(clubId, [
			row({ customerId: `PN-EM-${n}`, name: "Em", email: `em-${n}@x.io` }),
		]);

		expect(stats.peopleMatchedByCustomerId).toBe(1);
		const [em] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.customerId, `PN-EM-${n}`));
		expect(em?.email).toBeNull();
		// The club's own contact record DID fill — that is the officer's to set,
		// and it is the address the invite and the claim will both use.
		const [membership] = await testDb
			.select({ email: members.email })
			.from(members)
			.where(eq(members.clubId, clubId));
		expect(membership?.email).toBe(`em-${n}@x.io`);
	});

	it("cannot re-key a Person the importing club does not hold", async () => {
		// The cross-club shape, which is the one with teeth: the candidate list is
		// matched GLOBALLY on Customer ID, so a row carrying a victim's PN- number
		// and the importer's own address reached a Person another club holds. #755
		// answered that with a blast-radius predicate on the write; #756 removes the
		// write. Kept as a regression pin because the reason it is safe changed.
		//
		// It also said nothing about the MEMBERSHIP the row minted in club B, and
		// that silence was #759: the roster row, not the re-key, is what made Vic
		// unable to sign in. The row counts below are that half.
		const clubA = await club();
		const clubB = await club();
		const n = randomUUID().slice(0, 8);
		await importPeopleAndMembers(clubA, [
			row({ customerId: `PN-VIC-${n}`, name: "Vic" }),
		]);
		const stats = await importPeopleAndMembers(clubB, [
			row({
				customerId: `PN-VIC-${n}`,
				name: "Vic",
				email: `attacker-${n}@x.io`,
			}),
		]);

		const [vic] = await testDb
			.select({ id: people.id, email: people.email })
			.from(people)
			.where(eq(people.customerId, `PN-VIC-${n}`));
		expect(vic?.email).toBeNull();
		expect(stats.foreignSkipped).toBe(1);
		const clubBRoster = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.clubId, clubB));
		expect(clubBRoster, "a roster row minted in the attacker's club").toEqual(
			[],
		);
		const vicMemberships = await testDb
			.select({ clubId: members.clubId })
			.from(members)
			.where(eq(members.personId, vic?.id ?? ""));
		expect(vicMemberships).toEqual([{ clubId: clubA }]);
	});

	it("re-matches a member whose person-level address was cleared", async () => {
		// The state migration 0076 leaves every un-claimed member in: `people.email`
		// NULL, the club's roster row holding the address. A Person with no Customer
		// ID is matched by EMAIL, so a person-level-only candidate list stops
		// recognising them — and the miss is not quiet, it adds a second Person AND
		// a second roster row for the same human on every subsequent import.
		const clubId = await club();
		const n = randomUUID().slice(0, 8);
		const addr = `fay-${n}@x.io`;
		await importPeopleAndMembers(clubId, [row({ name: "Fay", email: addr })]);
		// Simulate the migration — scoped to THIS club's person by id. An unscoped
		// `update(people)` on a shared `tm_test` takes another file's in-flight
		// rows, which is the hazard CLAUDE.md names by name.
		const [fay] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.clubId, clubId));
		if (!fay) throw new Error("seeded member missing");
		await testDb
			.update(people)
			.set({ email: null })
			.where(eq(people.id, fay.personId));

		const stats = await importPeopleAndMembers(clubId, [
			row({ name: "Fay", email: addr }),
		]);

		expect(stats.peopleCreated).toBe(0);
		expect(stats.peopleMatchedByEmail).toBe(1);
		const roster = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.clubId, clubId));
		expect(roster, "a duplicate roster row for the same human").toHaveLength(1);
	});

	it("does not match on ANOTHER club's roster address", async () => {
		// The candidate list is global, so widening it to membership addresses has
		// to stay scoped to the importing club — otherwise a CSV could reach a
		// Person through a contact record some other club typed, which is the
		// cross-club shape this whole change exists to close.
		const clubA = await club();
		const clubB = await club();
		const n = randomUUID().slice(0, 8);
		const addr = `gus-${n}@x.io`;
		await importPeopleAndMembers(clubA, [row({ name: "Gus", email: addr })]);
		const [gus] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.clubId, clubA));
		if (!gus) throw new Error("seeded member missing");
		await testDb
			.update(people)
			.set({ email: null })
			.where(eq(people.id, gus.personId));

		const stats = await importPeopleAndMembers(clubB, [
			row({ name: "Gus", email: addr }),
		]);

		expect(stats.peopleCreated).toBe(1);
		expect(stats.peopleMatchedByEmail).toBe(0);
	});

	it("adopts a Customer ID onto a person first seen by email only", async () => {
		const clubId = await club();
		await importPeopleAndMembers(clubId, [
			row({ name: "Di", email: "di@x.io" }),
		]);
		const stats = await importPeopleAndMembers(clubId, [
			row({ customerId: "PN-DI", name: "Di", email: "di@x.io" }),
		]);
		expect(stats.peopleMatchedByEmail).toBe(1);
		expect(stats.peopleCreated).toBe(0);

		const di = await testDb
			.select()
			.from(people)
			.where(eq(people.email, "di@x.io"));
		expect(di).toHaveLength(1);
		expect(di[0].customerId).toBe("PN-DI");
	});

	it("moves original_join_date onto the person, not the membership", async () => {
		const clubId = await club();
		const ojd = new Date("2012-02-01T08:00:00Z");
		await importPeopleAndMembers(clubId, [
			row({
				customerId: "PN-J",
				name: "Jo",
				email: "jo@x.io",
				joinedAt: new Date("2024-05-01T07:00:00Z"),
				originalJoinDate: ojd,
			}),
		]);
		const [p] = await testDb
			.select()
			.from(people)
			.where(eq(people.customerId, "PN-J"));
		expect(p.originalJoinDate?.getTime()).toBe(ojd.getTime());

		const [m] = await testDb
			.select()
			.from(members)
			.where(and(eq(members.clubId, clubId), eq(members.personId, p.id)));
		// joined_at (per-club) is on the membership.
		expect(m.joinedAt).not.toBeNull();
	});

	it("does not grant the parsed office on a fresh membership", async () => {
		const clubId = await club();
		await importPeopleAndMembers(clubId, [
			row({
				customerId: "PN-OP",
				name: "Ovi",
				officerPosition: "vp_education",
				currentPosition: "Club VP Education",
			}),
		]);
		const [m] = await testDb
			.select()
			.from(members)
			.where(eq(members.clubId, clubId));
		expect(await openOffices(m.id)).toEqual([]);
	});

	it("fill-only: never touches a membership that already holds an office", async () => {
		const clubId = await club();
		// Import the roster without granting the CSV office.
		await importPeopleAndMembers(clubId, [
			row({
				customerId: "PN-K",
				name: "Kai",
				officerPosition: "president",
				currentPosition: "Club President",
			}),
		]);
		const [m] = await testDb
			.select()
			.from(members)
			.where(eq(members.clubId, clubId));
		// A VPE explicitly assigns secretary in-app.
		const { reconcileOfficerTerms } = await import(
			"#/server/officer-terms-logic"
		);
		await reconcileOfficerTerms(testDb, m.id, ["secretary"]);
		// Re-import still says president — must NOT touch the in-app office set.
		const stats = await importPeopleAndMembers(clubId, [
			row({
				customerId: "PN-K",
				name: "Kai",
				officerPosition: "president",
				currentPosition: "Club President",
			}),
		]);
		expect(stats.membersUpdated).toBe(1);
		expect(await openOffices(m.id)).toEqual(["secretary"]);
	});

	it("recovers when a concurrent writer takes the membership first (#489)", async () => {
		// The importer runs on the bare `db` handle with NO transaction, so its
		// membership SELECT and INSERT are separated by an arbitrary gap — the
		// widest double-add window in the app, and two admins importing overlapping
		// rosters is an ordinary Tuesday. Drive the real interleaving: a concurrent
		// writer inserts the membership and holds it uncommitted, so the import
		// reads "no membership", then parks on the unique index.
		const clubId = await club();
		const [person] = await testDb
			.insert(people)
			.values({ customerId: "PN-RACE", name: "Racing Member" })
			.returning({ id: people.id });
		const personId = person?.id ?? "";
		// Removed from this club earlier, as `applyMemberRemove` records it: a
		// Person no club holds is matchable only by the club that released them
		// (#855), and the race below needs the row to match.
		await testDb.insert(activityLog).values({
			clubId,
			action: "member_remove",
			targetType: "member",
			detail: { name: "Removed", personId },
		});

		let winnerId = "";
		const winner = await openBlockingTx(async (tx) => {
			const [row] = await tx
				.insert(members)
				.values({ clubId, personId, name: "Racing Member" })
				.returning({ id: members.id });
			winnerId = row?.id ?? "";
		});

		// The CSV row carries contact the winner's row does NOT have. Without that,
		// `classifyMembership` yields a byte-identical `set` and the re-classify
		// below is a provable no-op — the test would pass with the fix deleted,
		// which is exactly the trap CLAUDE.md warns about for guard-only code.
		const running = importPeopleAndMembers(clubId, [
			row({
				customerId: "PN-RACE",
				name: "Racing Member",
				email: "race@x.io",
				phone: "5551230000",
				joinedAt: new Date("2020-01-02T00:00:00Z"),
			}),
		]);
		await waitForLockWait('insert into "members"', winner.pid);
		await winner.commit();

		// The import completes instead of throwing "Failed to insert member", and
		// counts the row as an update — it did not create anything.
		const stats = await running;
		expect(stats.membersCreated).toBe(0);
		expect(stats.membersUpdated).toBe(1);

		const rows = await testDb
			.select({
				id: members.id,
				email: members.email,
				phone: members.phone,
				joinedAt: members.joinedAt,
			})
			.from(members)
			.where(and(eq(members.clubId, clubId), eq(members.personId, personId)));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(winnerId);
		// The losing row's data landed instead of being dropped on the floor.
		expect(rows[0]?.email).toBe("race@x.io");
		expect(rows[0]?.phone).toBe("+15551230000");
		expect(rows[0]?.joinedAt?.toISOString()).toBe("2020-01-02T00:00:00.000Z");
	});

	it("keeps the winner's values on the raced path (fill-only, #489)", async () => {
		// The recovery reconciles, but must not CLOBBER: fill-only means the row
		// already present wins on any field it has.
		const clubId = await club();
		const [person] = await testDb
			.insert(people)
			.values({ customerId: "PN-FILL", name: "Fill Only" })
			.returning({ id: people.id });
		const personId = person?.id ?? "";
		// Removed from this club earlier, as `applyMemberRemove` records it: a
		// Person no club holds is matchable only by the club that released them
		// (#855), and the race below needs the row to match.
		await testDb.insert(activityLog).values({
			clubId,
			action: "member_remove",
			targetType: "member",
			detail: { name: "Removed", personId },
		});

		const winner = await openBlockingTx(async (tx) => {
			await tx.insert(members).values({
				clubId,
				personId,
				name: "Fill Only",
				email: "winner@x.io",
			});
		});

		const running = importPeopleAndMembers(clubId, [
			row({
				customerId: "PN-FILL",
				name: "Fill Only",
				email: "csv@x.io",
				phone: "5559990000",
			}),
		]);
		await waitForLockWait('insert into "members"', winner.pid);
		await winner.commit();
		await running;

		const [m] = await testDb
			.select({ email: members.email, phone: members.phone })
			.from(members)
			.where(and(eq(members.clubId, clubId), eq(members.personId, personId)));
		expect(m?.email).toBe("winner@x.io"); // not clobbered
		expect(m?.phone).toBe("+15559990000"); // empty slot filled
	});

	it("counts an unparseable non-blank position without opening a term", async () => {
		const clubId = await club();
		const stats = await importPeopleAndMembers(clubId, [
			row({
				customerId: "PN-W",
				name: "Web Master",
				officerPosition: null,
				currentPosition: "Webmaster",
			}),
		]);
		expect(stats.unparseablePosition).toBe(1);
		const [m] = await testDb
			.select()
			.from(members)
			.where(eq(members.clubId, clubId));
		expect(await openOffices(m.id)).toEqual([]);
	});
});
