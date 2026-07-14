/**
 * DB-backed integration tests for client-UUID idempotent minutes creates
 * (#176 slice 2). Exercises the REAL minutes logic against a live Postgres
 * identified by TEST_DATABASE_URL: an offline queue (slices 3–5) mints a UUID
 * client-side and may replay a create more than once, so the two id-minting
 * creates must accept an optional client id, insert idempotently, and return the
 * same id on a replay — and later ops that reference the new row (move / remove)
 * must resolve against that client id.
 *
 * `#/db` is mocked to the test client so the logic module imports cleanly without
 * a production DATABASE_URL. When TEST_DATABASE_URL is unset the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, meetingAttendance, tableTopicsSpeakers } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	addGuestPresent,
	addTableTopicsSpeaker,
	loadMinutes,
	moveTableTopicsSpeaker,
	removeGuestPresent,
	removeTableTopicsSpeaker,
} = await import("#/server/minutes-logic");

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe.skipIf(!hasTestDb)(
	"idempotent client-UUID creates (#176 slice 2)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		describe("addTableTopicsSpeaker", () => {
			it("honors a client id, replays as a no-op, and move/remove target it", async () => {
				const clientId = randomUUID();

				// (1) Client-supplied id is honored.
				const first = await addTableTopicsSpeaker({
					meetingId: seed.meetingId,
					id: clientId,
					memberId: seed.memberId,
					topic: "Favorite season?",
				});
				expect(first.id).toBe(clientId);

				// (2) Re-running the same create is a no-op that still succeeds and
				// returns the same id — no duplicate row, no throw.
				const replay = await addTableTopicsSpeaker({
					meetingId: seed.meetingId,
					id: clientId,
					memberId: seed.memberId,
					topic: "Favorite season?",
				});
				expect(replay.id).toBe(clientId);

				const rows = await testDb
					.select({ id: tableTopicsSpeakers.id })
					.from(tableTopicsSpeakers)
					.where(eq(tableTopicsSpeakers.meetingId, seed.meetingId));
				expect(rows).toHaveLength(1);

				// (3) A follow-up op referencing the client id works: add a second
				// speaker, move the client-id speaker down, then remove it by client id.
				const second = await addTableTopicsSpeaker({
					meetingId: seed.meetingId,
					memberId: seed.adminMemberId,
				});
				await moveTableTopicsSpeaker({
					meetingId: seed.meetingId,
					id: clientId,
					direction: "down",
				});
				let m = await loadMinutes(seed.meetingId);
				expect(m.tableTopicsSpeakers.map((s) => s.id)).toEqual([
					second.id,
					clientId,
				]);

				await removeTableTopicsSpeaker({
					meetingId: seed.meetingId,
					id: clientId,
				});
				m = await loadMinutes(seed.meetingId);
				expect(m.tableTopicsSpeakers.map((s) => s.id)).toEqual([second.id]);
			});

			it("omitting the id still works (server-generated) — back-compat", async () => {
				const created = await addTableTopicsSpeaker({
					meetingId: seed.meetingId,
					memberId: seed.memberId,
				});
				expect(created.id).toMatch(UUID_RE);
				const m = await loadMinutes(seed.meetingId);
				expect(m.tableTopicsSpeakers.map((s) => s.id)).toEqual([created.id]);
			});
		});

		describe("addGuestPresent (new-guest path)", () => {
			it("honors a client guest id, replays as a no-op, and remove targets it", async () => {
				const clientId = randomUUID();

				// (1) Client-supplied id is honored for the new guest row.
				const first = await addGuestPresent({
					meetingId: seed.meetingId,
					id: clientId,
					newGuest: { name: "Ben Carter", email: "ben@example.com" },
				});
				expect(first.guestId).toBe(clientId);

				// (2) Replaying the same create is a no-op — same id, no duplicate guest
				// row, no duplicate attendance row, no throw.
				const replay = await addGuestPresent({
					meetingId: seed.meetingId,
					id: clientId,
					newGuest: { name: "Ben Carter", email: "ben@example.com" },
				});
				expect(replay.guestId).toBe(clientId);

				const guestRows = await testDb
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.id, clientId));
				expect(guestRows).toHaveLength(1);

				const attRows = await testDb
					.select({ id: meetingAttendance.id })
					.from(meetingAttendance)
					.where(
						and(
							eq(meetingAttendance.meetingId, seed.meetingId),
							eq(meetingAttendance.guestId, clientId),
						),
					);
				expect(attRows).toHaveLength(1);

				let m = await loadMinutes(seed.meetingId);
				expect(m.guests.filter((g) => g.guestId === clientId)).toHaveLength(1);
				expect(m.counts.guests).toBe(1);

				// (3) Follow-up: remove the present guest by the client id.
				await removeGuestPresent({
					meetingId: seed.meetingId,
					guestId: clientId,
				});
				m = await loadMinutes(seed.meetingId);
				expect(m.guests).toHaveLength(0);
			});

			it("omitting the id still works (server-generated) — back-compat", async () => {
				const created = await addGuestPresent({
					meetingId: seed.meetingId,
					newGuest: { name: "Nadia Visitor" },
				});
				expect(created.guestId).toMatch(UUID_RE);
				const m = await loadMinutes(seed.meetingId);
				expect(m.guests.map((g) => g.guestId)).toEqual([created.guestId]);
			});
		});
	},
);
