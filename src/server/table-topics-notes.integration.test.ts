/**
 * DB-backed tests for the Table Topics notes capability (#880): a club admin,
 * the meeting's self-asserted TMOD, OR the meeting's self-asserted Table Topics
 * Master may edit `meetings.table_topics_notes` — and the TTM's writer can touch
 * nothing else. Tests the plain logic fns directly (`#/db` → test database).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/table-topics-notes.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings, members, roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveTableTopicsNotesAuthz } = await import("./meeting-authz-logic");
const {
	applyMeetingMetaPatch,
	applyTableTopicsNotesUpdate,
	applyWordOfTheDayUpdate,
} = await import("./meetings-logic");

/** Add a role def + slot to the meeting; optionally assign a member. */
async function addRoleSlot(
	club: SeededClub,
	name: string,
	assignedMemberId: string | null,
	key: string | null,
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

const readMeeting = async (id: string) => {
	const row = await testDb.query.meetings.findFirst({
		where: eq(meetings.id, id),
	});
	if (!row) throw new Error("meeting vanished");
	return row;
};

const NOTES = "1. 🏆 THE COMEBACK\nTell us your “I almost gave up” story.";

describe.skipIf(!hasTestDb)("resolveTableTopicsNotesAuthz (#880)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("allows a club admin (session) — via admin", async () => {
		const authz = await resolveTableTopicsNotesAuthz({
			meetingId: club.meetingId,
			sessionUserId: club.adminUserId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("admin");
	});

	it("allows the meeting's Table Topics Master, by key, after a rename", async () => {
		await addRoleSlot(
			club,
			"Topicsmaster",
			club.memberId,
			"table_topics_master",
		);
		const authz = await resolveTableTopicsNotesAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("table-topics-master-self-assert");
		expect(authz.actorMemberId).toBe(club.memberId);
	});

	it("allows the meeting's Toastmaster — via tmod-self-assert", async () => {
		await addRoleSlot(
			club,
			"Toastmaster of the Day",
			club.memberId,
			"toastmaster_of_the_day",
		);
		const authz = await resolveTableTopicsNotesAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(true);
		expect(authz.via).toBe("tmod-self-assert");
	});

	it("refuses a member who is neither the TTM nor the TMOD nor an officer", async () => {
		await addRoleSlot(
			club,
			"Table Topics Master",
			club.memberId,
			"table_topics_master",
		);
		await addRoleSlot(club, "Grammarian", null, "grammarian");
		const other = await addRosterMember(club.clubId, "Someone Else");
		const authz = await resolveTableTopicsNotesAuthz({
			meetingId: club.meetingId,
			selfMemberId: other,
		});
		expect(authz.allowed).toBe(false);
		expect(authz.via).toBe(null);
		expect(authz.actorMemberId).toBe(null);
	});

	it("refuses the Grammarian — the WOD grant does not reach the notes", async () => {
		await addRoleSlot(club, "Grammarian", club.memberId, "grammarian");
		const authz = await resolveTableTopicsNotesAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(false);
	});

	it("refuses a club-invented look-alike with a NULL key (#464)", async () => {
		await addRoleSlot(
			club,
			"Table Topics Master Assistant",
			club.memberId,
			null,
		);
		const authz = await resolveTableTopicsNotesAuthz({
			meetingId: club.meetingId,
			selfMemberId: club.memberId,
		});
		expect(authz.allowed).toBe(false);
	});

	it("refuses anyone when the TTM slot is unassigned", async () => {
		await addRoleSlot(club, "Table Topics Master", null, "table_topics_master");
		const someone = await addRosterMember(club.clubId, "Wannabe");
		const authz = await resolveTableTopicsNotesAuthz({
			meetingId: club.meetingId,
			selfMemberId: someone,
		});
		expect(authz.allowed).toBe(false);
	});

	it("throws when the meeting is completed (locked choke point)", async () => {
		await addRoleSlot(
			club,
			"Table Topics Master",
			club.memberId,
			"table_topics_master",
		);
		await testDb
			.update(meetings)
			.set({ status: "completed" })
			.where(eq(meetings.id, club.meetingId));
		await expect(
			resolveTableTopicsNotesAuthz({
				meetingId: club.meetingId,
				selfMemberId: club.memberId,
			}),
		).rejects.toThrow();
	});
});

describe.skipIf(!hasTestDb)("applyTableTopicsNotesUpdate (#880)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("writes the notes with line breaks and emoji intact, and nothing else", async () => {
		await testDb
			.update(meetings)
			.set({
				theme: "Existing theme",
				wordOfTheDay: "ineffable",
				wodDefinition: "too great for words",
				location: "Room 5",
				reminders: "Dues are due",
			})
			.where(eq(meetings.id, club.meetingId));
		const before = await readMeeting(club.meetingId);

		await applyTableTopicsNotesUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			tableTopicsNotes: `  ${NOTES}  `,
		});

		const after = await readMeeting(club.meetingId);
		expect(after.tableTopicsNotes).toBe(NOTES);
		expect({ ...after, tableTopicsNotes: null }).toEqual({
			...before,
			tableTopicsNotes: null,
		});
	});

	it("clears on blank and leaves the column alone when omitted", async () => {
		await applyTableTopicsNotesUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			tableTopicsNotes: NOTES,
		});
		await applyTableTopicsNotesUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
		});
		expect((await readMeeting(club.meetingId)).tableTopicsNotes).toBe(NOTES);

		await applyTableTopicsNotesUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			tableTopicsNotes: "   \n  ",
		});
		expect((await readMeeting(club.meetingId)).tableTopicsNotes).toBe(null);
	});

	it("saving theme or Word of the Day does not change the notes", async () => {
		await applyTableTopicsNotesUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			tableTopicsNotes: NOTES,
		});
		// The theme editor's payload through the general patch (#772).
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			canReschedule: false,
			theme: "New theme",
		});
		await applyWordOfTheDayUpdate({
			meetingId: club.meetingId,
			actorMemberId: club.memberId,
			wordOfTheDay: "loquacious",
		});
		const after = await readMeeting(club.meetingId);
		expect(after.theme).toBe("New theme");
		expect(after.wordOfTheDay).toBe("loquacious");
		expect(after.tableTopicsNotes).toBe(NOTES);
	});

	it("the officer dialog's general patch writes and clears the notes", async () => {
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: null,
			tableTopicsNotes: NOTES,
		});
		expect((await readMeeting(club.meetingId)).tableTopicsNotes).toBe(NOTES);
		await applyMeetingMetaPatch({
			meetingId: club.meetingId,
			actorMemberId: null,
			tableTopicsNotes: null,
		});
		expect((await readMeeting(club.meetingId)).tableTopicsNotes).toBe(null);
	});
});
