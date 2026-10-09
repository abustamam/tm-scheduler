/**
 * A guest is a Person (#1124, ADR-0031): every `guests` row points at a `people`
 * row, and what that costs the writers around it.
 *
 * Four groups, each an acceptance criterion the regression suites cannot see:
 *   - the five insert paths each mint a Person with the guest, in one
 *     transaction, so a failure leaves no orphan Person;
 *   - convert puts the membership on the guest's OWN Person and copies the
 *     guest's contact onto it under three predicates, each proved by a case that
 *     only that predicate can fail;
 *   - `mergePeople` takes its club locks before its Person locks and moves guest
 *     rows, and `RESTRICT` makes a forgotten re-point loud;
 *   - a club delete removes that club's guest-only Persons and keeps a Person
 *     another club still holds as a guest, and the merge tool labels them.
 *
 * Every name carries a per-run suffix and every assertion is scoped to ids this
 * file created: vitest runs test FILES in parallel against one database.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubs,
	guests,
	meetings,
	members,
	people,
	user,
} from "#/db/schema";
import { toStoredPhone } from "#/lib/phone";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { createGuestRecord, ensureGuestPerson, RECORD_CHANGED_MESSAGE } =
	await import("#/server/guests-logic");
const { applyAssignGuestToSlot } = await import("#/server/guests-logic");
const {
	applyConvertGuestToMember,
	applyUndoGuestConversion,
	captureGuestVisit,
} = await import("#/server/guest-pipeline-logic");
const { addGuestPresent } = await import("#/server/minutes-logic");
const { joinBallotAsGuest } = await import("#/server/voting-logic");
const { mergePeople } = await import("#/server/people-merge-logic");
const { searchPeopleForMerge, listDuplicatePeople } = await import(
	"#/server/people-logic"
);
const { deleteClubPermanently } = await import("#/server/onboarding-logic");
const { lockClubForWrite } = await import("#/server/club-write-lock");
const { recordGuestBookTool } = await import(
	"#/server/mcp/tools/record-guest-book"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { applyPendingPlan, loadPendingPlan } = await import(
	"#/server/guest-book-pending-logic"
);

/** A name no other run has used, so a count over `people` is this file's own. */
const uniq = (stem: string) => `${stem} ${randomUUID().slice(0, 8)}`;

function uniquePhone(): string {
	const digits = randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "0");
	return `555${digits}`;
}

async function guestRow(guestId: string) {
	const [row] = await testDb
		.select()
		.from(guests)
		.where(eq(guests.id, guestId));
	if (!row) throw new Error(`guest ${guestId} is gone`);
	return row;
}

async function personRow(personId: string) {
	const [row] = await testDb
		.select()
		.from(people)
		.where(eq(people.id, personId));
	return row;
}

async function peopleNamed(name: string) {
	return testDb.select().from(people).where(eq(people.name, name));
}

describe.skipIf(!hasTestDb)("a guest is a Person (#1124)", () => {
	let seed: SeededClub;
	// Everything this file made that `cleanup` cannot reach.
	let extraClubs: string[] = [];
	let extraPeople: string[] = [];
	let extraUsers: string[] = [];
	// Guest Persons, collected before the club cascade deletes the rows naming them.
	let guestPersons: string[] = [];

	async function makeClub(name = uniq("Club"), archived = false) {
		const id = randomUUID();
		await testDb.insert(clubs).values({
			id,
			name,
			slug: `gp-1124-${id}`,
			archivedAt: archived ? new Date() : null,
		});
		extraClubs.push(id);
		return id;
	}

	async function makePerson(
		values: {
			name?: string;
			email?: string | null;
			phone?: string | null;
			userId?: string | null;
		} = {},
	) {
		const id = await seedPerson({ name: uniq("Person"), ...values });
		extraPeople.push(id);
		return id;
	}

	async function makeUser() {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "U",
			email: `u-${id}@test.example`,
			emailVerified: true,
		});
		extraUsers.push(id);
		return id;
	}

	/** A guest in the seeded club, through the one writer, with its contact on the row. */
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
		const row = await guestRow(id);
		if (row.personId) guestPersons.push(row.personId);
		return { guestId: id, personId: row.personId as string };
	}

	const convert = (guestId: string) =>
		applyConvertGuestToMember({
			clubId: seed.clubId,
			guestId,
			actorMemberId: seed.adminMemberId,
		});

	beforeEach(async () => {
		seed = await seedClub();
		extraClubs = [];
		extraPeople = [];
		extraUsers = [];
		guestPersons = [];
	});

	afterEach(async () => {
		// Guest Persons of every club this test touched, read before the cascade.
		const clubIds = [seed.clubId, ...extraClubs];
		const named = await testDb
			.selectDistinct({ id: guests.personId })
			.from(guests)
			.where(inArray(guests.clubId, clubIds));
		const toRemove = new Set([
			...guestPersons,
			...extraPeople,
			...named.flatMap((g) => (g.id ? [g.id] : [])),
		]);
		if (extraClubs.length > 0) {
			await testDb.delete(clubs).where(inArray(clubs.id, extraClubs));
		}
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		// One at a time: a Person another test's row still holds is simply kept.
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

	// -----------------------------------------------------------------------
	// AC4: each insert path creates guest + Person in one transaction.
	// -----------------------------------------------------------------------
	describe("every insert path mints the guest's Person", () => {
		/** The Person a guest points at: name-only, nobody's account. */
		async function expectNameOnlyPerson(guestId: string, name: string) {
			const g = await guestRow(guestId);
			expect(g.personId, "the guest row has no Person").not.toBeNull();
			guestPersons.push(g.personId as string);
			const p = await personRow(g.personId as string);
			expect(p?.name).toBe(name);
			// Contact is still on the guest row (#1125 moves it): the Person is a
			// name and nothing else, whatever the visitor typed.
			expect(p?.email).toBeNull();
			expect(p?.phone).toBeNull();
			expect(p?.userId).toBeNull();
			return g;
		}

		it("the public guest book (captureGuestVisit)", async () => {
			const name = uniq("Capture Guest");
			const { guestId, created } = await captureGuestVisit({
				clubId: seed.clubId,
				name,
				email: "capture@example.com",
			});
			expect(created).toBe(true);
			const g = await expectNameOnlyPerson(guestId, name);
			expect(g.email).toBe("capture@example.com");

			// A returning visitor is the same guest and the same Person: no second.
			const again = await captureGuestVisit({
				clubId: seed.clubId,
				name,
				email: "capture@example.com",
			});
			expect(again.guestId).toBe(guestId);
			expect(await peopleNamed(name)).toHaveLength(1);
		});

		it("assigning a new guest to a role (applyAssignGuestToSlot)", async () => {
			const name = uniq("Slot Guest");
			const { guestId } = await applyAssignGuestToSlot({
				slotId: seed.slotId,
				newGuest: { name, email: "slot@example.com" },
				actorMemberId: seed.adminMemberId,
			});
			await expectNameOnlyPerson(guestId, name);
		});

		it("the minutes editor (addGuestPresent), and a replay of its client id", async () => {
			const name = uniq("Minutes Guest");
			const id = randomUUID();
			const first = await addGuestPresent({
				meetingId: seed.meetingId,
				id,
				newGuest: { name },
			});
			expect(first.guestId).toBe(id);
			await expectNameOnlyPerson(id, name);

			// A lost-ack replay of the same offline create: one guest, ONE Person. The
			// guest insert conflicts on the supplied id, and the Person minted for the
			// replay must go with it.
			const replay = await addGuestPresent({
				meetingId: seed.meetingId,
				id,
				newGuest: { name },
			});
			expect(replay.guestId).toBe(id);
			expect(await peopleNamed(name)).toHaveLength(1);
		});

		it("joining the ballot (joinBallotAsGuest)", async () => {
			const name = uniq("Ballot Guest");
			const g = await joinBallotAsGuest({ meetingId: seed.meetingId, name });
			await expectNameOnlyPerson(g.id, name);
		});

		it("the guest-book confirm flow (applyGuestBookPlan)", async () => {
			const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
			await testDb
				.insert(apiTokens)
				.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
			// A meeting that has already happened: the flow records a page for it.
			const { utcToZonedWallTime, zonedWallTimeToUtc } = await import(
				"#/lib/datetime"
			);
			const weekAgo = utcToZonedWallTime(
				new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
				"America/Chicago",
			).slice(0, 10);
			const past = zonedWallTimeToUtc(`${weekAgo}T12:00`, "America/Chicago");
			await testDb.insert(meetings).values({
				clubId: seed.clubId,
				scheduledAt: past,
				status: "completed",
			});
			const name = uniq("Confirm Guest");
			const { pendingId } = (await recordGuestBookTool.handler(
				{
					clubId: seed.clubId,
					meetingDate: utcToZonedWallTime(past, "America/Chicago").slice(0, 10),
					entries: [{ name, email: "confirm@example.com" }],
				},
				{ rawToken: raw },
			)) as { pendingId: string };
			const view = await loadPendingPlan({
				pendingId,
				userId: seed.adminUserId,
			});
			if (view.status !== "editable") throw new Error(`got ${view.status}`);
			const applied = await applyPendingPlan({
				pendingId,
				userId: seed.adminUserId,
				planHash: view.planHash,
			});
			expect(applied.ok).toBe(true);

			const [row] = await testDb
				.select({ id: guests.id })
				.from(guests)
				.where(and(eq(guests.clubId, seed.clubId), eq(guests.name, name)));
			if (!row) throw new Error("the confirm flow wrote no guest");
			await expectNameOnlyPerson(row.id, name);
		});

		it("a forced failure on the guest insert leaves no orphan Person", async () => {
			const name = uniq("Orphan Check");
			// An unknown club: the Person insert succeeds, the guest insert then
			// violates `guests.club_id`'s foreign key.
			await expect(
				createGuestRecord(testDb, { clubId: randomUUID(), name }),
			).rejects.toThrow();
			expect(await peopleNamed(name)).toHaveLength(0);
		});

		it("inside a caller's transaction a failed create rolls back its own Person only", async () => {
			const kept = uniq("Kept In Batch");
			const lost = uniq("Lost In Batch");
			await testDb.transaction(async (tx) => {
				await createGuestRecord(tx, { clubId: seed.clubId, name: kept });
				// The failure aborts the SAVEPOINT `createGuestRecord` opened, not the
				// batch around it: the caller's earlier work survives and may continue.
				await expect(
					createGuestRecord(tx, { clubId: randomUUID(), name: lost }),
				).rejects.toThrow();
			});
			expect(await peopleNamed(kept)).toHaveLength(1);
			expect(await peopleNamed(lost)).toHaveLength(0);
		});

		it("reports a replay of a client id as not created, and keeps one Person", async () => {
			const name = uniq("Replay Direct");
			const id = randomUUID();
			const first = await createGuestRecord(testDb, {
				id,
				clubId: seed.clubId,
				name,
			});
			const second = await createGuestRecord(testDb, {
				id,
				clubId: seed.clubId,
				name,
			});
			expect(first).toEqual({ id, created: true });
			expect(second).toEqual({ id, created: false });
			expect(await peopleNamed(name)).toHaveLength(1);
			guestPersons.push(...(await peopleNamed(name)).map((p) => p.id));
		});

		it("points at a Person the caller names instead of minting one", async () => {
			const name = uniq("Existing Human");
			const personId = await makePerson({ name });
			const { id } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name,
				personId,
			});
			expect((await guestRow(id)).personId).toBe(personId);
			expect(await peopleNamed(name)).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	// ensureGuestPerson: the old container's row.
	// -----------------------------------------------------------------------
	describe("ensureGuestPerson", () => {
		it("returns the Person a guest already has, and creates nothing", async () => {
			const name = uniq("Has Person");
			const { guestId, personId } = await newGuest(name);
			expect(await ensureGuestPerson(testDb, guestId)).toBe(personId);
			expect(await peopleNamed(name)).toHaveLength(1);
		});

		it("creates a name-and-goes-by Person for a null person_id, once", async () => {
			const name = uniq("Old Container");
			const [g] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name, preferredName: "Oc" })
				.returning({ id: guests.id });
			if (!g) throw new Error("fixture");
			expect((await guestRow(g.id)).personId).toBeNull();

			const personId = await ensureGuestPerson(testDb, g.id);
			guestPersons.push(personId);
			const p = await personRow(personId);
			expect(p?.name).toBe(name);
			expect(p?.preferredName).toBe("Oc");
			expect(p?.email).toBeNull();
			expect((await guestRow(g.id)).personId).toBe(personId);
			// Idempotent: a second call finds it.
			expect(await ensureGuestPerson(testDb, g.id)).toBe(personId);
			expect(await peopleNamed(name)).toHaveLength(1);
		});
	});

	describe("ensureGuestPerson, racing itself", () => {
		it("two repairs of one null person_id agree on ONE Person and mint no orphan", async () => {
			// The repair is a check-then-set, and its UPDATE carries `person_id IS
			// NULL` so the second writer READS the first one's Person instead of
			// overwriting it. Driven for real: the first repair holds the guest row
			// uncommitted, the second reads null, mints its own Person and parks on
			// the row, then wakes to find the column set.
			const name = uniq("Racing Repair");
			const [g] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name })
				.returning({ id: guests.id });
			if (!g) throw new Error("fixture");
			let first = "";
			const blocker = await openBlockingTx(async (tx) => {
				first = await ensureGuestPerson(tx, g.id);
			});
			const second = ensureGuestPerson(testDb, g.id);
			await waitForLockWait("guests", blocker.pid);
			await blocker.commit();

			expect(await second).toBe(first);
			expect((await guestRow(g.id)).personId).toBe(first);
			// The loser's Person went with its lost race: one Person carries the name.
			const named = await peopleNamed(name);
			expect(named.map((p) => p.id)).toEqual([first]);
			guestPersons.push(first);
		});
	});

	// -----------------------------------------------------------------------
	// Convert: the membership goes on the guest's own Person.
	// -----------------------------------------------------------------------
	describe("convert adopts the guest's Person", () => {
		it("adds the membership on that Person, mints no Person, and copies the guest's contact onto it (AC6)", async () => {
			const name = uniq("Adopt Me");
			const email = `adopt-${randomUUID()}@example.com`;
			const rawPhone = uniquePhone();
			const { guestId, personId } = await newGuest(name, {
				email,
				phone: rawPhone,
			});
			// Name-only before the convert: that is what the backfill and
			// `createGuestRecord` leave.
			expect((await personRow(personId))?.email).toBeNull();
			expect((await personRow(personId))?.phone).toBeNull();

			const res = await convert(guestId);

			// One human, one Person: the guest's own, now a member.
			expect(res.personId).toBe(personId);
			expect(await peopleNamed(name)).toHaveLength(1);
			const [m] = await testDb
				.select({ personId: members.personId, clubId: members.clubId })
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(m).toEqual({ personId, clubId: seed.clubId });
			// The copy ran BEFORE the membership insert. After it the Person is no
			// longer guest-only and the UPDATE would match nothing and still succeed,
			// leaving the member with no contact.
			const p = await personRow(personId);
			expect(p?.email).toBe(email);
			expect(p?.phone).toBe(toStoredPhone(rawPhone, "1"));
			// `createdPerson` is false: undo must never treat this Person as minted.
			const [entry] = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_add"),
						eq(activityLog.targetId, res.membershipId),
					),
				);
			expect(entry?.detail).toMatchObject({
				createdPerson: false,
				createdMembership: true,
				personId,
			});
			// The guest row still points at the same Person and is frozen as joined.
			const g = await guestRow(guestId);
			expect(g.personId).toBe(personId);
			expect(g.stage).toBe("joined");
			expect(g.convertedMembershipId).toBe(res.membershipId);
		});

		it("reports a shared address after commit when the copy wrote one (#759)", async () => {
			// The address this convert wrote is already on ANOTHER Person who is
			// somebody (here, a member of another club), so neither can sign in. The
			// notice rides on `written`, which is set only when the UPDATE landed.
			const email = `shared-${randomUUID()}@example.com`;
			const otherClub = await makeClub();
			const other = await makePerson({ email });
			await testDb.insert(members).values({
				clubId: otherClub,
				personId: other,
				name: uniq("Other Holder"),
			});
			const { guestId, personId } = await newGuest(uniq("Shares Address"), {
				email,
			});

			const res = await convert(guestId);

			expect(res.personId).toBe(personId);
			expect((await personRow(personId))?.email).toBe(email);
			expect(res.rosterConflict).toBe("shared_address");
		});

		it("keeps an email the Person already has, and still fills the blank phone", async () => {
			const kept = `kept-${randomUUID()}@example.com`;
			const rawPhone = uniquePhone();
			const { guestId, personId } = await newGuest(uniq("Has Email"), {
				email: `typed-${randomUUID()}@example.com`,
				phone: rawPhone,
			});
			await testDb
				.update(people)
				.set({ email: kept })
				.where(eq(people.id, personId));

			await convert(guestId);

			const p = await personRow(personId);
			expect(p?.email).toBe(kept);
			expect(p?.phone).toBe(toStoredPhone(rawPhone, "1"));
		});

		it("keeps a phone the Person already has, and still fills the blank email", async () => {
			const keptPhone = toStoredPhone(uniquePhone(), "1");
			const email = `fill-${randomUUID()}@example.com`;
			const { guestId, personId } = await newGuest(uniq("Has Phone"), {
				email,
				phone: uniquePhone(),
			});
			await testDb
				.update(people)
				.set({ phone: keptPhone })
				.where(eq(people.id, personId));

			await convert(guestId);

			const p = await personRow(personId);
			expect(p?.phone).toBe(keptPhone);
			expect(p?.email).toBe(email);
		});

		it("copies nothing onto a Person somebody has signed in as", async () => {
			const { guestId, personId } = await newGuest(uniq("Bound Guest"), {
				email: `bound-${randomUUID()}@example.com`,
				phone: uniquePhone(),
			});
			await testDb
				.update(people)
				.set({ userId: await makeUser() })
				.where(eq(people.id, personId));

			await convert(guestId);

			// The address on a bound Person is its account's, and the guest book is an
			// anonymous form.
			const p = await personRow(personId);
			expect(p?.email).toBeNull();
			expect(p?.phone).toBeNull();
		});

		it("copies nothing onto a Person that is already a member somewhere else", async () => {
			// A merge can leave a guest row pointing at a member's Person. What that
			// club recorded stays; the guest row's contact is not theirs to add.
			const otherClub = await makeClub();
			const memberPerson = await makePerson({ name: uniq("Elsewhere Member") });
			await testDb.insert(members).values({
				clubId: otherClub,
				personId: memberPerson,
				name: "Elsewhere Member",
			});
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Guest Of A Member"),
				email: `elsewhere-${randomUUID()}@example.com`,
				phone: uniquePhone(),
				personId: memberPerson,
			});

			const res = await convert(guestId);

			// Still adopted: the membership goes on that Person...
			expect(res.personId).toBe(memberPerson);
			const held = await testDb
				.select({ clubId: members.clubId })
				.from(members)
				.where(eq(members.personId, memberPerson));
			expect(held.map((h) => h.clubId).sort()).toEqual(
				[otherClub, seed.clubId].sort(),
			);
			// ...and nothing is copied onto it.
			const p = await personRow(memberPerson);
			expect(p?.email).toBeNull();
			expect(p?.phone).toBeNull();
		});

		it("creates the Person first for a guest whose person_id is null, then converts (AC7)", async () => {
			const name = uniq("Null Person");
			const email = `null-${randomUUID()}@example.com`;
			const [g] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name, email })
				.returning({ id: guests.id });
			if (!g) throw new Error("fixture");

			const res = await convert(g.id);

			const row = await guestRow(g.id);
			expect(row.personId).toBe(res.personId);
			guestPersons.push(res.personId);
			// One Person, named for the guest, carrying the copied address.
			const named = await peopleNamed(name);
			expect(named.map((p) => p.id)).toEqual([res.personId]);
			expect(named[0]?.email).toBe(email);
			const [m] = await testDb
				.select({ personId: members.personId })
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(m?.personId).toBe(res.personId);
		});

		it("undoing it leaves the Person and the guest row, and the guest returns to following_up (AC8)", async () => {
			const name = uniq("Undo Me");
			const { guestId, personId } = await newGuest(name, {
				email: `undo-${randomUUID()}@example.com`,
			});
			const res = await convert(guestId);

			const undone = await applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(undone.membershipDeleted).toBe(true);
			const gone = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(gone).toHaveLength(0);
			// Both the guest row and its Person survive.
			const g = await guestRow(guestId);
			expect(g.stage).toBe("following_up");
			expect(g.convertedMembershipId).toBeNull();
			expect(g.personId).toBe(personId);
			expect(await personRow(personId)).toBeDefined();
			expect(await peopleNamed(name)).toHaveLength(1);
		});

		it("refuses when the guest's Person changed between the read and the locks", async () => {
			// The read-then-lock rule: the Person is learned from an unlocked read,
			// and the locked re-read must agree. A concurrent writer that sets
			// `person_id` on the row between the two is the case.
			const name = uniq("Moved Person");
			const [g] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name })
				.returning({ id: guests.id });
			if (!g) throw new Error("fixture");
			const newPerson = await makePerson({ name });

			const blocker = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from guests where id = ${g.id} for update`,
				);
				await tx
					.update(guests)
					.set({ personId: newPerson })
					.where(eq(guests.id, g.id));
			});
			const racing = convert(g.id).then(
				() => null,
				(e: Error) => e,
			);
			// Parked on the guest row lock, having already read `person_id` as null.
			await waitForLockWait("guests", blocker.pid);
			await blocker.commit();

			const err = await racing;
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			// Nothing was written: the guest is still not joined, and has no member.
			const row = await guestRow(g.id);
			expect(row.stage).not.toBe("joined");
			expect(row.convertedMembershipId).toBeNull();
		});
	});

	// -----------------------------------------------------------------------
	// mergePeople, RESTRICT, member delete.
	// -----------------------------------------------------------------------
	describe("merging, deleting and the foreign key", () => {
		it("mergePeople moves the absorbed Person's guest rows to the keeper (AC9)", async () => {
			const clubB = await makeClub();
			const keeper = await newGuest(uniq("Keeper Guest"));
			const absorbed = await newGuest(uniq("Absorbed Guest"), {}, clubB);

			await mergePeople({
				keeperPersonId: keeper.personId,
				absorbedPersonId: absorbed.personId,
			});

			// Both guest rows, in BOTH clubs, now belong to the keeper; the absorbed
			// Person is gone. The guest records themselves stay per club.
			expect((await guestRow(keeper.guestId)).personId).toBe(keeper.personId);
			const moved = await guestRow(absorbed.guestId);
			expect(moved.personId).toBe(keeper.personId);
			expect(moved.clubId).toBe(clubB);
			expect(await personRow(absorbed.personId)).toBeUndefined();
			expect(await personRow(keeper.personId)).toBeDefined();
		});

		it("deleting a Person a guest row still names fails on the foreign key (AC9)", async () => {
			const { personId } = await newGuest(uniq("Restricted"));
			await expect(
				testDb.delete(people).where(eq(people.id, personId)),
			).rejects.toMatchObject({
				cause: { code: "23503" },
			});
			expect(await personRow(personId)).toBeDefined();
		});

		it("deleting a member who has two converted guest rows succeeds (AC10)", async () => {
			// Several converted guest rows legitimately share one member Person
			// (#635). `converted_membership_id` is SET NULL, and nothing may make that
			// one statement fail: a unique index over it would.
			const personId = await makePerson({ name: uniq("Two Guests") });
			const [member] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name: "Two Guests" })
				.returning({ id: members.id });
			if (!member) throw new Error("fixture");
			const ids: string[] = [];
			for (const stem of ["First Visit", "Second Visit"]) {
				const { id } = await createGuestRecord(testDb, {
					clubId: seed.clubId,
					name: uniq(stem),
					stage: "joined",
					convertedMembershipId: member.id,
					personId,
				});
				ids.push(id);
			}

			await testDb.delete(members).where(eq(members.id, member.id));

			const rows = await testDb
				.select({
					convertedMembershipId: guests.convertedMembershipId,
					personId: guests.personId,
				})
				.from(guests)
				.where(inArray(guests.id, ids));
			expect(rows).toHaveLength(2);
			for (const r of rows) {
				expect(r.convertedMembershipId).toBeNull();
				expect(r.personId).toBe(personId);
			}
		});
	});

	// -----------------------------------------------------------------------
	// The lock protocol: club, then Person, then guest.
	// -----------------------------------------------------------------------
	describe("lock order", () => {
		it("a writer holding the club lock may take a Person while mergePeople waits on that club (AC13)", async () => {
			// A guest-book capture, a convert and #1127's link all take the club's
			// write lock and THEN a Person. If `mergePeople` held its Persons while it
			// waited for the club lock (its old order), this transaction asking for one
			// of them would close a cycle and Postgres would kill one side with 40P01.
			const clubB = await makeClub();
			const a = await newGuest(uniq("Merge A"));
			const b = await newGuest(uniq("Merge B"), {}, clubB);

			const writer = await openBlockingTx(async (tx) => {
				await lockClubForWrite(tx, clubB);
			});
			const merging = mergePeople({
				keeperPersonId: a.personId,
				absorbedPersonId: b.personId,
			}).then(
				() => null,
				(e: Error) => e,
			);
			// The merge is parked on the club's advisory lock, holding no Person yet.
			await waitForLockWait("pg_advisory_xact_lock", writer.pid);

			// This writer now takes the Person, as a convert would. It must not wait.
			const tookPerson = await testDb.transaction(async (tx) => {
				// A different backend from `writer`: so this is the cycle's other leg
				// only if the merge already holds the Person.
				await tx.execute(sql`set local lock_timeout = '2s'`);
				const rows = await tx
					.select({ id: people.id })
					.from(people)
					.where(eq(people.id, b.personId))
					.for("update");
				return rows.length;
			});
			expect(tookPerson).toBe(1);
			await writer.commit();

			expect(await merging).toBeNull();
			expect((await guestRow(b.guestId)).personId).toBe(a.personId);
		});

		it("a guest-book capture racing mergePeople on the same club and Person completes (AC13)", async () => {
			// The scenario the issue names, driven for real: both take the club write
			// lock first, so one waits for the other, in either order, and neither is
			// ever the victim of a deadlock.
			const clubB = await makeClub();
			const name = uniq("Racing Guest");
			const email = `race-${randomUUID()}@example.com`;
			const keeper = await newGuest(uniq("Race Keeper"), {}, clubB);
			const absorbed = await newGuest(name, { email });

			const outcomes = await Promise.allSettled([
				captureGuestVisit({ clubId: seed.clubId, name, email }),
				mergePeople({
					keeperPersonId: keeper.personId,
					absorbedPersonId: absorbed.personId,
				}),
			]);

			for (const o of outcomes) {
				if (o.status === "rejected") {
					const msg = (o.reason as Error).message;
					// The only refusals that are not a bug: the club was busy, or the
					// merge saw its set of clubs move under it.
					expect(msg).toMatch(
						new RegExp(`${RECORD_CHANGED_MESSAGE}|busy right now`),
					);
					expect(msg).not.toMatch(/deadlock/i);
				}
			}
			// The merge, at least, landed: it is the one with nothing to wait for
			// once the capture's transaction is done.
			expect(outcomes[1].status).toBe("fulfilled");
			// And the capture found the same human whichever order they ran in.
			const capture = outcomes[0];
			if (capture.status === "fulfilled") {
				expect(capture.value.guestId).toBe(absorbed.guestId);
			}
		});

		it("refuses a merge whose clubs changed after it read them", async () => {
			const clubB = await makeClub();
			const a = await newGuest(uniq("Moved A"));
			const b = await newGuest(uniq("Moved B"));
			// The merge reads the clubs of both Persons (just this one) and parks on
			// its lock, held here. While it waits, `b` gains a guest row in a club
			// the merge never read, so its re-read under the locks differs.
			const writer = await openBlockingTx(async (tx) => {
				await lockClubForWrite(tx, seed.clubId);
			});
			const merging = mergePeople({
				keeperPersonId: a.personId,
				absorbedPersonId: b.personId,
			}).then(
				() => null,
				(e: Error) => e,
			);
			await waitForLockWait("pg_advisory_xact_lock", writer.pid);
			// Committed before the writer lets go.
			await createGuestRecord(testDb, {
				clubId: clubB,
				name: uniq("Appeared"),
				personId: b.personId,
			});
			await writer.commit();

			const err = await merging;
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			// Nothing was written: `b`'s Person is still there.
			expect(await personRow(b.personId)).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// Club delete.
	// -----------------------------------------------------------------------
	describe("deleting a club (AC11)", () => {
		it("deletes the club's guest-only Persons and keeps one a guest row elsewhere still names", async () => {
			const archivedName = uniq("Doomed Club");
			const doomed = await makeClub(archivedName, true);
			const survivor = await makeClub();

			const local = await newGuest(uniq("Only Here"), {}, doomed);
			const shared = await newGuest(uniq("Seen Both Places"), {}, doomed);
			// A second guest row for the SAME human in another club (the shape #1127
			// creates): the Person must outlive the club that is going.
			const { id: survivorGuest } = await createGuestRecord(testDb, {
				clubId: survivor,
				name: uniq("Seen Both Places"),
				personId: shared.personId,
			});

			await deleteClubPermanently(doomed, archivedName);

			expect(await personRow(local.personId), "guest-only Person kept").toBe(
				undefined,
			);
			const kept = await personRow(shared.personId);
			expect(
				kept,
				"a Person with a guest row elsewhere was deleted",
			).toBeDefined();
			// Its other guest row is intact and still points at it.
			expect((await guestRow(survivorGuest)).personId).toBe(shared.personId);
			// The doomed club's guest rows went with the cascade.
			const left = await testDb
				.select({ id: guests.id })
				.from(guests)
				.where(eq(guests.clubId, doomed));
			expect(left).toHaveLength(0);
		});

		it("keeps a guest Person a member of another club holds", async () => {
			const archivedName = uniq("Doomed Member Club");
			const doomed = await makeClub(archivedName, true);
			const personId = await makePerson({ name: uniq("Member And Guest") });
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId,
				name: "Member And Guest",
			});
			await createGuestRecord(testDb, {
				clubId: doomed,
				name: uniq("Member And Guest"),
				personId,
			});

			await deleteClubPermanently(doomed, archivedName);

			expect(await personRow(personId)).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// The superadmin merge tool.
	// -----------------------------------------------------------------------
	describe("the merge tool (AC12)", () => {
		it("lists a guest-only Person labelled, and a member Person not", async () => {
			const stem = uniq("Mergetool").toLowerCase().replaceAll(" ", "-");
			const guest = await newGuest(`${stem}-guest`);
			const memberPerson = await makePerson({ name: `${stem}-member` });
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId: memberPerson,
				name: `${stem}-member`,
			});
			// A guest Person who is ALSO a member is not guest-only.
			const both = await makePerson({ name: `${stem}-both` });
			await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: both, name: `${stem}-both` });
			await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: `${stem}-both`,
				personId: both,
			});
			// And one somebody has signed in as.
			const boundGuest = await newGuest(`${stem}-bound`);
			await testDb
				.update(people)
				.set({ userId: await makeUser() })
				.where(eq(people.id, boundGuest.personId));

			const found = await searchPeopleForMerge(stem);
			const byName = new Map(found.map((p) => [p.name, p]));

			expect(byName.get(`${stem}-guest`)).toMatchObject({
				id: guest.personId,
				guestOnly: true,
			});
			expect(byName.get(`${stem}-member`)?.guestOnly).toBe(false);
			expect(byName.get(`${stem}-both`)?.guestOnly).toBe(false);
			expect(byName.get(`${stem}-bound`)?.guestOnly).toBe(false);
		});

		it("labels a duplicate group's guest-only Person too", async () => {
			const email = `dup-${randomUUID()}@example.com`;
			const guest = await newGuest(uniq("Dup Guest"));
			// Contact still moves in #1125, so give the guest's Person an address the
			// way a later release will, and a member Person the same one.
			await testDb
				.update(people)
				.set({ email })
				.where(eq(people.id, guest.personId));
			const member = await makePerson({ email });
			await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: member, name: "Dup Member" });

			const groups = await listDuplicatePeople();
			const group = groups.find((g) => g.email === email);
			expect(group?.people.map((p) => [p.id, p.guestOnly]).sort()).toEqual(
				[
					[guest.personId, true],
					[member, false],
				].sort(),
			);
		});
	});
});
