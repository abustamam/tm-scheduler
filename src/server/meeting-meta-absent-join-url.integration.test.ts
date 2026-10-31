/**
 * #1444, D6: the Edit meeting dialog omits `joinUrl` for a viewer whose payload
 * withholds it, so the writer must read absence as "unchanged", never "clear".
 * Asserts the stored column, not a payload.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMeetingMetaPatch } = await import("./meetings-logic");

const LINK = "https://zoom.us/j/1234567890";

describe.skipIf(!hasTestDb)("a save that omits joinUrl", () => {
	let club: SeededClub;
	beforeEach(async () => {
		club = await seedClub();
		await testDb
			.update(meetings)
			.set({ joinUrl: LINK })
			.where(eq(meetings.id, club.meetingId));
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	const stored = async () =>
		(
			await testDb
				.select({ joinUrl: meetings.joinUrl })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId))
		)[0]?.joinUrl;

	it("leaves the stored link unchanged", async () => {
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			theme: "Only the theme",
			wordOfTheDay: "ephemeral",
		});
		expect(await stored()).toBe(LINK);
	});

	it("still clears on an explicit blank", async () => {
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			joinUrl: "",
		});
		expect(await stored()).toBeNull();
	});
});
