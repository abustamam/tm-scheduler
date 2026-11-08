/**
 * The invite draft's visit variables all use the INSTANT rule (#1547).
 *
 * `{visitCount}`, `{lastVisit}` and `{firstVisit}` must agree: a guest whose
 * only slot is a meeting that has not started yet has visited nothing, so none
 * of the three may show tonight's meeting. Does NOT cover the VP Membership
 * page rendering them (`vp-membership.test.tsx`).
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the suite skips without it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, meetingAttendance, meetings, roleSlots } from "#/db/schema";
import { guestInviteValues } from "#/lib/guest-invite-template";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadGuestPipeline } = await import("#/server/guest-pipeline-logic");

const TONIGHT = new Date("2031-06-10T19:00:00Z");
const LAST_WEEK = new Date("2031-06-03T19:00:00Z");
const BEFORE_START = new Date("2031-06-10T12:00:00Z");

describe.skipIf(!hasTestDb)("invite values, instant rule (#1547)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function meetingOn(at: Date) {
		const [m] = await testDb
			.insert(meetings)
			.values({ clubId: seed.clubId, scheduledAt: at, status: "scheduled" })
			.returning({ id: meetings.id });
		return m!.id;
	}
	async function guest(name: string) {
		const [g] = await testDb
			.insert(guests)
			.values(await withGuestPerson({ clubId: seed.clubId, name }, testDb))
			.returning({ id: guests.id });
		return g!.id;
	}
	async function valuesFor(guestId: string) {
		const row = (await loadGuestPipeline(seed.clubId, [], BEFORE_START)).find(
			(g) => g.id === guestId,
		);
		expect(row).toBeDefined();
		return guestInviteValues({
			guestName: "G",
			clubName: "C",
			meeting: { scheduledAt: TONIGHT, location: null },
			shareUrl: "u",
			joinLink: null,
			guest: row!,
			timeZone: "UTC",
		});
	}

	// protects=firstVisit, lastVisit and visitCount agree on one rule;
	// fails_when={firstVisit} shows a meeting that has not started while
	// {visitCount} says 0; no_claim=a guest with a started visit (next test).
	it("a guest whose only slot is today's not-yet-started meeting has no visit at all", async () => {
		await meetingOn(LAST_WEEK);
		const tonight = await meetingOn(TONIGHT);
		const id = await guest("Slot Tonight");
		await testDb.insert(roleSlots).values({
			meetingId: tonight,
			roleDefinitionId: seed.roleDefinitionId,
			assignedGuestId: id,
			status: "claimed",
		});
		const v = await valuesFor(id);
		expect(v.firstVisit).toBe("");
		expect(v.lastVisit).toBe("");
		expect(v.visitCount).toBe("0");
	});

	// protects=the positive control: a started visit fills all three;
	// fails_when=firstVisit is blanked for a real visitor; no_claim=none beyond protects.
	it("a guest who attended last week has a first visit, a last visit and a count of 1", async () => {
		const last = await meetingOn(LAST_WEEK);
		await meetingOn(TONIGHT);
		const id = await guest("Came Last Week");
		await testDb
			.insert(meetingAttendance)
			.values({ meetingId: last, guestId: id, status: "present" });
		const v = await valuesFor(id);
		expect(v.firstVisit).toBe("Jun 3");
		expect(v.lastVisit).toBe("Jun 3");
		expect(v.visitCount).toBe("1");
	});
});
