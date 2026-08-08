/**
 * DB-backed integration tests for the VP-Membership guest pipeline (#208 /
 * ADR-0018): guest-book capture (create-or-find + attendance), derived visits
 * (including participation — #374), edit/delete (#364), manual stage
 * transitions, and convert-to-member (Person dedup, membership create, slot
 * re-point, stage=joined, picker exclusion, activity log).
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the whole suite skips when
 * that env is unset.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	guests,
	meetingAttendance,
	meetings,
	members,
	people,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { toStoredPhone } from "#/lib/phone";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/**
 * A phone number no other test run has used.
 *
 * `cleanup` only deletes `people` rows that ended up with a membership, so a
 * test whose convert links somewhere unexpected leaves an orphan behind. Person
 * dedup is now deterministic (oldest-first, #488), which means a stale row
 * sharing a hard-coded number wins every LATER run — a fixture that poisons
 * itself. Unique digits per run keep each test's Person its own.
 */
function uniquePhone(): string {
	const digits = randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "0");
	return `555${digits}`;
}

const {
	applyConvertGuestToMember,
	applyDeleteGuest,
	applySetGuestStage,
	applyUpdateGuest,
	captureGuestVisit,
	loadGuestPipeline,
} = await import("#/server/guest-pipeline-logic");
const { applyAssignGuestToSlot, listClubGuests } = await import(
	"#/server/guests-logic"
);

/**
 * A guest signing the book AT a meeting, then that meeting receding into the
 * past — i.e. one real visit.
 *
 * Since #319 an attendance row is written ONLY for a meeting happening today,
 * so two visits necessarily happen on two different DAYS. Aging the meeting
 * after the capture lets one test simulate that without touching the clock; the
 * attendance row it wrote is untouched and still points at that meeting.
 */
async function captureAtTodaysMeeting(
	input: Parameters<typeof captureGuestVisit>[0],
): Promise<{
	meetingId: string;
	res: Awaited<ReturnType<typeof captureGuestVisit>>;
}> {
	const meetingId = await seedMeetingLaterToday(input.clubId);
	const res = await captureGuestVisit(input);
	await testDb
		.update(meetings)
		.set({ scheduledAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
		.where(eq(meetings.id, meetingId));
	return { meetingId, res };
}

/** Insert a second, sooner meeting so the next capture resolves against IT. */
async function seedSoonerMeeting(clubId: string, daysOut = 1): Promise<string> {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000),
			status: "scheduled",
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("Failed to seed meeting");
	return m.id;
}

/** Insert a meeting that has already HAPPENED (the seeded one is 7 days out). */
async function seedPastMeeting(
	clubId: string,
	daysAgo: number,
	status: "scheduled" | "cancelled" = "scheduled",
): Promise<string> {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
			status,
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("Failed to seed meeting");
	return m.id;
}

/**
 * A meeting LATER TODAY in the club's own timezone (23:59 local). The visit
 * derivation compares club-local DATES, so this counts as having happened even
 * though the wall clock hasn't reached it — the "VPM opens the minutes at 18:45
 * for a 19:00 meeting" case from #374.
 */
async function seedMeetingLaterToday(clubId: string): Promise<string> {
	const [club] = await testDb
		.select({ timezone: clubs.timezone })
		.from(clubs)
		.where(eq(clubs.id, clubId))
		.limit(1);
	const tz = club?.timezone ?? "America/Chicago";
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: sql`((date_trunc('day', now() at time zone ${tz}::text) + interval '23 hours 59 minutes') at time zone ${tz}::text)`,
			status: "scheduled",
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("Failed to seed meeting");
	return m.id;
}

/** A bare club guest — no attendance, no participation anywhere. */
async function seedGuest(clubId: string, name: string): Promise<string> {
	const [g] = await testDb
		.insert(guests)
		.values({ clubId, name })
		.returning({ id: guests.id });
	if (!g) throw new Error("Failed to seed guest");
	return g.id;
}

/** A claimed role slot on `meetingId` held by `guestId`. */
async function seedGuestRoleSlot(
	meetingId: string,
	roleDefinitionId: string,
	guestId: string,
): Promise<string> {
	const [s] = await testDb
		.insert(roleSlots)
		.values({
			meetingId,
			roleDefinitionId,
			assignedGuestId: guestId,
			status: "claimed",
		})
		.returning({ id: roleSlots.id });
	if (!s) throw new Error("Failed to seed role slot");
	return s.id;
}

async function attendanceForGuest(guestId: string) {
	return testDb
		.select({ meetingId: meetingAttendance.meetingId })
		.from(meetingAttendance)
		.where(eq(meetingAttendance.guestId, guestId));
}

async function pipelineRow(clubId: string, guestId: string) {
	const row = (await loadGuestPipeline(clubId)).find((g) => g.id === guestId);
	expect(row).toBeDefined();
	return row!;
}

describe.skipIf(!hasTestDb)("guest pipeline (#208)", () => {
	let seed: SeededClub;
	// People inserted DIRECTLY by a test (not via a membership). `cleanup` only
	// removes people reachable from this club's members, so without this these
	// rows outlive the run and accumulate in tm_test forever — and a stale row
	// sharing a phone silently changes which Person the oldest-first dedup picks.
	let strayPeople: string[] = [];

	/** Insert a Person for a test and register it for teardown. */
	async function trackedPerson(values: {
		name: string;
		email?: string | null;
		phone?: string | null;
	}): Promise<string> {
		const [p] = await testDb
			.insert(people)
			.values(values)
			.returning({ id: people.id });
		if (!p) throw new Error("Failed to insert person");
		strayPeople.push(p.id);
		return p.id;
	}

	beforeEach(async () => {
		seed = await seedClub();
		strayPeople = [];
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		if (strayPeople.length > 0) {
			await testDb.delete(people).where(inArray(people.id, strayPeople));
		}
	});

	describe("capture (guest book)", () => {
		it("creates a prospect + an attendance row against TODAY's meeting", async () => {
			// Attendance is only written for a meeting happening today (#319), so
			// the fixture must schedule one — the seeded club meeting is 7 days out.
			const today = await seedMeetingLaterToday(seed.clubId);
			const res = await captureGuestVisit({
				clubId: seed.clubId,
				name: "  Jamie Rivera  ",
				phone: "(555) 123-4567",
			});
			expect(res.created).toBe(true);
			expect(res.attendanceRecorded).toBe(true);
			expect(res.meetingId).toBe(today);

			const [g] = await testDb
				.select()
				.from(guests)
				.where(eq(guests.id, res.guestId))
				.limit(1);
			expect(g).toMatchObject({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				stage: "prospect",
				// E.164 even though this club never set a country code (#397): the
				// stored value IS the dedup key, so it can't depend on the spelling.
				phone: "+15551234567",
			});

			const att = await attendanceForGuest(res.guestId);
			expect(att).toHaveLength(1);
			expect(att[0]!.meetingId).toBe(today);
		});

		it("dedups by PHONE across formats — reuses the guest, adds a new visit", async () => {
			// Two visits on two different days — only a same-day meeting yields an
			// attendance row (#319).
			const { meetingId: m1, res: first } = await captureAtTodaysMeeting({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				phone: "555-123-4567",
			});
			const { meetingId: m2, res: second } = await captureAtTodaysMeeting({
				clubId: seed.clubId,
				name: "Jamie R.",
				phone: "(555) 123.4567",
			});

			expect(second.created).toBe(false);
			expect(second.guestId).toBe(first.guestId);
			expect(second.meetingId).toBe(m2);

			const clubGuests = await testDb
				.select()
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(clubGuests).toHaveLength(1);

			const att = await attendanceForGuest(first.guestId);
			expect(att.map((a) => a.meetingId).sort()).toEqual([m1, m2].sort());
		});

		it("dedups by EMAIL when phone differs; a total mismatch creates a new guest", async () => {
			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Pat Lee",
				email: "Pat@Example.com",
				phone: "555-000-1111",
			});
			const sameEmail = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Pat Lee",
				email: "pat@example.com", // case-insensitive match
				phone: "555-999-8888", // different phone
			});
			expect(sameEmail.created).toBe(false);
			expect(sameEmail.guestId).toBe(first.guestId);

			const fresh = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Someone Else",
				email: "else@example.com",
				phone: "555-222-3333",
			});
			expect(fresh.created).toBe(true);
			expect(fresh.guestId).not.toBe(first.guestId);
		});

		it("still creates the guest when the club has no resolvable meeting", async () => {
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seed.meetingId));

			const res = await captureGuestVisit({
				clubId: seed.clubId,
				name: "No Meeting Guest",
				phone: "555-444-5555",
			});
			expect(res.created).toBe(true);
			expect(res.meetingId).toBeNull();
			expect(res.attendanceRecorded).toBe(false);
			expect(await attendanceForGuest(res.guestId)).toHaveLength(0);
		});
	});

	/**
	 * #397: the dedup key is the E.164 form, and the promotion to E.164 now
	 * always applies — `loadClubDefaultCountryCode` falls back to the app default
	 * for a club that never set one (`seedClub` doesn't). Before this, a club with
	 * no country code stored `(555) 123-4567` as typed and `+1 (555) 123-4567` as
	 * `+15551234567`: one phone, two keys, two "1 visit" prospects.
	 */
	describe("phone dedup across +country-code spellings (#397)", () => {
		/** The issue's own acceptance test, end to end. */
		it("one guest with 2 visits when the same number is typed with and without +1", async () => {
			// Two visits on two days; `captureAtTodaysMeeting` ages each meeting
			// after the capture, so both are already past and the derivation
			// counts them (#374).
			const { res: first } = await captureAtTodaysMeeting({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				phone: "(555) 123-4567",
			});
			expect(first.created).toBe(true);

			// Second visit, a different meeting — an officer types the country code.
			const { res: second } = await captureAtTodaysMeeting({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				phone: "+1 (555) 123-4567",
			});
			expect(second.created).toBe(false);
			expect(second.guestId).toBe(first.guestId);

			const clubGuests = await testDb
				.select()
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(clubGuests).toHaveLength(1);

			const row = await pipelineRow(seed.clubId, first.guestId);
			expect(row.visitCount).toBe(2);
		});

		it.each([
			["+1 (555) 123-4567"],
			["+1 555 123 4567"],
			["+15551234567"],
			["1 (555) 123-4567"],
			["1-555-123-4567"],
			["15551234567"],
			["(555) 123-4567"],
			["555-123-4567"],
			["555.123.4567"],
			["5551234567"],
			["001 555 123 4567"],
		])("reuses the guest when the second visit types %s", async (spelling) => {
			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				phone: "(555) 123-4567",
			});
			await seedSoonerMeeting(seed.clubId);
			const second = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				phone: spelling,
			});
			expect(second.created).toBe(false);
			expect(second.guestId).toBe(first.guestId);
		});

		it("does NOT merge two numbers that differ by a real country code", async () => {
			// The rejected fix — compare the last 10 digits — would make these one
			// guest. `+44 20 7946 0958` and `+1 (207) 946-0958` are two people.
			const uk = await captureGuestVisit({
				clubId: seed.clubId,
				name: "London Visitor",
				phone: "+44 20 7946 0958",
			});
			const us = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Maine Visitor",
				phone: "+1 (207) 946-0958",
			});
			expect(us.created).toBe(true);
			expect(us.guestId).not.toBe(uk.guestId);

			const stored = await testDb
				.select({ phone: guests.phone })
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(stored.map((g) => g.phone).sort()).toEqual([
				"+12079460958",
				"+442079460958",
			]);
		});

		it("dedups on the CLUB's country code, not on +1", async () => {
			// A club outside NANP: the local spelling is the trunk-0 form, and the
			// same digits under +1 stay a different number.
			await testDb
				.update(clubs)
				.set({ defaultCountryCode: "+44" })
				.where(eq(clubs.id, seed.clubId));

			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Alex Fenn",
				phone: "020 7946 0958",
			});
			await seedSoonerMeeting(seed.clubId);
			const second = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Alex Fenn",
				phone: "+44 20 7946 0958",
			});
			expect(second.created).toBe(false);
			expect(second.guestId).toBe(first.guestId);

			const [g] = await testDb
				.select({ phone: guests.phone })
				.from(guests)
				.where(eq(guests.id, first.guestId));
			expect(g.phone).toBe("+442079460958");

			// Same national digits, different country → a different guest.
			const other = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Not Alex",
				phone: "+1 207 946 0958",
			});
			expect(other.created).toBe(true);
			expect(other.guestId).not.toBe(first.guestId);
		});
	});

	describe("derived visits", () => {
		it("computes visitCount + firstVisitAt from attendance (no stored counter)", async () => {
			// Two visits on two different days. `captureAtTodaysMeeting` ages each
			// meeting after the capture, so both are past by the time we read.
			const { res: first } = await captureAtTodaysMeeting({
				clubId: seed.clubId,
				name: "Repeat Visitor",
				phone: "555-777-8888",
			});
			await captureAtTodaysMeeting({
				clubId: seed.clubId,
				name: "Repeat Visitor",
				phone: "555-777-8888",
			});

			const row = await pipelineRow(seed.clubId, first.guestId);
			expect(row.visitCount).toBe(2);
			expect(row.firstVisitAt).toBeInstanceOf(Date);

			// A guest with no attendance derives zero visits / null first-visit.
			const [orphan] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name: "Never Attended" })
				.returning({ id: guests.id });
			const pipeline2 = await loadGuestPipeline(seed.clubId);
			const orphanRow = pipeline2.find((g) => g.id === orphan!.id);
			expect(orphanRow!.visitCount).toBe(0);
			expect(orphanRow!.firstVisitAt).toBeNull();
		});

		/**
		 * The #319 rule, stated directly.
		 *
		 * Before it, `resolveCurrentMeeting`'s fallback to the NEXT upcoming
		 * meeting meant an advance sign-up wrote `status: "present"` against a
		 * meeting the guest had not attended. `guestVisits` date-gates its own
		 * derivation, so the VP-Membership pipeline hid it — but `minutes-logic`
		 * reads `meeting_attendance` with NO date gate, so the guest appeared in
		 * that meeting's official minutes as present and was emailed them.
		 *
		 * Linking the guest book from the public club page turned that from an edge
		 * case into the expected flow, so the row is no longer written at all.
		 */
		it("an advance sign-up creates the guest but NO attendance row", async () => {
			// The seeded club meeting is 7 days out and nothing is scheduled today.
			const res = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Plans To Visit",
				phone: uniquePhone(),
			});

			// The prospect still exists — the VPE must see who is coming.
			expect(res.created).toBe(true);
			expect(res.attendanceRecorded).toBe(false);
			expect(res.meetingId).toBeNull();
			const [g] = await testDb
				.select()
				.from(guests)
				.where(eq(guests.id, res.guestId))
				.limit(1);
			expect(g?.stage).toBe("prospect");

			// ...but nothing claims they attended anything.
			expect(await attendanceForGuest(res.guestId)).toHaveLength(0);

			// And the row does NOT appear once that meeting's date passes — the
			// defect was that it started counting as a real visit on the day.
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
				.where(eq(meetings.id, seed.meetingId));
			const row = await pipelineRow(seed.clubId, res.guestId);
			expect(row.visitCount).toBe(0);
			expect(row.firstVisitAt).toBeNull();
		});
	});

	// #374: taking part IS visiting. The derivation reads role_slots and
	// table_topics_speakers alongside attendance — and still writes nothing (the
	// "holding a slot never sets attendance" rule of #218 is untouched).
	describe("participation counts as a visit (#374)", () => {
		it("counts a guest who only HELD A ROLE at a meeting that has happened", async () => {
			const past = await seedPastMeeting(seed.clubId, 7);
			const guestId = await seedGuest(seed.clubId, "Role Only");
			await seedGuestRoleSlot(past, seed.roleDefinitionId, guestId);

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(1);
			expect(row.firstVisitAt).toBeInstanceOf(Date);
			// Derived, never stored: no attendance row was written for them (#218).
			expect(await attendanceForGuest(guestId)).toHaveLength(0);
		});

		it("counts a guest who only SPOKE AT TABLE TOPICS at a meeting that has happened", async () => {
			const past = await seedPastMeeting(seed.clubId, 5);
			const guestId = await seedGuest(seed.clubId, "Topics Only");
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: past, guestId });

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(1);
			expect(row.firstVisitAt).toBeInstanceOf(Date);
			expect(await attendanceForGuest(guestId)).toHaveLength(0);
		});

		it("does NOT count a FUTURE meeting (penciled in ≠ visited), nor a cancelled one", async () => {
			const guestId = await seedGuest(seed.clubId, "Penciled In");
			// The seeded meeting is 7 days out — a future role and a future Table
			// Topics slot are plans, not visits.
			await seedGuestRoleSlot(seed.meetingId, seed.roleDefinitionId, guestId);
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: seed.meetingId, guestId });
			// A cancelled past meeting never happened either.
			const cancelled = await seedPastMeeting(seed.clubId, 14, "cancelled");
			await seedGuestRoleSlot(cancelled, seed.roleDefinitionId, guestId);

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(0);
			expect(row.firstVisitAt).toBeNull();
		});

		it("does NOT count an ATTENDANCE row on a future meeting, nor on a cancelled one", async () => {
			const guestId = await seedGuest(seed.clubId, "Booked Ahead");
			// The guest book resolves the UPCOMING meeting when none is today, so a
			// walk-up today writes attendance against next week's meeting. Same rule
			// as a penciled-in role: it's a visit on the day, not before it.
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: seed.meetingId, guestId, status: "present" });
			const cancelled = await seedPastMeeting(seed.clubId, 10, "cancelled");
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: cancelled, guestId, status: "present" });

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(0);
			expect(row.firstVisitAt).toBeNull();
		});

		it("counts a meeting scheduled LATER TODAY in the club's timezone", async () => {
			// #374 verbatim: the VPM opens VP Membership at 18:45 to set up the
			// minutes for a 19:00 meeting. The guest holding Timer is a visitor —
			// the compare is on the club-local DATE, not the wall clock.
			const tonight = await seedMeetingLaterToday(seed.clubId);

			const timerId = await seedGuest(seed.clubId, "Tonight Timer");
			await seedGuestRoleSlot(tonight, seed.roleDefinitionId, timerId);
			const timer = await pipelineRow(seed.clubId, timerId);
			expect(timer.visitCount).toBe(1);
			expect(timer.firstVisitAt).toBeInstanceOf(Date);

			const topicsId = await seedGuest(seed.clubId, "Tonight Topics");
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: tonight, guestId: topicsId });
			expect((await pipelineRow(seed.clubId, topicsId)).visitCount).toBe(1);

			// The guest-book scan at the door still counts the moment it lands.
			const bookId = await seedGuest(seed.clubId, "Tonight Walk-Up");
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: tonight, guestId: bookId, status: "present" });
			expect((await pipelineRow(seed.clubId, bookId)).visitCount).toBe(1);
		});

		it("counts a meeting ONCE when the guest has attendance AND a role slot on it", async () => {
			const past = await seedPastMeeting(seed.clubId, 3);
			const guestId = await seedGuest(seed.clubId, "Both Sources");
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: past, guestId, status: "present" });
			await seedGuestRoleSlot(past, seed.roleDefinitionId, guestId);
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: past, guestId });

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(1);
		});

		it("derives firstVisitAt as the EARLIEST qualifying meeting across sources", async () => {
			const older = await seedPastMeeting(seed.clubId, 30);
			const newer = await seedPastMeeting(seed.clubId, 2);
			const guestId = await seedGuest(seed.clubId, "Two Visits");
			await seedGuestRoleSlot(older, seed.roleDefinitionId, guestId);
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: newer, guestId, status: "present" });

			const row = await pipelineRow(seed.clubId, guestId);
			expect(row.visitCount).toBe(2);
			const [oldMeeting] = await testDb
				.select({ scheduledAt: meetings.scheduledAt })
				.from(meetings)
				.where(eq(meetings.id, older));
			expect(row.firstVisitAt?.getTime()).toBe(
				oldMeeting!.scheduledAt.getTime(),
			);
		});
	});

	// #364: a typo'd guest was permanent — there was no update or delete path.
	describe("edit + delete (#364)", () => {
		it("updates a guest's name/email/phone, normalizing the phone to E.164 (#295)", async () => {
			const guestId = await seedGuest(seed.clubId, "Tpyo Nmae");

			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "  Typo Fixed  ",
				email: "  fixed@example.com  ",
				phone: "+1 (555) 010-2030",
			});

			const [g] = await testDb
				.select({ name: guests.name, email: guests.email, phone: guests.phone })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g).toMatchObject({
				name: "Typo Fixed",
				email: "fixed@example.com",
				phone: "+15550102030",
			});
		});

		it("clears contact when the edit sends empty values", async () => {
			const guestId = await seedGuest(seed.clubId, "Has Contact");
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "Has Contact",
				email: "drop@example.com",
				phone: "+15550001111",
			});
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "Has Contact",
				email: null,
				phone: null,
			});
			const [g] = await testDb
				.select({ email: guests.email, phone: guests.phone })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g).toMatchObject({ email: null, phone: null });
		});

		it("stores a goes-by name, and stores a blank one as NULL (#486)", async () => {
			// Guests get nudged like anyone else, so the draft greeting needs the
			// same "goes by" escape hatch. Blank must land as NULL, not "" —
			// `greetingName` has to see "nobody told us" and fall back.
			const guestId = await seedGuest(seed.clubId, "Robert Smith");
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "Robert Smith",
				preferredName: "  Bob  ",
			});
			const [set] = await testDb
				.select({ preferredName: guests.preferredName })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(set?.preferredName).toBe("Bob");

			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "Robert Smith",
				preferredName: "   ",
			});
			const [cleared] = await testDb
				.select({ preferredName: guests.preferredName })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(cleared?.preferredName).toBeNull();
		});

		it("serves the stored goes-by name back to the pipeline view (#486)", async () => {
			// The WRITE half above asserts the column; this is the READ half, and
			// the only thing standing between it and the VP Membership edit form,
			// whose "Goes by" input renders `guest.preferredName`. Without this the
			// loader could select the wrong column (or map null) and the field
			// would render permanently blank — which then SAVES as null, silently
			// wiping the name on the next edit. The write tests all read the row
			// straight off `testDb`, so none of them see this hop.
			const namedId = await seedGuest(seed.clubId, "Robert Smith");
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId: namedId,
				name: "Robert Smith",
				preferredName: "Bob",
			});
			const plainId = await seedGuest(seed.clubId, "Plain Guest");

			expect((await pipelineRow(seed.clubId, namedId)).preferredName).toBe(
				"Bob",
			);
			// Nobody recorded one ⇒ null, so `greetingName` falls back to the first
			// token. The loader must not invent a value here.
			expect(
				(await pipelineRow(seed.clubId, plainId)).preferredName,
			).toBeNull();
		});

		it("rejects an empty name, and a guest outside the caller's club", async () => {
			const guestId = await seedGuest(seed.clubId, "Real Guest");
			await expect(
				applyUpdateGuest({ clubId: seed.clubId, guestId, name: "   " }),
			).rejects.toThrow(/name is required/i);
			await expect(
				applyUpdateGuest({ clubId: randomUUID(), guestId, name: "Nope" }),
			).rejects.toThrow(/not found/i);
		});

		it("deletes a guest, resets the slots they held to Open, and drops their minutes rows", async () => {
			const guestId = await seedGuest(seed.clubId, "Delete Me");
			await applyAssignGuestToSlot({
				slotId: seed.slotId,
				guestId,
				actorMemberId: null,
			});
			const past = await seedPastMeeting(seed.clubId, 4);
			await testDb
				.insert(meetingAttendance)
				.values({ meetingId: past, guestId, status: "present" });
			await testDb
				.insert(tableTopicsSpeakers)
				.values({ meetingId: past, guestId });

			// The pipeline surfaces the held-slot count so the UI can warn first.
			expect((await pipelineRow(seed.clubId, guestId)).heldSlotCount).toBe(1);

			const res = await applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			expect(res.slotsReopened).toBe(1);

			expect(
				await testDb.select().from(guests).where(eq(guests.id, guestId)),
			).toHaveLength(0);

			// The slot is genuinely Open again — never "claimed" by nobody.
			const [slot] = await testDb
				.select({
					status: roleSlots.status,
					assignedGuestId: roleSlots.assignedGuestId,
					assignedMemberId: roleSlots.assignedMemberId,
					claimedAt: roleSlots.claimedAt,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			expect(slot).toMatchObject({
				status: "open",
				assignedGuestId: null,
				assignedMemberId: null,
				claimedAt: null,
			});

			// Minutes rows cascade with the guest — nothing dangles.
			expect(await attendanceForGuest(guestId)).toHaveLength(0);
			expect(
				await testDb
					.select()
					.from(tableTopicsSpeakers)
					.where(eq(tableTopicsSpeakers.guestId, guestId)),
			).toHaveLength(0);

			// Each reopened slot is logged as a release (mirrors applyMemberRemove).
			const log = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.targetId, seed.slotId),
						eq(activityLog.action, "release"),
					),
				);
			expect(log).toHaveLength(1);
		});

		it("BLOCKS deleting a guest who has been converted to a member", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Now A Member",
				phone: "555-606-7070",
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: null,
			});

			await expect(
				applyDeleteGuest({
					clubId: seed.clubId,
					guestId,
					actorMemberId: null,
				}),
			).rejects.toThrow(/member/i);
			expect(
				await testDb.select().from(guests).where(eq(guests.id, guestId)),
			).toHaveLength(1);
		});

		it("rejects deleting a guest outside the caller's club", async () => {
			const guestId = await seedGuest(seed.clubId, "Other Club Guest");
			await expect(
				applyDeleteGuest({
					clubId: randomUUID(),
					guestId,
					actorMemberId: null,
				}),
			).rejects.toThrow(/not found/i);
		});

		it("rejects an edit that would collide with another guest's phone or email", async () => {
			// `captureGuestVisit` dedups on phone→email, so two club guests sharing
			// either one make the next guest-book submission ambiguous — it would
			// split the returning visitor's history across both rows.
			await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie",
				phone: "+15551234567",
				email: "jamie@example.com",
			});
			const otherId = await seedGuest(seed.clubId, "Jamie Rivera");

			await expect(
				applyUpdateGuest({
					clubId: seed.clubId,
					guestId: otherId,
					name: "Jamie Rivera",
					phone: "+1 (555) 123-4567", // same digits, different formatting
				}),
			).rejects.toThrow(/already/i);
			await expect(
				applyUpdateGuest({
					clubId: seed.clubId,
					guestId: otherId,
					name: "Jamie Rivera",
					email: "JAMIE@example.com", // case-insensitive collision
				}),
			).rejects.toThrow(/already/i);

			// The row is untouched, and editing a guest's OWN contact still works.
			const [g] = await testDb
				.select({ phone: guests.phone, email: guests.email })
				.from(guests)
				.where(eq(guests.id, otherId));
			expect(g).toMatchObject({ phone: null, email: null });
			await expect(
				applyUpdateGuest({
					clubId: seed.clubId,
					guestId: otherId,
					name: "Jamie Rivera",
					phone: "+15559998888",
				}),
			).resolves.toMatchObject({ ok: true });
			await expect(
				applyUpdateGuest({
					clubId: seed.clubId,
					guestId: otherId,
					name: "Jamie R.",
					phone: "555-999-8888", // its own number — not a collision
				}),
			).resolves.toMatchObject({ ok: true });
		});

		// The delete is a read-then-write over role_slots, and `reassignSlot` /
		// `claimSlot` are PUBLIC, no-session server fns — so a visitor can land on
		// the same slot mid-delete. The conditional UPDATE is the race guard
		// (same standard as `removeOpenRoleSlots` / `reassignSlotCore`).
		it("leaves a slot alone when it is reassigned to a member mid-delete", async () => {
			const guestId = await seedGuest(seed.clubId, "Racy Guest");
			await applyAssignGuestToSlot({
				slotId: seed.slotId,
				guestId,
				actorMemberId: null,
			});

			// A public reassign takes the slot for a member, uncommitted.
			const writer = await openBlockingTx(async (tx) => {
				await tx
					.update(roleSlots)
					.set({
						assignedMemberId: seed.memberId,
						assignedGuestId: null,
						status: "claimed",
						claimedAt: new Date(),
					})
					.where(eq(roleSlots.id, seed.slotId));
			});

			// The delete reads the slot as still guest-held, then blocks on the
			// writer's row lock; the writer commits into that gap.
			const pending = applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			pending.catch(() => {});
			try {
				await waitForLockWait('update "role_slots"', writer.pid);
			} finally {
				await writer.commit();
			}
			const res = await pending;

			// Nothing was reopened — the slot no longer matched "held by this guest".
			expect(res.slotsReopened).toBe(0);
			const [slot] = await testDb
				.select({
					status: roleSlots.status,
					assignedGuestId: roleSlots.assignedGuestId,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			// Never "open" while still showing the member's name — that state lets
			// anyone silently claim the slot out from under them.
			expect(slot).toMatchObject({
				status: "claimed",
				assignedGuestId: null,
				assignedMemberId: seed.memberId,
			});

			// And no `release` entry blaming the deleted guest for a slot they lost.
			const log = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.targetId, seed.slotId),
						eq(activityLog.action, "release"),
					),
				);
			expect(log).toHaveLength(0);

			// The guest itself is still deleted — that part was never in doubt.
			expect(
				await testDb.select().from(guests).where(eq(guests.id, guestId)),
			).toHaveLength(0);
		});

		it("loses to a convert-to-member that commits mid-delete", async () => {
			const guestId = await seedGuest(seed.clubId, "Converting Now");

			// Tab B converts the guest while tab A's delete is in flight.
			const writer = await openBlockingTx(async (tx) => {
				await tx
					.update(guests)
					.set({ stage: "joined" })
					.where(eq(guests.id, guestId));
			});

			const pending = applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			pending.catch(() => {});
			try {
				// This writer holds the GUESTS row lock, so the delete parks on its
				// opening `select ... from "guests" ... for update`, not on the
				// role_slots sweep (this guest holds no slot).
				await waitForLockWait("for update", writer.pid);
			} finally {
				await writer.commit();
			}

			// "A converted guest is NEVER deleted" must hold across the interleaving.
			await expect(pending).rejects.toThrow(/member/i);
			expect(
				await testDb.select().from(guests).where(eq(guests.id, guestId)),
			).toHaveLength(1);
		});
	});

	describe("manual stage transitions", () => {
		it("moves a guest between prospect/following_up/lost", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Stage Mover",
				phone: "555-321-0000",
			});
			await applySetGuestStage({
				clubId: seed.clubId,
				guestId,
				stage: "following_up",
			});
			const [g] = await testDb
				.select({ stage: guests.stage })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g!.stage).toBe("following_up");
		});

		it("rejects a stage change on a converted (joined) guest", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Joined Already",
				phone: "555-111-0000",
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			await expect(
				applySetGuestStage({ clubId: seed.clubId, guestId, stage: "lost" }),
			).rejects.toThrow(/already joined/i);
		});
	});

	describe("Person dedup on convert (#488)", () => {
		it("does NOT fuse two humans who share a phone number", async () => {
			// The bug: a member brings their spouse, both write the household mobile
			// in the guest book. Matching on digits alone converted the guest onto
			// the member's Person — and `members`/`speeches`/`path_enrollments` are
			// all Person-scoped, so every speech and Pathways enrollment the newcomer
			// ever records would have filed under the wrong human.
			const shared = uniquePhone();
			const spouse = await trackedPerson({
				name: "Jane Doe",
				phone: toStoredPhone(shared, "1"),
			});

			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "John Doe",
				phone: shared,
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(res.personId).not.toBe(spouse);
			const [p] = await testDb
				.select({ name: people.name })
				.from(people)
				.where(eq(people.id, res.personId));
			expect(p?.name).toBe("John Doe");
		});

		it("still fuses onto a phone match when the name agrees", async () => {
			// The guard must not cost us the dedupe it qualifies.
			const shared = uniquePhone();
			const self = await trackedPerson({
				name: "Jamie Rivera",
				phone: toStoredPhone(shared, "1"),
			});

			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie R.",
				phone: shared,
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(res.personId).toBe(self);
		});

		it("scans PAST an older phone match whose name disagrees", async () => {
			// The heart of the fix, and previously unpinned: every fixture seeded
			// exactly ONE row per phone, so `candidates.find(namesAgree)` could have
			// been `candidates[0]` and the oldest-first ordering could have been
			// deleted, with the whole suite still green.
			const shared = uniquePhone();
			const older = await trackedPerson({
				name: "Jane Doe",
				phone: toStoredPhone(shared, "1"),
			});
			const newer = await trackedPerson({
				name: "John Doe",
				phone: toStoredPhone(shared, "1"),
			});

			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "John Doe",
				phone: shared,
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(res.personId).toBe(newer);
			expect(res.personId).not.toBe(older);
		});

		it("prefers an email match over a phone match", async () => {
			// Email identifies one human; a phone is a household fact. When they
			// disagree the email is the one to trust.
			const shared = uniquePhone();
			const email = `both-${randomUUID()}@example.com`;
			const byPhone = await trackedPerson({
				name: "Pat Doe",
				phone: toStoredPhone(shared, "1"),
			});
			const byEmail = await trackedPerson({ name: "Pat Doe", email });

			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Pat Doe",
				phone: shared,
				email,
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(res.personId).toBe(byEmail);
			expect(res.personId).not.toBe(byPhone);
		});

		it("reuses the EMAIL match even when a phone match also exists", async () => {
			// Pins the email-leads-over-phone reorder inside `findGuestByContact`.
			// Swapping the two blocks back to phone-first must break something.
			const shared = uniquePhone();
			const email = `lead-${randomUUID()}@example.com`;
			const byPhone = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Alex Stone",
				phone: shared,
			});
			const byEmail = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Alex Stone",
				email,
			});
			expect(byEmail.guestId).not.toBe(byPhone.guestId);

			// Carries BOTH keys: the older row matches on phone, the newer on email.
			const both = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Alex Stone",
				email,
				phone: shared,
			});
			expect(both.created).toBe(false);
			expect(both.guestId).toBe(byEmail.guestId);
		});

		it("lets an admin move a guest onto a shared phone when names disagree", async () => {
			// User-visible behaviour change: this edit used to be refused outright.
			const shared = uniquePhone();
			await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jane Roe",
				phone: shared,
			});
			const otherId = await seedGuest(seed.clubId, "John Roe");

			await expect(
				applyUpdateGuest({
					clubId: seed.clubId,
					guestId: otherId,
					name: "John Roe",
					phone: shared,
				}),
			).resolves.toMatchObject({ ok: true });

			const [g] = await testDb
				.select({ phone: guests.phone })
				.from(guests)
				.where(eq(guests.id, otherId));
			expect(g?.phone).toBe(toStoredPhone(shared, "1"));
		});

		it("still refuses the edit when the names DO agree", async () => {
			const shared = uniquePhone();
			await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				phone: shared,
			});
			const otherId = await seedGuest(seed.clubId, "Jamie Rivera");

			await expect(
				applyUpdateGuest({
					clubId: seed.clubId,
					guestId: otherId,
					name: "Jamie R.",
					phone: shared,
				}),
			).rejects.toThrow(/already/i);
		});

		it("scans PAST an older same-phone GUEST whose name disagrees", async () => {
			// Mirror of the Person-side scan test. Without it the guest-side
			// `byPhone.find(...)` could be `byPhone[0]` and the suite stays green.
			const shared = uniquePhone();
			const jane = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jane Roe",
				phone: shared,
			});
			const john = await captureGuestVisit({
				clubId: seed.clubId,
				name: "John Roe",
				phone: shared,
			});
			expect(john.guestId).not.toBe(jane.guestId);

			// "John R." agrees with John only — Jane is the OLDER row on that phone.
			const again = await captureGuestVisit({
				clubId: seed.clubId,
				name: "John R.",
				phone: shared,
			});
			expect(again.created).toBe(false);
			expect(again.guestId).toBe(john.guestId);
			expect(again.guestId).not.toBe(jane.guestId);
		});

		it("links the OLDEST agreeing Person when two share a phone", async () => {
			// Pins the deterministic ORDER BY. Insert the newer row FIRST and then
			// backdate the other, so heap order disagrees with createdAt order —
			// otherwise a seq scan returns the right answer without any ORDER BY.
			const shared = uniquePhone();
			const newer = await trackedPerson({
				name: "Jamie Rivera",
				phone: toStoredPhone(shared, "1"),
			});
			const older = await trackedPerson({
				name: "Jamie Rivera",
				phone: toStoredPhone(shared, "1"),
			});
			await testDb
				.update(people)
				.set({ createdAt: new Date("2020-01-01T00:00:00Z") })
				.where(eq(people.id, older));

			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				phone: shared,
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			expect(res.personId).toBe(older);
			expect(res.personId).not.toBe(newer);
		});

		it("does NOT fuse onto an email shared by two people (ADR-0008)", async () => {
			// A family address is real, and ADR-0008 is explicit: match on email only
			// when it resolves to exactly one person, never auto-merge on an email
			// shared by 2+. Otherwise promoting email to the FIRST key would just
			// move the household fusion from the phone branch to the email branch.
			const shared = `family-${randomUUID()}@example.com`;
			const one = await trackedPerson({ name: "Pat Family", email: shared });
			const two = await trackedPerson({ name: "Sam Family", email: shared });

			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Sam Family",
				email: shared,
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			// Neither existing Person is claimed — a fresh one is minted, which the
			// superadmin merge tool can fuse deliberately later.
			expect(res.personId).not.toBe(one);
			expect(res.personId).not.toBe(two);
			const [p] = await testDb
				.select({ name: people.name })
				.from(people)
				.where(eq(people.id, res.personId));
			expect(p?.name).toBe("Sam Family");
		});

		it("keeps two guests on one phone as two separate prospects", async () => {
			// Same root cause on the guest side: collapsing them into one row merges
			// their attendance and undercounts the VP-Membership funnel.
			const shared = uniquePhone();
			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jane Roe",
				phone: shared,
			});
			const second = await captureGuestVisit({
				clubId: seed.clubId,
				name: "John Roe",
				phone: shared,
			});

			expect(second.created).toBe(true);
			expect(second.guestId).not.toBe(first.guestId);
		});
	});

	describe("one membership per person per club (#489)", () => {
		it("rejects a second membership for the same person and club", async () => {
			const [person] = await testDb
				.insert(people)
				.values({ name: "Solo Member" })
				.returning({ id: people.id });
			const personId = person?.id ?? "";
			await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name: "Solo Member" });

			await expect(
				testDb
					.insert(members)
					.values({ clubId: seed.clubId, personId, name: "Solo Member" }),
			).rejects.toThrow();
		});

		it("survives two concurrent converts that resolve to the same Person", async () => {
			// The race the issue describes: both transactions read "no membership",
			// both insert. Before the unique index the club ended up with two roster
			// rows for one human — the duplicate class #329 built `mergePeople` to
			// unpick by hand. Run for real rather than asserting the SELECT, because
			// a check-then-insert always LOOKS correct when run serially.
			const shared = uniquePhone();
			const email = `race-${randomUUID()}@example.com`;
			const [person] = await testDb
				.insert(people)
				.values({
					name: "Casey Lane",
					email,
					phone: toStoredPhone(shared, "1"),
				})
				.returning({ id: people.id });

			// Two distinct guest rows (one carries only email, the other only phone)
			// that both dedupe onto that one Person.
			const byEmail = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Casey Lane",
				email,
			});
			const byPhone = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Casey Lane",
				phone: shared,
			});
			expect(byPhone.guestId).not.toBe(byEmail.guestId);

			const results = await Promise.all([
				applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId: byEmail.guestId,
					actorMemberId: seed.adminMemberId,
				}),
				applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId: byPhone.guestId,
					actorMemberId: seed.adminMemberId,
				}),
			]);

			// Both callers succeed and agree on one membership — the loser of the
			// race re-reads the winner's row instead of erroring or double-adding.
			expect(results[0].personId).toBe(person?.id);
			expect(results[1].personId).toBe(person?.id);
			expect(results[0].membershipId).toBe(results[1].membershipId);

			const rows = await testDb
				.select({ id: members.id })
				.from(members)
				.where(
					and(
						eq(members.clubId, seed.clubId),
						eq(members.personId, person?.id ?? ""),
					),
				);
			expect(rows).toHaveLength(1);
		});

		it("does not double-add a CONTACTLESS guest converted twice at once", async () => {
			// The unique index only bites once both racers resolve the SAME Person.
			// A guest with neither email nor phone (both optional on the public book)
			// makes each racer mint a FRESH Person, so the two membership inserts
			// carry different person_ids and the index never fires. Serializing on
			// the guest row is what actually closes it.
			const guestId = await seedGuest(seed.clubId, "No Contact At All");

			const results = await Promise.allSettled([
				applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
				applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			]);

			// Exactly one caller wins; the loser is told the guest already joined.
			const ok = results.filter((r) => r.status === "fulfilled");
			expect(ok).toHaveLength(1);
			const rejected = results.find((r) => r.status === "rejected");
			expect(String((rejected as PromiseRejectedResult).reason)).toMatch(
				/already been converted/i,
			);

			// And the club has ONE roster row for that human, not two.
			const [g] = await testDb
				.select({ membershipId: guests.convertedMembershipId })
				.from(guests)
				.where(eq(guests.id, guestId));
			const rows = await testDb
				.select({ id: members.id })
				.from(members)
				.where(
					and(
						eq(members.clubId, seed.clubId),
						eq(members.name, "No Contact At All"),
					),
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.id).toBe(g?.membershipId);
		});

		it("re-reads the winner's row when it LOSES the insert race", async () => {
			// The `Promise.all` case above happens to serialize, so it never reaches
			// the recovery branch. Force it: hold a transaction open that has already
			// inserted the membership, let the convert's SELECT miss it (READ
			// COMMITTED can't see an uncommitted row), then commit. The convert's
			// INSERT is parked on the unique index at that moment; it wakes to a
			// conflict, gets zero rows from DO NOTHING, and must recover by reading
			// rather than throwing "Failed to create membership".
			const email = `loser-${randomUUID()}@example.com`;
			const [person] = await testDb
				.insert(people)
				.values({ name: "Robin Park", email })
				.returning({ id: people.id });
			const personId = person?.id ?? "";
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Robin Park",
				email,
			});

			// The winner: inserts the membership, then holds the transaction open so
			// its row lock — and its invisibility to READ COMMITTED — both persist.
			let winnerId = "";
			const winner = await openBlockingTx(async (tx) => {
				const [row] = await tx
					.insert(members)
					.values({ clubId: seed.clubId, personId, name: "Robin Park" })
					.returning({ id: members.id });
				winnerId = row?.id ?? "";
			});

			const convert = applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			// Poll for the real thing rather than sleeping a guessed interval: the
			// convert has passed its SELECT and is now parked on the unique index.
			await waitForLockWait('insert into "members"', winner.pid);
			await winner.commit();

			const res = await convert;
			expect(res.personId).toBe(personId);
			expect(res.membershipId).toBe(winnerId);

			const rows = await testDb
				.select({ id: members.id })
				.from(members)
				.where(
					and(eq(members.clubId, seed.clubId), eq(members.personId, personId)),
				);
			expect(rows).toHaveLength(1);
		});
	});

	describe("convert to member", () => {
		it("carries a goes-by name onto both the Person and the Membership (#486)", async () => {
			// Recorded while they were a guest, but true of the human — it has to
			// survive the promotion. Assert BOTH inserts: a single-table assertion
			// passes while the other one silently drops it.
			const guestId = await seedGuest(seed.clubId, "Robert Smith");
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "Robert Smith",
				preferredName: "Bob",
			});

			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			const [p] = await testDb
				.select({ preferredName: people.preferredName })
				.from(people)
				.where(eq(people.id, res.personId));
			expect(p?.preferredName).toBe("Bob");
			const [m] = await testDb
				.select({ preferredName: members.preferredName })
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(m?.preferredName).toBe("Bob");
		});

		it("seeds the goes-by name when the guest dedupes onto an EXISTING Person", async () => {
			// The Person INSERT never runs on this branch, so without an explicit
			// seed the person-level value is lost — and with the cross-club read
			// being a coalesce onto people.preferred_name, losing it means every
			// OTHER club greets them wrong (#486).
			const email = `dedupe-${randomUUID()}@example.com`;
			const [existing] = await testDb
				.insert(people)
				.values({ name: "Robert Smith", email, preferredName: null })
				.returning({ id: people.id });

			const guestId = await seedGuest(seed.clubId, "Robert Smith");
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "Robert Smith",
				email,
				preferredName: "Bob",
			});

			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			expect(res.personId).toBe(existing?.id);

			const [p] = await testDb
				.select({ preferredName: people.preferredName })
				.from(people)
				.where(eq(people.id, res.personId));
			expect(p?.preferredName).toBe("Bob");
		});

		it("does not overwrite a goes-by name the matched Person already has", async () => {
			const email = `keep-${randomUUID()}@example.com`;
			const [existing] = await testDb
				.insert(people)
				.values({ name: "Robert Smith", email, preferredName: "Rob" })
				.returning({ id: people.id });

			const guestId = await seedGuest(seed.clubId, "Robert Smith");
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "Robert Smith",
				email,
				preferredName: "Bob",
			});

			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			const [p] = await testDb
				.select({ preferredName: people.preferredName })
				.from(people)
				.where(eq(people.id, existing?.id ?? ""));
			expect(p?.preferredName).toBe("Rob");
		});

		it("creates a membership, re-points slots, joins the guest, and logs it", async () => {
			// A guest holding a role slot.
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Convert Me",
				email: "convert@example.com",
				phone: "555-246-8100",
			});
			await applyAssignGuestToSlot({
				slotId: seed.slotId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			// Membership created for this club, member role, joinedAt stamped.
			const [m] = await testDb
				.select()
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(m).toMatchObject({
				clubId: seed.clubId,
				name: "Convert Me",
				clubRole: "member",
				status: "active",
			});
			expect(m!.joinedAt).toBeInstanceOf(Date);
			expect(m!.personId).toBe(res.personId);

			// Slot re-pointed guest → member (XOR holds).
			const [slot] = await testDb
				.select({
					assignedMemberId: roleSlots.assignedMemberId,
					assignedGuestId: roleSlots.assignedGuestId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			expect(slot!.assignedMemberId).toBe(res.membershipId);
			expect(slot!.assignedGuestId).toBeNull();

			// Guest persists at joined with the membership pointer.
			const [g] = await testDb
				.select({
					stage: guests.stage,
					convertedMembershipId: guests.convertedMembershipId,
				})
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g!.stage).toBe("joined");
			expect(g!.convertedMembershipId).toBe(res.membershipId);

			// Excluded from the assign picker, still visible in the pipeline.
			const picker = await listClubGuests(seed.clubId);
			expect(picker.map((p) => p.id)).not.toContain(guestId);
			const pipeline = await loadGuestPipeline(seed.clubId);
			expect(pipeline.find((p) => p.id === guestId)?.stage).toBe("joined");

			// Activity log entry.
			const log = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.targetId, res.membershipId),
					),
				);
			expect(log).toHaveLength(1);
			expect(log[0]!.action).toBe("member_add");
			expect((log[0]!.detail as { fromGuestId?: string }).fromGuestId).toBe(
				guestId,
			);
		});

		it("links an existing Person by phone rather than creating a duplicate", async () => {
			// Stored E.164 — what every write path produces (#295/#397). A `people`
			// row written before that carries a bare national number and matches
			// nothing here; `scripts/backfill-phone-e164.ts` is what brings it over.
			const [existingPerson] = await testDb
				.insert(people)
				.values({ name: "Existing Human", phone: "+15559990000" })
				.returning({ id: people.id });

			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Existing Human",
				phone: "(555) 999-0000", // same digits, different format
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: null,
			});
			expect(res.personId).toBe(existingPerson!.id);
		});

		it("is idempotent-safe: converting an already-joined guest throws", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Once Only",
				phone: "555-808-8080",
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: null,
			});
			await expect(
				applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: null,
				}),
			).rejects.toThrow(/already been converted/i);
		});
	});
});
