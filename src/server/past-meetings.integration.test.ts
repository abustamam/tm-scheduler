/**
 * DB-backed tests for the past-meetings archive (#375). Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test_a \
 *     bunx vitest run --pool=threads --no-file-parallelism \
 *     src/server/past-meetings.integration.test.ts
 *
 * `#/db` is mocked to the test client so the logic module imports cleanly
 * without a production DATABASE_URL. Skipped when TEST_DATABASE_URL is unset.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, meetingAttendance, meetings, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadPastMeetings } = await import("#/server/past-meetings-logic");

/** Insert a meeting for the seeded club and return its id. */
async function addMeeting(
	clubId: string,
	iso: string,
	overrides: {
		status?: "scheduled" | "cancelled" | "completed";
		theme?: string;
		meetingNumber?: number;
	} = {},
): Promise<string> {
	const [row] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(iso),
			status: overrides.status ?? "completed",
			theme: overrides.theme ?? null,
			meetingNumber: overrides.meetingNumber ?? null,
		})
		.returning({ id: meetings.id });
	if (!row) throw new Error("Failed to insert meeting");
	return row.id;
}

describe.skipIf(!hasTestDb)("loadPastMeetings (#375)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		// Pin the club timezone so the url-key assertions are deterministic.
		await testDb
			.update(clubs)
			.set({ timezone: "America/Chicago" })
			.where(eq(clubs.id, seed.clubId));
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("returns only meetings before now, newest first", async () => {
		const old = await addMeeting(seed.clubId, "2026-01-07T19:00:00Z");
		const mid = await addMeeting(seed.clubId, "2026-02-04T19:00:00Z");
		const recent = await addMeeting(seed.clubId, "2026-03-04T19:00:00Z");

		const page = await loadPastMeetings({ clubId: seed.clubId });

		// The seeded fixture meeting is a week in the FUTURE — never in the archive.
		expect(page.meetings.map((m) => m.id)).toEqual([recent, mid, old]);
		expect(page.meetings.map((m) => m.id)).not.toContain(seed.meetingId);
		expect(page.hasMore).toBe(false);
	});

	it("excludes cancelled meetings", async () => {
		const held = await addMeeting(seed.clubId, "2026-01-07T19:00:00Z");
		const scrapped = await addMeeting(seed.clubId, "2026-01-14T19:00:00Z", {
			status: "cancelled",
		});

		const page = await loadPastMeetings({ clubId: seed.clubId });

		expect(page.meetings.map((m) => m.id)).toEqual([held]);
		expect(page.meetings.map((m) => m.id)).not.toContain(scrapped);
	});

	it("pages with limit/offset without skipping or repeating a row", async () => {
		const ids: string[] = [];
		for (let i = 1; i <= 5; i++) {
			ids.push(await addMeeting(seed.clubId, `2026-01-0${i}T19:00:00Z`));
		}
		const newestFirst = [...ids].reverse();

		const first = await loadPastMeetings({ clubId: seed.clubId, limit: 2 });
		expect(first.meetings.map((m) => m.id)).toEqual(newestFirst.slice(0, 2));
		expect(first.hasMore).toBe(true);

		const second = await loadPastMeetings({
			clubId: seed.clubId,
			limit: 2,
			offset: 2,
		});
		expect(second.meetings.map((m) => m.id)).toEqual(newestFirst.slice(2, 4));
		expect(second.hasMore).toBe(true);

		// Last page: exactly one row left and no further page.
		const third = await loadPastMeetings({
			clubId: seed.clubId,
			limit: 2,
			offset: 4,
		});
		expect(third.meetings.map((m) => m.id)).toEqual(newestFirst.slice(4));
		expect(third.hasMore).toBe(false);

		// Past the end: empty, not an error.
		const beyond = await loadPastMeetings({
			clubId: seed.clubId,
			limit: 2,
			offset: 10,
		});
		expect(beyond.meetings).toEqual([]);
		expect(beyond.hasMore).toBe(false);
	});

	it("scopes to the club — another club's history never leaks in", async () => {
		const other = await seedClub();
		try {
			const mine = await addMeeting(seed.clubId, "2026-01-07T19:00:00Z");
			const theirs = await addMeeting(other.clubId, "2026-01-08T19:00:00Z");

			const page = await loadPastMeetings({ clubId: seed.clubId });
			expect(page.meetings.map((m) => m.id)).toEqual([mine]);
			expect(page.meetings.map((m) => m.id)).not.toContain(theirs);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("honors a `before` cursor so the nav strip can page backwards", async () => {
		const a = await addMeeting(seed.clubId, "2026-01-07T19:00:00Z");
		const b = await addMeeting(seed.clubId, "2026-01-14T19:00:00Z");
		const c = await addMeeting(seed.clubId, "2026-01-21T19:00:00Z");

		const page = await loadPastMeetings({
			clubId: seed.clubId,
			before: new Date("2026-01-21T19:00:00Z"),
			limit: 5,
		});

		// Strictly before the cursor: c itself is excluded.
		expect(page.meetings.map((m) => m.id)).toEqual([b, a]);
		expect(page.meetings.map((m) => m.id)).not.toContain(c);
	});

	it("gives same-club-local-day meetings distinct url keys, plain dates otherwise", async () => {
		// 18:45 and 20:00 local on 2026-01-07 (America/Chicago).
		const early = await addMeeting(seed.clubId, "2026-01-08T00:45:00Z");
		const late = await addMeeting(seed.clubId, "2026-01-08T02:00:00Z");
		const solo = await addMeeting(seed.clubId, "2026-01-15T01:00:00Z");

		const page = await loadPastMeetings({ clubId: seed.clubId });
		const keyOf = (id: string) =>
			page.meetings.find((m) => m.id === id)?.urlKey;

		expect(keyOf(early)).toBe("2026-01-07-1845");
		expect(keyOf(late)).toBe("2026-01-07-2000");
		expect(keyOf(solo)).toBe("2026-01-14");
	});

	it("derives the meeting number from the club's anchor and leaves it null with no anchor", async () => {
		// No numbering anywhere in the club yet.
		const unnumbered = await addMeeting(seed.clubId, "2026-01-07T19:00:00Z");
		let page = await loadPastMeetings({ clubId: seed.clubId });
		expect(page.meetings.find((m) => m.id === unnumbered)?.meetingNumber).toBe(
			null,
		);

		// Freeze #10 on the anchor; the two later held meetings derive #11 and #12,
		// and a cancelled meeting in between consumes no number.
		await testDb
			.update(meetings)
			.set({ meetingNumber: 10 })
			.where(eq(meetings.id, unnumbered));
		await addMeeting(seed.clubId, "2026-01-14T19:00:00Z", {
			status: "cancelled",
		});
		const next = await addMeeting(seed.clubId, "2026-01-21T19:00:00Z");
		const after = await addMeeting(seed.clubId, "2026-01-28T19:00:00Z");

		page = await loadPastMeetings({ clubId: seed.clubId });
		const numberOf = (id: string) =>
			page.meetings.find((m) => m.id === id)?.meetingNumber;
		expect(numberOf(unnumbered)).toBe(10);
		expect(numberOf(next)).toBe(11);
		expect(numberOf(after)).toBe(12);
	});

	it("reports role fill, locked state, and whether minutes were recorded", async () => {
		const done = await addMeeting(seed.clubId, "2026-01-07T19:00:00Z", {
			status: "completed",
			theme: "Sea legs",
		});
		const open = await addMeeting(seed.clubId, "2026-01-14T19:00:00Z", {
			status: "scheduled",
		});
		await testDb.insert(roleSlots).values([
			{
				meetingId: done,
				roleDefinitionId: seed.roleDefinitionId,
				status: "confirmed",
			},
			{
				meetingId: open,
				roleDefinitionId: seed.roleDefinitionId,
				status: "open",
			},
			{
				meetingId: open,
				roleDefinitionId: seed.roleDefinitionId,
				slotIndex: 1,
				status: "claimed",
			},
		]);
		// Attendance saved for the completed meeting only.
		await testDb.insert(meetingAttendance).values({
			meetingId: done,
			memberId: seed.memberId,
			status: "present",
		});

		const page = await loadPastMeetings({ clubId: seed.clubId });
		const row = (id: string) => page.meetings.find((m) => m.id === id);

		expect(row(done)).toMatchObject({
			theme: "Sea legs",
			status: "completed",
			openSlots: 0,
			totalSlots: 1,
			hasMinutes: true,
		});
		expect(row(open)).toMatchObject({
			status: "scheduled",
			openSlots: 1,
			totalSlots: 2,
			hasMinutes: false,
		});
		expect(page.timezone).toBe("America/Chicago");
		expect(page.clubSlug).toBe(`test-club-${seed.clubId}`);
	});
});
