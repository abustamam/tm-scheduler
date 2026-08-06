/**
 * DB-backed tests for the SEAM between action items and a meeting's minutes
 * (#529). Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run --pool=threads --no-file-parallelism \
 *     src/server/action-items-minutes.integration.test.ts
 *
 * This file exists because the seam was the one thing nothing tested, and the
 * seam is where the feature's whole promise lives. `action-items.integration`
 * calls `loadActionItemsForMinutes` with a HAND-SUPPLIED `meetingAt` and
 * `previousMeetingAt`, which stubs out exactly the code under discussion: how
 * `loadMinutes` derives those two instants from the meetings table.
 *
 * Measured before these tests were written — each of the following mutations
 * left all 208 files / 3236 tests green:
 *   - `meetingAt = thisMeeting.scheduledAt` → `new Date()`, i.e. render TODAY'S
 *     open list into every past meeting: the exact defect #529 exists to prevent
 *   - `resolvedBetween(all, previousMeetingAt, ...)` → `(all, null, ...)`
 *   - `ne(meetings.status, "cancelled")` → `ne(meetings.status, "completed")`
 * Every test below is written so that one of those turns it red.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubActionItems, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { createActionItem, resolveActionItem } = await import(
	"#/server/action-items-logic"
);
const { loadMinutes } = await import("#/server/minutes-logic");
const { renderMinutesPdf } = await import("#/server/minutes-pdf-logic");

const AT = (iso: string) => new Date(iso);

describe.skipIf(!hasTestDb)(
	"action items in a meeting's minutes (#529)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			seed = await seedClub();
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		/**
		 * A meeting for the seeded club at a given instant.
		 *
		 * Note `seedClub()` already created one at now + 7 days, so a test that needs
		 * to be the LAST meeting must land before that.
		 */
		async function addMeeting(
			at: string | Date,
			status: "scheduled" | "completed" | "cancelled" = "completed",
		): Promise<string> {
			const [m] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: typeof at === "string" ? AT(at) : at,
					status,
				})
				.returning({ id: meetings.id });
			if (!m) throw new Error("Failed to insert meeting");
			return m.id;
		}

		/** Force an item's timestamps; `resolution` rides along per the check constraint. */
		async function backdate(
			id: string,
			createdAt: string,
			resolvedAt: string | null = null,
		) {
			await testDb
				.update(clubActionItems)
				.set({
					createdAt: AT(createdAt),
					...(resolvedAt
						? { resolvedAt: AT(resolvedAt), resolution: "done" as const }
						: {}),
				})
				.where(eq(clubActionItems.id, id));
		}

		it("pins a past meeting's list to THAT meeting's instant, not to now", async () => {
			// The single most important behaviour in the feature. January's minutes
			// must keep saying the item was open, however long after the fact they are
			// regenerated, and whatever has happened to the item since.
			const jan = await addMeeting("2026-01-10T19:00:00Z");
			// Anchored one day AFTER the resolution below, which lands at wall-clock
			// "now" — and before the meeting `seedClub()` puts at now + 7 days, so this
			// one's previous meeting is January. Both halves were learned the hard way:
			// a fixed past date left the item still open at that instant, and a far
			// future date let the seeded meeting become the window's lower bound and
			// swallow the resolution.
			const later = await addMeeting(
				new Date(Date.now() + 24 * 60 * 60 * 1000),
				"scheduled",
			);
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Book the venue",
			});
			await backdate(id, "2025-12-01T00:00:00Z");

			const janBefore = await loadMinutes(jan);
			expect(janBefore.actionItems.open.map((i) => i.id)).toEqual([id]);

			// The world moves on: the item is closed NOW, long after January.
			await resolveActionItem({
				clubId: seed.clubId,
				id,
				resolution: "done",
			});

			// January is unchanged — it is a historical record, not a live query.
			const janAfter = await loadMinutes(jan);
			expect(janAfter.actionItems.open.map((i) => i.id)).toEqual([id]);
			expect(janAfter.actionItems.resolved).toEqual([]);

			// A meeting whose instant follows the resolution moves it to resolved.
			const laterAfter = await loadMinutes(later);
			expect(laterAfter.actionItems.open).toEqual([]);
			expect(laterAfter.actionItems.resolved.map((i) => i.id)).toEqual([id]);
			expect(laterAfter.actionItems.resolved[0]?.resolution).toBe("done");
		});

		it("carries one open item across three consecutive meetings", async () => {
			// The acceptance criterion, stated in its own terms: an item that nobody
			// closes is still there next month, and the month after.
			const m1 = await addMeeting("2026-01-10T19:00:00Z");
			const m2 = await addMeeting("2026-02-10T19:00:00Z");
			const m3 = await addMeeting("2026-03-10T19:00:00Z");
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Chase the lapsed members",
			});
			await backdate(id, "2025-12-01T00:00:00Z");

			for (const meetingId of [m1, m2, m3]) {
				const minutes = await loadMinutes(meetingId);
				expect(minutes.actionItems.open.map((i) => i.id)).toEqual([id]);
			}
		});

		it("excludes an item raised after the meeting it is asked about", async () => {
			const jan = await addMeeting("2026-01-10T19:00:00Z");
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Raised in February",
			});
			await backdate(id, "2026-02-01T00:00:00Z");

			const minutes = await loadMinutes(jan);
			expect(minutes.actionItems.open).toEqual([]);
		});

		it("bounds 'closed since we last met' by the PREVIOUS meeting", async () => {
			// Kills the `resolvedBetween(all, null, meetingAt)` mutation: with the lower
			// bound dropped, `old` reappears in March's resolved list.
			const jan = await addMeeting("2026-01-10T19:00:00Z");
			const mar = await addMeeting("2026-03-10T19:00:00Z");
			expect(jan).toBeTruthy();

			const old = await createActionItem({ clubId: seed.clubId, text: "Old" });
			await backdate(old, "2025-11-01T00:00:00Z", "2025-12-01T00:00:00Z");
			const recent = await createActionItem({
				clubId: seed.clubId,
				text: "Recent",
			});
			await backdate(recent, "2025-11-01T00:00:00Z", "2026-02-01T00:00:00Z");

			const minutes = await loadMinutes(mar);
			// Only the one closed BETWEEN January and March. `old` closed before
			// January and was reported in January's minutes; repeating it here would
			// make every meeting re-announce the club's entire history of closures.
			expect(minutes.actionItems.resolved.map((i) => i.id)).toEqual([recent]);
		});

		it("does not treat a CANCELLED meeting as the previous meeting", async () => {
			// Kills the `ne(status, "cancelled")` → `ne(status, "completed")` mutation.
			// A cancelled meeting never happened, so nothing was reported at it, and
			// using it as the lower bound would silently swallow every item closed
			// before it.
			await addMeeting("2026-01-10T19:00:00Z");
			await addMeeting("2026-02-10T19:00:00Z", "cancelled");
			const mar = await addMeeting("2026-03-10T19:00:00Z");

			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Closed",
			});
			// Closed between the real January meeting and the cancelled February one.
			await backdate(id, "2025-11-01T00:00:00Z", "2026-01-20T00:00:00Z");

			const minutes = await loadMinutes(mar);
			// The window opens at JANUARY (the last meeting that actually happened),
			// so this item is still reported. If February counted, it would vanish.
			expect(minutes.actionItems.resolved.map((i) => i.id)).toEqual([id]);
		});

		it("opens the window at the beginning of time for a club's first minutes", async () => {
			const only = await addMeeting("2026-01-10T19:00:00Z");
			const id = await createActionItem({
				clubId: seed.clubId,
				text: "Closed",
			});
			await backdate(id, "2025-11-01T00:00:00Z", "2025-12-01T00:00:00Z");

			const minutes = await loadMinutes(only);
			expect(minutes.actionItems.resolved.map((i) => i.id)).toEqual([id]);
		});

		it("caps both lists and reports the true totals behind the cap", async () => {
			// The "+N more" tail is only honest if the totals survive the cap. Asserted
			// against an ABSOLUTE ceiling rather than against the cap constant: stated
			// relative to it, this passes for every value of the cap, including one
			// that reintroduces an unbounded render.
			const mar = await addMeeting("2026-03-10T19:00:00Z");
			for (let i = 0; i < 45; i++) {
				const id = await createActionItem({
					clubId: seed.clubId,
					text: `Item ${i}`,
				});
				await backdate(id, "2026-01-01T00:00:00Z");
			}

			const minutes = await loadMinutes(mar);
			expect(minutes.actionItems.open.length).toBeLessThanOrEqual(50);
			expect(minutes.actionItems.openTotal).toBe(45);
			// The cap actually fired, so the tail has something to report.
			expect(minutes.actionItems.openTotal).toBeGreaterThan(
				minutes.actionItems.open.length,
			);
		});

		it("never shows another club's action items", async () => {
			const other = await seedClub();
			try {
				await createActionItem({
					clubId: other.clubId,
					text: "Someone else's business",
				});
				const mine = await addMeeting("2026-03-10T19:00:00Z");
				const minutes = await loadMinutes(mine);
				expect(minutes.actionItems.open).toEqual([]);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		describe("the emailed PDF", () => {
			it("is smaller for guests, because the action-item section is gone", async () => {
				// End-to-end counterpart to `minutes-email-port-logic.test.ts`, which
				// pins the ARGUMENT. This pins the CONSEQUENCE: that asking for the
				// guest view actually removes the rows rather than merely being passed
				// along and ignored. Compared by size rather than by extracting text,
				// because a PDF's content streams are compressed.
				const meetingId = await addMeeting(
					new Date(Date.now() + 24 * 60 * 60 * 1000),
					"scheduled",
				);
				for (let i = 0; i < 20; i++) {
					await createActionItem({
						clubId: seed.clubId,
						text: `Something the club owes itself, number ${i}`,
					});
				}

				const forMembers = await renderMinutesPdf(meetingId);
				const forGuests = await renderMinutesPdf(meetingId, "guests");

				// Both are real PDFs...
				expect(new TextDecoder().decode(forMembers.slice(0, 5))).toBe("%PDF-");
				expect(new TextDecoder().decode(forGuests.slice(0, 5))).toBe("%PDF-");
				// ...and the guest one is missing 20 rows of club business.
				expect(forGuests.length).toBeLessThan(forMembers.length);
			});
		});
	},
);
