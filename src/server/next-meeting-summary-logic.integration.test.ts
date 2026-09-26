/**
 * DB-backed tests for the next-meeting summary behind the deck's "What's on
 * tap for next meeting" slide (#932).
 *
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/next-meeting-summary-logic.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	guests,
	meetings,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadNextMeetingSummary } = await import("./next-meeting-summary-logic");

/** Load the summary the way `loadMeetingDetail` does: from the meeting's own
 *  row, in its club's timezone, handed the current meeting's number. */
async function summaryAfter(
	meetingId: string,
	currentNumber: number | null = null,
) {
	const [row] = await testDb
		.select({
			id: meetings.id,
			clubId: meetings.clubId,
			scheduledAt: meetings.scheduledAt,
			timezone: clubs.timezone,
		})
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId));
	if (!row) throw new Error("no such meeting");
	return loadNextMeetingSummary(row, row.timezone, currentNumber);
}

const DAY = 24 * 60 * 60 * 1000;
/** A fixed local noon well in the future, so day boundaries never bite. */
const BASE = Date.UTC(2031, 2, 10, 18, 0); // 2031-03-10 18:00Z = 1 PM Chicago

describe.skipIf(!hasTestDb)("loadNextMeetingSummary (#932)", () => {
	let seeded: SeededClub;
	let presented: string;

	async function addMeeting(
		at: number,
		over: Partial<typeof meetings.$inferInsert> = {},
	): Promise<string> {
		const [row] = await testDb
			.insert(meetings)
			.values({
				clubId: seeded.clubId,
				scheduledAt: new Date(at),
				status: "scheduled",
				...over,
			})
			.returning({ id: meetings.id });
		return row.id;
	}

	beforeEach(async () => {
		seeded = await seedClub();
		// The seeded meeting (with its one open Timer slot) becomes the NEXT
		// meeting, a week after the one being presented.
		await testDb
			.update(meetings)
			.set({
				scheduledAt: new Date(BASE + 7 * DAY),
				location: "  Library Room B ",
				theme: "Momentum",
				meetingNumber: 57,
			})
			.where(eq(meetings.id, seeded.meetingId));
		presented = await addMeeting(BASE, { location: "Elsewhere" });
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	});

	it("summarises the next meeting: when, where, theme, number, roles", async () => {
		const [tm] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seeded.clubId,
				name: "Toastmaster of the Day",
				key: "toastmaster_of_the_day",
				category: "leadership",
				sortOrder: -10,
			})
			.returning({ id: roleDefinitions.id });
		const [speaker] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seeded.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
				sortOrder: 5,
			})
			.returning({ id: roleDefinitions.id });
		const [guest] = await testDb
			.insert(guests)
			.values({
				clubId: seeded.clubId,
				name: "Gus Guest",
				email: "gus-932@test.example",
				phone: "+1 555 0932",
			})
			.returning({ id: guests.id });
		await testDb.insert(roleSlots).values([
			{
				meetingId: seeded.meetingId,
				roleDefinitionId: tm.id,
				assignedMemberId: seeded.memberId,
				status: "claimed",
			},
			{
				meetingId: seeded.meetingId,
				roleDefinitionId: speaker.id,
				slotIndex: 0,
				assignedGuestId: guest.id,
				status: "claimed",
			},
			{
				meetingId: seeded.meetingId,
				roleDefinitionId: speaker.id,
				slotIndex: 1,
			},
		]);

		const next = await summaryAfter(presented);
		expect(next).toEqual({
			scheduledAt: new Date(BASE + 7 * DAY),
			location: "Library Room B",
			theme: "Momentum",
			meetingNumber: 57,
			urlKey: "2031-03-17",
			toastmaster: {
				label: "Toastmaster of the Day",
				names: ["Member User"],
				openCount: 0,
			},
			// Agenda order: Timer (sort 0) before Speaker (sort 5).
			roles: [
				{ label: "Timer", names: [], openCount: 1 },
				{ label: "Speaker", names: ["Gus Guest · Guest"], openCount: 1 },
			],
		});
		// Names only: the member's and the guest's contact exist, and ship nowhere.
		const shipped = JSON.stringify(next);
		expect(shipped).not.toContain("@test.example");
		expect(shipped).not.toContain("555");
	});

	it("skips a cancelled meeting in between", async () => {
		await addMeeting(BASE + 3 * DAY, { status: "cancelled" });
		expect((await summaryAfter(presented))?.urlKey).toBe("2031-03-17");
	});

	it("is relative to the PRESENTED meeting, not to now", async () => {
		// A meeting before the presented one is not "next".
		await addMeeting(BASE - 7 * DAY);
		expect((await summaryAfter(presented))?.urlKey).toBe("2031-03-17");
	});

	it("disambiguates a double-header's URL key with the time", async () => {
		await addMeeting(BASE + 7 * DAY + 2 * 60 * 60 * 1000);
		const next = await summaryAfter(presented);
		// 18:00Z is 1:00 PM in the club's default America/Chicago.
		expect(next?.urlKey).toBe("2031-03-17-1300");
	});

	it("reads the day in the CLUB's timezone", async () => {
		await testDb
			.update(clubs)
			.set({ timezone: "Pacific/Auckland" })
			.where(eq(clubs.id, seeded.clubId));
		// 18:00Z on the 17th is already the 18th in Auckland.
		expect((await summaryAfter(presented))?.urlKey).toBe("2031-03-18");
	});

	it("is null when nothing is scheduled after it", async () => {
		expect(await summaryAfter(seeded.meetingId)).toBeNull();
	});

	it("derives the next number from the current one when it stores none", async () => {
		await testDb
			.update(meetings)
			.set({ meetingNumber: null })
			.where(eq(meetings.id, seeded.meetingId));
		expect((await summaryAfter(presented, 56))?.meetingNumber).toBe(57);
		expect((await summaryAfter(presented, null))?.meetingNumber).toBeNull();
	});

	it("prefers the next meeting's own stored number", async () => {
		// Stored 57 in beforeEach; a current number that disagrees does not win.
		expect((await summaryAfter(presented, 10))?.meetingNumber).toBe(57);
	});

	it("never reaches into another club", async () => {
		const other = await seedClub();
		try {
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(BASE + DAY) })
				.where(eq(meetings.id, other.meetingId));
			expect((await summaryAfter(presented))?.urlKey).toBe("2031-03-17");
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});
});
