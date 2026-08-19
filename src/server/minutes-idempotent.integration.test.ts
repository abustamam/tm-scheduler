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
import {
	guests,
	meetingAttendance,
	meetingAwards,
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

const {
	addGuestPresent,
	addTableTopicsSpeaker,
	loadMinutes,
	moveTableTopicsSpeaker,
	removeGuestPresent,
	removeTableTopicsSpeaker,
	setAward,
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

		describe("moveTableTopicsSpeaker", () => {
			/** Four speakers in a known order. Four is the minimum that can SEE the
			 *  replay bug: with two rows a doubled "move down" bounces back and reads
			 *  correct, and with three the stepped row lands on the edge and the second
			 *  apply no-ops. */
			async function fourSpeakers() {
				const ids: string[] = [];
				for (let i = 0; i < 4; i++) {
					const created = await addTableTopicsSpeaker({
						meetingId: seed.meetingId,
						id: randomUUID(),
						memberId: i % 2 === 0 ? seed.memberId : seed.adminMemberId,
						topic: `Topic ${i}`,
					});
					ids.push(created.id);
				}
				return ids;
			}
			const order = async () =>
				(await loadMinutes(seed.meetingId)).tableTopicsSpeakers.map(
					(s) => s.id,
				);

			it("CONVERGES when a move carrying toIndex is replayed (G2)", async () => {
				// The reason this op needed an absolute target. The write deadline
				// (`offline-write-deadline.ts`) abandons a request WITHOUT cancelling it,
				// so a slow write can land server-side and then be replayed by the drain.
				// A relative swap steps the row a second position; an absolute target is
				// already satisfied and no-ops.
				const [a, b, c, d] = await fourSpeakers();
				const move = {
					meetingId: seed.meetingId,
					id: b,
					direction: "down" as const,
					toIndex: 2,
				};

				await moveTableTopicsSpeaker(move);
				expect(await order()).toEqual([a, c, b, d]);

				// The replay the drain performs, verbatim. Twice, to prove it is a fixed
				// point rather than merely alternating.
				await moveTableTopicsSpeaker(move);
				expect(await order()).toEqual([a, c, b, d]);
				await moveTableTopicsSpeaker(move);
				expect(await order()).toEqual([a, c, b, d]);
			});

			it("STEPS a replayed move that carries only a direction — the hazard (G2 control)", async () => {
				// The negative control, and it is what stops the test above from passing
				// vacuously: a `moveTableTopicsSpeaker` that had become a no-op for every
				// input would satisfy "replaying changes nothing" too. This also pins the
				// behaviour still live for ops persisted before `toIndex` existed, and for
				// the Ballot Counter console, which sends `direction` alone.
				const [a, b, c, d] = await fourSpeakers();
				const move = {
					meetingId: seed.meetingId,
					id: b,
					direction: "down" as const,
				};

				await moveTableTopicsSpeaker(move);
				expect(await order()).toEqual([a, c, b, d]);
				await moveTableTopicsSpeaker(move);
				// Two positions from one officer tap: the corruption G2 names.
				expect(await order()).toEqual([a, c, d, b]);
			});

			it("leaves sortOrder dense and distinct, so the id tie-break cannot decide order (G2)", async () => {
				// The order assertions above sort by `(sortOrder, id)`, so they read the
				// same whether the column is [0,1,2,3] or [0,5,5,9] — they cannot see a
				// server that stopped renumbering, which is exactly what would let the
				// client mirror (`derive-minutes.ts`) diverge on the tie-break.
				const [a, b, c, d] = await fourSpeakers();
				// Duplicate + sparse on the way in: the shape a swap-only history leaves,
				// and the input that makes "did it renumber?" observable at all.
				for (const [id, sortOrder] of [
					[a, 0],
					[b, 5],
					[c, 5],
					[d, 9],
				] as [string, number][]) {
					await testDb
						.update(tableTopicsSpeakers)
						.set({ sortOrder })
						.where(eq(tableTopicsSpeakers.id, id));
				}
				// READ the order back rather than assuming it. `b` and `c` share a
				// sortOrder, so which comes first is decided by the `id` tie-break over
				// two `randomUUID()`s — random per run. Hard-coding `[b, c]` here made
				// this test fail roughly half the time, which is the same nondeterminism
				// the renumber exists to remove.
				const before = await order();
				expect(before).toContain(a);
				expect(before[0]).toBe(a);

				await moveTableTopicsSpeaker({
					meetingId: seed.meetingId,
					id: a,
					direction: "down",
					toIndex: 3,
				});

				// `a` last, the other three in the order they already had.
				const expected = [...before.filter((id) => id !== a), a];
				expect(await order()).toEqual(expected);
				const rows = await testDb
					.select({
						id: tableTopicsSpeakers.id,
						sortOrder: tableTopicsSpeakers.sortOrder,
					})
					.from(tableTopicsSpeakers)
					.where(eq(tableTopicsSpeakers.meetingId, seed.meetingId));
				const byId = new Map(rows.map((r) => [r.id, r.sortOrder]));
				// Dense and distinct 0..3 — the assertion `order()` cannot make, and the
				// one that fails if the server goes back to writing only two rows.
				expect(expected.map((id) => byId.get(id))).toEqual([0, 1, 2, 3]);
			});

			it("places a row a NON-adjacent distance, and no-ops out of range (G2)", async () => {
				// `direction` can only name an adjacent target, so this is unreachable
				// through today's UI — but the payload permits it and the client mirror
				// implements it, so the two must agree or a future drag-to-reorder desyncs.
				const [a, b, c, d] = await fourSpeakers();
				await moveTableTopicsSpeaker({
					meetingId: seed.meetingId,
					id: d,
					direction: "up",
					toIndex: 0,
				});
				expect(await order()).toEqual([d, a, b, c]);

				for (const toIndex of [4, 99]) {
					await moveTableTopicsSpeaker({
						meetingId: seed.meetingId,
						id: a,
						direction: "down",
						toIndex,
					});
					expect(await order()).toEqual([d, a, b, c]);
				}
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

		// #176 slice 5: the orphan-guest window. An inline NEW guest embedded in a
		// TT-speaker / award op now carries its own client PK (`newGuestId`, distinct
		// from the speaker-row `id`). Replaying the SAME op (a lost-ack retry) must
		// reuse that guest row — exactly ONE guest, no orphan — and the TT/award must
		// reference it.
		describe("inline new-guest replay is idempotent (no orphan guest)", () => {
			it("addTableTopicsSpeaker with newGuestId replays to exactly one guest", async () => {
				const speakerRowId = randomUUID();
				const newGuestId = randomUUID();
				const op = {
					meetingId: seed.meetingId,
					id: speakerRowId,
					newGuestId,
					newGuest: { name: "Vera Visitor", email: "vera@example.com" },
					topic: "First time here?",
				};

				// (1) First drain: the client speaker-row id and guest PK are honored.
				const first = await addTableTopicsSpeaker(op);
				expect(first.id).toBe(speakerRowId);

				// (2) Lost-ack retry: replay the SAME op. Idempotent — no throw.
				const replay = await addTableTopicsSpeaker(op);
				expect(replay.id).toBe(speakerRowId);

				// (3) Exactly ONE guest row exists (no orphan) — both by the client PK
				// and across the whole club (nothing else was minted).
				const byId = await testDb
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.id, newGuestId));
				expect(byId).toHaveLength(1);
				const allClubGuests = await testDb
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.clubId, seed.clubId));
				expect(allClubGuests).toHaveLength(1);

				// (4) Exactly one TT-speaker row, and it references the new guest.
				const ttRows = await testDb
					.select({
						id: tableTopicsSpeakers.id,
						guestId: tableTopicsSpeakers.guestId,
					})
					.from(tableTopicsSpeakers)
					.where(eq(tableTopicsSpeakers.meetingId, seed.meetingId));
				expect(ttRows).toHaveLength(1);
				expect(ttRows[0].guestId).toBe(newGuestId);

				// (5) loadMinutes surfaces the guest speaker + best-TT eligibility.
				const m = await loadMinutes(seed.meetingId);
				expect(m.tableTopicsSpeakers).toHaveLength(1);
				expect(m.tableTopicsSpeakers[0]).toMatchObject({
					id: speakerRowId,
					guestId: newGuestId,
					isGuest: true,
					name: "Vera Visitor",
				});
				expect(m.awardEligible.best_table_topics.guestIds).toEqual([
					newGuestId,
				]);
			});

			it("setAward with newGuestId replays to exactly one guest", async () => {
				const newGuestId = randomUUID();
				const op = {
					meetingId: seed.meetingId,
					category: "best_speaker" as const,
					newGuestId,
					newGuest: { name: "Gina Guest" },
				};

				// (1) First drain, then (2) lost-ack retry of the SAME op.
				await setAward(op);
				await setAward(op);

				// (3) Exactly ONE guest row (no orphan).
				const byId = await testDb
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.id, newGuestId));
				expect(byId).toHaveLength(1);
				const allClubGuests = await testDb
					.select({ id: guests.id })
					.from(guests)
					.where(eq(guests.clubId, seed.clubId));
				expect(allClubGuests).toHaveLength(1);

				// (4) A single award row for the category, referencing the new guest.
				const awardRows = await testDb
					.select({ guestId: meetingAwards.guestId })
					.from(meetingAwards)
					.where(
						and(
							eq(meetingAwards.meetingId, seed.meetingId),
							eq(meetingAwards.category, "best_speaker"),
						),
					);
				expect(awardRows).toHaveLength(1);
				expect(awardRows[0].guestId).toBe(newGuestId);

				// (5) loadMinutes resolves the award winner to the new guest.
				const m = await loadMinutes(seed.meetingId);
				const award = m.awards.find((a) => a.category === "best_speaker");
				expect(award).toMatchObject({
					guestId: newGuestId,
					isGuest: true,
					name: "Gina Guest",
				});
			});
		});
	},
);
