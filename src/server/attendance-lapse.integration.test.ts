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
import { meetingAttendance, meetings, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
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

describe.skipIf(!hasTestDb)("loadAttendanceLapse (#530)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
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
