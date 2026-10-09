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
	pathEnrollments,
	pathwaysPaths,
	people,
	speeches,
	user,
} from "#/db/schema";
import {
	CONVERT_NAME_CLASH_MESSAGE,
	UNDO_MEMBER_HAS_ACCOUNT_MESSAGE,
	UNDO_NO_RECORD_MESSAGE,
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
	revertGuestContactFill,
} = await import("#/server/guests-logic");
const {
	applyConvertGuestToMember,
	applyDeleteGuest,
	applyLinkGuestToMember,
	applyUndoGuestConversion,
	applyUnlinkGuestFromMember,
	applyUpdateGuest,
	captureGuestVisit,
} = await import("#/server/guest-pipeline-logic");
const { bindVerifiedPerson } = await import("#/server/account-link-logic");
const { collapseMemberships } = await import(
	"#/server/membership-collapse-logic"
);
const { addGuestPresent } = await import("#/server/minutes-logic");
const { joinBallotAsGuest } = await import("#/server/voting-logic");
const { mergePeople } = await import("#/server/people-merge-logic");
const { searchPeopleForMerge, listDuplicatePeople, getMergePreview } =
	await import("#/server/people-logic");
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

		it("copies nothing onto, and renames nothing on, a Person somebody has signed in as", async () => {
			const { guestId, personId } = await newGuest(uniq("Bound Guest"), {
				email: `bound-${randomUUID()}@example.com`,
				phone: uniquePhone(),
			});
			const theirName = uniq("Their Own Name");
			await testDb
				.update(people)
				.set({ userId: await makeUser(), name: theirName, preferredName: "T" })
				.where(eq(people.id, personId));

			await convert(guestId);

			// The address on a bound Person is its account's, and the guest book is an
			// anonymous form. The name is theirs too: the guest row's does not replace it.
			const p = await personRow(personId);
			expect(p?.email).toBeNull();
			expect(p?.phone).toBeNull();
			expect(p?.name).toBe(theirName);
			expect(p?.preferredName).toBe("T");
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
			const memberName = (await personRow(memberPerson))?.name;
			const { id: guestId } = await createGuestRecord(testDb, {
				clubId: seed.clubId,
				name: uniq("Guest Of A Member"),
				preferredName: "Gom",
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
			// ...and nothing is copied onto it, and its name is not replaced by the
			// guest row's.
			const p = await personRow(memberPerson);
			expect(p?.email).toBeNull();
			expect(p?.phone).toBeNull();
			expect(p?.name).toBe(memberName);
			expect(p?.preferredName).toBeNull();
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
			// And what convert filled is taken back: the Person is name-only again.
			expect((await personRow(res.personId))?.email).toBeNull();
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
		filled?: unknown;
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
				...(opts.filled === undefined ? {} : { filled: opts.filled }),
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
	describe("undo takes back exactly what convert filled (H1)", () => {
		it("a typo'd address does not stay on a member's Person: convert, undo, correct, convert again", async () => {
			const name = uniq("Typo Guest");
			const typo = `typo-${randomUUID()}@example.test`;
			const fixed = `fixed-${randomUUID()}@example.test`;
			const { guestId, personId } = await newGuest(name, { email: typo });
			const first = await convert(guestId);
			expect(first.personId).toBe(personId);
			expect((await personRow(personId))?.email).toBe(typo);

			await undo(guestId);
			// The Person is name-only again, not holding an address the guest no longer has.
			expect((await personRow(personId))?.email).toBeNull();

			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name,
				email: fixed,
			});
			const second = await convert(guestId);

			// The same Person, now a member, carrying the CORRECTED address.
			expect(second.personId).toBe(personId);
			expect((await personRow(personId))?.email).toBe(fixed);
			// End to end through the bind rule: whoever owns the typo cannot sign in to
			// a Person that now holds a membership, and the real address can.
			const typoOwner = await makeUser(typo);
			expect(await bindVerifiedPerson({ personId, userId: typoOwner })).toBe(
				false,
			);
			expect((await personRow(personId))?.userId).toBeNull();
			const realOwner = await makeUser(fixed);
			expect(await bindVerifiedPerson({ personId, userId: realOwner })).toBe(
				true,
			);
		});

		it("the same for a record from BEFORE #1124 (createdPerson: true): the Person the old convert minted goes back to name-only", async () => {
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
			const after = await personRow(personId);
			expect(after?.email).toBeNull();
			expect(after?.phone).toBeNull();
			// Its name is untouched, and the guest still names it.
			expect(after?.name).toBe(name);
			expect((await guestRow(guestId)).personId).toBe(personId);

			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name,
				email: fixed,
			});
			const second = await convert(guestId);

			expect(second.personId).toBe(personId);
			expect((await personRow(personId))?.email).toBe(fixed);
			const typoOwner = await makeUser(typo);
			expect(await bindVerifiedPerson({ personId, userId: typoOwner })).toBe(
				false,
			);
		});

		it("clears a field only while it still holds what convert wrote", async () => {
			const email = `kept-${randomUUID()}@example.test`;
			const { guestId, personId } = await newGuest(uniq("Edited Since"), {
				email,
				phone: uniquePhone(),
			});
			await convert(guestId);
			// An officer corrects the member's address on the member page afterwards.
			const theirs = `theirs-${randomUUID()}@example.test`;
			await testDb
				.update(people)
				.set({ email: theirs })
				.where(eq(people.id, personId));

			await undo(guestId);

			const p = await personRow(personId);
			// The address is theirs now and stays; the phone convert wrote still
			// matched, so it went.
			expect(p?.email).toBe(theirs);
			expect(p?.phone).toBeNull();
		});

		it("a phone an officer changed since is left alone too, while the unchanged address still goes", async () => {
			const email = `still-${randomUUID()}@example.test`;
			const { guestId, personId } = await newGuest(uniq("Phone Edited"), {
				email,
				phone: uniquePhone(),
			});
			await convert(guestId);
			const theirs = toStoredPhone(uniquePhone(), "1");
			await testDb
				.update(people)
				.set({ phone: theirs })
				.where(eq(people.id, personId));

			await undo(guestId);

			const p = await personRow(personId);
			expect(p?.phone).toBe(theirs);
			expect(p?.email).toBeNull();
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

		it("revertGuestContactFill clears only an unbound, guest-held Person, and only a matching value", async () => {
			const revert = (
				personId: string,
				what: Parameters<typeof revertGuestContactFill>[2],
			) =>
				testDb.transaction((tx) => revertGuestContactFill(tx, personId, what));
			const holdsEmail = async (email: string) => {
				const { guestId, personId } = await newGuest(uniq("Revert Target"));
				await testDb
					.update(people)
					.set({ email, phone: "+15550002222" })
					.where(eq(people.id, personId));
				return { guestId, personId };
			};

			// Control: a recorded fill that still matches IS cleared.
			const e1 = `r1-${randomUUID()}@example.test`;
			const a = await holdsEmail(e1);
			await revert(a.personId, { email: e1, phone: "+15550002222" });
			expect((await personRow(a.personId))?.email).toBeNull();
			expect((await personRow(a.personId))?.phone).toBeNull();

			// A different value: untouched.
			const b = await holdsEmail(`r2-${randomUUID()}@example.test`);
			await revert(b.personId, { email: "someone-else@example.test" });
			expect((await personRow(b.personId))?.email).not.toBeNull();

			// Signed in: untouched, in either mode.
			const c = await holdsEmail(`r3-${randomUUID()}@example.test`);
			await testDb
				.update(people)
				.set({ userId: await makeUser() })
				.where(eq(people.id, c.personId));
			await revert(c.personId, { any: true });
			expect((await personRow(c.personId))?.email).not.toBeNull();
			expect((await personRow(c.personId))?.phone).not.toBeNull();

			// A member of some club: untouched, in either mode.
			const d = await holdsEmail(`r4-${randomUUID()}@example.test`);
			const otherClub = await makeClub();
			await testDb.insert(members).values({
				clubId: otherClub,
				personId: d.personId,
				name: "Held Elsewhere",
			});
			await revert(d.personId, { any: true });
			expect((await personRow(d.personId))?.email).not.toBeNull();
			expect((await personRow(d.personId))?.phone).not.toBeNull();

			// The legacy mode clears whatever is there on a Person that qualifies.
			const f = await holdsEmail(`r5-${randomUUID()}@example.test`);
			await revert(f.personId, { any: true });
			expect((await personRow(f.personId))?.email).toBeNull();
			expect((await personRow(f.personId))?.phone).toBeNull();
		});

		it("refuses a record whose filled key is half-readable, rather than reading it as 'filled nothing'", async () => {
			for (const bad of ["x", [], { email: 5 }, { phone: {} }]) {
				const { guestId, personId } = await newGuest(uniq("Bad Record"));
				const [m] = await testDb
					.insert(members)
					.values({ clubId: seed.clubId, personId, name: uniq("Bad Record M") })
					.returning({ id: members.id });
				if (!m) throw new Error("fixture");
				await testDb
					.update(guests)
					.set({ stage: "joined", convertedMembershipId: m.id })
					.where(eq(guests.id, guestId));
				await plantConversionRecord({
					guestId,
					membershipId: m.id,
					personId,
					createdMembership: true,
					createdPerson: false,
					filled: bad,
				});
				await expect(undo(guestId)).rejects.toThrow(UNDO_NO_RECORD_MESSAGE);
			}
		});
	});

	// -----------------------------------------------------------------------
	// H2: after an undo or unlink the guest no longer names a member's Person.
	// -----------------------------------------------------------------------
	describe("after an undo or unlink a guest never keeps a member's Person (H2)", () => {
		it("a backfilled converted row whose membership was REUSED: undo re-points the guest, and a re-convert makes a NEW membership", async () => {
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

			// The membership was convert's REUSE, so it stands, untouched...
			expect(undone.membershipDeleted).toBe(false);
			// ...and the guest no longer names its Person: a fresh name-only one.
			const g = await guestRow(guestId);
			expect(g.personId).not.toBe(memberPerson);
			guestPersons.push(g.personId as string);
			const fresh = await personRow(g.personId as string);
			expect(fresh?.name).toBe(name);
			expect(fresh?.email).toBeNull();
			expect(g.stage).toBe("following_up");

			// A re-convert under the SAME name now meets the #617 refusal instead of
			// quietly reusing the member's row.
			await expect(convert(guestId)).rejects.toThrow(
				CONVERT_NAME_CLASH_MESSAGE,
			);
			// Rename the guest and it creates a NEW membership on the fresh Person.
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: uniq("Entirely Different"),
			});
			const res = await convert(guestId);
			expect(res.membershipId).not.toBe(m0.id);
			expect(res.personId).toBe(g.personId);
			expect(res.reactivated).toBe(false);
			// The lapsed admin was not woken or demoted.
			const [still] = await testDb
				.select({ status: members.status, clubRole: members.clubRole })
				.from(members)
				.where(eq(members.id, m0.id));
			expect(still).toEqual({ status: "inactive", clubRole: "admin" });
		});

		it("a linked guest unlinked: the guest gets a fresh Person, and a re-convert does not land on the member", async () => {
			const stem = uniq("Linked");
			const { guestId, personId: guestsOwn } = await newGuest(stem);

			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
			});
			// L5: the link points the guest at the member's Person, as a convert does,
			// and the guest's own Person, named by nobody now, is taken back.
			const linked = await guestRow(guestId);
			expect(linked.personId).toBe(seed.personId);
			expect(await personRow(guestsOwn)).toBeUndefined();

			await applyUnlinkGuestFromMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			const unlinked = await guestRow(guestId);
			expect(unlinked.personId).not.toBe(seed.personId);
			guestPersons.push(unlinked.personId as string);
			expect((await personRow(unlinked.personId as string))?.name).toBe(stem);
			// The member's Person is still theirs, untouched.
			expect(await personRow(seed.personId)).toBeDefined();

			const res = await convert(guestId);
			expect(res.membershipId).not.toBe(seed.memberId);
			expect(res.personId).toBe(unlinked.personId);
		});

		it("the pre-#759 cross-club shape: a convert that attached ANOTHER club's Person is undone, and the guest lets go of it", async () => {
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
			const g = await guestRow(guestId);
			// This club's membership is gone, but the stranger's Person still holds
			// the OTHER club's, so the guest must not keep naming it.
			expect(g.personId).not.toBe(strangersPerson);
			guestPersons.push(g.personId as string);
			expect((await personRow(g.personId as string))?.name).toBe(name);

			const res = await convert(guestId);
			expect(res.personId).toBe(g.personId);
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
});
