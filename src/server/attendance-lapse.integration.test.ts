/**
 * DB-backed tests for the attendance-lapse window (#530). Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run --pool=threads --no-file-parallelism \
 *     src/server/attendance-lapse.integration.test.ts
 *
 * These cover the rules SQL owns — which meetings enter the window, and which
 * members are scored. The scoring maths itself is unit-tested in
 * `src/lib/attendance-lapse.test.ts` with no database.
 *
 * `#/db` is mocked to the test client so the logic module imports cleanly
 * without a production DATABASE_URL. Skipped when TEST_DATABASE_URL is unset —
 * which is why a bare `bun run test` silently drops this file.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAttendance,
	meetings,
	members,
	roleSlots,
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

const { loadAttendanceLapse } = await import("#/server/reporting-logic");

const DAY = 24 * 60 * 60 * 1000;

/** A meeting `daysAgo` in the past. Defaults to a normal held meeting. */
async function addMeeting(
	clubId: string,
	daysAgo: number,
	status: "scheduled" | "cancelled" | "completed" = "completed",
): Promise<string> {
	const [row] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() - daysAgo * DAY),
			status,
		})
		.returning({ id: meetings.id });
	if (!row) throw new Error("Failed to insert meeting");
	return row.id;
}

async function mark(
	meetingId: string,
	memberId: string,
	status: "present" | "absent" | "excused",
) {
	await testDb
		.insert(meetingAttendance)
		.values({ meetingId, memberId, status });
}

/** An extra active roster member (every member needs a Person, ADR-0008). */
async function addMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [row] = await testDb
		.insert(members)
		.values({ clubId, personId, name, clubRole: "member", status: "active" })
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

describe.skipIf(!hasTestDb)("loadAttendanceLapse (#530)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		// Members are scored from `joined_at ?? created_at`. seedClub creates them
		// NOW while these fixtures backdate meetings into the past — an ordering
		// that cannot occur in production, where a member exists before the
		// meetings they are scored on. Backdate so the fixtures are realistic.
		await testDb
			.update(members)
			.set({ createdAt: new Date(Date.now() - 400 * DAY) })
			.where(eq(members.clubId, seed.clubId));
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/** The row for the seeded non-admin member. */
	async function memberRow() {
		const rows = await loadAttendanceLapse(seed.clubId);
		const row = rows.find((r) => r.memberId === seed.memberId);
		if (!row) throw new Error("seeded member missing from result");
		return row;
	}

	it("surfaces a member absent from the last three held meetings", async () => {
		// Oldest first so the three absences are the most recent.
		const older = await addMeeting(seed.clubId, 40);
		await mark(older, seed.memberId, "present");
		for (const d of [21, 14, 7]) {
			const id = await addMeeting(seed.clubId, d);
			await mark(id, seed.memberId, "absent");
		}

		const row = await memberRow();
		expect(row.streak).toBe(3);
		expect(row.isLapsed).toBe(true);
	});

	it("ignores cancelled meetings entirely", async () => {
		const held = await addMeeting(seed.clubId, 40);
		await mark(held, seed.memberId, "present");
		// Three cancelled meetings the member was marked absent at. If cancelled
		// meetings entered the window this would read as a 3-meeting lapse.
		for (const d of [21, 14, 7]) {
			const id = await addMeeting(seed.clubId, d, "cancelled");
			await mark(id, seed.memberId, "absent");
		}

		const row = await memberRow();
		expect(row.eligibleCount).toBe(1);
		expect(row.streak).toBe(0);
		expect(row.isLapsed).toBe(false);
	});

	it("ignores a meeting where nobody took the register", async () => {
		// This is missing data, NOT a club-wide absence. Three meetings with no
		// attendance rows at all, most recent — if they counted, the member who
		// attended everything recorded would read as a 3-meeting lapse.
		const held = await addMeeting(seed.clubId, 40);
		await mark(held, seed.memberId, "present");
		for (const d of [21, 14, 7]) await addMeeting(seed.clubId, d);

		const row = await memberRow();
		expect(row.eligibleCount).toBe(1);
		expect(row.streak).toBe(0);
		expect(row.isLapsed).toBe(false);
	});

	it("ignores meetings that have not happened yet", async () => {
		const held = await addMeeting(seed.clubId, 40);
		await mark(held, seed.memberId, "present");
		// Future meeting, register pre-filled. Must not count against anyone.
		const future = await addMeeting(seed.clubId, -7, "scheduled");
		await mark(future, seed.memberId, "absent");

		const row = await memberRow();
		expect(row.eligibleCount).toBe(1);
		expect(row.streak).toBe(0);
	});

	it("looks back over at most eight held meetings", async () => {
		// Ten held meetings, member absent from all of them.
		for (let i = 1; i <= 10; i++) {
			const id = await addMeeting(seed.clubId, i * 7);
			await mark(id, seed.memberId, "absent");
		}

		const row = await memberRow();
		// Absolute: proves the LIMIT exists and is 8, not merely "some limit".
		expect(row.eligibleCount).toBe(8);
		expect(row.streak).toBe(8);
	});

	it("excludes members who are no longer active", async () => {
		const held = await addMeeting(seed.clubId, 7);
		await mark(held, seed.memberId, "absent");
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, seed.memberId));

		const rows = await loadAttendanceLapse(seed.clubId);
		expect(rows.map((r) => r.memberId)).not.toContain(seed.memberId);
	});

	it("does not let another club's meetings into the window", async () => {
		const other = await seedClub();
		try {
			const held = await addMeeting(seed.clubId, 40);
			await mark(held, seed.memberId, "present");
			// Three held meetings in the OTHER club. They must not reach this club.
			for (const d of [21, 14, 7]) {
				const id = await addMeeting(other.clubId, d);
				await mark(id, other.memberId, "absent");
			}

			const row = await memberRow();
			expect(row.eligibleCount).toBe(1);
			expect(row.streak).toBe(0);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("ignores a meeting where only guests were logged", async () => {
		// Guest attendance rows carry a NULL member_id (ADR-0013). Without the
		// isNotNull(member_id) clause on the window join, a visitors-only night
		// enters the window and scores EVERY member not-present — flagging the
		// whole club as "stopped attending" on the strength of a guest register.
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Visitor" })
			.returning({ id: guests.id });
		if (!g) throw new Error("guest insert failed");

		const held = await addMeeting(seed.clubId, 40);
		await mark(held, seed.memberId, "present");
		for (const d of [21, 14, 7]) {
			const id = await addMeeting(seed.clubId, d);
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: id, guestId: g.id, status: "present" });
		}

		const row = await memberRow();
		expect(row.eligibleCount).toBe(1);
		expect(row.streak).toBe(0);
		expect(row.isLapsed).toBe(false);
	});

	it("does not report another club's members", async () => {
		// The window query's club scope is covered above; this pins the scope on
		// the MEMBERS query, which is a separate predicate. Without it, one club's
		// dashboard lists another club's roster and their attendance history.
		const other = await seedClub();
		try {
			const held = await addMeeting(seed.clubId, 7);
			await mark(held, seed.memberId, "present");
			const theirs = await addMeeting(other.clubId, 7);
			await mark(theirs, other.memberId, "absent");

			const rows = await loadAttendanceLapse(seed.clubId);
			const ids = rows.map((r) => r.memberId);
			expect(ids).not.toContain(other.memberId);
			expect(ids).not.toContain(other.adminMemberId);
			expect(ids).toHaveLength(2); // this club's admin + member, nobody else
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("counts a meeting ONCE however many people were marked at it", async () => {
		// Every other fixture in this file marks exactly ONE person per meeting,
		// so the window join returns one row per meeting whether or not it is
		// DISTINCT — the whole file passes with `selectDistinct` downgraded to
		// `select`. A real club marks its entire roster, and the duplicate rows
		// then eat the LIMIT: six attendees would collapse an 8-meeting window
		// to a single meeting counted eight times, and every absent member would
		// read as an 8-meeting lapse on their first missed week.
		const others = await Promise.all([
			addMember(seed.clubId, "Bea Roster"),
			addMember(seed.clubId, "Cal Roster"),
			addMember(seed.clubId, "Dee Roster"),
			addMember(seed.clubId, "Eli Roster"),
		]);
		const roster = [seed.memberId, seed.adminMemberId, ...others];

		// Three held meetings, the whole roster marked at each. The seeded member
		// came to the oldest and has missed the two since — a streak of 2, below
		// the threshold.
		const ids = [];
		for (const d of [21, 14, 7]) ids.push(await addMeeting(seed.clubId, d));
		for (const [i, meetingId] of ids.entries()) {
			for (const memberId of roster) {
				const absentee = memberId === seed.memberId && i > 0;
				await mark(meetingId, memberId, absentee ? "absent" : "present");
			}
		}

		const row = await memberRow();
		expect(row.eligibleCount).toBe(3);
		expect(row.streak).toBe(2);
		expect(row.isLapsed).toBe(false);
	});

	it("returns a row per member for a club with no attendance history", async () => {
		// A brand-new club: the window query returns nothing, so the mark query
		// runs `inArray(meeting_id, [])`. Every active member must still come
		// back — scored against an empty window, nobody lapsed — rather than the
		// VPE dashboard 500ing on its first load.
		const rows = await loadAttendanceLapse(seed.clubId);
		expect(rows.map((r) => r.memberId).sort()).toEqual(
			[seed.memberId, seed.adminMemberId].sort(),
		);
		for (const row of rows) {
			expect(row.eligibleCount).toBe(0);
			expect(row.streak).toBe(0);
			expect(row.rate).toBeNull();
			expect(row.lastSeenAt).toBeNull();
			expect(row.isLapsed).toBe(false);
		}
	});

	it("does not flag a brand-new member added through the app", async () => {
		// `joined_at` is written ONLY by the CSV import; every member created
		// through the app has it NULL. Treating NULL as "has always been here"
		// flagged a newcomer as having missed the whole window on day one.
		for (let i = 1; i <= 8; i++) {
			const id = await addMeeting(seed.clubId, i * 7);
			await mark(id, seed.memberId, "present");
		}
		const fresh = await addMember(seed.clubId, "Brand New");
		const [raw] = await testDb
			.select({ joinedAt: members.joinedAt })
			.from(members)
			.where(eq(members.id, fresh));
		expect(raw?.joinedAt).toBeNull(); // the shape production actually creates

		const rows = await loadAttendanceLapse(seed.clubId);
		const newcomer = rows.find((r) => r.memberId === fresh);
		expect(newcomer).toBeDefined();
		expect(newcomer?.streak).toBe(0);
		expect(newcomer?.isLapsed).toBe(false);
	});

	it("treats holding a role as being there", async () => {
		// #218 decoupled role-holding from attendance, so running the meeting as
		// Toastmaster writes NO attendance row. Without corroboration the member
		// who ran every recent meeting reads as "never recorded present" while the
		// Overdue-for-a-role panel below correctly shows them as engaged.
		for (const d of [21, 14, 7]) {
			const id = await addMeeting(seed.clubId, d);
			await mark(id, seed.adminMemberId, "present"); // register was taken
			await testDb.insert(roleSlots).values({
				meetingId: id,
				roleDefinitionId: seed.roleDefinitionId,
				assignedMemberId: seed.memberId,
				status: "confirmed",
			});
		}

		const row = await memberRow();
		expect(row.streak).toBe(0);
		expect(row.isLapsed).toBe(false);
	});

	it("lets an explicit absent record beat the role inference", async () => {
		// A human saying "they were not here" outranks the inference.
		for (const d of [21, 14, 7]) {
			const id = await addMeeting(seed.clubId, d);
			await mark(id, seed.memberId, "absent");
			await testDb.insert(roleSlots).values({
				meetingId: id,
				roleDefinitionId: seed.roleDefinitionId,
				assignedMemberId: seed.memberId,
				status: "confirmed",
			});
		}

		const row = await memberRow();
		expect(row.streak).toBe(3);
		expect(row.isLapsed).toBe(true);
	});

	it("scores a member only from their join date", async () => {
		await testDb
			.update(members)
			.set({ joinedAt: new Date(Date.now() - 10 * DAY) })
			.where(eq(members.id, seed.memberId));
		// Four held meetings; only the two most recent fall after the join date.
		for (const d of [28, 21, 7, 3]) {
			const id = await addMeeting(seed.clubId, d);
			await mark(id, seed.memberId, "absent");
		}

		const row = await memberRow();
		expect(row.eligibleCount).toBe(2);
		expect(row.streak).toBe(2);
		expect(row.isLapsed).toBe(false);
	});
});
