/**
 * DB-backed integration tests for `collapseMemberships` — the membership-merge
 * primitive that re-points all ten membership-scoped FKs onto a keeper and
 * deletes the absorbed `members` row.
 *
 * Covers the required cases plus the trickier re-point paths:
 *   1. Data-loss fix: an OPEN officer_term + a member_dues row on the absorbed
 *      membership are RE-POINTED (not cascade-deleted) to the keeper.
 *   2. Reconcile: club_role/status/joined_at/email are folded correctly.
 *   3. Collision (unique-constraint) tests: availability + dues, attendance,
 *      and notifications — collapse succeeds, exactly one survivor each.
 *   4. Officer-term dedup: two OPEN terms for one position collapse to the
 *      earliest-started one.
 *   5. Happy-path re-point: role_slots, meeting_awards (distinct category),
 *      table_topics_speakers, and activity_log (actor + jsonb detail refs +
 *      member-target deletion) all move to the keeper.
 *   6. FK drift-guard: the DB's set of foreign keys referencing `members`
 *      exactly matches the 10 this primitive re-points.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/membership-collapse-logic.integration.test.ts
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	duesPeriods,
	meetingAttendance,
	meetingAwards,
	memberAvailability,
	memberDues,
	members,
	notifications,
	officerTerms,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Import after the mock so the logic module's `#/db` import resolves to testDb
// (it only needs it for the Tx type, but the mock also avoids the import-time
// "DATABASE_URL is not set" throw when TEST_DATABASE_URL is the only URL set).
const { collapseMemberships } = await import("./membership-collapse-logic");

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("collapseMemberships", () => {
	let seed: SeededClub;
	// Person ids created here so afterEach can remove them: the absorbed
	// membership is deleted during collapse, so `cleanup` (which reads the club's
	// surviving members) never sees its person — track + delete explicitly.
	let extraPersonIds: string[];

	beforeEach(async () => {
		seed = await seedClub();
		extraPersonIds = [];
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		for (const personId of extraPersonIds) {
			await testDb.delete(members).where(eq(members.personId, personId));
			const { people } = await import("#/db/schema");
			await testDb.delete(people).where(eq(people.id, personId));
		}
	});

	/** Insert a membership (with its own tracked person) in the seeded club. */
	async function addMembership(opts: {
		name: string;
		clubRole?: "admin" | "member";
		status?: "active" | "inactive";
		email?: string | null;
		joinedAt?: Date | null;
	}): Promise<string> {
		const personId = await seedPerson({ name: opts.name });
		extraPersonIds.push(personId);
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				personId,
				name: opts.name,
				clubRole: opts.clubRole ?? "member",
				status: opts.status ?? "active",
				email: opts.email ?? null,
				joinedAt: opts.joinedAt ?? null,
			})
			.returning({ id: members.id });
		if (!m) throw new Error("Failed to insert membership");
		return m.id;
	}

	async function makePeriod(label: string): Promise<string> {
		const [p] = await testDb
			.insert(duesPeriods)
			.values({ clubId: seed.clubId, label, dueDate: new Date() })
			.returning({ id: duesPeriods.id });
		if (!p) throw new Error("Failed to insert dues period");
		return p.id;
	}

	const collapse = (keeperId: string, absorbedId: string) =>
		testDb.transaction((tx) =>
			collapseMemberships(tx, seed.clubId, keeperId, absorbedId),
		);

	it("re-points an OPEN officer term + dues row to the keeper (not cascade-deleted)", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		// Absorbed holds an OPEN office and a paid dues record — both have
		// ON DELETE CASCADE on members, so the old merge silently destroyed them.
		await testDb.insert(officerTerms).values({
			membershipId: absorbedId,
			position: "treasurer",
			termStart: new Date(),
			termEnd: null,
		});
		const periodId = await makePeriod("2026 renewal");
		await testDb.insert(memberDues).values({
			membershipId: absorbedId,
			duesPeriodId: periodId,
			status: "paid",
			amountCents: 5000,
		});

		await collapse(keeperId, absorbedId);

		// Absorbed membership is gone.
		const absorbedRows = await testDb
			.select()
			.from(members)
			.where(eq(members.id, absorbedId));
		expect(absorbedRows).toHaveLength(0);

		// The office survived and now references the keeper.
		const terms = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.position, "treasurer"));
		expect(terms).toHaveLength(1);
		expect(terms[0]?.membershipId).toBe(keeperId);
		expect(terms[0]?.termEnd).toBeNull();

		// The dues row survived and now references the keeper.
		const dues = await testDb
			.select()
			.from(memberDues)
			.where(eq(memberDues.duesPeriodId, periodId));
		expect(dues).toHaveLength(1);
		expect(dues[0]?.membershipId).toBe(keeperId);
		expect(dues[0]?.amountCents).toBe(5000);
	});

	it("reconciles club_role, status, joined_at, and fills a null email", async () => {
		const older = new Date(Date.now() - 400 * DAY);
		const newer = new Date(Date.now() - 100 * DAY);
		// Keeper: member / active / null email / later join.
		const keeperId = await addMembership({
			name: "Keeper",
			clubRole: "member",
			status: "active",
			email: null,
			joinedAt: newer,
		});
		// Absorbed: admin / inactive / has email / earlier join.
		const absorbedId = await addMembership({
			name: "Absorbed",
			clubRole: "admin",
			status: "inactive",
			email: "absorbed@example.com",
			joinedAt: older,
		});

		await collapse(keeperId, absorbedId);

		const [keeper] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, keeperId));
		expect(keeper?.clubRole).toBe("admin"); // higher of the two wins
		expect(keeper?.status).toBe("active"); // active if either is active
		expect(keeper?.email).toBe("absorbed@example.com"); // null filled from absorbed
		expect(keeper?.joinedAt?.getTime()).toBe(older.getTime()); // earliest known
	});

	it("survives a same-meeting availability + same-period dues collision", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		// Both are NOT available for the SAME meeting (unique member,meeting).
		await testDb.insert(memberAvailability).values([
			{ memberId: keeperId, meetingId: seed.meetingId },
			{ memberId: absorbedId, meetingId: seed.meetingId },
		]);
		// Both have a dues row for the SAME period (unique membership,period).
		const periodId = await makePeriod("shared period");
		await testDb.insert(memberDues).values([
			{ membershipId: keeperId, duesPeriodId: periodId, status: "paid" },
			{ membershipId: absorbedId, duesPeriodId: periodId, status: "waived" },
		]);

		// Must NOT throw a unique-violation.
		await expect(collapse(keeperId, absorbedId)).resolves.toBeUndefined();

		// Exactly one availability row remains for (keeper, meeting); none for absorbed.
		const keeperAvail = await testDb
			.select()
			.from(memberAvailability)
			.where(
				and(
					eq(memberAvailability.memberId, keeperId),
					eq(memberAvailability.meetingId, seed.meetingId),
				),
			);
		expect(keeperAvail).toHaveLength(1);
		const absorbedAvail = await testDb
			.select()
			.from(memberAvailability)
			.where(eq(memberAvailability.memberId, absorbedId));
		expect(absorbedAvail).toHaveLength(0);

		// Exactly one dues row remains for (keeper, period) — the keeper's own,
		// which was recorded `paid` (the absorbed `waived` dup was dropped).
		const keeperDues = await testDb
			.select()
			.from(memberDues)
			.where(
				and(
					eq(memberDues.membershipId, keeperId),
					eq(memberDues.duesPeriodId, periodId),
				),
			);
		expect(keeperDues).toHaveLength(1);
		expect(keeperDues[0]?.status).toBe("paid");
		const absorbedDues = await testDb
			.select()
			.from(memberDues)
			.where(eq(memberDues.membershipId, absorbedId));
		expect(absorbedDues).toHaveLength(0);
	});

	it("dedupes two OPEN terms for one position down to the earliest-started", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		const earlyStart = new Date(Date.now() - 300 * DAY);
		const lateStart = new Date(Date.now() - 50 * DAY);
		// Keeper already holds an OPEN president term (later start); absorbed holds
		// an OPEN president term (earlier start). After collapse only the earliest
		// survives.
		await testDb.insert(officerTerms).values([
			{ membershipId: keeperId, position: "president", termStart: lateStart },
			{
				membershipId: absorbedId,
				position: "president",
				termStart: earlyStart,
			},
		]);

		await collapse(keeperId, absorbedId);

		const openPresident = await testDb
			.select()
			.from(officerTerms)
			.where(
				and(
					eq(officerTerms.membershipId, keeperId),
					eq(officerTerms.position, "president"),
				),
			);
		expect(openPresident).toHaveLength(1);
		expect(openPresident[0]?.termStart?.getTime()).toBe(earlyStart.getTime());
	});

	it("survives a same-meeting attendance collision", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		// Both recorded present at the SAME meeting (unique meeting,member).
		await testDb.insert(meetingAttendance).values([
			{ meetingId: seed.meetingId, memberId: keeperId, status: "present" },
			{ meetingId: seed.meetingId, memberId: absorbedId, status: "excused" },
		]);

		await expect(collapse(keeperId, absorbedId)).resolves.toBeUndefined();

		// Exactly one attendance row remains for (keeper, meeting) — the keeper's
		// own (present); the absorbed dup (excused) was dropped.
		const keeperRows = await testDb
			.select()
			.from(meetingAttendance)
			.where(
				and(
					eq(meetingAttendance.memberId, keeperId),
					eq(meetingAttendance.meetingId, seed.meetingId),
				),
			);
		expect(keeperRows).toHaveLength(1);
		expect(keeperRows[0]?.status).toBe("present");
		const absorbedRows = await testDb
			.select()
			.from(meetingAttendance)
			.where(eq(meetingAttendance.memberId, absorbedId));
		expect(absorbedRows).toHaveLength(0);
	});

	it("survives a same-slot notifications collision", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		// Both queued a reminder for the SAME slot (partial unique on
		// slot_id, assigned_member_id where member is not null).
		const sendAt = new Date(Date.now() + DAY);
		await testDb.insert(notifications).values([
			{
				userId: seed.adminUserId,
				slotId: seed.slotId,
				assignedMemberId: keeperId,
				type: "role_reminder",
				channel: "email",
				sendAt,
			},
			{
				userId: seed.memberUserId,
				slotId: seed.slotId,
				assignedMemberId: absorbedId,
				type: "role_reminder",
				channel: "email",
				sendAt,
			},
		]);

		await expect(collapse(keeperId, absorbedId)).resolves.toBeUndefined();

		// Exactly one notification remains for (slot, keeper); none for absorbed.
		const keeperNotifs = await testDb
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.assignedMemberId, keeperId),
					eq(notifications.slotId, seed.slotId),
				),
			);
		expect(keeperNotifs).toHaveLength(1);
		const absorbedNotifs = await testDb
			.select()
			.from(notifications)
			.where(eq(notifications.assignedMemberId, absorbedId));
		expect(absorbedNotifs).toHaveLength(0);
	});

	it("re-points set-null FKs + activity_log (actor + jsonb detail) to the keeper", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		// role_slots.assigned_member_id (no member-unique) — a fresh assigned slot.
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: seed.roleDefinitionId,
				assignedMemberId: absorbedId,
				status: "confirmed",
			})
			.returning({ id: roleSlots.id });
		if (!slot) throw new Error("Failed to insert role slot");

		// meeting_awards — DISTINCT category so there is no (meeting,category) clash.
		await testDb.insert(meetingAwards).values({
			meetingId: seed.meetingId,
			category: "best_speaker",
			memberId: absorbedId,
		});

		// table_topics_speakers (no member-unique).
		await testDb.insert(tableTopicsSpeakers).values({
			meetingId: seed.meetingId,
			memberId: absorbedId,
			topic: "A tricky question",
		});

		// activity_log — an actor row with a jsonb detail.memberId ref…
		await testDb.insert(activityLog).values({
			clubId: seed.clubId,
			actorMemberId: absorbedId,
			action: "claim",
			targetType: "slot",
			targetId: slot.id,
			detail: { memberId: absorbedId },
		});
		// …a jsonb detail.fromMemberId ref (the second jsonb_set path)…
		await testDb.insert(activityLog).values({
			clubId: seed.clubId,
			actorMemberId: null,
			action: "release",
			targetType: "slot",
			targetId: slot.id,
			detail: { fromMemberId: absorbedId },
		});
		// …and the absorbed member's OWN member-target row (must be deleted).
		const [ownRow] = await testDb
			.insert(activityLog)
			.values({
				clubId: seed.clubId,
				actorMemberId: absorbedId,
				action: "member_add",
				targetType: "member",
				targetId: absorbedId,
				detail: { name: "Absorbed" },
			})
			.returning({ id: activityLog.id });
		if (!ownRow) throw new Error("Failed to insert activity row");

		await collapse(keeperId, absorbedId);

		// role_slots re-pointed.
		const [slotAfter] = await testDb
			.select()
			.from(roleSlots)
			.where(eq(roleSlots.id, slot.id));
		expect(slotAfter?.assignedMemberId).toBe(keeperId);

		// meeting_awards re-pointed.
		const awards = await testDb
			.select()
			.from(meetingAwards)
			.where(eq(meetingAwards.meetingId, seed.meetingId));
		expect(awards).toHaveLength(1);
		expect(awards[0]?.memberId).toBe(keeperId);

		// table_topics_speakers re-pointed.
		const topics = await testDb
			.select()
			.from(tableTopicsSpeakers)
			.where(eq(tableTopicsSpeakers.meetingId, seed.meetingId));
		expect(topics).toHaveLength(1);
		expect(topics[0]?.memberId).toBe(keeperId);

		// activity_log: actor column + BOTH jsonb detail refs rewritten to keeper.
		const actorRows = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.actorMemberId, keeperId));
		expect(actorRows.length).toBeGreaterThanOrEqual(1);
		const claimRow = actorRows.find((r) => r.action === "claim");
		expect((claimRow?.detail as { memberId?: string })?.memberId).toBe(
			keeperId,
		);
		const [releaseRow] = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.action, "release"),
				),
			);
		expect(
			(releaseRow?.detail as { fromMemberId?: string })?.fromMemberId,
		).toBe(keeperId);
		// No activity_log actor still points at the absorbed membership.
		const absorbedActor = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.actorMemberId, absorbedId));
		expect(absorbedActor).toHaveLength(0);

		// The absorbed member's own member-target row was deleted.
		const ownAfter = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.id, ownRow.id));
		expect(ownAfter).toHaveLength(0);
	});

	it("FK drift-guard: every foreign key referencing `members` is handled", async () => {
		// The exact set of (referencing table, column) FKs pointing at members.id
		// that collapseMemberships re-points. If a future migration adds an 11th FK
		// to members, this fails LOUDLY here — instead of silently cascade-deleting
		// or orphaning that data on the next merge.
		const HANDLED = new Set([
			"officer_terms.membership_id",
			"member_dues.membership_id",
			"member_availability.member_id",
			"meeting_attendance.member_id",
			"meeting_awards.member_id",
			"notifications.assigned_member_id",
			"role_slots.assigned_member_id",
			"table_topics_speakers.member_id",
			"guests.converted_membership_id",
			"activity_log.actor_member_id",
		]);

		const result = await testDb.execute(sql`
			SELECT con.conrelid::regclass::text AS tbl, a.attname AS col
			FROM pg_constraint con
			CROSS JOIN LATERAL unnest(con.conkey) AS ck(attnum)
			JOIN pg_attribute a
				ON a.attrelid = con.conrelid AND a.attnum = ck.attnum
			WHERE con.contype = 'f' AND con.confrelid = 'members'::regclass`);
		const actual = new Set(
			(result.rows as { tbl: string; col: string }[]).map(
				(r) => `${r.tbl}.${r.col}`,
			),
		);

		expect([...actual].sort()).toEqual([...HANDLED].sort());
	});

	it("is a no-op when keeper === absorbed", async () => {
		const keeperId = await addMembership({ name: "Solo" });
		await expect(collapse(keeperId, keeperId)).resolves.toBeUndefined();
		const rows = await testDb
			.select()
			.from(members)
			.where(eq(members.id, keeperId));
		expect(rows).toHaveLength(1);
	});
});
