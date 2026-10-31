/**
 * DB-backed tests for the public guest RSVP write path (#1443):
 * `submitGuestRsvpLogic`, and the identity half it shares with the guest book.
 * `#/db` is mocked to the test client; the suite skips without a test database.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	guests,
	meetingAttendance,
	meetingGuestRsvps,
	meetings,
	people,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { TMOD_ROLE_KEY } from "#/lib/meeting-roles";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { captureGuestVisit, GUEST_BOOK_MAX_NEW_PER_WINDOW } = await import(
	"./guest-pipeline-logic"
);
const { submitGuestRsvpLogic } = await import("./guest-rsvp-logic");
const { guestRsvpSchema, RSVP_MEETING_REFUSED_MESSAGE } = await import(
	"./guest-rsvp-schemas"
);

const created: SeededClub[] = [];
afterEach(async () => {
	for (const c of created.splice(0)) {
		await cleanup(c.clubId, [c.adminUserId, c.memberUserId]);
	}
});

async function club(): Promise<SeededClub> {
	const c = await seedClub();
	created.push(c);
	return c;
}

const unique = () => `rsvp-${randomUUID()}@example.test`;

function rsvp(
	c: SeededClub,
	over: Partial<Parameters<typeof submitGuestRsvpLogic>[0]> = {},
	now?: Date,
) {
	return submitGuestRsvpLogic(
		{
			clubId: c.clubId,
			meetingId: c.meetingId,
			clientKey: randomUUID(),
			firstName: "Pat",
			email: null,
			phone: null,
			website: "",
			fillMs: 10_000,
			...over,
		},
		now,
	);
}

const guestsOf = (c: SeededClub) =>
	testDb.select().from(guests).where(eq(guests.clubId, c.clubId));
const rsvpsOf = (c: SeededClub) =>
	testDb
		.select()
		.from(meetingGuestRsvps)
		.where(eq(meetingGuestRsvps.clubId, c.clubId));

describe.skipIf(!hasTestDb)("submitGuestRsvp", () => {
	it("same first name + same email twice is one guest and one RSVP; the email stays off the Person", async () => {
		const c = await club();
		const email = unique();
		await rsvp(c, { email });
		await rsvp(c, { email }); // a different browser: new clientKey
		const gs = await guestsOf(c);
		expect(gs).toHaveLength(1);
		expect(await rsvpsOf(c)).toHaveLength(1);
		expect(gs[0]?.bookEmail).toBe(email);
		const [person] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, gs[0]?.personId ?? ""));
		expect(person?.email).toBeNull();
	});

	it("a first-name-only submit sent twice with one clientKey is one guest and one RSVP, same id", async () => {
		const c = await club();
		const clientKey = randomUUID();
		const a = await rsvp(c, { clientKey });
		const b = await rsvp(c, { clientKey });
		expect(await guestsOf(c)).toHaveLength(1);
		expect(await rsvpsOf(c)).toHaveLength(1);
		expect(a.confirmation?.rsvpId).toBeDefined();
		expect(b.confirmation?.rsvpId).toBe(a.confirmation?.rsvpId);
	});

	it("a different clientKey with no contact match is a new guest", async () => {
		const c = await club();
		await rsvp(c);
		await rsvp(c);
		expect(await guestsOf(c)).toHaveLength(2);
		expect(await rsvpsOf(c)).toHaveLength(2);
	});

	it("shares the hourly new-guest cap with the guest book", async () => {
		const c = await club();
		for (let i = 0; i < GUEST_BOOK_MAX_NEW_PER_WINDOW - 1; i++) {
			await captureGuestVisit({ clubId: c.clubId, name: `Book ${i}` });
		}
		await rsvp(c, { firstName: "Last One" });
		await expect(rsvp(c, { firstName: "One Too Many" })).rejects.toThrow(
			/too many guests/i,
		);
		await expect(
			captureGuestVisit({ clubId: c.clubId, name: "Also Refused" }),
		).rejects.toThrow(/too many guests/i);
		expect(await guestsOf(c)).toHaveLength(GUEST_BOOK_MAX_NEW_PER_WINDOW);
	});

	it("a filled honeypot or a fast submit writes nothing and answers success-shaped", async () => {
		const c = await club();
		expect(await rsvp(c, { website: "https://spam.example" })).toEqual({
			ok: true,
			confirmation: null,
		});
		expect(await rsvp(c, { fillMs: 500 })).toEqual({
			ok: true,
			confirmation: null,
		});
		expect(await rsvp(c, { fillMs: Number.NaN })).toEqual({
			ok: true,
			confirmation: null,
		});
		expect(await guestsOf(c)).toHaveLength(0);
		expect(await rsvpsOf(c)).toHaveLength(0);
	});

	it("refuses a cancelled, completed, past, or too-distant meeting, and one of another club", async () => {
		const c = await club();
		const other = await club();
		const set = (v: Partial<typeof meetings.$inferInsert>) =>
			testDb.update(meetings).set(v).where(eq(meetings.id, c.meetingId));

		await set({ status: "cancelled" });
		await expect(rsvp(c)).rejects.toThrow(RSVP_MEETING_REFUSED_MESSAGE);
		await set({ status: "completed" });
		await expect(rsvp(c)).rejects.toThrow(RSVP_MEETING_REFUSED_MESSAGE);
		await set({
			status: "scheduled",
			scheduledAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
		});
		await expect(rsvp(c)).rejects.toThrow(RSVP_MEETING_REFUSED_MESSAGE);
		await set({ scheduledAt: new Date(Date.now() + 61 * 24 * 60 * 60 * 1000) });
		await expect(rsvp(c)).rejects.toThrow(RSVP_MEETING_REFUSED_MESSAGE);
		await set({ scheduledAt: new Date(Date.now() + 59 * 24 * 60 * 60 * 1000) });
		await expect(rsvp(c)).resolves.toMatchObject({ ok: true });
		// A meeting id from another club is "not found", never an RSVP.
		await expect(rsvp(c, { meetingId: other.meetingId })).rejects.toThrow(
			/not found/i,
		);
		expect(await rsvpsOf(other)).toHaveLength(0);
	});

	it("an RSVP alone never makes a visit", async () => {
		const c = await club();
		await rsvp(c);
		const rows = await testDb
			.select()
			.from(meetingAttendance)
			.where(eq(meetingAttendance.meetingId, c.meetingId));
		expect(rows.filter((r) => r.guestId !== null)).toHaveLength(0);
	});

	it("returns the confirmation: location falls back to the club's, joinUrl and the Toastmaster's first name ride along", async () => {
		const c = await club();
		await testDb
			.update(clubs)
			.set({ defaultLocation: "Club Hall" })
			.where(eq(clubs.id, c.clubId));
		const first = await rsvp(c);
		expect(first.confirmation).toMatchObject({
			clubName: "Test Club",
			location: "Club Hall",
			joinUrl: null,
			toastmasterFirstName: null,
		});

		await testDb
			.update(meetings)
			.set({ location: "Room 4", joinUrl: "https://meet.example/abc" })
			.where(eq(meetings.id, c.meetingId));
		const [tmod] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: c.clubId,
				name: "Toastmaster of the Day",
				key: TMOD_ROLE_KEY,
				category: "leadership",
				isSpeakerRole: false,
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			meetingId: c.meetingId,
			roleDefinitionId: tmod?.id ?? "",
			status: "confirmed",
			assignedMemberId: c.memberId,
		});
		const second = await rsvp(c);
		expect(second.confirmation).toMatchObject({
			location: "Room 4",
			// Hybrid (location AND link): the link is not handed to a non-member.
			joinUrl: null,
			toastmasterFirstName: "Member",
		});
		await testDb
			.update(meetings)
			.set({ location: null })
			.where(eq(meetings.id, c.meetingId));
		await testDb
			.update(clubs)
			.set({ defaultLocation: null })
			.where(eq(clubs.id, c.clubId));
		const online = await rsvp(c);
		expect(online.confirmation).toMatchObject({
			location: null,
			joinUrl: "https://meet.example/abc",
		});
	});

	it("refuses an archived club and writes nothing", async () => {
		const c = await club();
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, c.clubId));
		await expect(rsvp(c)).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
		expect(await guestsOf(c)).toHaveLength(0);
	});

	it("an RSVP row cascades away with its guest", async () => {
		const c = await club();
		await rsvp(c);
		const [g] = await guestsOf(c);
		await testDb.delete(guests).where(eq(guests.id, g?.id ?? ""));
		expect(await rsvpsOf(c)).toHaveLength(0);
	});

	it("the retry key is per meeting: the same clientKey on a second meeting is its own RSVP", async () => {
		const c = await club();
		const [second] = await testDb
			.insert(meetings)
			.values({
				clubId: c.clubId,
				scheduledAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			})
			.returning({ id: meetings.id });
		const clientKey = randomUUID();
		const a = await rsvp(c, { clientKey });
		const b = await rsvp(c, { clientKey, meetingId: second?.id ?? "" });
		expect(b.confirmation?.rsvpId).toBeDefined();
		expect(b.confirmation?.rsvpId).not.toBe(a.confirmation?.rsvpId);
		const rows = await rsvpsOf(c);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.meetingId)).size).toBe(2);
	});

	it("a clientKey that is another guest's id attaches nothing to that guest", async () => {
		const c = await club();
		await captureGuestVisit({ clubId: c.clubId, name: "Existing Guest" });
		const [existing] = await guestsOf(c);
		// The request also carries the guest's id as an extra `guestId` field;
		// the schema strips it, and the logic never takes a guest id.
		const data = guestRsvpSchema.parse({
			clubId: c.clubId,
			meetingId: c.meetingId,
			clientKey: existing?.id,
			firstName: "Someone Else",
			fillMs: 10_000,
			guestId: existing?.id,
		});
		const result = await rsvp(c, {
			clientKey: data.clientKey,
			firstName: data.firstName,
			fillMs: data.fillMs,
		});
		expect(result.confirmation?.rsvpId).toBeDefined();
		const rows = await rsvpsOf(c);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.guestId).not.toBe(existing?.id);
	});

	it("a retry with the same clientKey is refused once the club is archived", async () => {
		const c = await club();
		const clientKey = randomUUID();
		await rsvp(c, { clientKey });
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, c.clubId));
		await expect(rsvp(c, { clientKey })).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});
});
