/**
 * DB-backed tests for the ORDER of the archive gate and the frozen-meeting
 * refusal in the Word of the Day and Table Topics notes resolvers (#1134).
 *
 * The archive gate must run first: with the status refusal first, an archived
 * club's COMPLETED (or cancelled) meeting answers "this meeting is locked" /
 * "this meeting is cancelled", which discloses meeting state the takedown was
 * meant to end and answers differently from the same club's scheduled meeting.
 * `meeting-authz.integration.test.ts` covers the agenda resolver's completed
 * case; these cover the other two. #1134 moved all three onto
 * `assertMeetingAccepts`, so the call now sits one line from the gate and a
 * reorder is a one-line mistake. `public-readers-archive-gate.guard.test.ts`
 * pins the order in source; this pins it in behaviour, and the CONTROL cases
 * (the same meeting, club not archived) prove the status refusal itself is
 * still what answers when the club is live, so a swapped message cannot make
 * both read green.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-authz-archived-frozen.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { resolveTableTopicsNotesAuthz, resolveWordOfTheDayAuthz } = await import(
	"./meeting-authz-logic"
);

const RESOLVERS = [
	["Word of the Day", resolveWordOfTheDayAuthz],
	["Table Topics notes", resolveTableTopicsNotesAuthz],
] as const;

const FROZEN = [
	["completed", MEETING_LOCKED_MESSAGE],
	["cancelled", MEETING_CANCELLED_MESSAGE],
] as const;

describe.skipIf(!hasTestDb)(
	"archive gate runs before the frozen-meeting refusal (#1134)",
	() => {
		let club: SeededClub;

		beforeEach(async () => {
			club = await seedClub();
		});

		afterEach(async () => {
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		async function freezeMeeting(status: "completed" | "cancelled") {
			await testDb
				.update(meetings)
				.set({ status })
				.where(eq(meetings.id, club.meetingId));
		}

		async function archiveClub() {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, club.clubId));
		}

		for (const [name, resolve] of RESOLVERS) {
			describe(`${name} resolver`, () => {
				for (const [status, frozenMessage] of FROZEN) {
					it(`reports the takedown, not the lock, on an archived club's ${status} meeting`, async () => {
						await freezeMeeting(status);
						await archiveClub();
						await expect(
							resolve({
								meetingId: club.meetingId,
								sessionUserId: club.adminUserId,
							}),
						).rejects.toThrow(new Error(CLUB_ARCHIVED_MESSAGE));
					});

					it(`refuses a ${status} meeting with its own sentence when the club is live`, async () => {
						await freezeMeeting(status);
						await expect(
							resolve({
								meetingId: club.meetingId,
								sessionUserId: club.adminUserId,
							}),
						).rejects.toThrow(new Error(frozenMessage));
					});
				}
			});
		}
	},
);
