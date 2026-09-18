/**
 * DB-backed tests for the two writes behind the focused duty editors (#666):
 * the Toastmaster's theme and the Grammarian's Word of the Day.
 *
 * ## What is new here, given the authorization already existed
 *
 * `meeting-authz.integration.test.ts` and `word-of-the-day.integration.test.ts`
 * already prove the grant ladders. What neither covers is the WRITE the focused
 * editors actually make — and that is where this feature's own risk lives:
 *
 *   1. **A theme save must leave the rest of the meeting alone.** It used to be
 *      a full REPLACE, so a theme-only save nulled the club's location, Word of
 *      the Day, definition, example, announcements and notes unless the editor
 *      echoed all six back. #772 made the writer a PATCH, so the preservation
 *      below is now a property of the WRITER rather than of every caller's
 *      memory — and the control at the bottom of this file, which used to
 *      reproduce the damage, is what says so: it sends the bare payload that
 *      erased six fields and asserts they survive.
 *   2. **A self-serve Toastmaster may not reschedule.** Since #772 the editor
 *      omits `scheduledAt` entirely rather than resubmitting the meeting's wall
 *      time for `applyMeetingMetaPatch` to compare TO THE MINUTE, so the
 *      round-trip hazard is gone; what is left to prove is that omitting it is
 *      not read as a move. The admin dialog still sends it, so the comparison
 *      itself still has to work — `meeting-meta-patch.integration.test.ts`
 *      covers that arm.
 *
 * The denial cases are stated in the editors' terms rather than the resolvers':
 * the question this file answers is "can the Grammarian who tapped their chat
 * link save the theme?", and the answer has to come from the same pair of calls
 * the route makes.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/personal-duty-edit.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { utcToZonedWallTime } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveMeetingAgendaAuthz, resolveWordOfTheDayAuthz } = await import(
	"./meeting-authz-logic"
);
const { applyMeetingMetaPatch, applyWordOfTheDayUpdate } = await import(
	"./meetings-logic"
);

/** The stored meta a theme-only save must leave alone. Distinct values, so a
 *  payload that crosses two fields fails rather than passing on a shared one. */
const STORED_META = {
	location: "The Old Library, Room 5",
	// #731. The costliest of these to lose: for an online-only club the join link
	// is the room, and the save that used to take it is one a TMOD makes from
	// their phone on meeting night.
	joinUrl: "https://zoom.us/j/1234567890",
	wordOfTheDay: "ineffable",
	wodDefinition: "too great to be expressed in words",
	wodExample: "an ineffable joy",
	notes: "Bring the spare timing lights",
	reminders: "Contest entries close Friday",
	theme: "Old theme",
};

/** Add a role def + slot to the seeded meeting, optionally assigned.
 *  `key` defaults to NULL — the shape `createClubRole` produces for every
 *  club-invented role, and the one #464 is about. */
async function addRoleSlot(
	club: SeededClub,
	name: string,
	assignedMemberId: string | null,
	key: string | null = null,
): Promise<void> {
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId: club.clubId,
			name,
			key,
			category: "functionary",
			isSpeakerRole: false,
			sortOrder: 50,
		})
		.returning({ id: roleDefinitions.id });
	await testDb.insert(roleSlots).values({
		meetingId: club.meetingId,
		roleDefinitionId: def.id,
		status: assignedMemberId ? "claimed" : "open",
		assignedMemberId,
	});
}

async function addRosterMember(clubId: string, name: string): Promise<string> {
	const personId = await seedPerson({ name });
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId, name })
		.returning({ id: members.id });
	return m.id;
}

const readMeeting = (meetingId: string) =>
	testDb.query.meetings.findFirst({ where: eq(meetings.id, meetingId) });

describe.skipIf(!hasTestDb)("focused duty editors — the writes", () => {
	let club: SeededClub;
	/** The meeting's current wall time in the club's zone — what the editor
	 *  resubmits so the save reads as a no-op rather than a reschedule. */
	let wallTime: string;

	beforeEach(async () => {
		club = await seedClub();
		await testDb
			.update(meetings)
			.set(STORED_META)
			.where(eq(meetings.id, club.meetingId));
		const [meeting, clubRow] = await Promise.all([
			readMeeting(club.meetingId),
			testDb.query.clubs.findFirst({ where: eq(clubs.id, club.clubId) }),
		]);
		if (!meeting || !clubRow) throw new Error("seed failed");
		wallTime = utcToZonedWallTime(meeting.scheduledAt, clubRow.timezone);
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	/** The theme save the route makes, end to end: resolve, then write. */
	async function saveTheme(selfMemberId: string | null, theme: string) {
		const authz = await resolveMeetingAgendaAuthz({
			meetingId: club.meetingId,
			selfMemberId,
		});
		if (!authz.allowed) return { allowed: false as const };
		// The payload the editor actually sends since #772: the theme, and nothing
		// it is not editing. No `scheduledAt`, no echo of the other six fields.
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			theme,
			actorMemberId: authz.actorMemberId,
			canReschedule: authz.via === "admin",
		});
		return { allowed: true as const, via: authz.via };
	}

	/** The Word-of-the-Day save the route makes, end to end. */
	async function saveWord(
		selfMemberId: string | null,
		wod: { word?: string; definition?: string; example?: string },
	) {
		const authz = await resolveWordOfTheDayAuthz({
			meetingId: club.meetingId,
			selfMemberId,
		});
		if (!authz.allowed) return { allowed: false as const };
		await applyWordOfTheDayUpdate({
			meetingId: club.meetingId,
			actorMemberId: authz.actorMemberId,
			wordOfTheDay: wod.word,
			wodDefinition: wod.definition,
			wodExample: wod.example,
		});
		return { allowed: true as const, via: authz.via };
	}

	describe("who may save the theme", () => {
		it("the Toastmaster's self-asserted id can, with no session", async () => {
			await addRoleSlot(club, "Toastmaster of the Day", club.memberId);
			const result = await saveTheme(club.memberId, "New beginnings");
			expect(result.allowed).toBe(true);
			expect((await readMeeting(club.meetingId))?.theme).toBe("New beginnings");
		});

		it("the Grammarian's cannot", async () => {
			await addRoleSlot(club, "Toastmaster of the Day", null);
			await addRoleSlot(club, "Grammarian", club.memberId);
			expect((await saveTheme(club.memberId, "Nope")).allowed).toBe(false);
			expect((await readMeeting(club.meetingId))?.theme).toBe("Old theme");
		});

		it("a member holding no relevant role cannot", async () => {
			await addRoleSlot(club, "Toastmaster of the Day", club.memberId);
			const other = await addRosterMember(club.clubId, "Someone Else");
			expect((await saveTheme(other, "Nope")).allowed).toBe(false);
			expect((await readMeeting(club.meetingId))?.theme).toBe("Old theme");
		});

		// #464. Every club-invented role carries a NULL key, so the name fallback
		// is what decides — and it matches the canonical name EXACTLY.
		it("a club-invented role whose key is NULL cannot, however it is named", async () => {
			await addRoleSlot(club, "Toastmaster Assistant", club.memberId, null);
			expect((await saveTheme(club.memberId, "Nope")).allowed).toBe(false);
			expect((await readMeeting(club.meetingId))?.theme).toBe("Old theme");
		});
	});

	describe("who may save the Word of the Day", () => {
		it("the Grammarian's self-asserted id can, with no session", async () => {
			await addRoleSlot(club, "Grammarian", club.memberId);
			const result = await saveWord(club.memberId, {
				word: "loquacious",
				definition: "tending to talk a great deal",
				example: "a loquacious Table Topics answer",
			});
			expect(result.allowed).toBe(true);
			expect(result.allowed && result.via).toBe("grammarian-self-assert");
			expect((await readMeeting(club.meetingId))?.wordOfTheDay).toBe(
				"loquacious",
			);
		});

		it("a member holding no relevant role cannot", async () => {
			await addRoleSlot(club, "Grammarian", club.memberId);
			const other = await addRosterMember(club.clubId, "Someone Else");
			expect((await saveWord(other, { word: "nope" })).allowed).toBe(false);
			expect((await readMeeting(club.meetingId))?.wordOfTheDay).toBe(
				"ineffable",
			);
		});

		it("a club-invented role whose key is NULL cannot, however it is named", async () => {
			await addRoleSlot(club, "Grammarian Assistant", club.memberId, null);
			expect((await saveWord(club.memberId, { word: "nope" })).allowed).toBe(
				false,
			);
			expect((await readMeeting(club.meetingId))?.wordOfTheDay).toBe(
				"ineffable",
			);
		});

		it("carries an untouched definition and example back with a new word", async () => {
			// `applyWordOfTheDayUpdate` nulls what it is not given, so the editor
			// submits all three every time. A word-only payload is the bug.
			await addRoleSlot(club, "Grammarian", club.memberId);
			await saveWord(club.memberId, {
				word: "loquacious",
				definition: STORED_META.wodDefinition,
				example: STORED_META.wodExample,
			});
			const after = await readMeeting(club.meetingId);
			expect(after?.wodDefinition).toBe(STORED_META.wodDefinition);
			expect(after?.wodExample).toBe(STORED_META.wodExample);
		});

		/**
		 * AC 4 (#731). True by CONSTRUCTION — `applyWordOfTheDayUpdate` writes only
		 * the three Word-of-the-Day columns, so it cannot touch the join link — but
		 * "true by construction" is a property of today's implementation, and this
		 * is the assertion that notices if that ever stops being true.
		 *
		 * It is a real risk rather than a theoretical one: the obvious "fix" for a
		 * future Grammarian-editable field is to widen this writer toward the
		 * general one, which reaches every meta column.
		 */
		it("a Grammarian saving only the Word of the Day leaves the join link intact", async () => {
			await addRoleSlot(club, "Grammarian", club.memberId);
			await saveWord(club.memberId, {
				word: "loquacious",
				definition: STORED_META.wodDefinition,
				example: STORED_META.wodExample,
			});
			expect((await readMeeting(club.meetingId))?.joinUrl).toBe(
				STORED_META.joinUrl,
			);
		});
	});

	describe("the closed windows", () => {
		it("a completed meeting is locked for both editors", async () => {
			await addRoleSlot(club, "Toastmaster of the Day", club.memberId);
			await addRoleSlot(club, "Grammarian", club.memberId);
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, club.meetingId));
			await expect(saveTheme(club.memberId, "Nope")).rejects.toThrow();
			await expect(saveWord(club.memberId, { word: "nope" })).rejects.toThrow();
		});

		it("an archived club throws for both editors, before either grant arm", async () => {
			// Takedown outranks every other reason to refuse, and it fires for the
			// session-less self-assert arm as well as the admin one (#555).
			await addRoleSlot(club, "Toastmaster of the Day", club.memberId);
			await addRoleSlot(club, "Grammarian", club.memberId);
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, club.clubId));
			await expect(saveTheme(club.memberId, "Nope")).rejects.toThrow(
				/archived|no longer/i,
			);
			await expect(saveWord(club.memberId, { word: "nope" })).rejects.toThrow(
				/archived|no longer/i,
			);
		});
	});

	describe("a theme save leaves the rest of the meeting alone", () => {
		it("preserves every other meta field", async () => {
			await addRoleSlot(club, "Toastmaster of the Day", club.memberId);
			await saveTheme(club.memberId, "New beginnings");
			const after = await readMeeting(club.meetingId);
			expect(after?.theme).toBe("New beginnings");
			expect(after?.location).toBe(STORED_META.location);
			// #731. The costliest of these to lose: for an online-only club the
			// join link is the room, and this save is one a TMOD makes from their
			// phone on meeting night.
			expect(after?.joinUrl).toBe(STORED_META.joinUrl);
			expect(after?.wordOfTheDay).toBe(STORED_META.wordOfTheDay);
			expect(after?.wodDefinition).toBe(STORED_META.wodDefinition);
			expect(after?.wodExample).toBe(STORED_META.wodExample);
			expect(after?.notes).toBe(STORED_META.notes);
			expect(after?.reminders).toBe(STORED_META.reminders);
		});

		it("does not move the meeting, and is not refused as a reschedule", async () => {
			// The self-serve TMOD carries `canReschedule = false`. Before #772 the
			// editor had to resubmit the meeting's wall time and this test turned on
			// `zonedWallTimeToUtc` round-tripping what `utcToZonedWallTime` produced;
			// now it omits the field, and what is proved is that saying nothing about
			// the time neither moves it nor reads as a move.
			await addRoleSlot(club, "Toastmaster of the Day", club.memberId);
			const before = await readMeeting(club.meetingId);
			await saveTheme(club.memberId, "New beginnings");
			const after = await readMeeting(club.meetingId);
			expect(Math.floor((after?.scheduledAt.getTime() ?? 0) / 60000)).toBe(
				Math.floor((before?.scheduledAt.getTime() ?? 1) / 60000),
			);
			expect(after?.lengthMinutes).toBe(before?.lengthMinutes);
		});

		/**
		 * The old CONTROL, inverted — and it is the most useful test in this file to
		 * read, because it is the diff.
		 *
		 * It used to send this exact payload to prove the damage was real and close:
		 * a bare `{ meetingId, scheduledAt, theme }` was accepted, reported success,
		 * and took SIX fields with it. Those six `toBeNull()` assertions are the
		 * `toBe(STORED_META.…)` ones below. Keeping the case rather than deleting it
		 * keeps the repro in the file the fix has to satisfy: if the writer ever
		 * goes back to naming columns it was not given, this fails first.
		 */
		it("the bare payload that used to erase six fields now preserves them", async () => {
			await addRoleSlot(club, "Toastmaster of the Day", club.memberId);
			const authz = await resolveMeetingAgendaAuthz({
				meetingId: club.meetingId,
				selfMemberId: club.memberId,
			});
			expect(authz.allowed).toBe(true);
			await applyMeetingMetaPatch({
				meetingId: club.meetingId,
				scheduledAt: wallTime,
				theme: "New beginnings",
				actorMemberId: authz.actorMemberId,
				canReschedule: false,
			});
			const after = await readMeeting(club.meetingId);
			expect(after?.theme).toBe("New beginnings");
			expect(after?.location).toBe(STORED_META.location);
			expect(after?.joinUrl).toBe(STORED_META.joinUrl);
			expect(after?.wordOfTheDay).toBe(STORED_META.wordOfTheDay);
			expect(after?.wodDefinition).toBe(STORED_META.wodDefinition);
			expect(after?.wodExample).toBe(STORED_META.wodExample);
			expect(after?.notes).toBe(STORED_META.notes);
			expect(after?.reminders).toBe(STORED_META.reminders);
		});
	});
});
