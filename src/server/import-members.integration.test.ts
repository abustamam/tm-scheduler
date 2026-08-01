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
import { clubs, members, officerTerms, people } from "#/db/schema";
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

	it("shares one person across clubs, matched by email (no Customer ID)", async () => {
		const clubA = await club();
		const clubB = await club();
		await importPeopleAndMembers(clubA, [
			row({ name: "Cy", email: "cy@x.io" }),
		]);
		const statsB = await importPeopleAndMembers(clubB, [
			row({ name: "Cy", email: "CY@x.io" }), // case-insensitive email
		]);

		expect(statsB.peopleMatchedByEmail).toBe(1);
		expect(statsB.peopleCreated).toBe(0);
		expect(statsB.membersCreated).toBe(1);

		const cyPeople = await testDb
			.select()
			.from(people)
			.where(eq(people.email, "cy@x.io"));
		expect(cyPeople).toHaveLength(1);
		// Same person, two memberships.
		const memberships = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.personId, cyPeople[0].id));
		expect(memberships).toHaveLength(2);
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

	it("opens an officer term for the parsed position on a fresh membership", async () => {
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
		expect(await openOffices(m.id)).toEqual(["vp_education"]);
	});

	it("fill-only: never touches a membership that already holds an office", async () => {
		const clubId = await club();
		// First import opens a president term.
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
		// A VPE later corrects it in-app to secretary (close president, open secretary).
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
