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
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	duesPeriods,
	guests,
	meetingAttendance,
	meetings,
	memberDues,
	members,
	officerTerms,
	people,
	roleSlots,
	speeches,
	tableTopicsSpeakers,
} from "#/db/schema";
import {
	CONVERT_NAME_CLASH_MESSAGE,
	LINK_ALREADY_JOINED_MESSAGE,
	LINK_MEMBER_NOT_IN_CLUB_MESSAGE,
	UNDO_MEMBER_HAS_ACCOUNT_MESSAGE,
	UNDO_MEMBER_HAS_HISTORY_MESSAGE,
	UNDO_NO_RECORD_MESSAGE,
	UNDO_NOT_CONVERTED_MESSAGE,
	UNLINK_NOT_LINKED_MESSAGE,
} from "#/lib/guest-convert";
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
import { readsOf, statementsDuring } from "#/test/query-spy";

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
	applyLinkGuestToMember,
	applySetGuestStage,
	applyUndoGuestConversion,
	applyUnlinkGuestFromMember,
	applyUpdateGuest,
	captureGuestVisit,
	GUEST_BOOK_MAX_NEW_PER_WINDOW,
	GUEST_BOOK_THROTTLED_MESSAGE,
	loadGuestPipeline,
	loadLinkCandidates,
} = await import("#/server/guest-pipeline-logic");
const { applyAssignGuestToSlot, listClubGuests } = await import(
	"#/server/guests-logic"
);
// The roster the season grid and every role picker read (`listMembers` serves
// it verbatim). Imported here so #501's "the member is invisible" can be stated
// in the READER's terms rather than as a column value.
const { loadPublicClubRoster } = await import("#/server/members-logic");

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
	const meetingId = await seedMeetingInProgress(input.clubId);
	const res = await captureGuestVisit(input);
	await testDb
		.update(meetings)
		.set({ scheduledAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
		.where(eq(meetings.id, meetingId));
	return { meetingId, res };
}

/**
 * Insert a meeting that is IN PROGRESS right now — started 10 minutes ago.
 *
 * Since #319 this is the only shape that produces an attendance row:
 * `captureGuestVisit` writes `status: "present"` only when the resolved meeting
 * is inside `isAtMeetingNow`'s absolute window, because the guest book is now
 * linked from the public club page and a sign-up outside the meeting must not
 * enter its minutes as a person present. The seeded club meeting is 7 days out,
 * so a fixture that wants attendance has to say so explicitly.
 */
async function seedMeetingInProgress(clubId: string): Promise<string> {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() - 10 * 60 * 1000),
			status: "scheduled",
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("Failed to seed in-progress meeting");
	return m.id;
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
 *
 * NOTE: this is for the READ-side derivation. It is NOT "in progress" for the
 * guest-book write gate, which since #319 uses an absolute window around the
 * meeting (`isAtMeetingNow`) — use `seedMeetingInProgress` for that.
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
			const today = await seedMeetingInProgress(seed.clubId);
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
			//
			// Both columns, because a convert writes both in one statement (step 4 of
			// `applyConvertGuestToMember`) and since #618 the delete guard reads both.
			// A bare `stage: "joined"` is no longer a faithful stand-in for a convert
			// — it is the STRANDED state, which means "converted once, membership
			// since removed from the roster", and a stranded row is deletable on
			// purpose. Faking the convert with the stage alone made this test assert
			// the opposite of what it is named for.
			const writer = await openBlockingTx(async (tx) => {
				await tx
					.update(guests)
					.set({ stage: "joined", convertedMembershipId: seed.memberId })
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

			// It never reactivates, and that is structural rather than an omission
			// (#501). This branch lives in the `else` of `if (existingMembership)`,
			// so the only row it can EVER observe is one a concurrent convert just
			// committed — and that insert hardcodes `status: "active"`. A
			// pre-existing lapsed membership is found by the first select and takes
			// the reuse branch instead, so "the raced path behaves like the unraced
			// one" would be false by construction. Pinned here so a later reader
			// does not "fix" the recovery branch into the reactivating path.
			expect(res.reactivated).toBe(false);

			const rows = await testDb
				.select({ id: members.id, status: members.status })
				.from(members)
				.where(
					and(eq(members.clubId, seed.clubId), eq(members.personId, personId)),
				);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("active");
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

		it("dedupes onto a member whose person-level address 0076 cleared", async () => {
			// The post-#756 shape, and the one migration 0076 leaves every un-claimed
			// member in: `people.email` NULL, the address on the club's roster row.
			// A person-level-only match stopped seeing them, and the failure is loud
			// in the data rather than on screen — a second Person AND a second roster
			// row for the same human, in the same club, invisible to
			// `listDuplicatePeople` because one of the pair has a NULL email.
			const email = `post0076-${randomUUID()}@example.com`;
			const [existing] = await testDb
				.insert(people)
				.values({ name: "Roberta Smith", email: null })
				.returning({ id: people.id });
			if (!existing) throw new Error("person insert failed");
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId: existing.id,
				name: "Roberta Smith",
				email,
			});

			const guestId = await seedGuest(seed.clubId, "Roberta Smith");
			await applyUpdateGuest({
				clubId: seed.clubId,
				guestId,
				name: "Roberta Smith",
				email,
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(res.personId).toBe(existing.id);
		});

		it("does not match on ANOTHER club's roster address", async () => {
			// Widening the key has to stay club-scoped, or a conversion could reach a
			// Person through a contact record some other club typed — the cross-club
			// shape the rest of #756 closes.
			const email = `otherclub-${randomUUID()}@example.com`;
			const other = await seedClub();
			try {
				const [existing] = await testDb
					.insert(people)
					.values({ name: "Elsewhere Person", email: null })
					.returning({ id: people.id });
				if (!existing) throw new Error("person insert failed");
				await testDb.insert(members).values({
					clubId: other.clubId,
					personId: existing.id,
					name: "Elsewhere Person",
					email,
				});

				const guestId = await seedGuest(seed.clubId, "Elsewhere Person");
				await applyUpdateGuest({
					clubId: seed.clubId,
					guestId,
					name: "Elsewhere Person",
					email,
				});
				const res = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});

				expect(res.personId).not.toBe(existing.id);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
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

	/**
	 * Convert onto a LAPSED membership (#501).
	 *
	 * Lapse-then-return is ordinary Toastmasters behaviour, and the reuse branch
	 * left the membership's status alone — so the convert reported success,
	 * stamped the guest `joined`, and produced a member who was invisible on the
	 * roster, the sign-up sheet, the season grid and every picker. `inactive` is
	 * not a soft label (`schema.ts`): it is what those readers filter on.
	 *
	 * The status is asserted on the ROW rather than through the flag, and the
	 * visibility is asserted through a real reader, because the two are what a
	 * human would look at. A test that only checked `reactivated` would pass on
	 * a convert that set the flag and wrote nothing.
	 */
	describe("convert onto a LAPSED membership (#501)", () => {
		/** A person with a lapsed membership in the seeded club. `clubRole`
		 *  defaults to the column's own default (`member`); pass `admin` for the
		 *  privilege cases — deactivation never cleared it, so an admin that
		 *  lapsed is the ordinary shape of that row, not a contrived one. */
		async function lapsedMember(
			name: string,
			contact: { email?: string; phone?: string },
			clubRole: "admin" | "member" = "member",
		) {
			const personId = await trackedPerson({
				name,
				email: contact.email ?? null,
				phone: contact.phone ? toStoredPhone(contact.phone, "1") : null,
			});
			const [m] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId,
					name,
					status: "inactive",
					clubRole,
				})
				.returning({ id: members.id });
			if (!m) throw new Error("Failed to seed lapsed membership");
			return { personId, membershipId: m.id };
		}

		async function statusOf(membershipId: string) {
			const [m] = await testDb
				.select({ status: members.status })
				.from(members)
				.where(eq(members.id, membershipId))
				.limit(1);
			return m?.status;
		}

		async function roleOf(membershipId: string) {
			const [m] = await testDb
				.select({ clubRole: members.clubRole })
				.from(members)
				.where(eq(members.id, membershipId))
				.limit(1);
			return m?.clubRole;
		}

		/** The newest `member_add` detail this guest's conversion wrote. */
		async function conversionDetail(guestId: string) {
			const [row] = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_add"),
						sql`${activityLog.detail}->>'fromGuestId' = ${guestId}`,
					),
				)
				.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
				.limit(1);
			return row?.detail as Record<string, unknown> | undefined;
		}

		it("reactivates the membership the EMAIL dedup landed on", async () => {
			const email = `lapsed-${randomUUID()}@example.com`;
			const { membershipId } = await lapsedMember("Dana Lapsed", { email });
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Dana Lapsed",
				email,
			});

			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			// Reuse, not a second roster row — that half already held.
			expect(res.membershipId).toBe(membershipId);
			expect(res.reactivated).toBe(true);
			// …and this is the half that did not: the bug was `{ ok: true }` over
			// a row still saying `inactive`.
			expect(await statusOf(membershipId)).toBe("active");
		});

		it("reactivates a membership matched by PHONE rather than email", async () => {
			// The other arm of the dedup, and the one the issue's repro names
			// second. It reaches the same reuse branch, so the fix covers it — but
			// only a test says so, and "the email case works" is not evidence about
			// a different query.
			const phone = uniquePhone();
			const { membershipId } = await lapsedMember("Kai Lapsed", { phone });
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Kai Lapsed",
				phone,
			});

			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(res.membershipId).toBe(membershipId);
			expect(res.reactivated).toBe(true);
			expect(await statusOf(membershipId)).toBe("active");
		});

		it("puts the returning guest back in the roster the pickers read", async () => {
			// The actual complaint, stated in the reader's own terms rather than in
			// the column's. `loadPublicClubRoster` is what `listMembers` serves to
			// the season grid and the role pickers, and it filters
			// `status <> 'inactive'` — so this is the assertion that would have
			// caught the bug with no knowledge of which column caused it.
			//
			// The slot is the aggravating case from the issue: step 3 re-points a
			// guest-held slot onto this membership, so before the fix a claimed
			// slot ended up owned by someone the picker could not display.
			const email = `roster-${randomUUID()}@example.com`;
			const { membershipId } = await lapsedMember("Robin Roster", { email });
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Robin Roster",
				email,
			});
			const slotId = await seedGuestRoleSlot(
				seed.meetingId,
				seed.roleDefinitionId,
				guestId,
			);

			// Invisible BEFORE the convert — the control. Without it this test
			// passes on a roster reader that never filtered at all.
			const before = await loadPublicClubRoster(seed.clubId);
			expect(before.map((m) => m.id)).not.toContain(membershipId);

			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			const after = await loadPublicClubRoster(seed.clubId);
			expect(after.map((m) => m.id)).toContain(membershipId);

			const [slot] = await testDb
				.select({ memberId: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId))
				.limit(1);
			expect(slot?.memberId).toBe(membershipId);
		});

		it("records the prior status in the activity log", async () => {
			// Without it the `member_add` row is indistinguishable from a fresh
			// join, and undo has nothing to restore from.
			const email = `logged-${randomUUID()}@example.com`;
			await lapsedMember("Logged Lapsed", { email });
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Logged Lapsed",
				email,
			});

			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			const detail = await conversionDetail(guestId);
			expect(detail?.reactivatedFrom).toBe("inactive");
			expect(detail?.createdMembership).toBe(false);
			expect(detail?.name).toBe("Logged Lapsed");
		});

		it("does NOT claim a reactivation when the membership was already active", async () => {
			// Ordinary dedup. The notice exists so an admin notices a rejoin — and
			// one that fires on the common path is one they learn to ignore, which
			// is the failure mode this asserts against. The key must be ABSENT, not
			// merely falsy: `readConversionRecord` reads its presence.
			const email = `active-${randomUUID()}@example.com`;
			const personId = await trackedPerson({ name: "Ever Active", email });
			const [m] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name: "Ever Active" })
				.returning({ id: members.id });
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Ever Active",
				email,
			});

			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(res.membershipId).toBe(m?.id);
			expect(res.reactivated).toBe(false);
			expect(await statusOf(m?.id ?? "")).toBe("active");
			expect(await conversionDetail(guestId)).not.toHaveProperty(
				"reactivatedFrom",
			);
		});

		it("does NOT claim a reactivation when it created the membership", async () => {
			// The flag means REUSE-OF-A-LAPSED-ROW, not success. A flag that were
			// simply true on every convert would satisfy the two tests above's
			// happy halves and mislead on the commonest path of all.
			const guestId = await seedGuest(seed.clubId, "Brand New");
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			strayPeople.push(res.personId);

			expect(res.reactivated).toBe(false);
			expect(await statusOf(res.membershipId)).toBe("active");
			expect(await conversionDetail(guestId)).not.toHaveProperty(
				"reactivatedFrom",
			);
		});

		it("undo puts the lapse back", async () => {
			// Undo leaves a REUSED membership standing (#618), so without the
			// restore a convert-then-undo would leave a lapsed member permanently
			// `active` and undo would stop being convert's reverse.
			const email = `undo-${randomUUID()}@example.com`;
			const { membershipId } = await lapsedMember("Undo Lapsed", { email });
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Undo Lapsed",
				email,
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			expect(await statusOf(membershipId)).toBe("active");

			const res = await applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			// Still standing — it was never this conversion's to delete…
			expect(res.membershipDeleted).toBe(false);
			expect(await statusOf(membershipId)).toBe("inactive");
			// …and hidden again from the readers that made this bug visible.
			const roster = await loadPublicClubRoster(seed.clubId);
			expect(roster.map((m) => m.id)).not.toContain(membershipId);
		});

		it("undo of a record with no reactivatedFrom still runs and touches no status", async () => {
			// Every conversion recorded before #501 is this shape, which is why the
			// key is OPTIONAL in `readConversionRecord`. Requiring it would have
			// made those records unreplayable — and, because the board decides
			// whether to OFFER Undo from the same validator, would have taken the
			// button off them with no error anywhere.
			const email = `legacy-${randomUUID()}@example.com`;
			const { membershipId } = await lapsedMember("Legacy Record", { email });
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Legacy Record",
				email,
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			// Rewrite the record into the pre-#501 shape, keeping every key #618
			// needs. Deliberately NOT `stripRecord`, which removes those too and so
			// would refuse for an unrelated reason.
			const [row] = await testDb
				.select({ id: activityLog.id, detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_add"),
						sql`${activityLog.detail}->>'fromGuestId' = ${guestId}`,
					),
				)
				.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
				.limit(1);
			if (!row) throw new Error("No conversion record");
			const { reactivatedFrom: _dropped, ...legacy } = row.detail as Record<
				string,
				unknown
			>;
			expect(_dropped).toBe("inactive");
			await testDb
				.update(activityLog)
				.set({ detail: legacy })
				.where(eq(activityLog.id, row.id));

			// Still OFFERED on the board — the half a server-only assertion misses.
			expect((await pipelineRow(seed.clubId, guestId)).conversionUndoable).toBe(
				true,
			);

			const res = await applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			expect(res.membershipDeleted).toBe(false);
			// Left exactly as the convert left it: the record says nothing about a
			// lapse, so undo must not invent one. `active` here is the CONVERT's
			// write surviving, which is the correct residue.
			expect(await statusOf(membershipId)).toBe("active");
		});

		/**
		 * What the wake-up does to PERMISSIONS (#501 review).
		 *
		 * `members.status === 'active'` is not a display flag, it is the
		 * write-authorization gate: `requireMembership` sends a non-active
		 * membership to `requireReadWriteImpersonation`, which refuses an
		 * ordinary caller. Deactivation never cleared `club_role`, so a
		 * membership that lapsed while it said `admin` was one `status` write
		 * away from full club-admin access — and #501's wake-up is that write,
		 * fired from a guest card that shows no role, by dedup that can match the
		 * wrong human (#561).
		 *
		 * Asserted on the COLUMN rather than through the returned flag, for the
		 * same reason the status cases above are: a test that only read
		 * `demotedFrom` would pass on a convert that set the flag and wrote
		 * nothing. `guest-convert-privilege.integration.test.ts` states the same
		 * claim once more in the GATE's own terms, which is the only form of it
		 * that is actually about security.
		 */
		describe("and what it does to permissions", () => {
			/** The newest `member_remove` detail this guest's undo wrote. */
			async function undoDetail(guestId: string) {
				const [row] = await testDb
					.select({ detail: activityLog.detail })
					.from(activityLog)
					.where(
						and(
							eq(activityLog.clubId, seed.clubId),
							eq(activityLog.action, "member_remove"),
							sql`${activityLog.detail}->>'undoneGuestId' = ${guestId}`,
						),
					)
					.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
					.limit(1);
				return row?.detail as Record<string, unknown> | undefined;
			}

			/** A lapsed ADMIN, a guest who dedups onto them, and the convert. */
			async function convertOntoLapsedAdmin(name: string) {
				const email = `${name.toLowerCase().replace(/\W+/g, "-")}-${randomUUID()}@example.com`;
				const seeded = await lapsedMember(name, { email }, "admin");
				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name,
					email,
				});
				const res = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});
				return { ...seeded, guestId, res };
			}

			it("writes a lapsed ADMIN's club role back down to member", async () => {
				// The bug, stated as the column it lives in. Before this, the row
				// came back `status: active, club_role: admin` — a full club admin
				// restored by a VP-Membership button whose toast said "(was
				// inactive)".
				const { membershipId, res } =
					await convertOntoLapsedAdmin("Prior Admin");

				expect(res.reactivated).toBe(true);
				expect(res.demotedFrom).toBe("admin");
				expect(await statusOf(membershipId)).toBe("active");
				expect(await roleOf(membershipId)).toBe("member");
				// DELETE THIS WITH THE FIELD, one release after #805 — see
				// `ConvertGuestResult.retainedOfficerPositions`. It is here so the
				// back-compat shim cannot be tidied away early: a tab loaded before
				// the deploy reads `result.retainedOfficerPositions.length`
				// unguarded, and on THIS path (`reactivated` true) that would throw
				// after the transaction had already committed.
				expect(res.retainedOfficerPositions).toEqual([]);
			});

			it("records the demotion in the activity log", async () => {
				// A permission change with no record is one nobody can audit or
				// reverse: `club_role` carries no history of its own, so absent this
				// key the row is indistinguishable from a membership that was never
				// an admin at all.
				const { guestId } = await convertOntoLapsedAdmin("Logged Admin");

				const detail = await conversionDetail(guestId);
				expect(detail?.demotedFrom).toBe("admin");
				expect(detail?.reactivatedFrom).toBe("inactive");
			});

			it("leaves an ordinary lapsed member's role alone, and says nothing", async () => {
				// The commonest wake-up by far. A `demotedFrom` written here would
				// report a permission change that never happened, and the toast
				// would start warning on the ordinary path — which is how a real
				// warning stops being read. ABSENT, not merely falsy:
				// `readConversionRecord` reads presence.
				const email = `plain-${randomUUID()}@example.com`;
				const { membershipId } = await lapsedMember("Plain Lapsed", { email });
				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name: "Plain Lapsed",
					email,
				});

				const res = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});

				expect(res.reactivated).toBe(true);
				expect(res.demotedFrom).toBeUndefined();
				expect(await roleOf(membershipId)).toBe("member");
				expect(await conversionDetail(guestId)).not.toHaveProperty(
					"demotedFrom",
				);
			});

			it("does NOT demote an admin whose membership was already active", async () => {
				// Ordinary dedup onto a SITTING admin — a VP-Membership converting a
				// guest who turns out to be the club president. Demoting here would
				// be a privilege regression convert has no business performing, and
				// it is the mistake a "convert always writes the role down" fix
				// makes. The demotion rides the wake-up or it does not happen.
				const email = `sitting-${randomUUID()}@example.com`;
				const personId = await trackedPerson({
					name: "Sitting Admin",
					email,
				});
				const [m] = await testDb
					.insert(members)
					.values({
						clubId: seed.clubId,
						personId,
						name: "Sitting Admin",
						clubRole: "admin",
					})
					.returning({ id: members.id });
				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name: "Sitting Admin",
					email,
				});

				const res = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});

				expect(res.membershipId).toBe(m?.id);
				expect(res.reactivated).toBe(false);
				expect(res.demotedFrom).toBeUndefined();
				expect(await roleOf(m?.id ?? "")).toBe("admin");
			});

			it("ends the open officer term the wake-up would have revived", async () => {
				// Effective-admin's OTHER source (#202): any open `officer_terms`
				// row is full admin whatever `club_role` says, and deactivation does
				// not close those either — so before #805 the demotion one column
				// over removed nothing, and the toast said it had. The term is ended
				// in the same transaction.
				//
				// CLOSED, not deleted (#100): the history stays, which is also what
				// keeps `applyUndoGuestConversion`'s officer-term refusal covering
				// this conversion afterwards.
				const email = `officer-${randomUUID()}@example.com`;
				const { membershipId } = await lapsedMember(
					"Lapsed Officer",
					{ email },
					"admin",
				);
				await testDb
					.insert(officerTerms)
					.values({ membershipId, position: "president", termEnd: null });
				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name: "Lapsed Officer",
					email,
				});

				const res = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});

				expect(res.demotedFrom).toBe("admin");
				expect(res.closedOfficerPositions).toEqual(["president"]);
				const terms = await testDb
					.select({ termEnd: officerTerms.termEnd })
					.from(officerTerms)
					.where(eq(officerTerms.membershipId, membershipId));
				expect(terms).toHaveLength(1);
				expect(terms[0]?.termEnd).toBeInstanceOf(Date);
				// Recorded, for the reason `demotedFrom` is: vacating an office is a
				// permission change with no `member_edit` of its own to explain it,
				// and `officer_terms` alone cannot say WHO ended the term or why.
				const detail = await conversionDetail(guestId);
				expect(detail?.closedOfficerPositions).toEqual(["president"]);
			});

			it("leaves a SITTING officer's term alone when it only deduped", async () => {
				// The scope of the governance claim, stated where it can fail.
				// Reuse of an ALREADY-ACTIVE membership never reaches the wake-up
				// branch, so converting a guest that dedups onto the club's sitting
				// President must not vacate the presidency — that would be the
				// guest-card-as-governance-write #805 deliberately is not.
				const email = `sitting-officer-${randomUUID()}@example.com`;
				const [person] = await testDb
					.insert(people)
					.values({ name: "Sitting Officer", email })
					.returning({ id: people.id });
				const [m] = await testDb
					.insert(members)
					.values({
						clubId: seed.clubId,
						personId: person?.id ?? "",
						name: "Sitting Officer",
						email,
						status: "active",
						clubRole: "member",
					})
					.returning({ id: members.id });
				const membershipId = m?.id ?? "";
				await testDb
					.insert(officerTerms)
					.values({ membershipId, position: "president", termEnd: null });
				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name: "Sitting Officer",
					email,
				});

				const res = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});

				expect(res.membershipId).toBe(membershipId);
				expect(res.reactivated).toBe(false);
				expect(res.closedOfficerPositions).toEqual([]);
				const terms = await testDb
					.select({ termEnd: officerTerms.termEnd })
					.from(officerTerms)
					.where(eq(officerTerms.membershipId, membershipId));
				expect(terms).toHaveLength(1);
				expect(terms[0]?.termEnd).toBeNull();
			});

			it("reports no officer positions when there are none", async () => {
				// The field is always present, so the UI never has to guard on
				// undefined — and empty must mean empty, not "we did not look".
				const { res, guestId } = await convertOntoLapsedAdmin("No Office");
				expect(res.closedOfficerPositions).toEqual([]);
				// ABSENT from the log, not an empty array: each key's PRESENCE is
				// the claim that convert wrote that column, the same discipline
				// `demotedFrom` keeps two cases up. An empty array recorded here
				// would read as "we ended nothing, deliberately" on every ordinary
				// wake-up in the club's history.
				expect(await conversionDetail(guestId)).not.toHaveProperty(
					"closedOfficerPositions",
				);
			});

			it("undo puts the admin role back along with the lapse", async () => {
				// Undo is convert's reverse or it is nothing. Restoring only the
				// status would quietly make undo a DEMOTION tool: the row would come
				// back `inactive, member`, with `club_role` silently changed by a
				// pair of actions that claim to cancel out.
				//
				// It grants nothing on the way back — the same statement returns the
				// row to `inactive`, which `requireMembership` refuses whatever the
				// role says. That is why this is safe to restore and the convert's
				// own wake-up was not.
				const { membershipId, guestId } =
					await convertOntoLapsedAdmin("Undo Admin");
				expect(await roleOf(membershipId)).toBe("member");

				const res = await applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});

				expect(res.membershipDeleted).toBe(false);
				expect(await statusOf(membershipId)).toBe("inactive");
				expect(await roleOf(membershipId)).toBe("admin");
			});

			it("records what undo restored on the member_remove row", async () => {
				// The member vanishes from the roster, the sign-up sheet and every
				// picker the instant undo runs, and `membershipDeleted: false` was
				// the whole story the log told — so nothing anywhere explained the
				// disappearance. That is the mirror of the bug #501 exists to fix,
				// pointing the other way, and worse, because this write is the one
				// that TAKES a member away.
				const { guestId } = await convertOntoLapsedAdmin("Audited Undo");
				await applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});

				const detail = await undoDetail(guestId);
				expect(detail?.membershipDeleted).toBe(false);
				expect(detail?.statusRestoredTo).toBe("inactive");
				expect(detail?.clubRoleRestoredTo).toBe("admin");
			});

			it("records nothing about a status undo did not write", async () => {
				// A conversion that CREATED the membership deletes it on undo, and a
				// deleted row has no status to restore. Keys that appear on every
				// entry regardless stop being evidence of anything — absence has to
				// keep meaning "undo left it alone".
				const guestId = await seedGuest(seed.clubId, "Fresh Undo");
				const conv = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});
				strayPeople.push(conv.personId);
				await applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});

				const detail = await undoDetail(guestId);
				expect(detail?.membershipDeleted).toBe(true);
				expect(detail).not.toHaveProperty("statusRestoredTo");
				expect(detail).not.toHaveProperty("clubRoleRestoredTo");
			});

			it("REFUSES to undo a record whose reactivatedFrom the enum can't hold", async () => {
				// A present-but-malformed claim is not an absent one. Coercing it to
				// `undefined` — which is what the first cut of #501 did — downgrades
				// "this conversion woke something and I can't tell you what" into
				// "it woke nothing", and undo then reports success while leaving the
				// membership permanently `active`. The same shape one column over
				// leaves an admin's permissions on.
				//
				// Absence still parses (the case above this one proves it), which is
				// what keeps every pre-#501 record undoable. Only PRESENCE is held
				// to the enum.
				const email = `corrupt-${randomUUID()}@example.com`;
				const { membershipId } = await lapsedMember("Corrupt Record", {
					email,
				});
				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name: "Corrupt Record",
					email,
				});
				await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});
				const [row] = await testDb
					.select({ id: activityLog.id, detail: activityLog.detail })
					.from(activityLog)
					.where(
						and(
							eq(activityLog.clubId, seed.clubId),
							eq(activityLog.action, "member_add"),
							sql`${activityLog.detail}->>'fromGuestId' = ${guestId}`,
						),
					)
					.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
					.limit(1);
				if (!row) throw new Error("No conversion record");
				await testDb
					.update(activityLog)
					.set({
						detail: {
							...(row.detail as Record<string, unknown>),
							reactivatedFrom: "suspended",
						},
					})
					.where(eq(activityLog.id, row.id));

				await expect(
					applyUndoGuestConversion({
						clubId: seed.clubId,
						guestId,
						actorMemberId: seed.adminMemberId,
					}),
				).rejects.toThrow(UNDO_NO_RECORD_MESSAGE);
				// Refused whole: the membership is untouched and the guest is still
				// joined, which is the state the roster-removal fallback expects.
				expect(await statusOf(membershipId)).toBe("active");
				// And the board stops OFFERING the button, rather than showing one
				// that always fails — same validator, same answer.
				expect(
					(await pipelineRow(seed.clubId, guestId)).conversionUndoable,
				).toBe(false);
			});

			it("REFUSES to undo a record whose demotedFrom the enum can't hold", async () => {
				// The same rule on the key that carries a PERMISSION. Read loosely,
				// undo would leave the membership at `member` and report success,
				// and the only record that it had ever been an admin is the string
				// it just ignored.
				const { guestId, membershipId } =
					await convertOntoLapsedAdmin("Corrupt Role");
				const [row] = await testDb
					.select({ id: activityLog.id, detail: activityLog.detail })
					.from(activityLog)
					.where(
						and(
							eq(activityLog.clubId, seed.clubId),
							eq(activityLog.action, "member_add"),
							sql`${activityLog.detail}->>'fromGuestId' = ${guestId}`,
						),
					)
					.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
					.limit(1);
				if (!row) throw new Error("No conversion record");
				await testDb
					.update(activityLog)
					.set({
						detail: {
							...(row.detail as Record<string, unknown>),
							demotedFrom: "superadmin",
						},
					})
					.where(eq(activityLog.id, row.id));

				await expect(
					applyUndoGuestConversion({
						clubId: seed.clubId,
						guestId,
						actorMemberId: seed.adminMemberId,
					}),
				).rejects.toThrow(UNDO_NO_RECORD_MESSAGE);
				expect(await roleOf(membershipId)).toBe("member");
			});
		});
	});

	// The guest book is a session-less public POST, and since v1.9.0.0 it is
	// linked from the public club page rather than only living on a printed QR.
	// Uncapped it mints `guests` rows without limit — and during a meeting each
	// new guest ALSO becomes a `meeting_attendance` row with `status: "present"`
	// that reaches the official minutes and the minutes email.
	describe("public signup throttle", () => {
		/** Fill the club's window to `n` new guests, bypassing the public path so
		 *  the fixture itself is not throttled while building the precondition. */
		async function seedGuests(clubId: string, n: number) {
			if (n === 0) return;
			await testDb.insert(guests).values(
				Array.from({ length: n }, (_, i) => ({
					clubId,
					name: `Seeded Guest ${i}`,
				})),
			);
		}

		it("refuses a NEW guest once the club is over the window cap", async () => {
			await seedGuests(seed.clubId, GUEST_BOOK_MAX_NEW_PER_WINDOW);
			await expect(
				captureGuestVisit({
					clubId: seed.clubId,
					name: "One Too Many",
					email: null,
					phone: null,
				}),
			).rejects.toThrow(GUEST_BOOK_THROTTLED_MESSAGE);
		});

		it("still lets a RETURNING guest sign in when the cap is full", async () => {
			// The regular who comes every week must never be turned away because
			// strangers filled the window: only the create path consumes the cap.
			const phone = uniquePhone();
			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Regular Visitor",
				email: null,
				phone,
			});
			await seedGuests(seed.clubId, GUEST_BOOK_MAX_NEW_PER_WINDOW);
			const again = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Regular Visitor",
				email: null,
				phone,
			});
			expect(again.created).toBe(false);
			expect(again.guestId).toBe(first.guestId);
		});

		it("is scoped to ONE club — a busy club cannot throttle its neighbour", async () => {
			const other = await seedClub();
			try {
				await seedGuests(seed.clubId, GUEST_BOOK_MAX_NEW_PER_WINDOW);
				const res = await captureGuestVisit({
					clubId: other.clubId,
					name: "Unaffected Visitor",
					email: null,
					phone: null,
				});
				expect(res.created).toBe(true);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("holds under a CONCURRENT burst, not just a sequential loop", async () => {
			// The case a sequential test cannot see. A count taken outside the
			// transaction lets every concurrent request read the same pre-insert
			// total and all pass — that exact bypass was proved on the voting guest
			// cap (#510), where 200 concurrent calls cleared a limit of 60.
			const burst = GUEST_BOOK_MAX_NEW_PER_WINDOW * 3;
			const results = await Promise.allSettled(
				Array.from({ length: burst }, (_, i) =>
					captureGuestVisit({
						clubId: seed.clubId,
						name: `Burst Visitor ${i}`,
						email: null,
						phone: null,
					}),
				),
			);
			const accepted = results.filter((r) => r.status === "fulfilled").length;
			const [row] = await testDb
				.select({ n: count() })
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(accepted).toBeLessThanOrEqual(GUEST_BOOK_MAX_NEW_PER_WINDOW);
			expect(row.n).toBeLessThanOrEqual(GUEST_BOOK_MAX_NEW_PER_WINDOW);
		});
	});

	/**
	 * Read-time phone coalescing on the pipeline payload (#295), the third path
	 * through `coalesceToE164` after the season grid and the club roster.
	 *
	 * These insert into `guests` DIRECTLY, bypassing `toStoredPhone` — that is the
	 * shape a row written before normalize-on-write (#397) actually has, and it is
	 * the only way to produce one now that every write path normalizes. The
	 * `uniquePhone` rule above does not apply: nothing here converts, so no
	 * `people` row is created to collide with, and each assertion matches on the
	 * returned guest id rather than on a name or a number.
	 */
	describe("loadGuestPipeline phone normalization", () => {
		async function insertGuestWithPhone(phone: string): Promise<string> {
			const [row] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name: "Sam Visitor", phone })
				.returning({ id: guests.id });
			if (!row) throw new Error("Failed to insert guest");
			return row.id;
		}

		it("coalesces a pre-#397 national number to E.164", async () => {
			const guestId = await insertGuestWithPhone("(415) 555-2671");
			const rows = await loadGuestPipeline(seed.clubId);
			expect(rows.find((r) => r.id === guestId)?.phone).toBe("+14155552671");
		});

		it("uses the CLUB's country code, not the app default", async () => {
			// Pins that the loader is actually consulted rather than `+1` being
			// hard-coded — the same number resolves differently under +44.
			await testDb
				.update(clubs)
				.set({ defaultCountryCode: "+44" })
				.where(eq(clubs.id, seed.clubId));
			const guestId = await insertGuestWithPhone("020 7946 0958");
			const rows = await loadGuestPipeline(seed.clubId);
			expect(rows.find((r) => r.id === guestId)?.phone).toBe("+442079460958");
		});

		it("keeps an un-normalizable phone as stored rather than dropping it", async () => {
			// `toStoredPhone` stores a digit-less value verbatim so the VPM can still
			// read and edit it, and the guest editor's phone field has no digit
			// requirement — so this is reachable in normal use, not just legacy data.
			// The payload must still carry the text: `WhatsAppPhoneLink` renders it as
			// plain text instead of a dead link.
			const guestId = await insertGuestWithPhone("call the office");
			const rows = await loadGuestPipeline(seed.clubId);
			expect(rows.find((r) => r.id === guestId)?.phone).toBe("call the office");
		});

		it("leaves a guest with no phone at null", async () => {
			const [row] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name: "Phoneless Visitor" })
				.returning({ id: guests.id });
			const rows = await loadGuestPipeline(seed.clubId);
			expect(rows.find((r) => r.id === row!.id)?.phone).toBeNull();
		});

		it("carries the STORED bytes as phoneRaw alongside the coalesced number", async () => {
			// The edit dialog prefills from `phoneRaw`, so the two fields have to
			// DIVERGE wherever coalescing changes anything — a `phoneRaw` that simply
			// aliased `phone` would pass a bare "is it defined" check while putting
			// the country-code guess back in the input.
			//
			// "x12" is an extension: coalescing welds it into the subscriber number,
			// so the guess is visibly not a phone number the VPM ever typed.
			const guestId = await insertGuestWithPhone("415-555-2671 x12");
			const row = (await loadGuestPipeline(seed.clubId)).find(
				(r) => r.id === guestId,
			);
			expect(row?.phoneRaw).toBe("415-555-2671 x12");
			expect(row?.phone).toBe("+1415555267112");
			expect(row?.phoneRaw).not.toBe(row?.phone);
		});

		it("reads the clubs row ONCE for the timezone and the country code", async () => {
			// Both are columns on the same `clubs` row. They used to be two loaders
			// issued in a `Promise.all` — concurrent, but still two round trips for
			// one row, on a payload that already makes several.
			//
			// Invisible to every other assertion in this file: the pipeline it
			// returns is byte-identical either way, so the observable has to be the
			// QUERY (CLAUDE.md, "assert the observable the guard actually
			// controls"). Counted at the pg client rather than by spying on a named
			// loader, because collapsing the two loaders DELETED the function a
			// call-count spy would have watched.
			const reads = readsOf(
				await statementsDuring(() => loadGuestPipeline(seed.clubId)),
				"clubs",
			);

			// Anti-vacuity: a spy that intercepted nothing, or a pattern that
			// stopped matching, reports zero and makes the count below meaningless.
			expect(
				reads.length,
				"no `clubs` read observed — the query spy has stopped working",
			).toBeGreaterThan(0);
			expect(reads).toHaveLength(1);
			// …and that single read really does carry both columns, so "one query"
			// was not achieved by dropping one of them.
			expect(reads[0]).toContain("timezone");
			expect(reads[0]).toContain("default_country_code");
		});

		it("phoneRaw is byte-exact, including surrounding whitespace", async () => {
			// `coalesceToE164` does not trim but `toE164` does before parsing, so a
			// padded value is the one shape where a `phoneRaw` implemented as
			// "coalesce, then undo" would quietly differ from the column.
			const guestId = await insertGuestWithPhone("  call the office  ");
			const row = (await loadGuestPipeline(seed.clubId)).find(
				(r) => r.id === guestId,
			);
			expect(row?.phoneRaw).toBe("  call the office  ");
		});
	});

	describe("convert refuses a duplicate name (#617)", () => {
		/** A roster row with NO email and NO phone — the shape the Person dedup can
		 *  never match, and exactly what the public self-add minted before #616. */
		async function contactlessMember(name: string): Promise<string> {
			const personId = await trackedPerson({ name });
			const [m] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name })
				.returning({ id: members.id });
			if (!m) throw new Error("Failed to insert member");
			return m.id;
		}

		async function clubMemberCount(clubId: string): Promise<number> {
			const [row] = await testDb
				.select({ n: count() })
				.from(members)
				.where(eq(members.clubId, clubId));
			return Number(row?.n ?? 0);
		}

		it("throws, and writes nothing, when the name is already on the roster", async () => {
			await contactlessMember("Casey Clash");
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Casey Clash",
				phone: "555-777-0001",
			});
			const before = await clubMemberCount(seed.clubId);

			await expect(
				applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(CONVERT_NAME_CLASH_MESSAGE);

			// The whole transaction must roll back, not just the membership insert:
			// a fresh Person or a `stage: joined` stamp surviving the refusal would
			// leave the guest half-converted, which is worse than the duplicate.
			expect(await clubMemberCount(seed.clubId)).toBe(before);
			const [g] = await testDb
				.select({
					stage: guests.stage,
					converted: guests.convertedMembershipId,
				})
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g?.stage).not.toBe("joined");
			expect(g?.converted).toBeNull();
		});

		it("is club-scoped — the same name in another club does not block", async () => {
			const other = await seedClub();
			try {
				const personId = await trackedPerson({ name: "Dana Elsewhere" });
				await testDb.insert(members).values({
					clubId: other.clubId,
					personId,
					name: "Dana Elsewhere",
				});
				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name: "Dana Elsewhere",
					phone: "555-777-0002",
				});
				const res = await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});
				expect(res.ok).toBe(true);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("catches a clash even when the Person deduped onto another club's row", async () => {
			// The case that decided WHERE this check lives. #617 proposed putting it
			// just before the fresh-Person insert; this guest never reaches that
			// branch, because its email matches a Person who is already a member
			// somewhere else. The Person is reused, no fresh row is created, and the
			// duplicate name would still land in THIS club's roster. Placing the
			// check at the MEMBERSHIP insert is what catches it.
			const other = await seedClub();
			try {
				const sharedPerson = await trackedPerson({
					name: "Erin Crossclub",
					email: "erin.crossclub@example.com",
				});
				await testDb.insert(members).values({
					clubId: other.clubId,
					personId: sharedPerson,
					name: "Erin Crossclub",
				});
				// …and THIS club already has the name, contactless.
				await contactlessMember("Erin Crossclub");

				const { guestId } = await captureGuestVisit({
					clubId: seed.clubId,
					name: "Erin Crossclub",
					email: "erin.crossclub@example.com",
				});
				await expect(
					applyConvertGuestToMember({
						clubId: seed.clubId,
						guestId,
						actorMemberId: seed.adminMemberId,
					}),
				).rejects.toThrow(CONVERT_NAME_CLASH_MESSAGE);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("still reuses an existing membership rather than reporting a clash", async () => {
			// Regression: the person ALREADY has a membership in this club, so the
			// reuse branch runs and the clash check must not fire. Without this, a
			// guard written to stop duplicates would instead break the one path that
			// correctly avoids them.
			const personId = await trackedPerson({
				name: "Fran Reuse",
				email: "fran.reuse@example.com",
			});
			const [existing] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name: "Fran Reuse" })
				.returning({ id: members.id });
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Fran Reuse",
				email: "fran.reuse@example.com",
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			expect(res.membershipId).toBe(existing?.id);
		});
	});

	describe("a stranded converted guest is not frozen (#618)", () => {
		/** Convert, then remove the member from the roster — which nulls
		 *  `converted_membership_id` (`onDelete: "set null"`) and leaves `stage`
		 *  saying `joined` with nothing to point at. */
		async function strandedGuest(name: string): Promise<string> {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name,
				phone: "555-888-0001",
			});
			const { membershipId } = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			await testDb.delete(members).where(eq(members.id, membershipId));
			const [g] = await testDb
				.select({
					stage: guests.stage,
					converted: guests.convertedMembershipId,
				})
				.from(guests)
				.where(eq(guests.id, guestId));
			// The precondition IS the bug — assert it rather than assuming the FK
			// behaves, or these tests could pass against a row that is not stranded.
			expect(g?.stage).toBe("joined");
			expect(g?.converted).toBeNull();
			return guestId;
		}

		it("can be moved back to a manual stage", async () => {
			const guestId = await strandedGuest("Gale Stranded");
			await applySetGuestStage({
				clubId: seed.clubId,
				guestId,
				stage: "following_up",
			});
			const [g] = await testDb
				.select({ stage: guests.stage })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g?.stage).toBe("following_up");
		});

		it("can be deleted", async () => {
			// The old refusal told the admin to "remove them from the roster
			// instead" — which is what they had already done to get here.
			const guestId = await strandedGuest("Hana Stranded");
			const res = await applyDeleteGuest({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			expect(res.ok).toBe(true);
			expect(
				await testDb.select().from(guests).where(eq(guests.id, guestId)),
			).toHaveLength(0);
		});

		it("a guest whose membership still exists stays frozen", async () => {
			// The complement, and the assertion that stops the fix from becoming
			// "any joined guest may be edited". Same shape as the two above; the
			// only difference is that the membership is left alone.
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Ivan Intact",
				phone: "555-888-0002",
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			await expect(
				applySetGuestStage({
					clubId: seed.clubId,
					guestId,
					stage: "following_up",
				}),
			).rejects.toThrow(/already joined/i);
			await expect(
				applyDeleteGuest({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(/club member/i);
		});
	});

	describe("link a guest to an existing member (#635)", () => {
		/** A past meeting, so `loadRoleRecency` can see slots on it. */
		async function seedPastMeeting(clubId: string): Promise<string> {
			const id = await seedMeetingInProgress(clubId);
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) })
				.where(eq(meetings.id, id));
			return id;
		}

		async function memberRow(name: string): Promise<string> {
			const personId = await trackedPerson({ name });
			const [m] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name })
				.returning({ id: members.id });
			if (!m) throw new Error("Failed to insert member");
			return m.id;
		}

		async function latestMergeDetail() {
			const [row] = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_merge"),
					),
				)
				.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
				.limit(1);
			return row?.detail as {
				fromGuestId?: string;
				slotIds?: string[];
			} | null;
		}

		it("re-points every slot, past and upcoming, and creates no new roster row", async () => {
			// Per-run unique, because the Person assertion below has to be SCOPED:
			// `people` is club-less and global, vitest runs test FILES in parallel
			// against one shared `tm_test`, and an unscoped `count()` over it moves
			// for reasons that have nothing to do with this code. A first cut of
			// this test counted every row in `people` and passed alone, then failed
			// in the full suite — the exact order-dependence CLAUDE.md records.
			const who = `Linkable Guest ${randomUUID().slice(0, 8)}`;
			const guestId = await seedGuest(seed.clubId, who);
			const memberId = await memberRow(who);
			const past = await seedPastMeeting(seed.clubId);
			const pastSlot = await seedGuestRoleSlot(
				past,
				seed.roleDefinitionId,
				guestId,
			);
			const upcomingSlot = await seedGuestRoleSlot(
				seed.meetingId,
				seed.roleDefinitionId,
				guestId,
			);

			const [beforeMembers] = await testDb
				.select({ n: count() })
				.from(members)
				.where(eq(members.clubId, seed.clubId));
			const [beforePeople] = await testDb
				.select({ n: count() })
				.from(people)
				.where(eq(people.name, who));

			const res = await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId,
				actorMemberId: seed.adminMemberId,
			});
			expect([...res.slotIds].sort()).toEqual([pastSlot, upcomingSlot].sort());

			const slots = await testDb
				.select({
					id: roleSlots.id,
					memberId: roleSlots.assignedMemberId,
					guestId: roleSlots.assignedGuestId,
				})
				.from(roleSlots)
				.where(inArray(roleSlots.id, [pastSlot, upcomingSlot]));
			// BOTH, not just the upcoming one — role recency reads past meetings.
			expect(slots).toHaveLength(2);
			for (const s of slots) {
				expect(s.memberId).toBe(memberId);
				expect(s.guestId).toBeNull();
			}

			// A link creates no membership and no Person; both already exist.
			const [afterMembers] = await testDb
				.select({ n: count() })
				.from(members)
				.where(eq(members.clubId, seed.clubId));
			const [afterPeople] = await testDb
				.select({ n: count() })
				.from(people)
				.where(eq(people.name, who));
			expect(Number(afterMembers?.n)).toBe(Number(beforeMembers?.n));
			expect(Number(afterPeople?.n)).toBe(Number(beforePeople?.n));

			const [g] = await testDb
				.select({
					stage: guests.stage,
					converted: guests.convertedMembershipId,
				})
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g?.stage).toBe("joined");
			expect(g?.converted).toBe(memberId);

			// The recorded slot ids are the ONLY thing an unlink can restore from.
			const detail = await latestMergeDetail();
			expect(detail?.fromGuestId).toBe(guestId);
			expect([...(detail?.slotIds ?? [])].sort()).toEqual(
				[pastSlot, upcomingSlot].sort(),
			);
		});

		it("gives the member the guest's role history", async () => {
			// The acceptance criterion the whole design turns on. `loadRoleRecency`
			// groups PAST meetings by `assignedMemberId`, so an upcoming-only
			// re-point would leave this empty and the member would still read
			// "Never done this role" for a role they had demonstrably done.
			const { loadRoleRecency } = await import("#/server/role-recency-logic");
			const guestId = await seedGuest(seed.clubId, "History Guest");
			const memberId = await memberRow("History Guest");
			const past = await seedPastMeeting(seed.clubId);
			await seedGuestRoleSlot(past, seed.roleDefinitionId, guestId);

			const before = await loadRoleRecency({
				clubId: seed.clubId,
				before: new Date(),
			});
			expect(before.some((r) => r.memberId === memberId)).toBe(false);

			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId,
				actorMemberId: seed.adminMemberId,
			});

			const after = await loadRoleRecency({
				clubId: seed.clubId,
				before: new Date(),
			});
			expect(
				after.some(
					(r) =>
						r.memberId === memberId &&
						r.roleDefinitionId === seed.roleDefinitionId,
				),
			).toBe(true);
		});

		it("drops the guest out of the assign picker", async () => {
			const guestId = await seedGuest(seed.clubId, "Picker Guest");
			const memberId = await memberRow("Picker Guest");
			expect(
				(await listClubGuests(seed.clubId)).some((g) => g.id === guestId),
			).toBe(true);
			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId,
				actorMemberId: seed.adminMemberId,
			});
			expect(
				(await listClubGuests(seed.clubId)).some((g) => g.id === guestId),
			).toBe(false);
		});

		it("unlink restores exactly the slots the link moved, and nothing else", async () => {
			const guestId = await seedGuest(seed.clubId, "Undo Guest");
			const memberId = await memberRow("Undo Guest");
			const past = await seedPastMeeting(seed.clubId);
			const guestSlot = await seedGuestRoleSlot(
				past,
				seed.roleDefinitionId,
				guestId,
			);
			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId,
				actorMemberId: seed.adminMemberId,
			});

			// A slot the member picked up AFTER the link was never the guest's, so
			// unlink must leave it alone. Without the recorded id list, a naive
			// "give back everything this member holds" would steal it.
			const [later] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: seed.meetingId,
					roleDefinitionId: seed.roleDefinitionId,
					assignedMemberId: memberId,
					status: "claimed",
				})
				.returning({ id: roleSlots.id });
			if (!later) throw new Error("Failed to seed the later slot");

			await applyUnlinkGuestFromMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			const [restored] = await testDb
				.select({
					memberId: roleSlots.assignedMemberId,
					guestId: roleSlots.assignedGuestId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, guestSlot));
			expect(restored?.guestId).toBe(guestId);
			expect(restored?.memberId).toBeNull();

			const [untouched] = await testDb
				.select({ memberId: roleSlots.assignedMemberId })
				.from(roleSlots)
				.where(eq(roleSlots.id, later.id));
			expect(untouched?.memberId).toBe(memberId);

			const [g] = await testDb
				.select({
					stage: guests.stage,
					converted: guests.convertedMembershipId,
				})
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g?.stage).toBe("following_up");
			expect(g?.converted).toBeNull();
		});

		it("refuses a member from another club", async () => {
			const other = await seedClub();
			try {
				const guestId = await seedGuest(seed.clubId, "Wrong Club Member");
				await expect(
					applyLinkGuestToMember({
						clubId: seed.clubId,
						guestId,
						memberId: other.memberId,
						actorMemberId: seed.adminMemberId,
					}),
				).rejects.toThrow(LINK_MEMBER_NOT_IN_CLUB_MESSAGE);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("refuses a guest from another club", async () => {
			const other = await seedClub();
			try {
				const foreignGuest = await seedGuest(other.clubId, "Foreign Guest");
				const memberId = await memberRow("Foreign Guest");
				await expect(
					applyLinkGuestToMember({
						clubId: seed.clubId,
						guestId: foreignGuest,
						memberId,
						actorMemberId: seed.adminMemberId,
					}),
				).rejects.toThrow(/not found in this club/i);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("refuses a guest already linked to a live membership", async () => {
			const guestId = await seedGuest(seed.clubId, "Twice Linked");
			const first = await memberRow("Twice Linked");
			const second = await memberRow("Someone Else Entirely");
			await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId: first,
				actorMemberId: seed.adminMemberId,
			});
			await expect(
				applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId,
					memberId: second,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(LINK_ALREADY_JOINED_MESSAGE);
		});

		it("ALLOWS linking a stranded guest — that is the recovery it offers", async () => {
			// stage `joined` with a null pointer (#618): converted once, membership
			// since removed from the roster. Refusing these would leave them with no
			// path at all, which is the dead end this area keeps producing.
			const guestId = await seedGuest(seed.clubId, "Stranded Then Linked");
			await testDb
				.update(guests)
				.set({ stage: "joined", convertedMembershipId: null })
				.where(eq(guests.id, guestId));
			const memberId = await memberRow("Stranded Then Linked");
			const res = await applyLinkGuestToMember({
				clubId: seed.clubId,
				guestId,
				memberId,
				actorMemberId: seed.adminMemberId,
			});
			expect(res.ok).toBe(true);
		});

		it("refuses to unlink a guest that was never linked", async () => {
			const guestId = await seedGuest(seed.clubId, "Never Linked");
			await expect(
				applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNLINK_NOT_LINKED_MESSAGE);
		});

		it("refuses to unlink a REAL convert, which has a Person and membership to unwind", async () => {
			// `applyConvertGuestToMember` writes no `slotIds` record, so there is
			// nothing for this to replay — and half-reversing it would strand the
			// Person and membership it created. That undo is #618, not this.
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Real Convert",
				phone: "555-909-0001",
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			await expect(
				applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNLINK_NOT_LINKED_MESSAGE);
		});

		describe("link candidates", () => {
			it("marks name-agreeing members as suggested and others not", async () => {
				const guestId = await seedGuest(seed.clubId, "Bill Nakamura");
				const same = await memberRow("Bill Nakamura");
				const other = await memberRow("Zoe Unrelated");
				const rows = await loadLinkCandidates({
					clubId: seed.clubId,
					guestId,
				});
				expect(rows.find((r) => r.id === same)?.suggested).toBe(true);
				expect(rows.find((r) => r.id === other)?.suggested).toBe(false);
				// The WHOLE roster comes back, not just matches — the dialog needs the
				// annotations for a member found by free search too.
				expect(rows.length).toBeGreaterThan(1);
			});

			it("flags a member who shares a meeting with the guest", async () => {
				const guestId = await seedGuest(seed.clubId, "Shares Meeting");
				const clash = await memberRow("Clash Member");
				const clear = await memberRow("Clear Member");
				const meetingId = await seedPastMeeting(seed.clubId);
				await seedGuestRoleSlot(meetingId, seed.roleDefinitionId, guestId);
				await testDb.insert(roleSlots).values({
					meetingId,
					roleDefinitionId: seed.roleDefinitionId,
					assignedMemberId: clash,
					status: "claimed",
				});
				const rows = await loadLinkCandidates({
					clubId: seed.clubId,
					guestId,
				});
				expect(rows.find((r) => r.id === clash)?.sharesMeeting).toBe(true);
				expect(rows.find((r) => r.id === clear)?.sharesMeeting).toBe(false);
			});

			it("reports no collisions for a guest holding no slots", async () => {
				const guestId = await seedGuest(seed.clubId, "No Slots Guest");
				const rows = await loadLinkCandidates({
					clubId: seed.clubId,
					guestId,
				});
				expect(rows.length).toBeGreaterThan(0);
				expect(rows.every((r) => !r.sharesMeeting)).toBe(true);
			});
		});

		describe("linkReversible on the pipeline row", () => {
			// This flag decides WHICH button the board offers, and the seam tests
			// cannot see it. Both single-boolean versions of the rule shipped a
			// wrong button past a green suite: gating on `convertedMembershipId`
			// put an Unlink on real converts that fails every time, and gating on
			// `linkReversible` alone offered a real convert the Link button. Caught
			// by driving the board; pinned here so it stays caught.
			it("is true after a link and false after a real convert", async () => {
				const linkedGuest = await seedGuest(seed.clubId, "Reversible One");
				const memberId = await memberRow("Reversible One");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId: linkedGuest,
					memberId,
					actorMemberId: seed.adminMemberId,
				});

				const { guestId: convertedGuest } = await captureGuestVisit({
					clubId: seed.clubId,
					name: "Converted One",
					phone: "555-808-0002",
				});
				await applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId: convertedGuest,
					actorMemberId: seed.adminMemberId,
				});

				const rows = await loadGuestPipeline(seed.clubId);
				const linked = rows.find((r) => r.id === linkedGuest);
				const converted = rows.find((r) => r.id === convertedGuest);

				// Both carry a membership pointer — that is exactly why the pointer
				// alone cannot decide which control to show.
				expect(linked?.convertedMembershipId).toBeTruthy();
				expect(converted?.convertedMembershipId).toBeTruthy();

				expect(linked?.linkReversible).toBe(true);
				expect(converted?.linkReversible).toBe(false);
			});

			it("goes false again once the link is undone", async () => {
				const guestId = await seedGuest(seed.clubId, "Undone Reversible");
				const memberId = await memberRow("Undone Reversible");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId,
					memberId,
					actorMemberId: seed.adminMemberId,
				});
				await applyUnlinkGuestFromMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});
				const row = (await loadGuestPipeline(seed.clubId)).find(
					(r) => r.id === guestId,
				);
				// The link row is still in the log, but the pointer is null now, so
				// the join that derives this finds nothing — which is what keeps a
				// stale record from making an unlinked guest look reversible.
				expect(row?.convertedMembershipId).toBeNull();
				expect(row?.linkReversible).toBe(false);
			});
		});
	});

	describe("undo a convert-to-member (#618)", () => {
		/**
		 * Convert a fresh guest and hand back every id the undo reasons about.
		 *
		 * Deliberately goes through `applyConvertGuestToMember` rather than
		 * hand-writing the rows: the undo replays the ACTIVITY RECORD convert
		 * writes, so a fixture that stamped `stage`/`converted_membership_id`
		 * directly would test a state production never produces.
		 */
		async function converted(name: string) {
			const guestId = await seedGuest(seed.clubId, name);
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			strayPeople.push(res.personId);
			return { guestId, ...res };
		}

		/** Strip the replayable keys, leaving the pre-#618 record shape. */
		async function stripRecord(guestId: string) {
			const [row] = await testDb
				.select({ id: activityLog.id, detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_add"),
						sql`${activityLog.detail}->>'fromGuestId' = ${guestId}`,
					),
				)
				.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
				.limit(1);
			if (!row) throw new Error("No conversion record to strip");
			const d = row.detail as Record<string, unknown>;
			await testDb
				.update(activityLog)
				.set({
					detail: {
						name: d.name,
						fromGuestId: d.fromGuestId,
						personId: d.personId,
					},
				})
				.where(eq(activityLog.id, row.id));
		}

		async function guestRow(guestId: string) {
			const [g] = await testDb
				.select({
					stage: guests.stage,
					convertedMembershipId: guests.convertedMembershipId,
				})
				.from(guests)
				.where(eq(guests.id, guestId))
				.limit(1);
			return g;
		}

		it("returns the guest, its slots and the roster to before the convert", async () => {
			const guestId = await seedGuest(seed.clubId, "Misclick Guest");
			const slotId = await seedGuestRoleSlot(
				seed.meetingId,
				seed.roleDefinitionId,
				guestId,
			);
			const { membershipId, personId } = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			strayPeople.push(personId);

			const res = await applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			expect(res.membershipDeleted).toBe(true);
			expect(res.slotIds).toEqual([slotId]);

			// The slot goes back to the GUEST, not to open. This is what orders the
			// membership delete after the slot move: the FK would otherwise null
			// `assigned_member_id` on its way out and strand the slot unassigned.
			const [slot] = await testDb
				.select({
					memberId: roleSlots.assignedMemberId,
					guestId: roleSlots.assignedGuestId,
					status: roleSlots.status,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId))
				.limit(1);
			expect(slot?.guestId).toBe(guestId);
			expect(slot?.memberId).toBeNull();
			expect(slot?.status).toBe("claimed");

			const g = await guestRow(guestId);
			expect(g?.stage).toBe("following_up");
			expect(g?.convertedMembershipId).toBeNull();

			const [gone] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.id, membershipId))
				.limit(1);
			expect(gone).toBeUndefined();
		});

		it("logs the undo against the membership it removed", async () => {
			const { guestId, membershipId } = await converted("Logged Undo");
			await applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			const [row] = await testDb
				.select({ detail: activityLog.detail, targetId: activityLog.targetId })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_remove"),
						eq(activityLog.targetId, membershipId),
					),
				)
				.orderBy(desc(activityLog.createdAt), desc(activityLog.id))
				.limit(1);
			expect(row).toBeDefined();
			const detail = row?.detail as { undoneGuestId?: string } | null;
			expect(detail?.undoneGuestId).toBe(guestId);
		});

		it("refuses a guest that was never converted", async () => {
			const guestId = await seedGuest(seed.clubId, "Never Converted");
			await expect(
				applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNDO_NOT_CONVERTED_MESSAGE);
		});

		it("refuses a STRANDED guest, whose membership is already gone", async () => {
			// #632 gave this row its stage and delete controls back; there is no
			// membership left to unwind, so the undo is not the recovery for it.
			const { guestId, membershipId } = await converted("Stranded Undo");
			await testDb.delete(members).where(eq(members.id, membershipId));
			await expect(
				applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNDO_NOT_CONVERTED_MESSAGE);
		});

		it("refuses a conversion that predates the replayable record", async () => {
			const { guestId } = await converted("Old Conversion");
			await stripRecord(guestId);
			await expect(
				applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNDO_NO_RECORD_MESSAGE);
		});

		it("refuses when the converted member can sign in", async () => {
			const { guestId, personId } = await converted("Account Undo");
			await testDb
				.update(people)
				.set({ userId: seed.memberUserId })
				.where(eq(people.id, personId));
			await expect(
				applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNDO_MEMBER_HAS_ACCOUNT_MESSAGE);
		});

		it("refuses when the member took on a role the conversion did not move", async () => {
			const { guestId, membershipId } = await converted("Busy Undo");
			await testDb.insert(roleSlots).values({
				meetingId: seed.meetingId,
				roleDefinitionId: seed.roleDefinitionId,
				assignedMemberId: membershipId,
				status: "claimed",
			});
			await expect(
				applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNDO_MEMBER_HAS_HISTORY_MESSAGE("roles"));
		});

		it("refuses when the member has dues recorded", async () => {
			const { guestId, membershipId } = await converted("Dues Undo");
			const [period] = await testDb
				.insert(duesPeriods)
				.values({
					clubId: seed.clubId,
					label: `Undo period ${randomUUID()}`,
					dueDate: new Date(),
				})
				.returning({ id: duesPeriods.id });
			if (!period) throw new Error("Failed to seed dues period");
			await testDb.insert(memberDues).values({
				membershipId,
				duesPeriodId: period.id,
				status: "paid",
			});
			await expect(
				applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNDO_MEMBER_HAS_HISTORY_MESSAGE("dues records"));
		});

		it("refuses when a Person this conversion MINTED has since spoken", async () => {
			// Only meaningful on a fresh Person: a speech on one it deduped onto is
			// somebody's pre-existing history, and removing a membership does not
			// destroy it (speeches hang off `people`, not `members`).
			const { guestId, personId } = await converted("Spoken Undo");
			await testDb.insert(speeches).values({ personId, title: "First speech" });
			await expect(
				applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNDO_MEMBER_HAS_HISTORY_MESSAGE("speeches"));
		});

		it("leaves a REUSED membership standing and still frees the guest", async () => {
			// Convert dedupes onto an existing Person and reuses their membership in
			// this club, so that row predates the conversion. Deleting it would
			// destroy roster data the conversion never created.
			const personId = await trackedPerson({
				name: "Existing Human",
				email: `reuse-${randomUUID()}@example.com`,
			});
			const [existing] = await testDb
				.insert(members)
				.values({ clubId: seed.clubId, personId, name: "Existing Human" })
				.returning({ id: members.id });
			if (!existing) throw new Error("Failed to seed membership");
			const guestId = await seedGuest(seed.clubId, "Existing Human");
			const [person] = await testDb
				.select({ email: people.email })
				.from(people)
				.where(eq(people.id, personId))
				.limit(1);
			await testDb
				.update(guests)
				.set({ email: person?.email ?? null })
				.where(eq(guests.id, guestId));

			const conv = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			expect(conv.membershipId).toBe(existing.id);

			const res = await applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			expect(res.membershipDeleted).toBe(false);

			const [still] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.id, existing.id))
				.limit(1);
			expect(still?.id).toBe(existing.id);
			const g = await guestRow(guestId);
			expect(g?.stage).toBe("following_up");
			expect(g?.convertedMembershipId).toBeNull();
		});

		it("refuses when the member holds an officer term", async () => {
			// `officer_terms.membership_id` cascades on delete, so an undo without
			// this guard erases a term silently — the worst shape of data loss.
			const { guestId, membershipId } = await converted("Officer Undo");
			await testDb.insert(officerTerms).values({
				membershipId,
				position: "president",
				termStart: new Date(),
			});
			await expect(
				applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNDO_MEMBER_HAS_HISTORY_MESSAGE("an officer term"));
		});

		it("leaves a recorded slot that has since moved to someone else", async () => {
			// The "no extra roles" guard proves the member holds nothing beyond the
			// recorded set; it says nothing about a recorded slot having moved AWAY.
			// Replaying it blindly would take a role off a third party.
			const guestId = await seedGuest(seed.clubId, "Moved Slot Guest");
			const slotId = await seedGuestRoleSlot(
				seed.meetingId,
				seed.roleDefinitionId,
				guestId,
			);
			const { personId } = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			strayPeople.push(personId);

			// The VPE reassigns that slot to a different member afterwards.
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId })
				.where(eq(roleSlots.id, slotId));

			await applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			const [slot] = await testDb
				.select({
					memberId: roleSlots.assignedMemberId,
					guestId: roleSlots.assignedGuestId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId))
				.limit(1);
			expect(slot?.memberId).toBe(seed.memberId);
			expect(slot?.guestId).toBeNull();
		});

		it("cannot be replayed twice", async () => {
			const { guestId } = await converted("Twice Undo");
			await applyUndoGuestConversion({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			await expect(
				applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(UNDO_NOT_CONVERTED_MESSAGE);
		});

		describe("conversionUndoable on the board", () => {
			async function flagFor(guestId: string) {
				const rows = await loadGuestPipeline(seed.clubId);
				return rows.find((r) => r.id === guestId)?.conversionUndoable;
			}

			it("is true for a real convert and false once undone", async () => {
				const { guestId } = await converted("Flag Undo");
				expect(await flagFor(guestId)).toBe(true);
				await applyUndoGuestConversion({
					clubId: seed.clubId,
					guestId,
					actorMemberId: seed.adminMemberId,
				});
				expect(await flagFor(guestId)).toBe(false);
			});

			it("is false for a conversion with no replayable record", async () => {
				// The board must not offer an Undo the server would refuse — the same
				// failure the Unlink button had before `linkReversible` existed.
				const { guestId } = await converted("Flag Old");
				await stripRecord(guestId);
				expect(await flagFor(guestId)).toBe(false);
			});

			it("is false for a LINK, which Unlink owns", async () => {
				const guestId = await seedGuest(seed.clubId, "Flag Link");
				const linkPersonId = await trackedPerson({ name: "Flag Link" });
				const [m] = await testDb
					.insert(members)
					.values({
						clubId: seed.clubId,
						personId: linkPersonId,
						name: "Flag Link",
					})
					.returning({ id: members.id });
				if (!m) throw new Error("Failed to seed member");
				await applyLinkGuestToMember({
					clubId: seed.clubId,
					guestId,
					memberId: m.id,
					actorMemberId: seed.adminMemberId,
				});
				expect(await flagFor(guestId)).toBe(false);
			});
		});
	});
});
