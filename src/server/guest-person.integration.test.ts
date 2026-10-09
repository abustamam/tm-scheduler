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
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubCharterHelpers,
	clubs,
	guests,
	meetings,
	members,
	pathEnrollments,
	pathwaysPaths,
	people,
	peopleEmailBackup,
	roleSlots,
	speeches,
	user,
} from "#/db/schema";
import {
	CONVERT_NAME_CLASH_MESSAGE,
	UNDO_MEMBER_HAS_ACCOUNT_MESSAGE,
} from "#/lib/guest-convert";
import { toStoredPhone } from "#/lib/phone";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	type TestTx,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyAssignGuestToSlot,
	createGuestRecord,
	ensureGuestPerson,
	GUEST_NOT_IN_CLUB_MESSAGE,
	RECORD_CHANGED_MESSAGE,
} = await import("#/server/guests-logic");
const {
	applyConvertGuestToMember,
	applyDeleteGuest,
	applyLinkGuestToMember,
	applySetGuestStage,
	applyUndoGuestConversion,
	applyUnlinkGuestFromMember,
	applyUpdateGuest,
	captureGuestVisit,
} = await import("#/server/guest-pipeline-logic");
const { bindVerifiedPerson, pristineGuestPerson, releasedPersonSubquery } =
	await import("#/server/account-link-logic");
const { importPeopleAndMembers } = await import(
	"#/server/import-members-logic"
);
const { applyMemberEdit, applyMemberMerge, applyMemberRemove } = await import(
	"#/server/members-logic"
);
const { collapseMemberships } = await import(
	"#/server/membership-collapse-logic"
);
const { addGuestPresent } = await import("#/server/minutes-logic");
const { joinBallotAsGuest } = await import("#/server/voting-logic");
const { mergePeople } = await import("#/server/people-merge-logic");
const { searchPeopleForMerge, listDuplicatePeople, getMergePreview } =
	await import("#/server/people-logic");
const { deleteClubPermanently } = await import("#/server/onboarding-logic");
const { forUpdate, lockClubForWrite, lockPersonsInOrder, noKeyUpdate } =
	await import("#/server/club-write-lock");
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
	let extraPaths: string[] = [];
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

	async function makeUser(email?: string) {
		const id = randomUUID();
		await testDb.insert(user).values({
			id,
			name: "U",
			email: email ?? `u-${id}@test.example`,
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
		extraPaths = [];
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
		if (toRemove.size > 0) {
			await testDb
				.delete(peopleEmailBackup)
				.where(inArray(peopleEmailBackup.personId, [...toRemove]));
		}
		if (extraPaths.length > 0) {
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, extraPaths));
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

		it("a replay that names a Person leaves THAT Person alone", async () => {
			const name = uniq("Named Replay");
			const personId = await makePerson({ name });
			const id = randomUUID();
			await createGuestRecord(testDb, {
				id,
				clubId: seed.clubId,
				name,
				personId,
			});
			const replay = await createGuestRecord(testDb, {
				id,
				clubId: seed.clubId,
				name,
				personId,
			});
			expect(replay).toEqual({ id, created: false });
			// The Person was the caller's, not minted for the replay: it stays.
			expect(await personRow(personId)).toBeDefined();
		});

		it("refuses a client id that names ANOTHER club's guest, and mints nothing (L2)", async () => {
			const clubB = await makeClub();
			const theirs = await newGuest(uniq("Their Guest"), {}, clubB);
			const name = uniq("Squatter");

			await expect(
				createGuestRecord(testDb, {
					id: theirs.guestId,
					clubId: seed.clubId,
					name,
				}),
			).rejects.toThrow(GUEST_NOT_IN_CLUB_MESSAGE);

			// Nothing was minted for the refusal, and the other club's row is untouched.
			expect(await peopleNamed(name)).toHaveLength(0);
			const g = await guestRow(theirs.guestId);
			expect(g.clubId).toBe(clubB);
			expect(g.personId).toBe(theirs.personId);
		});

		it("addGuestPresent refuses another club's guest id instead of attaching it (L2)", async () => {
			const clubB = await makeClub();
			const theirs = await newGuest(uniq("Elsewhere Guest"), {}, clubB);

			await expect(
				addGuestPresent({
					meetingId: seed.meetingId,
					id: theirs.guestId,
					newGuest: { name: uniq("Same Id") },
				}),
			).rejects.toThrow(GUEST_NOT_IN_CLUB_MESSAGE);

			// The foreign guest was not recorded present at this club's meeting.
			const { meetingAttendance } = await import("#/db/schema");
			const rows = await testDb
				.select({ id: meetingAttendance.id })
				.from(meetingAttendance)
				.where(eq(meetingAttendance.guestId, theirs.guestId));
			expect(rows).toHaveLength(0);
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

		it("refuses a guest that does not exist", async () => {
			await expect(ensureGuestPerson(testDb, randomUUID())).rejects.toThrow(
				"Guest not found.",
			);
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
	describe("convert adopts the guest's Person when it is pristine", () => {
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

		it("a pristine guest Person is adopted: contact, name and goes-by are filled from the guest row, and no Person is inserted", async () => {
			// The control for every case below: nothing about this Person says it was
			// ever anyone but the guest.
			const name = uniq("Pristine Adopt");
			const email = `pristine-${randomUUID()}@example.com`;
			const rawPhone = uniquePhone();
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name,
				preferredName: "Pri",
				email,
				phone: rawPhone,
			});
			const personId = (await guestRow(guestId)).personId as string;
			guestPersons.push(personId);

			const res = await convert(guestId);

			expect(res.personId).toBe(personId);
			expect(await peopleNamed(name)).toHaveLength(1);
			const p = await personRow(personId);
			expect(p?.email).toBe(email);
			expect(p?.phone).toBe(toStoredPhone(rawPhone, "1"));
			expect(p?.preferredName).toBe("Pri");
			expect((await guestRow(guestId)).personId).toBe(personId);
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

			// AC8, from this very convert: undoing it leaves the Person ensure created
			// and the guest row, and the guest goes back to following_up on it.
			const undone = await applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId: g.id,
				actorMemberId: seed.adminMemberId,
			});
			expect(undone.membershipDeleted).toBe(true);
			const after = await guestRow(g.id);
			expect(after.stage).toBe("following_up");
			expect(after.convertedMembershipId).toBeNull();
			expect(after.personId).toBe(res.personId);
			expect(await peopleNamed(name)).toHaveLength(1);
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

	// =======================================================================
	// The review round of #1155. Every case below starts from the STATE THE BUG
	// LEAVES BEHIND (a backfilled row, a record written before #1124, a Person a
	// merge moved), not only from a fresh capture then convert.
	// =======================================================================

	/** A `member_add` record as convert writes it, or as it wrote it before #1124. */
	async function plantConversionRecord(opts: {
		guestId: string;
		membershipId: string;
		personId: string;
		createdMembership: boolean;
		createdPerson: boolean;
	}) {
		await testDb.insert(activityLog).values({
			clubId: seed.clubId,
			actorMemberId: seed.adminMemberId,
			action: "member_add",
			targetType: "member",
			targetId: opts.membershipId,
			detail: {
				name: "Planted",
				fromGuestId: opts.guestId,
				personId: opts.personId,
				slotIds: [],
				createdMembership: opts.createdMembership,
				createdPerson: opts.createdPerson,
			},
		});
	}

	/**
	 * What the OLD convert left behind, as the backfill read it: a Person it minted
	 * carrying the guest's contact, a membership on it, a guest row pointing at that
	 * Person and that membership, and a record saying it created both.
	 */
	async function legacyConvertedGuest(name: string, email: string) {
		const personId = await makePerson({ name, email, phone: "+15550001111" });
		const [m] = await testDb
			.insert(members)
			.values({ clubId: seed.clubId, personId, name })
			.returning({ id: members.id });
		if (!m) throw new Error("fixture");
		const { id: guestId } = await createGuestRecord(testDb, {
			clubId: seed.clubId,
			name,
			email,
			stage: "joined",
			convertedMembershipId: m.id,
			personId,
		});
		await plantConversionRecord({
			guestId,
			membershipId: m.id,
			personId,
			createdMembership: true,
			createdPerson: true,
		});
		return { guestId, personId, membershipId: m.id };
	}

	const undo = (guestId: string) =>
		applyUndoGuestConversion({
			clubId: seed.clubId,
			guestId,
			actorMemberId: seed.adminMemberId,
		});

	// -----------------------------------------------------------------------
	// H1: undo reverses what convert filled.
	// -----------------------------------------------------------------------
	describe("convert fills the contact, undo leaves it, a corrected re-convert is right (H1)", () => {
		it("a typo'd address does not stay on a member's Person: convert, undo, correct, convert again", async () => {
			const name = uniq("Typo Guest");
			const typo = `typo-${randomUUID()}@example.test`;
			const fixed = `fixed-${randomUUID()}@example.test`;
			const { guestId, personId } = await newGuest(name, { email: typo });
			const first = await convert(guestId);
			expect(first.personId).toBe(personId);
			expect((await personRow(personId))?.email).toBe(typo);

			await undo(guestId);
			// Undo leaves the contact as convert set it (#875): the undoing club's own
			// roster CSV still finds this Person by that address.
			expect((await personRow(personId))?.email).toBe(typo);

			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name,
				email: fixed,
			});
			const second = await convert(guestId);

			// The old Person now carries contact and a removal record, so it is not
			// pristine: the guest gets a FRESH Person with the CORRECTED address, and
			// the typo stays on the old Person, which holds no membership.
			expect(second.personId).not.toBe(personId);
			guestPersons.push(second.personId);
			expect((await personRow(second.personId))?.email).toBe(fixed);
			expect((await personRow(personId))?.email).toBe(typo);
			// End to end through the bind rule: the typo's owner cannot sign in to the
			// new member Person, nor to the old one (no membership vouches for it), and
			// the real address can bind the new one.
			const typoOwner = await makeUser(typo);
			expect(
				await bindVerifiedPerson({
					personId: second.personId,
					userId: typoOwner,
				}),
			).toBe(false);
			expect(await bindVerifiedPerson({ personId, userId: typoOwner })).toBe(
				false,
			);
			expect((await personRow(second.personId))?.userId).toBeNull();
			const realOwner = await makeUser(fixed);
			expect(
				await bindVerifiedPerson({
					personId: second.personId,
					userId: realOwner,
				}),
			).toBe(true);
		});

		it("the same for a record from BEFORE #1124 (createdPerson: true): the Person the old convert minted is not adopted again", async () => {
			const name = uniq("Legacy Typo");
			const typo = `legacy-typo-${randomUUID()}@example.test`;
			const fixed = `legacy-fixed-${randomUUID()}@example.test`;
			const { guestId, personId } = await legacyConvertedGuest(name, typo);
			// The state the old convert leaves: the member's Person carries the guest's
			// contact, the guest row points at it (the backfill), and it has a membership.
			expect((await personRow(personId))?.email).toBe(typo);
			expect((await personRow(personId))?.phone).toBe("+15550001111");

			const undone = await undo(guestId);
			expect(undone.membershipDeleted).toBe(true);
			// Undo does not touch the contact, and the guest still names the Person.
			const after = await personRow(personId);
			expect(after?.email).toBe(typo);
			expect(after?.phone).toBe("+15550001111");
			expect(after?.name).toBe(name);
			expect((await guestRow(guestId)).personId).toBe(personId);

			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name,
				email: fixed,
			});
			const second = await convert(guestId);

			// It has contact and a removal record: not pristine. A fresh Person carries
			// the corrected address and the guest row's (empty) phone; the old one keeps
			// what the old convert minted it with.
			expect(second.personId).not.toBe(personId);
			guestPersons.push(second.personId);
			const fresh = await personRow(second.personId);
			expect(fresh?.email).toBe(fixed);
			expect(fresh?.phone).toBeNull();
			expect((await personRow(personId))?.email).toBe(typo);
			const typoOwner = await makeUser(typo);
			expect(
				await bindVerifiedPerson({
					personId: second.personId,
					userId: typoOwner,
				}),
			).toBe(false);
		});

		it("a guest whose address was cleared after an undo: the re-convert's fresh Person has none, and the old one keeps its own", async () => {
			const name = uniq("Cleared After Undo");
			const email = `will-clear-${randomUUID()}@example.test`;
			const { guestId, personId } = await newGuest(name, { email });
			await convert(guestId);
			await undo(guestId);
			await applyUpdateGuest({ clubId: seed.clubId, guestId, name });

			const second = await convert(guestId);

			expect(second.personId).not.toBe(personId);
			guestPersons.push(second.personId);
			expect((await personRow(second.personId))?.email).toBeNull();
			expect((await personRow(personId))?.email).toBe(email);
		});

		it("an undo leaves the contact convert set, so the undoing club's CSV still matches it", async () => {
			const email = `kept-${randomUUID()}@example.test`;
			const rawPhone = uniquePhone();
			const { guestId, personId } = await newGuest(uniq("Undo Keeps"), {
				email,
				phone: rawPhone,
			});
			await convert(guestId);

			await undo(guestId);

			const p = await personRow(personId);
			expect(p?.email).toBe(email);
			expect(p?.phone).toBe(toStoredPhone(rawPhone, "1"));
		});

		it("undoes a conversion of a guest whose person_id is null (the old container's row) without minting a Person", async () => {
			// An old-container guest converted by the old container: no person_id on
			// the guest, a membership on a Person the old convert minted, and the
			// pre-#1124 record. Nothing for the guest to be separated from.
			const name = uniq("Old On Old");
			const personId = await makePerson({
				name,
				email: `old-${randomUUID()}@example.test`,
			});
			const [m] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name })
				.returning({ id: members.id });
			if (!m) throw new Error("fixture");
			const [g] = await testDb
				.insert(guests)
				.values({
					clubId: seed.clubId,
					name,
					stage: "joined",
					convertedMembershipId: m.id,
				})
				.returning({ id: guests.id });
			if (!g) throw new Error("fixture");
			await plantConversionRecord({
				guestId: g.id,
				membershipId: m.id,
				personId,
				createdMembership: true,
				createdPerson: true,
			});

			const undone = await undo(g.id);

			expect(undone.membershipDeleted).toBe(true);
			const row = await guestRow(g.id);
			expect(row.stage).toBe("following_up");
			expect(row.personId).toBeNull();
			expect(await peopleNamed(name)).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	// H2: after an undo or unlink the guest no longer names a member's Person.
	// -----------------------------------------------------------------------
	describe("an undo or unlink leaves the guest alone, and a re-convert never lands on a member (H2)", () => {
		it("a backfilled converted row whose membership was REUSED: undo leaves the guest alone, and a re-convert makes a NEW membership on a fresh Person", async () => {
			const name = uniq("Reuse Member");
			const memberPerson = await makePerson({ name });
			// A lapsed ADMIN: the reuse branch would wake it and demote it.
			const [m0] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: memberPerson,
					name,
					clubRole: "admin",
					status: "inactive",
				})
				.returning({ id: members.id });
			if (!m0) throw new Error("fixture");
			// The backfill's shape: the guest row names the member's Person.
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name,
				stage: "joined",
				convertedMembershipId: m0.id,
				personId: memberPerson,
			});
			await plantConversionRecord({
				guestId,
				membershipId: m0.id,
				personId: memberPerson,
				createdMembership: false,
				createdPerson: false,
			});

			const undone = await undo(guestId);

			// The membership was convert's REUSE, so it stands, untouched. Undo does not
			// move the guest; the next convert decides.
			expect(undone.membershipDeleted).toBe(false);
			const g = await guestRow(guestId);
			expect(g.personId).toBe(memberPerson);
			expect(g.stage).toBe("following_up");

			// A re-convert under the SAME name meets the #617 refusal instead of
			// quietly reusing the member's row, and the refusal leaves the guest where
			// it was (the whole transaction rolled back, the fresh Person with it).
			await expect(convert(guestId)).rejects.toThrow(
				CONVERT_NAME_CLASH_MESSAGE,
			);
			expect((await guestRow(guestId)).personId).toBe(memberPerson);
			// Rename the guest and it creates a NEW membership on a fresh Person.
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: uniq("Entirely Different"),
			});
			const res = await convert(guestId);
			expect(res.membershipId).not.toBe(m0.id);
			expect(res.personId).not.toBe(memberPerson);
			guestPersons.push(res.personId);
			expect((await guestRow(guestId)).personId).toBe(res.personId);
			expect(res.reactivated).toBe(false);
			// The lapsed admin was not woken or demoted, and its Person is untouched.
			const [still] = await testDb
				.select({ status: members.status, clubRole: members.clubRole })
				.from(members)
				.where(eq(members.id, m0.id));
			expect(still).toEqual({ status: "inactive", clubRole: "admin" });
			expect((await personRow(memberPerson))?.name).toBe(name);
		});

		it("a #635-linked guest, unlinked: the guest gets a fresh name-only Person, a re-convert makes a NEW membership on it, and the member is untouched", async () => {
			const stem = uniq("Linked");
			const { guestId } = await newGuest(stem);
			const memberBefore = await personRow(seed.personId);

			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			});
			// L5: the link points the guest at the member's Person, as a convert does.
			expect((await guestRow(guestId)).personId).toBe(seed.personId);

			await applyUnlinkGuestFromMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			// The member is still a member, so the unlink points the guest at a fresh
			// name-only Person rather than leaving it on theirs.
			const after = await guestRow(guestId);
			expect(after.personId).not.toBe(seed.personId);
			guestPersons.push(after.personId as string);
			const fresh = await personRow(after.personId as string);
			expect(fresh?.name).toBe(stem);
			expect(fresh?.email).toBeNull();

			const res = await convert(guestId);

			// It is pristine, so the convert adopts it: a NEW membership on it.
			expect(res.membershipId).not.toBe(seed.memberId);
			expect(res.personId).toBe(after.personId);
			// The member is exactly as they were.
			const memberAfter = await personRow(seed.personId);
			expect(memberAfter?.name).toBe(memberBefore?.name);
			expect(memberAfter?.email).toBe(memberBefore?.email);
			const [m] = await testDb
				.select({ status: members.status, clubRole: members.clubRole })
				.from(members)
				.where(eq(members.id, seed.memberId));
			expect(m?.status).toBe("active");
		});

		it("the pre-#759 cross-club shape: a convert that attached ANOTHER club's Person is undone, and a re-convert gives the guest a fresh Person", async () => {
			const otherClub = await makeClub();
			const strangersPerson = await makePerson({ name: uniq("Strangers") });
			await testDb.insert(members).values({
				clubId: otherClub,
				personId: strangersPerson,
				name: "Strangers",
			});
			// Before #759 the dedupe was global: this club's convert attached the
			// stranger's Person and gave it a membership HERE. The backfill then
			// pointed the guest at it.
			const name = uniq("Pre759 Guest");
			const [mx] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: strangersPerson, name })
				.returning({ id: members.id });
			if (!mx) throw new Error("fixture");
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name,
				stage: "joined",
				convertedMembershipId: mx.id,
				personId: strangersPerson,
			});
			await plantConversionRecord({
				guestId,
				membershipId: mx.id,
				personId: strangersPerson,
				createdMembership: true,
				createdPerson: false,
			});

			const undone = await undo(guestId);
			expect(undone.membershipDeleted).toBe(true);
			// This club's membership is gone; the guest still names the stranger's
			// Person, which holds the OTHER club's.
			expect((await guestRow(guestId)).personId).toBe(strangersPerson);

			const res = await convert(guestId);

			expect(res.personId).not.toBe(strangersPerson);
			guestPersons.push(res.personId);
			expect((await personRow(res.personId))?.name).toBe(name);
			const held = await testDb
				.select({ clubId: members.clubId })
				.from(members)
				.where(eq(members.personId, strangersPerson));
			// The stranger's Person was not attached to this club again.
			expect(held.map((h) => h.clubId)).toEqual([otherClub]);
		});

		it("an undo that deletes the membership of a guest-only Person leaves the guest on it", async () => {
			const { guestId, personId } = await newGuest(uniq("Stays Put"));
			await convert(guestId);

			await undo(guestId);

			// The Person holds no membership once it is undone, so there is nothing to
			// separate from: no Person is minted.
			expect((await guestRow(guestId)).personId).toBe(personId);
		});

		it("a link leaves the guest's old Person alone while something else still references it", async () => {
			const otherClub = await makeClub();
			const { guestId, personId: guestsOwn } = await newGuest(uniq("Shared"));
			await createGuestRecord(testDb, {
				clubId: otherClub,
				name: uniq("Shared Elsewhere"),
				personId: guestsOwn,
			});

			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			});

			expect((await guestRow(guestId)).personId).toBe(seed.personId);
			// Another club's guest row still names it: kept.
			expect(await personRow(guestsOwn)).toBeDefined();
		});

		it("linking a guest that already names the member's Person (the backfill's shape) deletes nothing", async () => {
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Already Theirs"),
				personId: seed.personId,
			});

			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			});

			expect((await guestRow(guestId)).personId).toBe(seed.personId);
			expect(await personRow(seed.personId)).toBeDefined();
		});

		it("collapsing two memberships carries a converted guest's person_id to the keeper's Person (L5)", async () => {
			const keeperPerson = await makePerson({ name: uniq("Collapse Keeper") });
			const absorbedPerson = await makePerson({ name: uniq("Collapse Gone") });
			const [keeper] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: keeperPerson,
					name: "Collapse Keeper",
				})
				.returning({ id: members.id });
			const [absorbed] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: absorbedPerson,
					name: "Collapse Gone",
				})
				.returning({ id: members.id });
			if (!keeper || !absorbed) throw new Error("fixture");
			// One converted guest that IS the absorbed member's Person, and one that
			// names some other Person (one convert deduped past).
			const { id: consistent } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Consistent"),
				stage: "joined",
				convertedMembershipId: absorbed.id,
				personId: absorbedPerson,
			});
			const { id: residual, created } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Residual"),
				stage: "joined",
				convertedMembershipId: absorbed.id,
			});
			expect(created).toBe(true);
			const residualPerson = (await guestRow(residual)).personId as string;
			guestPersons.push(residualPerson);

			await testDb.transaction((tx) =>
				collapseMemberships(tx, seed.clubId, keeper.id, absorbed.id),
			);

			const c = await guestRow(consistent);
			expect(c.convertedMembershipId).toBe(keeper.id);
			expect(c.personId).toBe(keeperPerson);
			const r = await guestRow(residual);
			expect(r.convertedMembershipId).toBe(keeper.id);
			// Its own Person is its own: not swapped for the keeper's.
			expect(r.personId).toBe(residualPerson);
		});
	});

	// -----------------------------------------------------------------------
	// Option A (the maintainer, 2026-10-09): convert adopts the guest's Person
	// only if it is PRISTINE; any other gets a fresh Person and is left alone.
	// -----------------------------------------------------------------------
	describe("convert adopts only a PRISTINE guest Person (option A)", () => {
		/** What a Person row holds that a convert must not change. */
		const snapshot = async (personId: string) => {
			const p = await personRow(personId);
			return {
				name: p?.name,
				preferredName: p?.preferredName,
				email: p?.email,
				phone: p?.phone,
				userId: p?.userId,
			};
		};

		/**
		 * The safe outcome for a Person that is not pristine: the guest ends up on a
		 * FRESH Person carrying the guest row's values, the membership is on it, and
		 * the old Person is untouched and still there.
		 */
		async function expectFreshPerson(
			guestId: string,
			oldPersonId: string,
			before: Awaited<ReturnType<typeof snapshot>>,
			res: Awaited<ReturnType<typeof convert>>,
			// Whether the old Person is still there: it is when something references it
			// or a removal names it, and is deleted when NOTHING does (a Person nobody
			// can see, with whatever contact it carries).
			oldSurvives = true,
		) {
			expect(res.personId).not.toBe(oldPersonId);
			guestPersons.push(res.personId);
			expect((await guestRow(guestId)).personId).toBe(res.personId);
			const [m] = await testDb
				.select({ personId: members.personId })
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(m?.personId).toBe(res.personId);
			if (oldSurvives) {
				expect(await snapshot(oldPersonId)).toEqual(before);
				expect(await personRow(oldPersonId)).toBeDefined();
			} else {
				expect(await personRow(oldPersonId)).toBeUndefined();
			}
			const guest = await guestRow(guestId);
			const fresh = await personRow(res.personId);
			expect(fresh?.name).toBe(guest.name.trim());
			expect(fresh?.email).toBe(guest.email?.trim() || null);
			return fresh;
		}

		/**
		 * One condition at a time that makes a Person not pristine, with whether the
		 * old Person survives the convert: it does when something still references it
		 * (a sign-in, a membership, owned history, another guest row) or a removal
		 * names it, and is deleted when NOTHING does.
		 */
		const conditions: Array<
			[string, (personId: string, otherClub: string) => Promise<void>, boolean]
		> = [
			[
				"a sign-in (and nothing else)",
				async (p) => {
					await testDb
						.update(people)
						.set({ userId: await makeUser() })
						.where(eq(people.id, p));
				},
				true,
			],
			[
				"a membership in another club, of any status",
				async (p, club) => {
					await testDb.insert(members).values({
						clubId: club,
						personId: p,
						name: "Lapsed",
						status: "inactive",
					});
				},
				true,
			],
			[
				"a speech",
				async (p) => {
					await testDb
						.insert(speeches)
						.values({ personId: p, title: uniq("Owned") });
				},
				true,
			],
			[
				"a Pathways enrolment",
				async (p) => {
					const [path] = await testDb
						.insert(pathwaysPaths)
						.values({ courseCode: `optA-${randomUUID()}`, name: "Path" })
						.returning({ id: pathwaysPaths.id });
					if (!path) throw new Error("fixture");
					extraPaths.push(path.id);
					await testDb
						.insert(pathEnrollments)
						.values({ personId: p, pathId: path.id });
				},
				true,
			],
			[
				"a charter-helper row",
				async (p, club) => {
					await testDb.insert(clubCharterHelpers).values({
						clubId: club,
						role: "sponsor",
						personId: p,
						name: "Helper",
					});
				},
				true,
			],
			[
				"another guest row, in another club",
				async (p, club) => {
					await createGuestRecord(testDb, {
						clubId: club,
						name: uniq("Same Human Elsewhere"),
						personId: p,
					});
				},
				true,
			],
			[
				"a member_remove on record",
				async (p, club) => {
					await testDb.insert(activityLog).values({
						clubId: club,
						action: "member_remove",
						targetType: "member",
						targetId: randomUUID(),
						detail: { name: "Removed", personId: p },
					});
				},
				true,
			],
			[
				"an email",
				async (p) => {
					await testDb
						.update(people)
						.set({ email: `had-${randomUUID()}@example.test` })
						.where(eq(people.id, p));
				},
				false,
			],
			[
				"a phone",
				async (p) => {
					await testDb
						.update(people)
						.set({ phone: "+15550004444" })
						.where(eq(people.id, p));
				},
				false,
			],
			[
				"a Toastmasters customer id",
				async (p) => {
					await testDb
						.update(people)
						.set({ customerId: `PN-${randomUUID()}` })
						.where(eq(people.id, p));
				},
				false,
			],
			[
				"a Base Camp user id",
				async (p) => {
					await testDb
						.update(people)
						.set({ basecampUserId: `bc-${randomUUID()}` })
						.where(eq(people.id, p));
				},
				false,
			],
			[
				"an original join date",
				async (p) => {
					await testDb
						.update(people)
						.set({ originalJoinDate: new Date("2015-03-01") })
						.where(eq(people.id, p));
				},
				false,
			],
			[
				"an account invite on record",
				async (p) => {
					await testDb
						.update(people)
						.set({ invitedAt: new Date("2025-01-01") })
						.where(eq(people.id, p));
				},
				false,
			],
		];

		for (const [what, give, survives] of conditions) {
			it(`a guest Person with ${what} is not adopted: the guest gets a fresh Person, and the old one ${survives ? "is left alone" : "is deleted, nothing referencing it"}`, async () => {
				const otherClub = await makeClub();
				const email = `fresh-${randomUUID()}@example.test`;
				const { guestId, personId } = await newGuest(uniq("Not Pristine"), {
					email,
					phone: uniquePhone(),
				});
				await give(personId, otherClub);
				const before = await snapshot(personId);

				const res = await convert(guestId);

				const fresh = await expectFreshPerson(
					guestId,
					personId,
					before,
					res,
					survives,
				);
				// The fresh Person carries what the guest row says, not the old one's.
				expect(fresh?.email).toBe(email);
				expect(fresh?.userId).toBeNull();
				// A convert that minted it says so, for the undo's record.
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
					createdPerson: true,
					personId: res.personId,
				});
			});
		}

		it("S1: a stranded former member comes back; the officer's correction survives on the OLD Person and the typo owner cannot bind its history", async () => {
			const typo = `alice-${randomUUID()}@gmial.example`;
			const real = `alice-${randomUUID()}@gmail.example`;
			const name = uniq("Alice Stranded");
			const { guestId, personId } = await newGuest(name, { email: typo });
			const c1 = await convert(guestId);
			expect(c1.personId).toBe(personId);
			// The officer corrects the MEMBER's address on the member page.
			await applyMemberEdit({
				clubId: seed.clubId,
				memberId: c1.membershipId,
				name,
				email: real,
				actorMemberId: seed.adminMemberId,
			});
			expect((await personRow(personId))?.email).toBe(real);
			// She lapses and is removed; the guest card is stranded, then revived.
			await applyMemberRemove({
				clubId: seed.clubId,
				memberId: c1.membershipId,
				actorMemberId: seed.adminMemberId,
			});
			await applySetGuestStage({
				clubId: seed.clubId,
				guestId,
				stage: "following_up",
			});
			const before = await snapshot(personId);

			const c2 = await convert(guestId);

			// The new member Person has the guest row's values; the old one keeps the
			// corrected address and is not re-keyed.
			const fresh = await expectFreshPerson(guestId, personId, before, c2);
			expect(fresh?.email).toBe(typo);
			expect((await personRow(personId))?.email).toBe(real);
			// Nobody can bind the OLD Person's history: it holds no membership, so no
			// club vouches for it, whichever address they own.
			const typoOwner = await makeUser(typo);
			expect(await bindVerifiedPerson({ personId, userId: typoOwner })).toBe(
				false,
			);
			const realOwner = await makeUser(real);
			expect(await bindVerifiedPerson({ personId, userId: realOwner })).toBe(
				false,
			);
		});

		it("S3: a guest linked to the WRONG member, who is then removed, converts onto a fresh Person; the member's Person keeps its name, contact and speech", async () => {
			const aliceEmail = `alice3-${randomUUID()}@example.test`;
			const aliceName = uniq("Alice Member");
			const alice = await makePerson({ name: aliceName, email: aliceEmail });
			const [m] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: alice, name: aliceName })
				.returning({ id: members.id });
			if (!m) throw new Error("fixture");
			await testDb
				.insert(speeches)
				.values({ personId: alice, title: uniq("Alice's Icebreaker") });
			const bobEmail = `bob3-${randomUUID()}@example.test`;
			const bobName = uniq("Bob Visitor");
			const { guestId } = await newGuest(bobName, { email: bobEmail });
			// The officer links Bob's card to the wrong member; Alice is removed.
			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: m.id,
				actorMemberId: seed.adminMemberId,
			});
			expect((await guestRow(guestId)).personId).toBe(alice);
			await applyMemberRemove({
				clubId: seed.clubId,
				memberId: m.id,
				actorMemberId: seed.adminMemberId,
			});
			await applySetGuestStage({
				clubId: seed.clubId,
				guestId,
				stage: "following_up",
			});
			const before = await snapshot(alice);

			const c = await convert(guestId);

			const fresh = await expectFreshPerson(guestId, alice, before, c);
			expect(fresh?.name).toBe(bobName);
			expect(fresh?.email).toBe(bobEmail);
			// Alice's Person is exactly as it was, and so is her history.
			expect((await personRow(alice))?.name).toBe(aliceName);
			expect((await personRow(alice))?.email).toBe(aliceEmail);
			const sp = await testDb
				.select({ id: speeches.id })
				.from(speeches)
				.where(eq(speeches.personId, alice));
			expect(sp).toHaveLength(1);
		});

		it("S4: guest-book input never reaches a former member's Person", async () => {
			const real = `carol-${randomUUID()}@real.example`;
			const attacker = `mallory-${randomUUID()}@evil.example`;
			const phone = uniquePhone();
			const name = uniq("Carol Phoneonly");
			// Captured on the public book with a phone and no address.
			const cap1 = await captureGuestVisit({
				clubId: seed.clubId,
				name,
				phone,
			});
			const personId = (await guestRow(cap1.guestId)).personId as string;
			guestPersons.push(personId);
			const c1 = await convert(cap1.guestId);
			// As a member the officer records her real address; then she is removed.
			await applyMemberEdit({
				clubId: seed.clubId,
				memberId: c1.membershipId,
				name,
				email: real,
				actorMemberId: seed.adminMemberId,
			});
			await applyMemberRemove({
				clubId: seed.clubId,
				memberId: c1.membershipId,
				actorMemberId: seed.adminMemberId,
			});
			// Anonymous: someone signs the public book with her name and phone and
			// their OWN address, which fills the stranded card's blank email.
			const cap2 = await captureGuestVisit({
				clubId: seed.clubId,
				name,
				phone,
				email: attacker,
			});
			expect(cap2.guestId).toBe(cap1.guestId);
			expect((await guestRow(cap1.guestId)).email).toBe(attacker);
			await applySetGuestStage({
				clubId: seed.clubId,
				guestId: cap1.guestId,
				stage: "following_up",
			});
			const before = await snapshot(personId);

			const c2 = await convert(cap1.guestId);

			// The fresh Person carries the guest row, which now holds the guest-book
			// address: that outcome is what `main` does for any guest, and it is the NEW
			// member's, not Carol's. What this test pins is the OLD Person's safety.
			await expectFreshPerson(cap1.guestId, personId, before, c2);
			// Her Person still has HER address, and the guest-book one is nowhere on it.
			expect((await personRow(personId))?.email).toBe(real);
			const mallory = await makeUser(attacker);
			expect(await bindVerifiedPerson({ personId, userId: mallory })).toBe(
				false,
			);
		});

		it("S5: a correction made on the member page is not reverted on the old Person by an undo and a re-convert", async () => {
			const typo = `dave-${randomUUID()}@gmial.example`;
			const real = `dave-${randomUUID()}@gmail.example`;
			const name = uniq("Dave Undo");
			const { guestId, personId } = await newGuest(name, { email: typo });
			const c1 = await convert(guestId);
			await applyMemberEdit({
				clubId: seed.clubId,
				memberId: c1.membershipId,
				name,
				preferredName: "Davey",
				email: real,
				actorMemberId: seed.adminMemberId,
			});
			await undo(guestId);
			const before = await snapshot(personId);
			expect(before.email).toBe(real);
			expect(before.preferredName).toBe("Davey");

			const c2 = await convert(guestId);

			const fresh = await expectFreshPerson(guestId, personId, before, c2);
			// The new Person carries the guest row (the typo; nobody fixed the card).
			expect(fresh?.email).toBe(typo);
			// The member-page correction is still on the old Person.
			expect((await personRow(personId))?.email).toBe(real);
			expect((await personRow(personId))?.preferredName).toBe("Davey");
		});

		it("a guest-only Person two clubs share (merged) is not adopted by either club's convert", async () => {
			const clubB = await makeClub();
			const a = await newGuest(uniq("Shared Human"));
			const b = await newGuest(uniq("Shared Human B"), {}, clubB);
			// A superadmin decides they are one human: both guest rows now name PA.
			await mergePeople({
				keeperPersonId: a.personId,
				absorbedPersonId: b.personId,
			});
			expect((await guestRow(b.guestId)).personId).toBe(a.personId);
			const before = await snapshot(a.personId);

			const res = await convert(a.guestId);

			await expectFreshPerson(a.guestId, a.personId, before, res);
			// The other club's guest still names the shared Person.
			expect((await guestRow(b.guestId)).personId).toBe(a.personId);
		});
	});

	// -----------------------------------------------------------------------
	// L1: undo reads the Person the membership names NOW.
	// -----------------------------------------------------------------------
	describe("undo after a merge (L1)", () => {
		it("refuses to delete the membership of a signed-in Person the guest's Person was merged into", async () => {
			const { guestId, personId } = await newGuest(uniq("Merged Away"));
			const res = await convert(guestId);
			expect(res.personId).toBe(personId);
			// A superadmin merges the guest's Person into somebody who has an account.
			const keeper = await makePerson({
				name: uniq("Has Account"),
				userId: await makeUser(),
			});
			await mergePeople({ keeperPersonId: keeper, absorbedPersonId: personId });
			// The record still names the Person the merge deleted.
			expect(await personRow(personId)).toBeUndefined();

			await expect(undo(guestId)).rejects.toThrow(
				UNDO_MEMBER_HAS_ACCOUNT_MESSAGE,
			);

			// Nothing was deleted: the signed-in member still has their membership.
			const [m] = await testDb
				.select({ personId: members.personId })
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(m?.personId).toBe(keeper);
		});

		it("undoes against the keeper when it is unbound, and names the keeper in the removal record", async () => {
			const { guestId, personId } = await newGuest(uniq("Merged Quietly"));
			const res = await convert(guestId);
			const keeper = await makePerson({ name: uniq("Plain Keeper") });
			await mergePeople({ keeperPersonId: keeper, absorbedPersonId: personId });

			const undone = await undo(guestId);

			expect(undone.membershipDeleted).toBe(true);
			const [log] = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_remove"),
						eq(activityLog.targetId, res.membershipId),
					),
				);
			// The Person the importer reads off the release is one that still exists.
			expect((log?.detail as { personId?: string })?.personId).toBe(keeper);
			expect(await personRow(keeper)).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// M1: convert carries an officer's edits to the name.
	// -----------------------------------------------------------------------
	describe("convert carries the officer's name and goes-by edits onto the Person (M1)", () => {
		it("a guest renamed and with its goes-by name CLEARED after capture: the Person follows", async () => {
			const original = uniq("Robbert Smiht");
			// What the guest book and the confirm flow do: a guest and its Person, the
			// goes-by name on both.
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: original,
				preferredName: "Bobby",
			});
			const personId = (await guestRow(guestId)).personId as string;
			guestPersons.push(personId);
			expect((await personRow(personId))?.preferredName).toBe("Bobby");

			const corrected = uniq("Roberta Smithe");
			await applyUpdateGuest({ clubId: seed.clubId, guestId, name: corrected });
			const res = await convert(guestId);

			expect(res.personId).toBe(personId);
			const p = await personRow(personId);
			expect(p?.name).toBe(corrected);
			// Cleared, not resurrected: the membership says nothing and the Person
			// is its fallback, so a stale "Bobby" here would greet them as Bobby.
			expect(p?.preferredName).toBeNull();
			const [m] = await testDb
				.select({ name: members.name, preferredName: members.preferredName })
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(m).toEqual({ name: corrected, preferredName: null });
		});

		it("a goes-by name an officer SETS after capture reaches the Person too", async () => {
			const name = uniq("Robert Smith");
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name,
			});
			const personId = (await guestRow(guestId)).personId as string;
			guestPersons.push(personId);
			expect((await personRow(personId))?.preferredName).toBeNull();

			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name,
				preferredName: "Bob",
			});
			await convert(guestId);

			expect((await personRow(personId))?.preferredName).toBe("Bob");
		});
	});

	// -----------------------------------------------------------------------
	// M2: deleting a guest deletes its Person, when nothing else names it.
	// -----------------------------------------------------------------------
	describe("deleting a guest takes its Person with it (M2)", () => {
		const del = (guestId: string) =>
			applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

		it("deletes the Person of a mistaken guest", async () => {
			const { guestId, personId } = await newGuest(uniq("Spam Visitor"));

			await del(guestId);

			expect(
				await testDb.select().from(guests).where(eq(guests.id, guestId)),
			).toHaveLength(0);
			expect(await personRow(personId)).toBeUndefined();
		});

		it("keeps a Person another club's guest row still names", async () => {
			const otherClub = await makeClub();
			const { guestId, personId } = await newGuest(uniq("Seen Elsewhere"));
			await createGuestRecord(testDb, {
				clubId: otherClub,
				name: uniq("Seen Elsewhere"),
				personId,
			});

			await del(guestId);

			expect(await personRow(personId)).toBeDefined();
		});

		it("keeps a Person somebody has signed in as", async () => {
			const { guestId, personId } = await newGuest(uniq("Has Login"));
			await testDb
				.update(people)
				.set({ userId: await makeUser() })
				.where(eq(people.id, personId));

			await del(guestId);

			expect(await personRow(personId)).toBeDefined();
		});

		it("keeps a Person a club holds as a member", async () => {
			const { guestId, personId } = await newGuest(uniq("Is A Member"));
			const otherClub = await makeClub();
			await testDb.insert(members).values({
				clubId: otherClub,
				personId,
				name: "Is A Member",
			});

			await del(guestId);

			expect(await personRow(personId)).toBeDefined();
		});

		it("keeps a Person that owns a speech, whose delete would cascade it away", async () => {
			const { guestId, personId } = await newGuest(uniq("Has A Speech"));
			await testDb
				.insert(speeches)
				.values({ personId, title: uniq("Ice Breaker") });

			await del(guestId);

			expect(await personRow(personId)).toBeDefined();
		});

		it("keeps a Person with a Pathways enrolment", async () => {
			const { guestId, personId } = await newGuest(uniq("Enrolled"));
			const [path] = await testDb
				.insert(pathwaysPaths)
				.values({ courseCode: `1124-${randomUUID()}`, name: "Path" })
				.returning({ id: pathwaysPaths.id });
			if (!path) throw new Error("fixture");
			extraPaths.push(path.id);
			await testDb
				.insert(pathEnrollments)
				.values({ personId, pathId: path.id });

			await del(guestId);

			expect(await personRow(personId)).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// M3: a club delete never takes a signed-in Person.
	// -----------------------------------------------------------------------
	describe("deleting a club keeps a signed-in guest-only Person and its account (M3)", () => {
		it("a Person with an account held only by a guest row of the deleted club survives, and its account is not queued", async () => {
			const archivedName = uniq("Doomed Signed In");
			const doomed = await makeClub(archivedName, true);
			const signedIn = await newGuest(uniq("Signed In Guest"), {}, doomed);
			const plain = await newGuest(uniq("Plain Guest"), {}, doomed);
			const accountId = await makeUser();
			await testDb
				.update(people)
				.set({ userId: accountId })
				.where(eq(people.id, signedIn.personId));

			const res = await deleteClubPermanently(doomed, archivedName);

			expect(await personRow(signedIn.personId)).toBeDefined();
			expect(await personRow(plain.personId)).toBeUndefined();
			// The account was not queued for deletion with the Person: it is intact.
			const accounts = await testDb
				.select({ id: user.id })
				.from(user)
				.where(eq(user.id, accountId));
			expect(accounts).toHaveLength(1);
			expect(res.usersDeleted).toBe(0);
			expect(res.peopleDeleted).toBe(1);
			expect(res.peopleKept).toBe(1);
		});
	});

	// -----------------------------------------------------------------------
	// L3: convert locks the matched member's Person together with the guest's.
	// -----------------------------------------------------------------------
	describe("the dedupe-hit path locks both Persons up front (L3)", () => {
		it("parks on the matched Person's lock BEFORE it takes the guest row", async () => {
			const email = `hit-${randomUUID()}@example.test`;
			const matched = await makePerson({ name: uniq("Matched Member"), email });
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId: matched,
				name: uniq("Matched Member Row"),
			});
			const { guestId } = await newGuest(uniq("Hits A Member"), { email });

			// A writer that holds the matched Person (the roster edit's lock) ...
			const holder = await openBlockingTx(async (tx) => {
				await tx
					.select({ id: people.id })
					.from(people)
					.where(eq(people.id, matched))
					.for("update");
			});
			const racing = convert(guestId).then(
				(r) => r,
				(e: Error) => e,
			);
			await waitForLockWait("people", holder.pid);

			// ... and the convert, parked behind it, must not yet hold the guest row.
			// Taking the Persons one at a time as it reaches them would park it here
			// with the guest row held, the first half of a deadlock with a convert
			// that took the same two Persons the other way round.
			await testDb.transaction(async (tx) => {
				const free = await tx
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.id, guestId))
					.for("update", { noWait: true });
				expect(free).toHaveLength(1);
			});

			await holder.commit();
			const res = await racing;
			expect(res).not.toBeInstanceOf(Error);
			expect((res as { personId: string }).personId).toBe(matched);
		});
	});

	// -----------------------------------------------------------------------
	// L4: a merge of guest rows is visible.
	// -----------------------------------------------------------------------
	describe("a merge of guest-only Persons is visible (L4)", () => {
		it("counts the moved guest rows, audits the club they were in, and the preview says so", async () => {
			const clubB = await makeClub();
			const keeper = await newGuest(uniq("Audit Keeper"));
			const absorbed = await newGuest(uniq("Audit Absorbed"), {}, clubB);

			const preview = await getMergePreview(keeper.personId, absorbed.personId);
			expect(preview.movedCounts.guests).toBe(1);

			const res = await mergePeople({
				keeperPersonId: keeper.personId,
				absorbedPersonId: absorbed.personId,
			});

			expect(res.movedCounts.guests).toBe(1);
			expect(res.movedCounts.memberships).toBe(0);
			// One audit row, in the club whose guest record moved.
			const audit = await testDb
				.select({ clubId: activityLog.clubId, detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.action, "member_merge"),
						eq(activityLog.targetId, keeper.personId),
					),
				);
			expect(audit.map((a) => a.clubId)).toEqual([clubB]);
			expect(
				(audit[0]?.detail as { movedCounts: { guests: number } }).movedCounts
					.guests,
			).toBe(1);
		});
	});

	// -----------------------------------------------------------------------
	// Every new read-then-lock refusal, driven by a writer that moves the row.
	// -----------------------------------------------------------------------
	describe("the read-then-lock refusals (ADR-0031)", () => {
		/**
		 * Run `op` while another transaction holds the guest row and, on commit,
		 * changes what the row or its membership names. `op` read the old values
		 * unlocked, parks on the row lock, and must refuse on the re-read.
		 */
		async function raced(
			guestId: string,
			move: (tx: TestTx) => Promise<void>,
			op: () => Promise<unknown>,
		) {
			const blocker = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from guests where id = ${guestId} for update`,
				);
				await move(tx);
			});
			const racing = op().then(
				() => null,
				(e: Error) => e,
			);
			await waitForLockWait("guests", blocker.pid);
			await blocker.commit();
			return racing;
		}

		const movePerson =
			(guestId: string, personId: string) => async (tx: TestTx) => {
				await tx.update(guests).set({ personId }).where(eq(guests.id, guestId));
			};

		it("undo refuses when the guest's Person moved", async () => {
			const { guestId } = await newGuest(uniq("Undo Race"));
			await convert(guestId);
			const other = await makePerson();
			const err = await raced(guestId, movePerson(guestId, other), () =>
				undo(guestId),
			);
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			// Nothing was undone.
			expect((await guestRow(guestId)).stage).toBe("joined");
		});

		it("undo refuses when the membership's Person moved", async () => {
			const { guestId } = await newGuest(uniq("Undo Member Race"));
			const res = await convert(guestId);
			const other = await makePerson();
			const err = await raced(
				guestId,
				async (tx) => {
					await tx
						.update(members)
						.set({ personId: other })
						.where(eq(members.id, res.membershipId));
				},
				() => undo(guestId),
			);
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			expect((await guestRow(guestId)).stage).toBe("joined");
		});

		it("link refuses when the guest's Person moved", async () => {
			const { guestId } = await newGuest(uniq("Link Race"));
			const other = await makePerson();
			const err = await raced(guestId, movePerson(guestId, other), () =>
				applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId,
					memberId: seed.memberId,
					actorMemberId: seed.adminMemberId,
				}),
			);
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			expect((await guestRow(guestId)).convertedMembershipId).toBeNull();
		});

		it("link refuses when the member's Person moved", async () => {
			const { guestId } = await newGuest(uniq("Link Member Race"));
			const other = await makePerson();
			const err = await raced(
				guestId,
				async (tx) => {
					await tx
						.update(members)
						.set({ personId: other })
						.where(eq(members.id, seed.memberId));
				},
				() =>
					applyLinkGuestToMember({
						clubId: seed.clubId,
						guestId,
						memberId: seed.memberId,
						actorMemberId: seed.adminMemberId,
					}),
			);
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			expect((await guestRow(guestId)).convertedMembershipId).toBeNull();
		});

		it("unlink refuses when the guest's Person moved", async () => {
			const { guestId } = await newGuest(uniq("Unlink Race"));
			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			});
			const other = await makePerson();
			const err = await raced(guestId, movePerson(guestId, other), () =>
				applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			);
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			expect((await guestRow(guestId)).convertedMembershipId).toBe(
				seed.memberId,
			);
		});

		it("delete refuses when the guest's Person moved", async () => {
			const { guestId } = await newGuest(uniq("Delete Race"));
			const other = await makePerson();
			const err = await raced(guestId, movePerson(guestId, other), () =>
				applyDeleteGuest({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			);
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			// Still there, and so are both Persons.
			expect((await guestRow(guestId)).personId).toBe(other);
		});

		it("convert refuses when the member it would match changed between the reads", async () => {
			const email = `match-${randomUUID()}@example.test`;
			const { guestId } = await newGuest(uniq("Match Race"), { email });
			const matched = await makePerson({ name: uniq("Late Member"), email });
			// The matching member appears while the convert waits on the guest row.
			const err = await raced(
				guestId,
				async (tx) => {
					await tx.insert(members).values({
						clubId: seed.clubId,
						personId: matched,
						name: uniq("Late Member Row"),
					});
				},
				() => convert(guestId),
			);
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			expect((await guestRow(guestId)).stage).not.toBe("joined");
		});
	});

	// =======================================================================
	// Round 3 of the review of #1155.
	// =======================================================================

	/** A second, raw connection: a writer that takes no club write lock. */
	async function rawClient() {
		const c = new pg.Client({
			connectionString: process.env.TEST_DATABASE_URL,
		});
		await c.connect();
		const res = await c.query("select pg_backend_pid() as pid");
		return { c, pid: Number(res.rows[0].pid) };
	}
	const sqlState = (e: unknown) =>
		(e as { code?: string }).code ?? (e as Error).message;

	// -----------------------------------------------------------------------
	// M1 and M2: lock cycles with writers that take no club write lock.
	// -----------------------------------------------------------------------
	describe("lock cycles with writers that take no club lock (M1, M2)", () => {
		it("a membership merge locks the keeper's Person before its membership, so a roster edit cannot deadlock it (M1)", async () => {
			const keeperPerson = await makePerson({ name: uniq("Edit Keeper") });
			const absorbedPerson = await makePerson({ name: uniq("Edit Absorbed") });
			const [mk] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: keeperPerson, name: "EK" })
				.returning({ id: members.id });
			const [mx] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: absorbedPerson, name: "EA" })
				.returning({ id: members.id });
			if (!mk || !mx) throw new Error("fixture");
			// A converted guest that IS the absorbed member's Person: the collapse
			// re-points it, which key-shares the keeper's Person.
			await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Collapse Guest"),
				stage: "joined",
				convertedMembershipId: mx.id,
				personId: absorbedPerson,
			});

			// `applyMemberEdit`: the Person `FOR UPDATE`, then the membership.
			const { c, pid } = await rawClient();
			await c.query("begin");
			await c.query("select id from people where id = $1 for update", [
				keeperPerson,
			]);
			const merging = applyMemberMerge({
				clubId: seed.clubId,
				keeperId: mk.id,
				absorbedId: mx.id,
				actorMemberId: seed.adminMemberId,
			}).then(
				() => "ok",
				(e: unknown) => sqlState(e),
			);
			// The merge is parked behind the edit. Before the fix it was parked on its
			// guest re-point, having already written the keeper's membership row.
			await waitForLockWait("", pid);
			const edit = await c
				.query("update members set name = name where id = $1", [mk.id])
				.then(
					() => "ok",
					(e: unknown) => sqlState(e),
				);
			await c.query(edit === "ok" ? "commit" : "rollback");
			await c.end();

			expect(edit).toBe("ok");
			expect(await merging).toBe("ok");
		});

		it("undo does not deadlock with a speaker claim that holds the slot and then key-shares the Person (M2)", async () => {
			const { guestId } = await newGuest(uniq("Undo Claim"));
			const res = await convert(guestId);

			// `claimSlotCore`: the slot UPDATE (a key share on the membership), then the
			// speech INSERT (a key share on the Person). No club write lock.
			const { c, pid } = await rawClient();
			await c.query("begin");
			await c.query(
				`update role_slots set assigned_member_id = $1, assigned_guest_id = null,
				        status = 'claimed', claimed_at = now() where id = $2`,
				[res.membershipId, seed.slotId],
			);
			const undoing = undo(guestId).then(
				() => "ok",
				(e: unknown) => sqlState(e),
			);
			await waitForLockWait("", pid);
			const claim = await c
				.query(
					"insert into speeches (person_id, title) values ($1, 'claimed speech') returning id",
					[res.personId],
				)
				.then(
					() => "ok",
					(e: unknown) => sqlState(e),
				);
			await c.query("rollback");
			await c.end();

			expect(claim).toBe("ok");
			expect(await undoing).toBe("ok");
		});

		/**
		 * Run `op` while a writer holds a key share on each Person, the lock a
		 * foreign-key INSERT takes. Resolves with whether `op` finished while it was
		 * held, or parked behind it; the holder is released either way.
		 */
		async function whileKeySharesHeld(
			personIds: string[],
			op: () => Promise<unknown>,
		) {
			const holder = await openBlockingTx(async (tx) => {
				for (const id of personIds) {
					await tx.execute(
						sql`select id from people where id = ${id} for key share`,
					);
				}
			});
			const running = op().then(
				(r) => ({ ok: r }),
				(e: unknown) => ({ err: e }),
			);
			const raced = await Promise.race([
				running.then(() => "finished" as const),
				new Promise<"parked">((r) => setTimeout(() => r("parked"), 2500)),
			]);
			await holder.commit();
			const result = await running;
			return { raced, result };
		}

		it("undo takes the Person's lock without blocking a key share", async () => {
			const { guestId } = await newGuest(uniq("Mode Undo"));
			await convert(guestId);
			const g = await guestRow(guestId);
			const { raced, result } = await whileKeySharesHeld(
				[g.personId as string],
				() => undo(guestId),
			);
			expect(raced).toBe("finished");
			expect("err" in result).toBe(false);
		});

		it("unlink takes the Persons' locks without blocking a key share", async () => {
			const { guestId } = await newGuest(uniq("Mode Unlink"));
			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			});
			const { raced, result } = await whileKeySharesHeld([seed.personId], () =>
				applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			);
			expect(raced).toBe("finished");
			expect("err" in result).toBe(false);
		});

		it("convert's dedupe-hit path takes both Persons' locks without blocking a key share", async () => {
			const email = `mode-${randomUUID()}@example.test`;
			const matched = await makePerson({ name: uniq("Mode Matched"), email });
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId: matched,
				name: uniq("Mode Matched Row"),
			});
			const { guestId, personId } = await newGuest(uniq("Mode Hit"), {
				email,
			});
			const { raced, result } = await whileKeySharesHeld(
				[matched, personId],
				() => convert(guestId),
			);
			expect(raced).toBe("finished");
			expect("err" in result).toBe(false);
		});

		it("a membership collapse takes the Persons' locks without blocking a key share", async () => {
			const pk = await makePerson({ name: uniq("Mode Keeper") });
			const px = await makePerson({ name: uniq("Mode Absorbed") });
			const [mk] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: pk, name: "MK" })
				.returning({ id: members.id });
			const [mx] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: px, name: "MX" })
				.returning({ id: members.id });
			if (!mk || !mx) throw new Error("fixture");
			const { raced, result } = await whileKeySharesHeld([pk, px], () =>
				testDb.transaction((tx) =>
					collapseMemberships(tx, seed.clubId, mk.id, mx.id),
				),
			);
			expect(raced).toBe("finished");
			expect("err" in result).toBe(false);
		});

		it("a membership collapse refuses when a membership's Person moved between its reads", async () => {
			const pk = await makePerson({ name: uniq("Move Keeper") });
			const px = await makePerson({ name: uniq("Move Absorbed") });
			const other = await makePerson({ name: uniq("Move Other") });
			const [mk] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: pk, name: "MvK" })
				.returning({ id: members.id });
			const [mx] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: px, name: "MvX" })
				.returning({ id: members.id });
			if (!mk || !mx) throw new Error("fixture");
			// A writer holds the keeper's Person and moves its membership to another
			// Person; the collapse read the old one, parks on the Person lock, and
			// must refuse when it re-reads.
			const holder = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from people where id = ${pk} for update`,
				);
				await tx
					.update(members)
					.set({ personId: other })
					.where(eq(members.id, mk.id));
			});
			const collapsing = testDb
				.transaction((tx) => collapseMemberships(tx, seed.clubId, mk.id, mx.id))
				.then(
					() => null,
					(e: Error) => e,
				);
			await waitForLockWait("people", holder.pid);
			await holder.commit();

			const err = await collapsing;
			expect(err?.message).toBe(RECORD_CHANGED_MESSAGE);
			// Nothing was collapsed.
			const still = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.id, mx.id));
			expect(still).toHaveLength(1);
		});

		it("a link of a guest that names a MEMBER's Person takes that Person's lock without blocking a key share", async () => {
			const otherMember = await makePerson({ name: uniq("Guest Names Me") });
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId: otherMember,
				name: uniq("Guest Names Me Row"),
			});
			// The backfill's shape for a guest linked before the deploy: following_up,
			// naming a member's Person.
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Names A Member"),
				stage: "following_up",
				personId: otherMember,
			});
			const { raced, result } = await whileKeySharesHeld([otherMember], () =>
				applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId,
					memberId: seed.memberId,
					actorMemberId: seed.adminMemberId,
				}),
			);
			expect(raced).toBe("finished");
			expect("err" in result).toBe(false);
		});

		it("a guest delete and a link, which delete a Person, keep the strong lock: they park at the Person BEFORE taking the guest row", async () => {
			// `FOR UPDATE` is what keeps a reference from appearing between the check
			// and the delete, so these two park behind a key share at the lock itself.
			// A weaker lock would let them through to the guest row and park only at
			// the DELETE, which is the cycle with a claim that this round removed
			// from the paths that do not delete.
			async function parksAtThePersonLock(
				guestId: string,
				personId: string,
				op: () => Promise<unknown>,
			) {
				const holder = await openBlockingTx(async (tx) => {
					await tx.execute(
						sql`select id from people where id = ${personId} for key share`,
					);
				});
				const running = op().then(
					() => null,
					(e: Error) => e,
				);
				await waitForLockWait("people", holder.pid);
				await testDb.transaction(async (tx) => {
					const free = await tx
						.select({ id: guests.id })
						.from(guests)
						.where(eq(guests.id, guestId))
						.for("update", { noWait: true });
					expect(free).toHaveLength(1);
				});
				await holder.commit();
				expect(await running).toBeNull();
			}

			const a = await newGuest(uniq("Strong Delete"));
			await parksAtThePersonLock(a.guestId, a.personId, () =>
				applyDeleteGuest({
					clubId: seed.clubId,
					guestId: a.guestId,
					actorMemberId: seed.adminMemberId,
				}),
			);

			const b = await newGuest(uniq("Strong Link"));
			await parksAtThePersonLock(b.guestId, b.personId, () =>
				applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: b.guestId,
					memberId: seed.memberId,
					actorMemberId: seed.adminMemberId,
				}),
			);
		});
	});

	// -----------------------------------------------------------------------
	// M4 and the charter helper: what a club delete and a guest delete keep.
	// -----------------------------------------------------------------------
	describe("what a Person delete keeps (M4)", () => {
		/** A former member of another club: unbound, no membership, owns history. */
		async function formerMember(owns: {
			speech?: boolean;
			enrolment?: boolean;
		}) {
			const q = await makePerson({ name: uniq("Former Member") });
			if (owns.enrolment) {
				const [path] = await testDb
					.insert(pathwaysPaths)
					.values({ courseCode: `r3-${randomUUID()}`, name: "Path" })
					.returning({ id: pathwaysPaths.id });
				if (!path) throw new Error("fixture");
				extraPaths.push(path.id);
				await testDb
					.insert(pathEnrollments)
					.values({ personId: q, pathId: path.id });
			}
			if (owns.speech) {
				await testDb
					.insert(speeches)
					.values({ personId: q, title: uniq("Logged") });
			}
			return q;
		}

		for (const owns of [
			{ speech: true, enrolment: false },
			{ speech: false, enrolment: true },
		]) {
			const what = owns.speech ? "speech" : "Pathways enrolment";
			it(`club delete keeps a guest-only Person merged with a former member, and that Person's ${what}`, async () => {
				const archivedName = uniq("Doomed History");
				const doomed = await makeClub(archivedName, true);
				const q = await formerMember(owns);
				const g = await newGuest(uniq("Merged Guest"), {}, doomed);
				await mergePeople({ keeperPersonId: q, absorbedPersonId: g.personId });
				// The guest row now names Q, which is guest-only by the predicate.
				expect((await guestRow(g.guestId)).personId).toBe(q);

				const res = await deleteClubPermanently(doomed, archivedName);

				expect(await personRow(q)).toBeDefined();
				const kept = owns.speech
					? await testDb
							.select({ id: speeches.id })
							.from(speeches)
							.where(eq(speeches.personId, q))
					: await testDb
							.select({ id: pathEnrollments.id })
							.from(pathEnrollments)
							.where(eq(pathEnrollments.personId, q));
				expect(kept).toHaveLength(1);
				expect(res.peopleKept).toBe(1);
				expect(res.peopleDeleted).toBe(0);
			});
		}

		it("club delete keeps a guest-only Person a charter-helper row of another club names", async () => {
			const archivedName = uniq("Doomed Helper");
			const doomed = await makeClub(archivedName, true);
			const other = await makeClub();
			const g = await newGuest(uniq("Helper Guest"), {}, doomed);
			await testDb.insert(clubCharterHelpers).values({
				clubId: other,
				role: "sponsor",
				personId: g.personId,
				name: "Helper Name",
			});

			await deleteClubPermanently(doomed, archivedName);

			expect(await personRow(g.personId)).toBeDefined();
		});

		it("a guest delete keeps a Person a charter helper names, instead of breaking the helper's identity check", async () => {
			const { guestId, personId } = await newGuest(uniq("Helped Guest"));
			// A legacy or imported helper that names only the Person: nulling its
			// person_id on a delete would violate `club_charter_helpers_identity_check`.
			await testDb.insert(clubCharterHelpers).values({
				clubId: seed.clubId,
				role: "club_mentor",
				personId,
			});

			await applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(await personRow(personId)).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// The email backup goes with a Person a guest delete or a link deletes.
	// -----------------------------------------------------------------------
	describe("the address backup goes with the Person (as in a club delete)", () => {
		const backupRows = (personId: string) =>
			testDb
				.select({ id: peopleEmailBackup.personId })
				.from(peopleEmailBackup)
				.where(eq(peopleEmailBackup.personId, personId));

		it("a guest delete clears the deleted Person's email backup", async () => {
			const { guestId, personId } = await newGuest(uniq("Backed Up"));
			await testDb
				.insert(peopleEmailBackup)
				.values({ personId, email: `bk-${randomUUID()}@example.test` });

			await applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(await personRow(personId)).toBeUndefined();
			expect(await backupRows(personId)).toHaveLength(0);
		});

		it("a link clears the guest's old Person's email backup", async () => {
			const { guestId, personId } = await newGuest(uniq("Backed Up Link"));
			await testDb
				.insert(peopleEmailBackup)
				.values({ personId, email: `bkl-${randomUUID()}@example.test` });

			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			});

			expect(await personRow(personId)).toBeUndefined();
			expect(await backupRows(personId)).toHaveLength(0);
		});

		it("keeps the backup of a Person that is NOT deleted", async () => {
			const otherClub = await makeClub();
			const { guestId, personId } = await newGuest(uniq("Kept Backup"));
			await createGuestRecord(testDb, {
				clubId: otherClub,
				name: uniq("Kept Elsewhere"),
				personId,
			});
			await testDb
				.insert(peopleEmailBackup)
				.values({ personId, email: `kb-${randomUUID()}@example.test` });

			await applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(await personRow(personId)).toBeDefined();
			expect(await backupRows(personId)).toHaveLength(1);
		});
	});

	// -----------------------------------------------------------------------
	// A merge's count and audit agree with its preview when a collapse moves
	// the guest first.
	// -----------------------------------------------------------------------
	describe("a merge that collapses a membership counts the guest it moved (the preview agrees)", () => {
		it("movedCounts.guests and the audit say 1, as the preview did", async () => {
			const keeper = await makePerson({ name: uniq("Count Keeper") });
			const absorbed = await makePerson({ name: uniq("Count Absorbed") });
			await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: keeper, name: "CK" });
			const [mx] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: absorbed, name: "CA" })
				.returning({ id: members.id });
			if (!mx) throw new Error("fixture");
			// A converted guest that IS the absorbed member's Person: the collapse
			// re-points it to the keeper before the merge's own guest step runs.
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Counted Guest"),
				stage: "joined",
				convertedMembershipId: mx.id,
				personId: absorbed,
			});

			const preview = await getMergePreview(keeper, absorbed);
			expect(preview.movedCounts.guests).toBe(1);

			const res = await mergePeople({
				keeperPersonId: keeper,
				absorbedPersonId: absorbed,
			});

			expect((await guestRow(guestId)).personId).toBe(keeper);
			expect(res.movedCounts.guests).toBe(1);
			expect(res.movedCounts.collapsed).toBe(1);
			const [audit] = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.action, "member_merge"),
						eq(activityLog.targetId, keeper),
					),
				);
			expect(
				(audit?.detail as { movedCounts: { guests: number } }).movedCounts
					.guests,
			).toBe(1);
		});
	});

	// =======================================================================
	// Round 5 of the review of #1155.
	// =======================================================================

	/** Whether `personId` reads PRISTINE for `guestId`, evaluated as the convert does. */
	async function readsPristine(personId: string, guestId: string) {
		const rows = await testDb
			.select({ id: people.id })
			.from(people)
			.where(and(eq(people.id, personId), pristineGuestPerson(guestId)));
		return rows.length === 1;
	}

	describe("pristine means never a member, nobody else's Person (H1)", () => {
		const snap = async (personId: string) => {
			const p = await personRow(personId);
			return {
				name: p?.name,
				email: p?.email,
				phone: p?.phone,
				customerId: p?.customerId,
				originalJoinDate: p?.originalJoinDate,
			};
		};

		it("roster merge: link, unlink, then the club merges the member's duplicate rows; the next convert does not write the guest onto the member's Person", async () => {
			const customerId = `PN-${randomUUID()}`;
			const samName = uniq("Sam Dup");
			const a = await makePerson({ name: samName });
			await testDb
				.update(people)
				.set({ customerId, originalJoinDate: new Date("2015-03-01") })
				.where(eq(people.id, a));
			const [ma] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: a, name: samName })
				.returning({ id: members.id });
			const k = await makePerson({
				name: uniq("Sam Keeper"),
				email: `sam-${randomUUID()}@keeper.example`,
			});
			const [mk] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: k, name: "Sam Keeper Row" })
				.returning({ id: members.id });
			if (!ma || !mk) throw new Error("fixture");
			const ginaName = uniq("Gina Guest");
			const ginaEmail = `gina-${randomUUID()}@guest.example`;
			const { guestId } = await newGuest(ginaName, { email: ginaEmail });
			// The officer links Gina's card to the wrong member, then unlinks it.
			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: ma.id,
				actorMemberId: seed.adminMemberId,
			});
			await applyUnlinkGuestFromMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			// The unlink does not leave the card on Sam's duplicate Person.
			const after = await guestRow(guestId);
			expect(after.personId).not.toBe(a);
			guestPersons.push(after.personId as string);
			// The club merges Sam's duplicate roster rows: the absorbed membership AND
			// its records are deleted, so nothing on record says A was ever a member.
			await applyMemberMerge({
				clubId: seed.clubId,
				keeperId: mk.id,
				absorbedId: ma.id,
				actorMemberId: seed.adminMemberId,
			});
			const before = await snap(a);

			const res = await convert(guestId);

			// Gina's membership is on a Person that is hers, never on Sam's.
			expect(res.personId).not.toBe(a);
			expect(await snap(a)).toEqual(before);
			const held = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.personId, a));
			expect(held).toHaveLength(0);
			expect((await personRow(res.personId))?.name).toBe(ginaName);
			// The next roster import by Sam's customer id cannot land on Gina's membership.
			await importPeopleAndMembers(seed.clubId, [
				{
					customerId,
					name: "Sam Keeper Row",
					email: null,
					phone: null,
					joinedAt: new Date("2015-03-01"),
					originalJoinDate: new Date("2015-03-01"),
					officerPosition: null,
					currentPosition: null,
				},
			]);
			const [gina] = await testDb
				.select({ name: members.name, personId: members.personId })
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(gina).toEqual({ name: ginaName, personId: res.personId });
		});

		it("the state the roster merge used to leave: a guest naming a Person with a customer id and join date, no membership and no record, reads not pristine", async () => {
			const a = await makePerson({ name: uniq("Collapsed Away") });
			await testDb
				.update(people)
				.set({
					customerId: `PN-${randomUUID()}`,
					originalJoinDate: new Date("2015-03-01"),
				})
				.where(eq(people.id, a));
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Guest On Collapsed"),
				personId: a,
			});

			expect(await readsPristine(a, guestId)).toBe(false);

			const before = await snap(a);
			const res = await convert(guestId);
			expect(res.personId).not.toBe(a);
			guestPersons.push(res.personId);
			// Unreferenced, unreleased and not pristine: deleted, with nothing left of it.
			expect(await personRow(a)).toBeUndefined();
			void before;
		});

		it("superadmin merge: a released former member folded into the guest's own Person as keeper makes it not pristine, and the convert gives the guest a fresh one", async () => {
			const clubB = await makeClub();
			const fredName = uniq("Fred Former");
			const f = await makePerson({ name: fredName });
			await testDb
				.update(people)
				.set({ customerId: `PNF-${randomUUID()}` })
				.where(eq(people.id, f));
			// Fred was a member of club B and was removed: the release names F, and a
			// merge copies F's anchors onto the keeper but leaves that record naming F.
			await testDb.insert(activityLog).values({
				clubId: clubB,
				action: "member_remove",
				targetType: "member",
				targetId: randomUUID(),
				detail: { name: fredName, personId: f },
			});
			const g = await newGuest(fredName);
			await mergePeople({ keeperPersonId: g.personId, absorbedPersonId: f });
			// The keeper now carries Fred's customer id and no removal names it.
			expect((await personRow(g.personId))?.customerId).not.toBeNull();
			expect(await readsPristine(g.personId, g.guestId)).toBe(false);

			const res = await convert(g.guestId);

			expect(res.personId).not.toBe(g.personId);
			guestPersons.push(res.personId);
			expect((await personRow(res.personId))?.customerId).toBeNull();
		});

		it("club delete: a Person kept by another club's guest row, whose membership and records went with the deleted club, reads not pristine", async () => {
			const doomedName = uniq("Doomed Roster");
			const doomed = await makeClub(doomedName, true);
			const x = await makePerson({ name: uniq("Imported Member") });
			await testDb
				.update(people)
				.set({ customerId: `PN-${randomUUID()}` })
				.where(eq(people.id, x));
			await testDb
				.insert(members)
				.values({ clubId: doomed, personId: x, name: "Imported Member" });
			// A guest of another club (this one) names that Person.
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Guest Of Imported"),
				personId: x,
			});

			await deleteClubPermanently(doomed, doomedName);

			// Kept (the guest row names it), but the membership and its records are gone.
			expect(await personRow(x)).toBeDefined();
			const held = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.personId, x));
			expect(held).toHaveLength(0);
			expect(await readsPristine(x, guestId)).toBe(false);
			const res = await convert(guestId);
			expect(res.personId).not.toBe(x);
			guestPersons.push(res.personId);
		});

		it("a Person released by a removal from before #875, whose record names no Person and who has only a join date, reads not pristine", async () => {
			const p = await makePerson({ name: uniq("Old Removal") });
			await testDb
				.update(people)
				.set({ originalJoinDate: new Date("2012-06-01") })
				.where(eq(people.id, p));
			// A removal record as it was written before #875: the name, no Person.
			await testDb.insert(activityLog).values({
				clubId: seed.clubId,
				action: "member_remove",
				targetType: "member",
				targetId: randomUUID(),
				detail: { name: "Old Removal" },
			});
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Guest On Old Removal"),
				personId: p,
			});

			expect(await readsPristine(p, guestId)).toBe(false);
		});

		it("a removal that names ANOTHER Person does not disqualify, and a bare name-only Person is pristine (the control)", async () => {
			const { guestId, personId } = await newGuest(uniq("Control"));
			await testDb.insert(activityLog).values({
				clubId: seed.clubId,
				action: "member_remove",
				targetType: "member",
				targetId: randomUUID(),
				detail: { name: "Somebody Else", personId: randomUUID() },
			});

			expect(await readsPristine(personId, guestId)).toBe(true);
		});

		it("the activity-log arm is served by the partial index, with an index condition on the expression", async () => {
			// The arm as the convert runs it, against a constant Person so the plan can
			// show an index condition. Sequential scans off: a plan that CAN use the
			// index does, and one that cannot (a bound `action IN (...)`, which the
			// partial index's predicate does not imply, or a wrapped expression) scans.
			const sub = releasedPersonSubquery(sql`${randomUUID()}::text`).toSQL();
			const c = new pg.Client({
				connectionString: process.env.TEST_DATABASE_URL,
			});
			await c.connect();
			try {
				await c.query("begin");
				await c.query("set local enable_seqscan = off");
				const plan = await c.query(
					`explain ${sub.sql}`,
					sub.params as unknown[],
				);
				const text = plan.rows
					.map((r: Record<string, string>) => r["QUERY PLAN"])
					.join("\n");
				expect(text).toContain("activity_log_member_remove_person_idx");
				expect(text).toMatch(/Index Cond:.*personId/);
				await c.query("rollback");
			} finally {
				await c.end();
			}
		});
	});

	describe("a convert that moves the guest off a Person deletes it only when nothing references it (L3)", () => {
		it("a Person a merge filled with a former member's contact, with no removal naming it, is deleted with its email backup", async () => {
			const clubB = await makeClub();
			const fernName = uniq("Fern Former");
			const f = await makePerson({
				name: fernName,
				email: `fern-${randomUUID()}@example.test`,
			});
			await testDb.insert(activityLog).values({
				clubId: clubB,
				action: "member_remove",
				targetType: "member",
				targetId: randomUUID(),
				detail: { name: fernName, personId: f },
			});
			const g = await newGuest(fernName);
			await mergePeople({ keeperPersonId: g.personId, absorbedPersonId: f });
			await testDb.insert(peopleEmailBackup).values({
				personId: g.personId,
				email: `bk-${randomUUID()}@example.test`,
			});
			expect((await personRow(g.personId))?.email).not.toBeNull();

			const res = await convert(g.guestId);

			expect(res.personId).not.toBe(g.personId);
			guestPersons.push(res.personId);
			expect(await personRow(g.personId)).toBeUndefined();
			const backup = await testDb
				.select({ id: peopleEmailBackup.personId })
				.from(peopleEmailBackup)
				.where(eq(peopleEmailBackup.personId, g.personId));
			expect(backup).toHaveLength(0);
		});

		it("an undone convert's Person, which a removal names, is kept through a re-convert (#875's release target)", async () => {
			const { guestId, personId } = await newGuest(uniq("Release Target"), {
				email: `rt-${randomUUID()}@example.test`,
			});
			await convert(guestId);
			await undo(guestId);

			const res = await convert(guestId);

			expect(res.personId).not.toBe(personId);
			guestPersons.push(res.personId);
			expect(await personRow(personId)).toBeDefined();
		});
	});

	describe("the delete of the old Person is taken under the strong lock (L3)", () => {
		it("a membership another transaction inserts for the old Person while the convert waits on that lock keeps the Person, and the member", async () => {
			const otherClub = await makeClub();
			const { guestId, personId } = await newGuest(uniq("Raced Person"), {
				email: `raced-${randomUUID()}@example.test`,
			});
			// Not pristine (it carries contact) and unreferenced: a candidate to delete.
			await testDb
				.update(people)
				.set({ email: `old-${randomUUID()}@example.test` })
				.where(eq(people.id, personId));
			// A writer is attaching a membership to it, uncommitted: its foreign key
			// holds a key share on the Person.
			const attaching = await openBlockingTx(async (tx) => {
				await tx.insert(members).values({
					clubId: otherClub,
					personId,
					name: "Attached Mid-Convert",
				});
			});
			const converting = convert(guestId).then(
				(r) => r,
				(e: Error) => e,
			);
			// The convert is parked on the Person's `FOR UPDATE`, behind that key share.
			await waitForLockWait("people", attaching.pid);
			await attaching.commit();

			const res = await converting;
			expect(res).not.toBeInstanceOf(Error);
			guestPersons.push((res as { personId: string }).personId);
			// With the lock, the DELETE's own WHERE saw the committed membership and
			// kept the Person. Without it the DELETE waited, ran on its old snapshot and
			// cascaded the new member away.
			expect(await personRow(personId)).toBeDefined();
			const kept = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.personId, personId));
			expect(kept).toHaveLength(1);
		});
	});

	describe("a mode chosen from a stale read cannot let a delete cascade away a committed row (M1)", () => {
		/**
		 * A guest in this club naming a Person K that holds a membership in another
		 * club (the shape a superadmin merge leaves): the guest delete and the link
		 * read that, without a lock, and take the WEAK lock on K. Then, AFTER that
		 * choice (the guest row is held `FOR SHARE` so the path parks past it), the
		 * other club's membership is removed, which makes K a delete candidate, while
		 * a third writer's uncommitted membership insert for K holds a key share on
		 * it. `FOR NO KEY UPDATE` does not conflict with that key share, so a DELETE
		 * under it waits for the writer and then decides on a snapshot older than the
		 * writer's commit: the cascade took the row the writer just committed.
		 */
		async function raceAfterTheModeChoice(
			run: (guestId: string) => Promise<unknown>,
		) {
			const clubC = await makeClub();
			const clubD = await makeClub();
			const k = await makePerson({ name: uniq("Stale Mode") });
			const [mC] = await testDb
				.insert(members)
				.values({ clubId: clubC, personId: k, name: uniq("Held Elsewhere") })
				.returning({ id: members.id });
			if (!mC) throw new Error("fixture");
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Stale Guest"),
				stage: "following_up",
				personId: k,
			});

			// The third writer: attaching K to club D, uncommitted (a key share on K).
			const attaching = await openBlockingTx(async (tx) => {
				await tx.insert(members).values({
					clubId: clubD,
					personId: k,
					name: "Attached Mid-Delete",
				});
			});
			// Holds the guest row, so the path parks AFTER it chose its lock mode.
			const { c, pid } = await rawClient();
			await c.query("begin");
			await c.query("select 1 from guests where id = $1 for share", [guestId]);
			const running = run(guestId).then(
				() => "ok" as const,
				(e: Error) => e.message,
			);
			await waitForLockWait("guests", pid);
			// The membership K held elsewhere is removed (`applyMemberRemove`'s DELETE),
			// so K is a candidate now; the path's early read said it was not.
			await c.query("delete from members where id = $1", [mC.id]);
			await c.query("commit");
			await c.end();
			// The path now reaches K's delete and waits behind the key share.
			await waitForLockWait("people", attaching.pid);
			await attaching.commit();
			return { outcome: await running, k, clubD };
		}

		async function expectCommittedRowSurvived(k: string, clubD: string) {
			expect(await personRow(k)).toBeDefined();
			const attached = await testDb
				.select({ id: members.id })
				.from(members)
				.where(and(eq(members.clubId, clubD), eq(members.personId, k)));
			expect(attached).toHaveLength(1);
		}

		it("a guest delete keeps the Person and the membership another writer committed", async () => {
			const { outcome, k, clubD } = await raceAfterTheModeChoice((guestId) =>
				applyDeleteGuest({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			);
			expect(outcome).toBe("ok");
			await expectCommittedRowSurvived(k, clubD);
		});

		it("a link keeps the Person and the membership another writer committed", async () => {
			const { outcome, k, clubD } = await raceAfterTheModeChoice((guestId) =>
				applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId,
					memberId: seed.memberId,
					actorMemberId: seed.adminMemberId,
				}),
			);
			expect(outcome).toBe("ok");
			await expectCommittedRowSurvived(k, clubD);
		});
	});

	describe("unlink leaves no guest on a member's Person (H1b)", () => {
		it("a guest whose Person holds no membership stays on it", async () => {
			// A guest linked to a membership, but naming a Person that holds none (the
			// two-Person residual a dedupe-hit convert leaves): nothing to separate from.
			const { guestId, personId } = await newGuest(uniq("Own Person"));
			const m = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: await makePerson({ name: uniq("Linked Elsewhere") }),
					name: uniq("Linked Elsewhere Row"),
				})
				.returning({ id: members.id });
			await testDb
				.update(guests)
				.set({ stage: "joined", convertedMembershipId: m[0]?.id })
				.where(eq(guests.id, guestId));
			// A link record, as `applyLinkGuestToMember` writes it.
			await testDb.insert(activityLog).values({
				clubId: seed.clubId,
				action: "member_merge",
				targetType: "member",
				targetId: m[0]?.id,
				detail: { fromGuestId: guestId, guestName: "G", slotIds: [] },
			});

			await applyUnlinkGuestFromMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect((await guestRow(guestId)).personId).toBe(personId);
		});
	});

	// -----------------------------------------------------------------------
	// L2: lock cycles, each reproduced with two connections.
	// -----------------------------------------------------------------------
	describe("lock cycles with writers that take no club lock, round 5 (L2)", () => {
		it("mergePeople does not deadlock a guest-profile edit that holds the keeper's membership FOR SHARE and then updates the guest", async () => {
			const keeper = await makePerson({ name: uniq("Profile Keeper") });
			const absorbed = await makePerson({ name: uniq("Profile Absorbed") });
			const [mk] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: keeper, name: "PK" })
				.returning({ id: members.id });
			await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId: absorbed, name: "PA" });
			if (!mk) throw new Error("fixture");
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Profile Guest"),
				personId: absorbed,
			});

			// `applyUpdateGuestProfile`: the introducer's membership FOR SHARE, then the
			// guest row.
			const { c, pid } = await rawClient();
			await c.query("begin");
			await c.query("select id from members where id = $1 for share", [mk.id]);
			const merging = mergePeople({
				keeperPersonId: keeper,
				absorbedPersonId: absorbed,
			}).then(
				() => "ok",
				(e: unknown) => sqlState(e),
			);
			// Parked on the keeper's membership behind the share lock.
			await waitForLockWait("", pid);
			const edit = await c
				.query("update guests set updated_at = now() where id = $1", [guestId])
				.then(
					() => "ok",
					(e: unknown) => sqlState(e),
				);
			await c.query(edit === "ok" ? "commit" : "rollback");
			await c.end();

			expect(edit).toBe("ok");
			expect(await merging).toBe("ok");
			expect((await guestRow(guestId)).personId).toBe(keeper);
		});

		it("a guest delete of a guest naming a MEMBER's Person does not deadlock a speaker claim", async () => {
			// The shape the backfill leaves for a linked guest that was unlinked before
			// the deploy: stage following_up, naming the member's Person.
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Backfilled Unlinked"),
				stage: "following_up",
				personId: seed.personId,
			});
			await testDb
				.update(roleSlots)
				.set({
					status: "open",
					assignedMemberId: null,
					assignedGuestId: guestId,
				})
				.where(eq(roleSlots.id, seed.slotId));

			// `claimSlotCore`: the conditional UPDATE of the open slot, then the speech.
			const { c, pid } = await rawClient();
			await c.query("begin");
			await c.query(
				`update role_slots set assigned_member_id = $1, assigned_guest_id = null, status = 'claimed'
				  where id = $2 and status = 'open' returning id`,
				[seed.memberId, seed.slotId],
			);
			const deleting = applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			}).then(
				() => "ok",
				(e: unknown) => sqlState(e),
			);
			await waitForLockWait("", pid);
			const claim = await c
				.query(
					"insert into speeches (person_id, title) values ($1, 'claim') returning id",
					[seed.personId],
				)
				.then(
					() => "ok",
					(e: unknown) => sqlState(e),
				);
			await c.query("rollback");
			await c.end();

			expect(claim).toBe("ok");
			// The delete finishes once the claim lets go; the member's Person is intact.
			expect(await deleting).toBe("ok");
			expect(await personRow(seed.personId)).toBeDefined();
		});

		it("a link does not deadlock a speaker claim for the member it links to", async () => {
			const { guestId } = await newGuest(uniq("Link Claim"));
			// The guest holds a slot that a claim for the member is touching.
			await testDb
				.update(roleSlots)
				.set({
					status: "claimed",
					assignedMemberId: null,
					assignedGuestId: guestId,
				})
				.where(eq(roleSlots.id, seed.slotId));
			const { c, pid } = await rawClient();
			await c.query("begin");
			await c.query("update role_slots set claimed_at = now() where id = $1", [
				seed.slotId,
			]);
			const linking = applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			}).then(
				() => "ok",
				(e: unknown) => sqlState(e),
			);
			await waitForLockWait("", pid);
			const claim = await c
				.query(
					"insert into speeches (person_id, title) values ($1, 'claim') returning id",
					[seed.personId],
				)
				.then(
					() => "ok",
					(e: unknown) => sqlState(e),
				);
			await c.query("rollback");
			await c.end();

			expect(claim).toBe("ok");
			expect(await linking).toBe("ok");
			expect((await guestRow(guestId)).personId).toBe(seed.personId);
		});
	});

	describe("lockPersonsInOrder (L2)", () => {
		/**
		 * Hold the locks `locks` takes, then try a `FOR KEY SHARE NOWAIT` on the
		 * Person from another connection: the lock a foreign-key INSERT takes. A
		 * `FOR UPDATE` refuses it (55P03); `FOR NO KEY UPDATE` does not.
		 */
		async function keyShareWhileHeld(
			locks: Parameters<typeof lockPersonsInOrder>[1],
			personId: string,
		) {
			const holder = await openBlockingTx(async (tx) => {
				await lockPersonsInOrder(tx, locks);
			});
			const { c } = await rawClient();
			try {
				await c.query("begin");
				return await c
					.query("select id from people where id = $1 for key share nowait", [
						personId,
					])
					.then(
						() => "free",
						(e: unknown) => sqlState(e),
					);
			} finally {
				await c.query("rollback");
				await c.end();
				await holder.commit();
			}
		}

		it("locks in id order, once each, and ignores a null", async () => {
			const a = await makePerson({ name: uniq("Order A") });
			const b = await makePerson({ name: uniq("Order B") });
			const c = await makePerson({ name: uniq("Order C") });
			const locked = await testDb.transaction((tx) =>
				lockPersonsInOrder(tx, [...noKeyUpdate(c, null, a, c, undefined, b)]),
			);
			expect(locked).toEqual([a, b, c].sort());
		});

		it("FOR NO KEY UPDATE does not block a key share", async () => {
			const p = await makePerson({ name: uniq("Weak") });
			expect(await keyShareWhileHeld(noKeyUpdate(p), p)).toBe("free");
		});

		it("FOR UPDATE blocks a key share", async () => {
			const p = await makePerson({ name: uniq("Strong") });
			expect(await keyShareWhileHeld(forUpdate(p), p)).toBe("55P03");
		});

		it("a Person named at both strengths is held at the stronger, whichever is listed first", async () => {
			const p = await makePerson({ name: uniq("Both") });
			expect(
				await keyShareWhileHeld([...noKeyUpdate(p), ...forUpdate(p)], p),
			).toBe("55P03");
			expect(
				await keyShareWhileHeld([...forUpdate(p), ...noKeyUpdate(p)], p),
			).toBe("55P03");
		});
	});
});
