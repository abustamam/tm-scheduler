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
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, members, officerTerms, people, user } from "#/db/schema";
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

/**
 * A per-run value for anything matched globally: `people.customer_id` is
 * UNIQUE, people are club-less (so the club cascade does not remove them), and
 * vitest runs files in parallel against one shared database. A fixed key that
 * survives one interrupted run fails every later one (#991, CLAUDE.md).
 */
const runKey = (prefix: string): string =>
	`${prefix}-${randomUUID().slice(0, 8)}`;

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
	// People this suite inserts directly (`releasedPerson`). They hold no
	// membership once released, so `cleanup`'s sweep (people of the club's
	// members) only reaches one if a later step re-attached it. A case that
	// fails or times out before then would otherwise leak a club-less row into
	// every later run (#991).
	const seededPersonIds: string[] = [];

	beforeEach(async () => {
		({ importPeopleAndMembers } = await import(
			"#/server/import-members-logic"
		));
		clubIds.length = 0;
		seededPersonIds.length = 0;
	});

	afterEach(async () => {
		// `finally`: a throwing club cleanup must not skip the people delete, or
		// the leak this exists to stop comes back.
		try {
			for (const id of clubIds) await cleanup(id, []);
		} finally {
			if (seededPersonIds.length > 0) {
				await testDb.delete(people).where(inArray(people.id, seededPersonIds));
			}
		}
	});

	async function club(): Promise<string> {
		const id = await makeClub();
		clubIds.push(id);
		return id;
	}

	/**
	 * A Person no club holds, released by `clubId` through the real
	 * `applyMemberRemove` (#855): a roster row, then its removal. The state
	 * after is the same one the race tests need (no membership anywhere), and
	 * only the releasing club may match it, so the removal record is written
	 * by the writer the importer reads rather than restated here.
	 */
	async function releasedPerson(
		clubId: string,
		customerId: string,
		name: string,
	): Promise<string> {
		const { applyMemberRemove } = await import("#/server/members-logic");
		const [person] = await testDb
			.insert(people)
			.values({ customerId, name })
			.returning({ id: people.id });
		const personId = person?.id ?? "";
		seededPersonIds.push(personId);
		const [m] = await testDb
			.insert(members)
			.values({ clubId, personId, name })
			.returning({ id: members.id });
		await applyMemberRemove({
			clubId,
			memberId: m?.id ?? "",
			actorMemberId: null,
		});
		return personId;
	}

	it("creates one person + one membership per fresh row", async () => {
		const clubId = await club();
		const stats = await importPeopleAndMembers(clubId, [
			row({
				customerId: runKey("PN-A"),
				name: "Ada",
				email: `${runKey("ada")}@x.io`,
			}),
			row({
				customerId: runKey("PN-B"),
				name: "Bob",
				email: `${runKey("bob")}@x.io`,
			}),
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
		const customerId = runKey("PN-A");
		const rows = [
			row({ customerId, name: "Ada", email: `${runKey("ada")}@x.io` }),
		];
		await importPeopleAndMembers(clubId, rows);
		const second = await importPeopleAndMembers(clubId, rows);

		expect(second.peopleCreated).toBe(0);
		expect(second.peopleMatchedByCustomerId).toBe(1);
		expect(second.membersUpdated).toBe(1);
		expect(second.membersCreated).toBe(0);

		const ppl = await testDb
			.select()
			.from(people)
			.where(eq(people.customerId, customerId));
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
		const addr = `${runKey("cy")}@x.io`;
		await importPeopleAndMembers(clubA, [row({ name: "Cy", email: addr })]);
		const statsB = await importPeopleAndMembers(clubB, [
			row({ name: "Cy", email: addr.toUpperCase() }),
		]);

		expect(statsB.foreignSkipped).toBe(1);
		expect(statsB.peopleMatchedByEmail).toBe(0);
		expect(statsB.peopleCreated).toBe(0);
		expect(statsB.membersCreated).toBe(0);

		const cyPeople = await testDb
			.select()
			.from(people)
			.where(eq(people.email, addr));
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
		const family = `${runKey("family")}@x.io`;
		const stats = await importPeopleAndMembers(clubId, [
			row({ name: "Pat", email: family }),
			row({ name: "Sam", email: family }),
		]);
		// The shared email is detected up front, so BOTH rows become distinct
		// people (never fused) — even though they arrive in the same batch.
		expect(stats.peopleCreated).toBe(2);
		expect(stats.ambiguous).toBe(2);

		const fam = await testDb
			.select()
			.from(people)
			.where(eq(people.email, family));
		expect(fam).toHaveLength(2);
		// Two distinct memberships too — neither person is dropped.
		const famMembers = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.clubId, clubId));
		expect(famMembers).toHaveLength(2);
	});

	it("fills a matched, single-club, unbound Person's blank address (#907)", async () => {
		// The address is the Person's, and the importing club is their only
		// holder and nobody has signed in, so the fill-only rule applies.
		const clubId = await club();
		// Per-run keys: vitest runs test FILES in parallel against one shared
		// `tm_test`, `people.customer_id` is globally UNIQUE, and an unscoped
		// select on `people` is order-dependent by construction (CLAUDE.md).
		const customerId = runKey("PN-EM");
		const addr = `${runKey("em")}@x.io`;
		await importPeopleAndMembers(clubId, [row({ customerId, name: "Em" })]);
		const stats = await importPeopleAndMembers(clubId, [
			row({ customerId, name: "Em", email: addr }),
		]);

		expect(stats.peopleMatchedByCustomerId).toBe(1);
		expect(stats.emailNotWritten).toBe(0);
		const [em] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.customerId, customerId));
		expect(em?.email).toBe(addr);
	});

	it("re-checks the sole holder IN the fill's statement, not from the file's snapshot (#907)", async () => {
		// The plan decides from a snapshot loaded at the start of the file. A
		// second club attaching the Person after that must make the fill a no-op,
		// which only the UPDATE's own WHERE can see. Driven through the `write`
		// hook: the attach lands just before this row's membership write.
		const clubId = await club();
		const other = await club();
		const cid = runKey("PN-RACE");
		await importPeopleAndMembers(clubId, [
			row({ customerId: cid, name: "Race" }),
		]);
		const [p] = await testDb
			.select({ id: people.id })
			.from(people)
			.where(eq(people.customerId, cid));
		if (!p) throw new Error("seeded person missing");

		const stats = await importPeopleAndMembers(
			clubId,
			[row({ customerId: cid, name: "Race", email: `${runKey("race")}@x.io` })],
			{
				write: async (kind, _rowIndex, _id, work) => {
					if (kind === "member") {
						await testDb
							.insert(members)
							.values({ clubId: other, personId: p.id, name: "Race" })
							.onConflictDoNothing();
					}
					return work(testDb);
				},
			},
		);

		expect(stats.emailNotWritten).toBe(1);
		const [after] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, p.id));
		expect(after?.email).toBeNull();
	});

	it("fills a BLANK (empty or whitespace) address, as the preview promises (#907 review)", async () => {
		const clubId = await club();
		for (const blank of ["", "   "]) {
			const cid = runKey("PN-BLANK");
			const addr = `${runKey("blank")}@x.io`;
			await importPeopleAndMembers(clubId, [
				row({ customerId: cid, name: "Blank" }),
			]);
			await testDb
				.update(people)
				.set({ email: blank })
				.where(eq(people.customerId, cid));

			const stats = await importPeopleAndMembers(clubId, [
				row({ customerId: cid, name: "Blank", email: addr }),
			]);

			expect(stats.emailNotWritten, `blank ${JSON.stringify(blank)}`).toBe(0);
			const [p] = await testDb
				.select({ email: people.email })
				.from(people)
				.where(eq(people.customerId, cid));
			expect(p?.email, `blank ${JSON.stringify(blank)}`).toBe(addr);
		}
	});

	it("does not write a new address onto a BOUND or MULTI-CLUB Person, and reports the row (#907)", async () => {
		const clubId = await club();
		const other = await club();
		const boundCid = runKey("PN-BND");
		const sharedCid = runKey("PN-SHR");
		const keptBound = `${runKey("bound")}@x.io`;
		await importPeopleAndMembers(clubId, [
			row({ customerId: boundCid, name: "Bound", email: keptBound }),
			row({ customerId: sharedCid, name: "Shared" }),
		]);
		const [bound] = await testDb
			.select({ id: people.id })
			.from(people)
			.where(eq(people.customerId, boundCid));
		const [shared] = await testDb
			.select({ id: people.id })
			.from(people)
			.where(eq(people.customerId, sharedCid));
		if (!bound || !shared) throw new Error("seeded people missing");
		const userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name: "Bound",
			email: keptBound,
			emailVerified: true,
		});
		try {
			await testDb
				.update(people)
				.set({ userId })
				.where(eq(people.id, bound.id));
			await testDb
				.insert(members)
				.values({ clubId: other, personId: shared.id, name: "Shared" });

			const stats = await importPeopleAndMembers(clubId, [
				row({
					customerId: boundCid,
					name: "Bound",
					email: `${runKey("new")}@x.io`,
				}),
				row({
					customerId: sharedCid,
					name: "Shared",
					email: `${runKey("new2")}@x.io`,
				}),
			]);

			expect(stats.emailNotWritten).toBe(2);
			const after = await testDb
				.select({ id: people.id, email: people.email })
				.from(people)
				.where(inArray(people.id, [bound.id, shared.id]));
			expect(after.find((p) => p.id === bound.id)?.email).toBe(keptBound);
			expect(after.find((p) => p.id === shared.id)?.email).toBeNull();
		} finally {
			await testDb
				.update(people)
				.set({ userId: null })
				.where(eq(people.id, bound.id));
			await testDb.delete(user).where(eq(user.id, userId));
		}
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
		const customerId = runKey("PN-VIC");
		await importPeopleAndMembers(clubA, [row({ customerId, name: "Vic" })]);
		const stats = await importPeopleAndMembers(clubB, [
			row({
				customerId,
				name: "Vic",
				email: `${runKey("attacker")}@x.io`,
			}),
		]);

		const [vic] = await testDb
			.select({ id: people.id, email: people.email })
			.from(people)
			.where(eq(people.customerId, customerId));
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

	it("refuses a row whose address is ANOTHER club's member's (#907)", async () => {
		// One address per Person since #907, so the email arm matches globally —
		// onto a Person another club holds, which is `foreign` (#759), never a
		// second Person for the same human.
		const clubA = await club();
		const clubB = await club();
		const addr = `${runKey("gus")}@x.io`;
		await importPeopleAndMembers(clubA, [row({ name: "Gus", email: addr })]);

		const stats = await importPeopleAndMembers(clubB, [
			row({ name: "Gus", email: addr }),
		]);

		expect(stats.foreignSkipped).toBe(1);
		expect(stats.peopleCreated).toBe(0);
	});

	it("adopts a Customer ID onto a person first seen by email only", async () => {
		const clubId = await club();
		const customerId = runKey("PN-DI");
		const addr = `${runKey("di")}@x.io`;
		await importPeopleAndMembers(clubId, [row({ name: "Di", email: addr })]);
		const stats = await importPeopleAndMembers(clubId, [
			row({ customerId, name: "Di", email: addr }),
		]);
		expect(stats.peopleMatchedByEmail).toBe(1);
		expect(stats.peopleCreated).toBe(0);

		const di = await testDb.select().from(people).where(eq(people.email, addr));
		expect(di).toHaveLength(1);
		expect(di[0].customerId).toBe(customerId);
	});

	it("moves original_join_date onto the person, not the membership", async () => {
		const clubId = await club();
		const ojd = new Date("2012-02-01T08:00:00Z");
		const customerId = runKey("PN-J");
		await importPeopleAndMembers(clubId, [
			row({
				customerId,
				name: "Jo",
				email: `${runKey("jo")}@x.io`,
				joinedAt: new Date("2024-05-01T07:00:00Z"),
				originalJoinDate: ojd,
			}),
		]);
		const [p] = await testDb
			.select()
			.from(people)
			.where(eq(people.customerId, customerId));
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
				customerId: runKey("PN-OP"),
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
		const customerId = runKey("PN-K");
		// Import the roster without granting the CSV office.
		await importPeopleAndMembers(clubId, [
			row({
				customerId,
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
				customerId,
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
		const customerId = runKey("PN-RACE");
		const personId = await releasedPerson(clubId, customerId, "Racing Member");

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
				customerId,
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
				// The Person's (#906, #907): the CSV phone and email land there.
				email: people.email,
				phone: people.phone,
				joinedAt: members.joinedAt,
			})
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
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
		const customerId = runKey("PN-FILL");
		const personId = await releasedPerson(clubId, customerId, "Fill Only");

		// The address is the Person's (#907); the winner's is already on file.
		await testDb
			.update(people)
			.set({ email: "winner@x.io" })
			.where(eq(people.id, personId));
		const winner = await openBlockingTx(async (tx) => {
			await tx.insert(members).values({
				clubId,
				personId,
				name: "Fill Only",
			});
		});

		const running = importPeopleAndMembers(clubId, [
			row({
				customerId,
				name: "Fill Only",
				email: "csv@x.io",
				phone: "5559990000",
			}),
		]);
		await waitForLockWait('insert into "members"', winner.pid);
		await winner.commit();
		await running;

		const [m] = await testDb
			.select({ email: people.email, phone: people.phone })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(and(eq(members.clubId, clubId), eq(members.personId, personId)));
		expect(m?.email).toBe("winner@x.io"); // not clobbered
		// The Person's blank phone filled (#906), by the Person arm.
		expect(m?.phone).toBe("+15559990000");
	});

	it("counts an unparseable non-blank position without opening a term", async () => {
		const clubId = await club();
		const stats = await importPeopleAndMembers(clubId, [
			row({
				customerId: runKey("PN-W"),
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
