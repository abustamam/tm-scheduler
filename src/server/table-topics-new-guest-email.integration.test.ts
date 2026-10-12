/**
 * The Table Topics new-guest path takes a NAME only (#1157).
 *
 * `addTableTopics` may be reached by the meeting's self-asserted Ballot Counter,
 * who is not an officer vouching for an address, and its UI sends a name and
 * nothing else. The schema now says the same: a stale or hand-made call that
 * still carries an email has it dropped by the validator, not stored.
 *
 * Executes the REAL `createServerFn` handler through the minimal adapter
 * `cancelled-meeting-officer-writes.integration.test.ts` uses, with the cookie
 * to session lookup faked and nothing else.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAwards,
	meetings,
	people,
	tableTopicsSpeakers,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
		handler:
			(handle: (input: { data: unknown }) => unknown) =>
			({ data }: { data: unknown }) =>
				handle({ data }),
	}),
}));

let sessionUserId: string | null = null;
let request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const { addTableTopics, setMinutesAward } = await import("./minutes");

describe.skipIf(!hasTestDb)(
	"A new guest from Table Topics or an award carries a name only (#1157)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			request = { headers: new Headers() };
			seed = await seedClub();
			sessionUserId = seed.adminUserId;
			// The day has arrived, so the recordable-meeting check passes.
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 60 * 60 * 1000) })
				.where(eq(meetings.id, seed.meetingId));
		});

		afterEach(async () => {
			sessionUserId = null;
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		// protects=a Table Topics new guest called with an email ends with Person.email NULL and guests.book_email NULL;
		// fails_when=the schema accepts newGuest.email again and writes it to the Person (a sign-in key) or the guest row;
		// no_claim=the admin-only minutes add-guest path, which keeps its email; the session is faked, the validator, handler and DB write are real.
		it("drops an email sent with the new guest instead of storing it (AC 4)", async () => {
			// An extra key is outside the schema's input type; a stale tab still sends it.
			const call = {
				data: {
					meetingId: seed.meetingId,
					newGuest: { name: "Topics Guest", email: "extra@example.com" },
				},
			} as unknown as Parameters<typeof addTableTopics>[0];

			await addTableTopics(call);

			const [speaker] = await testDb
				.select({ guestId: tableTopicsSpeakers.guestId })
				.from(tableTopicsSpeakers)
				.where(eq(tableTopicsSpeakers.meetingId, seed.meetingId));
			expect(speaker?.guestId).toBeTruthy();
			const [row] = await testDb
				.select({
					name: guests.name,
					bookEmail: guests.bookEmail,
					personEmail: people.email,
				})
				.from(guests)
				.innerJoin(people, eq(people.id, guests.personId))
				.where(eq(guests.id, speaker?.guestId as string));
			expect(row).toEqual({
				name: "Topics Guest",
				bookEmail: null,
				personEmail: null,
			});
		});

		// protects=an award's new guest called with an email ends with Person.email NULL and guests.book_email NULL, matching the award picker's name-only UI;
		// fails_when=the award schema accepts newGuest.email again and writes it to the Person (a sign-in key) or the guest row;
		// no_claim=the award's disqualification and vote-counter gates; the session is faked, the validator, handler and DB write are real.
		it("an award's new guest takes a name only (the award path matches its UI)", async () => {
			const call = {
				data: {
					meetingId: seed.meetingId,
					category: "best_speaker",
					newGuest: { name: "Award Guest", email: "extra@example.com" },
				},
			} as unknown as Parameters<typeof setMinutesAward>[0];

			await setMinutesAward(call);

			const [award] = await testDb
				.select({ guestId: meetingAwards.guestId })
				.from(meetingAwards)
				.where(eq(meetingAwards.meetingId, seed.meetingId));
			expect(award?.guestId).toBeTruthy();
			const [row] = await testDb
				.select({
					name: guests.name,
					bookEmail: guests.bookEmail,
					personEmail: people.email,
				})
				.from(guests)
				.innerJoin(people, eq(people.id, guests.personId))
				.where(eq(guests.id, award?.guestId as string));
			expect(row).toEqual({
				name: "Award Guest",
				bookEmail: null,
				personEmail: null,
			});
		});
	},
);
