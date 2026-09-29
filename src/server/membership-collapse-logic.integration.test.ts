/**
 * DB-backed integration tests for `collapseMemberships` — the membership-merge
 * primitive that re-points every membership-scoped FK onto a keeper and
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
 *      exactly matches the set this primitive re-points. (Stated as a set, not
 *      a count — the count went stale twice while the guard stayed correct.)
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/membership-collapse-logic.integration.test.ts
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubActionItems,
	duesPeriods,
	guestInvites,
	guests,
	meetingAttendance,
	meetingAttendancePlan,
	meetingAwards,
	meetingCandidateDisqualifications,
	meetings,
	meetingVoteSessions,
	meetingVotes,
	memberDues,
	members,
	mentorships,
	notifications,
	officerTerms,
	officerTrainingRecords,
	roleFeedbackNotes,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
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

// Import after the mock so the logic module's `#/db` import resolves to testDb
// (it only needs it for the Tx type, but the mock also avoids the import-time
// "DATABASE_URL is not set" throw when TEST_DATABASE_URL is the only URL set).
const { collapseMemberships } = await import("./membership-collapse-logic");
const { lockClubForWrite } = await import("./club-write-lock");

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
		preferredName?: string | null;
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
				preferredName: opts.preferredName ?? null,
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

		// The office survived and now references the keeper. Scoped to this
		// test's own two memberships: other suites seed treasurer terms in the
		// same shared database concurrently (#961).
		const terms = await testDb
			.select()
			.from(officerTerms)
			.where(
				and(
					eq(officerTerms.position, "treasurer"),
					inArray(officerTerms.membershipId, [keeperId, absorbedId]),
				),
			);
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

	it("fills a null goes-by name from the absorbed, but never overwrites one", async () => {
		// A collapse is irreversible and a recorded goes-by name is scarce — a
		// human had to type it — so it must survive when the keeper lacks one
		// and must not be clobbered when the keeper has one (#486).
		const keeperId = await addMembership({
			name: "Abdul-Rasheed Bustamam",
			preferredName: null,
		});
		const absorbedId = await addMembership({
			name: "Abdul-Rasheed Bustamam",
			preferredName: "Rasheed",
		});
		await collapse(keeperId, absorbedId);
		const [filled] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, keeperId));
		expect(filled?.preferredName).toBe("Rasheed");

		const ownerId = await addMembership({
			name: "Robert Smith",
			preferredName: "Bob",
		});
		const otherId = await addMembership({
			name: "Robert Smith",
			preferredName: "Rob",
		});
		await collapse(ownerId, otherId);
		const [kept] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, ownerId));
		expect(kept?.preferredName).toBe("Bob");
	});

	it("survives a same-period dues collision", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		// Both have a dues row for the SAME period (unique membership,period).
		const periodId = await makePeriod("shared period");
		await testDb.insert(memberDues).values([
			{ membershipId: keeperId, duesPeriodId: periodId, status: "paid" },
			{ membershipId: absorbedId, duesPeriodId: periodId, status: "waived" },
		]);

		// Must NOT throw a unique-violation.
		await expect(collapse(keeperId, absorbedId)).resolves.toBeUndefined();

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

	// The two collision tests that used to sit here — one per legacy boolean
	// table — are gone with the tables. The test below is their replacement and
	// covers strictly more: `meeting_attendance_plan` carries the SAME unique
	// (member, meeting) both of them had, so the same delete-then-re-point dance
	// is under test, and it also pins a row that must SURVIVE the merge, which
	// neither of the originals did.
	it("re-points plan rows and drops the absorbed duplicate", async () => {
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });
		const [second] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + DAY),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		const secondMeetingId = second!.id;

		await testDb.insert(meetingAttendancePlan).values([
			// Collision on the seeded meeting: unique (member, meeting), so a plain
			// re-point would raise a unique-violation and abort the whole merge.
			{
				memberId: keeperId,
				meetingId: seed.meetingId,
				status: "coming",
			},
			{
				memberId: absorbedId,
				meetingId: seed.meetingId,
				status: "not_coming",
			},
			// NO keeper row on the second meeting. This one has to SURVIVE the
			// merge by being re-pointed; the FK is ON DELETE CASCADE, so a merge
			// that forgets this table destroys the answer instead of keeping it.
			{
				memberId: absorbedId,
				meetingId: secondMeetingId,
				status: "reached_out",
			},
		]);

		await expect(collapse(keeperId, absorbedId)).resolves.toBeUndefined();

		const rows = await testDb
			.select({
				memberId: meetingAttendancePlan.memberId,
				meetingId: meetingAttendancePlan.meetingId,
				status: meetingAttendancePlan.status,
			})
			.from(meetingAttendancePlan)
			.where(
				inArray(meetingAttendancePlan.meetingId, [
					seed.meetingId,
					secondMeetingId,
				]),
			);

		expect(
			[...rows].sort((a, b) => a.meetingId.localeCompare(b.meetingId)),
		).toEqual(
			[
				{
					memberId: keeperId,
					meetingId: seed.meetingId,
					status: "coming",
				},
				{
					memberId: keeperId,
					meetingId: secondMeetingId,
					status: "reached_out",
				},
			].sort((a, b) => a.meetingId.localeCompare(b.meetingId)),
		);
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

	it("re-points an action item's owner to the keeper", async () => {
		// The FK drift-guard below proves this FK is DECLARED as handled; it
		// cannot prove the re-point actually runs. Verified by mutation: deleting
		// the clubActionItems update left every other test in this file green.
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		const [item] = await testDb
			.insert(clubActionItems)
			.values({
				clubId: seed.clubId,
				text: "Book the venue",
				ownerMemberId: absorbedId,
			})
			.returning({ id: clubActionItems.id });
		if (!item) throw new Error("Failed to insert action item");

		await collapse(keeperId, absorbedId);

		const [row] = await testDb
			.select({ ownerMemberId: clubActionItems.ownerMemberId })
			.from(clubActionItems)
			.where(eq(clubActionItems.id, item.id));
		// Pin the row first: asserting the field alone passes when the row is
		// gone entirely (CLAUDE.md coverage trap 1).
		expect(row).toBeDefined();
		expect(row?.ownerMemberId).toBe(keeperId);
	});

	it("keeps a guest invite's attribution on the keeper (#899)", async () => {
		// The drift-guard only proves the FK is DECLARED handled. Without the
		// re-point, deleting the absorbed membership SETs NULL the inviter, and
		// the VPM board silently drops "· by …" from the invite line.
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });
		const [guest] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Invited Guest" })
			.returning({ id: guests.id });
		if (!guest) throw new Error("Failed to insert guest");
		const [inv] = await testDb
			.insert(guestInvites)
			.values({
				clubId: seed.clubId,
				guestId: guest.id,
				meetingId: seed.meetingId,
				invitedByMemberId: absorbedId,
			})
			.returning({ id: guestInvites.id });
		if (!inv) throw new Error("Failed to insert invite");

		await collapse(keeperId, absorbedId);

		const [row] = await testDb
			.select({ invitedByMemberId: guestInvites.invitedByMemberId })
			.from(guestInvites)
			.where(eq(guestInvites.id, inv.id));
		expect(row).toBeDefined();
		expect(row?.invitedByMemberId).toBe(keeperId);
	});

	it("keeps the absorbed membership's feedback notes, on the keeper (#984)", async () => {
		// The FK cascades, so without the re-point the merge DELETES these notes —
		// a recipient loses what people wrote them. The drift-guard only proves
		// the FK is declared handled; this proves the move runs.
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });
		const notes = await testDb
			.insert(roleFeedbackNotes)
			.values([
				{
					clubId: seed.clubId,
					meetingId: seed.meetingId,
					recipientMemberId: absorbedId,
					roleLabel: "Timer",
					wentWell: "Clear signals",
				},
				{
					clubId: seed.clubId,
					meetingId: seed.meetingId,
					recipientMemberId: keeperId,
					roleLabel: "Grammarian",
					tryNext: "Announce the word earlier",
				},
			])
			.returning({ id: roleFeedbackNotes.id });

		await collapse(keeperId, absorbedId);

		const rows = await testDb
			.select({
				id: roleFeedbackNotes.id,
				recipientMemberId: roleFeedbackNotes.recipientMemberId,
			})
			.from(roleFeedbackNotes)
			.where(
				inArray(
					roleFeedbackNotes.id,
					notes.map((n) => n.id),
				),
			);
		// Both rows survive (a field check alone passes when the row is gone).
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.recipientMemberId === keeperId)).toBe(true);
	});

	it("keeps a feedback note submitted WHILE the merge runs, on the keeper", async () => {
		// The anonymous feedback form writes with no session, so nothing stops a
		// note for the absorbed membership landing mid-merge. Without a lock on
		// that row up front, the merge re-pointed the notes it could see, then its
		// final DELETE waited for this insert, and the cascade took the new note.
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });
		let noteId = "";
		// The real writer's shape: the club write lock, then the insert.
		const writer = await openBlockingTx(async (tx) => {
			await lockClubForWrite(tx, seed.clubId);
			const [n] = await tx
				.insert(roleFeedbackNotes)
				.values({
					clubId: seed.clubId,
					meetingId: seed.meetingId,
					recipientMemberId: absorbedId,
					roleLabel: "Timer",
					wentWell: "Landed mid-merge",
				})
				.returning({ id: roleFeedbackNotes.id });
			noteId = n.id;
		});

		const merge = collapse(keeperId, absorbedId);
		merge.catch(() => {});
		// Parked on the writer — on the club write lock with the fix, on the FK
		// lock at the final DELETE without it. Matching any statement catches both,
		// so the unfixed code fails the assertion below rather than timing out.
		await waitForLockWait("", writer.pid);
		await writer.commit();
		await merge;

		const [row] = await testDb
			.select({ recipientMemberId: roleFeedbackNotes.recipientMemberId })
			.from(roleFeedbackNotes)
			.where(eq(roleFeedbackNotes.id, noteId));
		expect(row?.recipientMemberId).toBe(keeperId);
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
		// that collapseMemberships re-points. If a future migration adds another FK
		// to members, this fails LOUDLY here — instead of silently cascade-deleting
		// or orphaning that data on the next merge.
		const HANDLED = new Set([
			"officer_terms.membership_id",
			"member_dues.membership_id",
			"meeting_attendance.member_id",
			// Planned attendance. The two boolean tables it superseded were
			// dropped in the same PR and left this set at that moment, not before:
			// it is compared for EXACT equality against the live catalog, so a
			// name lingering here after the drop fails just as loudly as a new FK
			// missing from it.
			"meeting_attendance_plan.member_id",
			"meeting_awards.member_id",
			"notifications.assigned_member_id",
			// #419 — attribution for a manual completion mark.
			"project_completion_marks.marked_by_member_id",
			"role_slots.assigned_member_id",
			"table_topics_speakers.member_id",
			// #529 — who owns a club action item.
			"club_action_items.owner_member_id",
			"guests.converted_membership_id",
			"activity_log.actor_member_id",
			// #510 — digital voting. `meeting_votes.voter_member_id` carries a
			// unique (session, voter), so it re-points via the delete-then-update
			// pattern; the other two re-point plainly.
			"meeting_vote_sessions.opened_by_member_id",
			"meeting_votes.voter_member_id",
			"meeting_votes.candidate_member_id",
			// #531 — Club Officer Training. Unique (membership, position,
			// program_year, period) and ON DELETE CASCADE, so it re-points via the
			// delete-then-update pattern. This guard is what caught it: the merge
			// would otherwise have destroyed the absorbed membership's training
			// credit and dropped the club below goal 9's four-officer bar.
			"officer_training_records.membership_id",
			// #730 — the Timer's measured times. Nullable attribution with no
			// member-unique constraint, so it re-points plainly. It matters beyond
			// tidiness: the overwrite floor treats an unknown recorder as NOT the
			// caller's own, so losing this on a merge would leave the merged member
			// unable to correct their own measurement.
			"meeting_timings.recorded_by_member_id",
			// #899 — who opened a guest's invite draft. Nullable attribution; the
			// table's unique is (guest, meeting), which carries no member, so it
			// re-points plainly.
			"guest_invites.invited_by_member_id",
			// #984 — anonymous role feedback. ON DELETE CASCADE with no
			// member-unique index, so it re-points plainly; without it a merge
			// would delete every note the absorbed membership received.
			"role_feedback_notes.recipient_member_id",
			// #723 — candidate disqualification. `candidate_member_id` sits inside a
			// unique (meeting, category, candidate), so it re-points via the
			// delete-then-update pattern; `disqualified_by_member_id` is nullable
			// attribution in no unique and re-points plainly. This guard is what
			// caught them: without the delete, merging two memberships both ruled
			// out on one meeting would violate the index and roll the WHOLE collapse
			// back, leaving the member unmergeable until someone found the row.
			"meeting_candidate_disqualifications.candidate_member_id",
			"meeting_candidate_disqualifications.disqualified_by_member_id",
			// #939 — mentorships. Both member columns are ON DELETE CASCADE and
			// sit inside the partial unique indexes on ACTIVE pairings, so they
			// re-point via delete-then-update, and a keeper↔absorbed pairing is
			// dropped rather than turned into a self-pairing. `created_by` is
			// nullable attribution and re-points plainly.
			"mentorships.mentor_member_id",
			"mentorships.mentee_member_id",
			"mentorships.created_by_member_id",
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

	it("merges two disqualified memberships instead of failing on the unique index (#723)", async () => {
		// The FK drift-guard above only proves the columns are NAMED. This proves
		// the delete-then-update runs, and it is the case that matters: without the
		// DELETE, the insert-or-update on a colliding pair violates
		// `meeting_candidate_dq_member_unique` and rolls back the WHOLE collapse —
		// so the member could not be merged at all until someone found the row by
		// hand. The collision is realistic rather than theoretical: a duplicate
		// membership is one human recorded twice, both can hold speaker slots on
		// one meeting, and the Vote Counter ruling "that speaker" out taps whichever
		// row the console showed them.
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		await testDb.insert(meetingCandidateDisqualifications).values([
			// The COLLIDING pair — same meeting, same category, both memberships.
			{
				meetingId: seed.meetingId,
				category: "best_speaker",
				candidateMemberId: keeperId,
				reason: "Keeper's ruling",
			},
			{
				meetingId: seed.meetingId,
				category: "best_speaker",
				candidateMemberId: absorbedId,
				reason: "Absorbed ruling",
			},
			// A row only the absorbed membership has, in another category — it must
			// SURVIVE the merge rather than being swept up with the collision.
			{
				meetingId: seed.meetingId,
				category: "best_table_topics",
				candidateMemberId: absorbedId,
				reason: "Absorbed elsewhere",
			},
			// And the attribution column, which is in no unique index.
			{
				meetingId: seed.meetingId,
				category: "best_evaluator",
				candidateMemberId: null,
				candidateGuestId: null,
				candidateWriteIn: "someone typed in",
				reason: "By the absorbed officer",
				disqualifiedByMemberId: absorbedId,
			},
		]);

		await testDb.transaction((tx) =>
			collapseMemberships(tx, seed.clubId, keeperId, absorbedId),
		);

		const rows = await testDb
			.select({
				category: meetingCandidateDisqualifications.category,
				candidate: meetingCandidateDisqualifications.candidateMemberId,
				by: meetingCandidateDisqualifications.disqualifiedByMemberId,
				reason: meetingCandidateDisqualifications.reason,
			})
			.from(meetingCandidateDisqualifications)
			.where(eq(meetingCandidateDisqualifications.meetingId, seed.meetingId));

		// The collision resolved to ONE row — the keeper's, reason and all.
		const speaker = rows.filter((r) => r.category === "best_speaker");
		expect(speaker).toEqual([
			expect.objectContaining({
				candidate: keeperId,
				reason: "Keeper's ruling",
			}),
		]);
		// The absorbed membership's OTHER ruling re-pointed rather than vanishing.
		expect(rows.filter((r) => r.category === "best_table_topics")).toEqual([
			expect.objectContaining({ candidate: keeperId }),
		]);
		// The attribution re-pointed too.
		expect(rows.filter((r) => r.category === "best_evaluator")).toEqual([
			expect.objectContaining({ by: keeperId }),
		]);
		// Nothing at all is left pointing at the absorbed membership — which is
		// also what makes the `members` DELETE at the end of the collapse possible.
		expect(
			rows.some((r) => r.candidate === absorbedId || r.by === absorbedId),
		).toBe(false);
	});

	it("keeps officer training credit through a merge, colliding rows and all (#531)", async () => {
		// The FK drift-guard above only proves the column is NAMED. This proves the
		// re-point runs — and it is the case that matters most, because
		// `officer_training_records` is ON DELETE CASCADE on `members`: without the
		// re-point the merge DESTROYS the absorbed membership's training credit,
		// silently dropping the club below goal 9's four-officer bar with no error
		// anywhere. The drift-guard caught this missing on the day the table landed.
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		// A COLLIDING pair — both memberships claim President, period 1, 2026 — plus
		// a distinct row on each side. The collision is the realistic case: a
		// duplicate membership is one human recorded twice, and whoever entered the
		// training may have picked a different row each period.
		await testDb.insert(officerTrainingRecords).values([
			{
				membershipId: keeperId,
				position: "president",
				programYear: 2026,
				period: 1,
				trainedOn: "2026-07-01",
			},
			{
				membershipId: absorbedId,
				position: "president",
				programYear: 2026,
				period: 1,
				trainedOn: "2026-07-02",
			},
			{
				membershipId: keeperId,
				position: "secretary",
				programYear: 2026,
				period: 1,
				trainedOn: "2026-07-03",
			},
			{
				membershipId: absorbedId,
				position: "treasurer",
				programYear: 2026,
				period: 2,
				trainedOn: "2026-12-04",
			},
		]);

		await testDb.transaction((tx) =>
			collapseMemberships(tx, seed.clubId, keeperId, absorbedId),
		);

		const survivors = await testDb
			.select({
				position: officerTrainingRecords.position,
				period: officerTrainingRecords.period,
				trainedOn: officerTrainingRecords.trainedOn,
				membershipId: officerTrainingRecords.membershipId,
			})
			.from(officerTrainingRecords)
			.where(eq(officerTrainingRecords.membershipId, keeperId));

		// Three rows, all on the keeper: the collision resolved to ONE (the
		// keeper's, by date), and the absorbed membership's Treasurer credit for
		// period 2 SURVIVED rather than being cascade-deleted.
		expect(survivors.map((r) => `${r.position}:${r.period}`).sort()).toEqual([
			"president:1",
			"secretary:1",
			"treasurer:2",
		]);
		expect(survivors.find((r) => r.position === "president")?.trainedOn).toBe(
			"2026-07-01",
		);
		// Nothing left pointing at the absorbed membership.
		expect(
			await testDb
				.select({ id: officerTrainingRecords.id })
				.from(officerTrainingRecords)
				.where(eq(officerTrainingRecords.membershipId, absorbedId)),
		).toHaveLength(0);
	});

	it("carries the absorbed row's audit attribution too, independently of the date (#531)", async () => {
		// `recorded_by` gets the same treatment as `trained_on` — one side ABSENT
		// rather than contradictory, so the null is filled instead of the row's
		// history being dropped. `coalesce` per column makes the two independent:
		// this fixture has the keeper holding the DATE and the absorbed row
		// holding the RECORDER, so a single shared guard would have carried
		// neither.
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });
		await testDb.insert(officerTrainingRecords).values([
			{
				membershipId: keeperId,
				position: "treasurer",
				programYear: 2026,
				period: 1,
				trainedOn: "2026-07-01",
				recordedBy: null,
			},
			{
				membershipId: absorbedId,
				position: "treasurer",
				programYear: 2026,
				period: 1,
				trainedOn: null,
				recordedBy: seed.adminUserId,
			},
		]);

		await testDb.transaction((tx) =>
			collapseMemberships(tx, seed.clubId, keeperId, absorbedId),
		);

		const rows = await testDb
			.select({
				membershipId: officerTrainingRecords.membershipId,
				trainedOn: officerTrainingRecords.trainedOn,
				recordedBy: officerTrainingRecords.recordedBy,
			})
			.from(officerTrainingRecords)
			.where(eq(officerTrainingRecords.membershipId, keeperId));

		expect(rows).toHaveLength(1);
		// The keeper's own date survived (not overwritten by the absorbed null)…
		expect(rows[0]?.trainedOn).toBe("2026-07-01");
		// …and the attribution the absorbed row carried was picked up.
		expect(rows[0]?.recordedBy).toBe(seed.adminUserId);
	});

	it("fills the keeper's missing date from the absorbed row on a colliding claim (#531)", async () => {
		// The fill-UPDATE only fires when the KEEPER's date is null and the
		// absorbed row has one. A plain "keeper wins" (the pattern borrowed from
		// `meeting_attendance_plan`) would silently downgrade a dated claim to
		// "date not recorded" — the case above (#531's own test) only exercises
		// "both sides dated", where the keeper's date already wins and this
		// branch of the UPDATE's WHERE (`k.trained_on IS NULL`) never runs.
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });

		await testDb.insert(officerTrainingRecords).values([
			{
				membershipId: keeperId,
				position: "secretary",
				programYear: 2026,
				period: 1,
				trainedOn: null,
			},
			{
				membershipId: absorbedId,
				position: "secretary",
				programYear: 2026,
				period: 1,
				trainedOn: "2026-07-05",
			},
		]);

		await testDb.transaction((tx) =>
			collapseMemberships(tx, seed.clubId, keeperId, absorbedId),
		);

		const rows = await testDb
			.select({
				membershipId: officerTrainingRecords.membershipId,
				trainedOn: officerTrainingRecords.trainedOn,
			})
			.from(officerTrainingRecords)
			.where(
				and(
					// Scoped to this test's own two memberships (#961).
					inArray(officerTrainingRecords.membershipId, [keeperId, absorbedId]),
					eq(officerTrainingRecords.position, "secretary"),
					eq(officerTrainingRecords.programYear, 2026),
					eq(officerTrainingRecords.period, 1),
				),
			);

		// The collision resolved to ONE row — the keeper's — and it now carries
		// the date the absorbed row had, rather than staying "date not recorded".
		expect(rows).toHaveLength(1);
		expect(rows[0]?.membershipId).toBe(keeperId);
		expect(rows[0]?.trainedOn).toBe("2026-07-05");
	});

	it("collapses two ballots by one human into one, and re-points the rest (#510)", async () => {
		// The FK drift-guard above only proves the columns are NAMED. This proves
		// the re-point actually runs — and that the unique (session, voter) index
		// does not blow the merge up when both memberships voted in one session.
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });
		const [session] = await testDb
			.insert(meetingVoteSessions)
			.values({
				meetingId: seed.meetingId,
				category: "best_speaker",
				openedByMemberId: absorbedId,
			})
			.returning({ id: meetingVoteSessions.id });

		// Both memberships voted in the SAME session — only possible because they
		// were, wrongly, two rows for one person. That is what the merge asserts.
		await testDb.insert(meetingVotes).values([
			{
				sessionId: session.id,
				voterMemberId: keeperId,
				candidateMemberId: seed.memberId,
			},
			{
				sessionId: session.id,
				voterMemberId: absorbedId,
				candidateMemberId: absorbedId,
			},
		]);

		await collapse(keeperId, absorbedId);

		const votes = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, session.id));
		// One human, one vote: the absorbed ballot is dropped, the keeper's stands.
		expect(votes).toHaveLength(1);
		expect(votes[0].voterMemberId).toBe(keeperId);

		// "Who opened this vote" survives the merge rather than going null.
		const [sessionAfter] = await testDb
			.select()
			.from(meetingVoteSessions)
			.where(eq(meetingVoteSessions.id, session.id));
		expect(sessionAfter.openedByMemberId).toBe(keeperId);
	});

	it("re-points a ballot CAST FOR the absorbed membership to the keeper (#510)", async () => {
		// The candidate side has no member-unique, so it re-points plainly — but
		// if it were skipped the vote would silently point at a deleted member.
		const keeperId = await addMembership({ name: "Keeper" });
		const absorbedId = await addMembership({ name: "Absorbed" });
		const [session] = await testDb
			.insert(meetingVoteSessions)
			.values({ meetingId: seed.meetingId, category: "best_evaluator" })
			.returning({ id: meetingVoteSessions.id });
		await testDb.insert(meetingVotes).values({
			sessionId: session.id,
			voterMemberId: seed.memberId,
			candidateMemberId: absorbedId,
		});

		await collapse(keeperId, absorbedId);

		const votes = await testDb
			.select()
			.from(meetingVotes)
			.where(eq(meetingVotes.sessionId, session.id));
		expect(votes).toHaveLength(1);
		expect(votes[0].candidateMemberId).toBe(keeperId);
	});

	describe("mentorships (#939)", () => {
		const pairs = async () =>
			(
				await testDb
					.select()
					.from(mentorships)
					.where(eq(mentorships.clubId, seed.clubId))
			).map((r) => ({
				mentor: r.mentorMemberId,
				mentee: r.menteeMemberId,
				focus: r.focus,
				ended: r.endedAt !== null,
				createdBy: r.createdByMemberId,
			}));

		it("drops the keeper↔absorbed pairing and keeps the absorbed member's other pairing, on the keeper", async () => {
			const keeperId = await addMembership({ name: "Keeper" });
			const absorbedId = await addMembership({ name: "Absorbed" });
			const thirdId = await addMembership({ name: "Third" });
			await testDb.insert(mentorships).values([
				// Would become a self-pairing: dropped, active or ended.
				{
					clubId: seed.clubId,
					mentorMemberId: keeperId,
					menteeMemberId: absorbedId,
					focus: "new_member",
				},
				{
					clubId: seed.clubId,
					mentorMemberId: absorbedId,
					menteeMemberId: keeperId,
					focus: "contest",
					endedAt: new Date(),
				},
				// The absorbed member's own mentee: must SURVIVE, on the keeper.
				{
					clubId: seed.clubId,
					mentorMemberId: absorbedId,
					menteeMemberId: thirdId,
					focus: "contest",
				},
			]);
			await collapse(keeperId, absorbedId);
			expect(await pairs()).toEqual([
				{
					mentor: keeperId,
					mentee: thirdId,
					focus: "contest",
					ended: false,
					createdBy: null,
				},
			]);
		});

		it("survives duplicate active pairings in both directions and both indexes, without rolling back", async () => {
			const keeperId = await addMembership({ name: "Keeper" });
			const absorbedId = await addMembership({ name: "Absorbed" });
			const otherId = await addMembership({ name: "Other" });
			const row = (
				mentor: string,
				mentee: string,
				focus: "new_member" | null,
				ended = false,
			) => ({
				clubId: seed.clubId,
				mentorMemberId: mentor,
				menteeMemberId: mentee,
				focus,
				endedAt: ended ? new Date() : null,
			});
			await testDb.insert(mentorships).values([
				// Keeper and absorbed both MENTOR `other`: focus set, and no focus.
				row(keeperId, otherId, "new_member"),
				row(absorbedId, otherId, "new_member"),
				row(keeperId, otherId, null),
				row(absorbedId, otherId, null),
				// Keeper and absorbed both MENTORED BY `other`: focus set, no focus.
				row(otherId, keeperId, "new_member"),
				row(otherId, absorbedId, "new_member"),
				row(otherId, keeperId, null),
				row(otherId, absorbedId, null),
				// Ended history duplicating an active keeper row: re-pointed, kept.
				row(absorbedId, otherId, "new_member", true),
			]);
			await collapse(keeperId, absorbedId);
			const after = await pairs();
			expect(after.filter((p) => !p.ended)).toHaveLength(4);
			expect(
				after.every((p) => p.mentor !== absorbedId && p.mentee !== absorbedId),
			).toBe(true);
			expect(after.filter((p) => p.ended)).toEqual([
				{
					mentor: keeperId,
					mentee: otherId,
					focus: "new_member",
					ended: true,
					createdBy: null,
				},
			]);
			const rows = await testDb
				.select()
				.from(members)
				.where(eq(members.id, absorbedId));
			expect(rows).toHaveLength(0);
		});

		it("re-points created_by from the absorbed membership to the keeper", async () => {
			const keeperId = await addMembership({ name: "Keeper" });
			const absorbedId = await addMembership({ name: "Absorbed" });
			const aId = await addMembership({ name: "A" });
			const bId = await addMembership({ name: "B" });
			await testDb.insert(mentorships).values({
				clubId: seed.clubId,
				mentorMemberId: aId,
				menteeMemberId: bId,
				createdByMemberId: absorbedId,
			});
			await collapse(keeperId, absorbedId);
			expect((await pairs())[0]?.createdBy).toBe(keeperId);
		});
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
