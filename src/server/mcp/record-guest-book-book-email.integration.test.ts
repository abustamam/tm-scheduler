/**
 * `record_guest_book`'s default minutes recipient follows the guest card's
 * unconfirmed address (#1157).
 *
 * A guest marked present is a default recipient of the minutes email draft when
 * the card holds an address. The card may hold it only as the club's note
 * (`guests.book_email`, typed on the public guest book); the plan counts it, the
 * same rule `loadRecipients` follows. It stays a draft an officer reviews and
 * sends, so counting the note names a recipient and writes nothing.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/record-guest-book-book-email.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiTokens, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { recordGuestBookTool } = await import(
	"#/server/mcp/tools/record-guest-book"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { captureGuestVisit } = await import("#/server/guest-pipeline-logic");

interface Preview {
	blocking: { code: string }[];
	summary?: { matched: number; minutesRecipients: number };
	entries?: { outcome: string }[];
}

describe.skipIf(!hasTestDb)(
	"record_guest_book default recipient reads the book note (#1157)",
	() => {
		let seed: SeededClub;
		let token: string;
		let meetingDate: string;

		beforeEach(async () => {
			seed = await seedClub();
			const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
			await testDb
				.insert(apiTokens)
				.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
			token = raw;
			const { utcToZonedWallTime, zonedWallTimeToUtc } = await import(
				"#/lib/datetime"
			);
			const weekAgo = utcToZonedWallTime(
				new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
				"America/Chicago",
			).slice(0, 10);
			const past = zonedWallTimeToUtc(`${weekAgo}T12:00`, "America/Chicago");
			await testDb.insert(meetings).values({
				clubId: seed.clubId,
				scheduledAt: past,
				status: "completed",
			});
			meetingDate = utcToZonedWallTime(past, "America/Chicago").slice(0, 10);
		});

		afterEach(async () => {
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		function preview(entry: Record<string, unknown>) {
			return recordGuestBookTool.handler(
				{ clubId: seed.clubId, meetingDate, entries: [entry] },
				{ rawToken: token },
			) as Promise<Preview>;
		}

		// protects=a line matched (by phone and name) onto a card whose only address is the book note counts as a minutes-email recipient, while the same line onto a card with no address does not;
		// fails_when=the plan's minutesRecipient stops falling back to the card's book note, or counts a card that has none;
		// no_claim=the draft itself (`minutes-email-book-recipients.integration.test.ts`); the card is made through the real public capture, and the plan only counts: nothing is written.
		it("counts a card holding only the unconfirmed address as a recipient", async () => {
			const phone = "+14155550142";
			await captureGuestVisit({
				clubId: seed.clubId,
				name: "Noted Guest",
				phone,
				email: `note-${randomUUID().slice(0, 8)}@example.com`,
			});
			await captureGuestVisit({
				clubId: seed.clubId,
				name: "Bare Guest",
				phone: "+14155550143",
			});

			const withNote = await preview({ name: "Noted Guest", phone });
			expect(withNote.blocking).toEqual([]);
			expect(withNote.entries?.map((e) => e.outcome)).toEqual(["matched"]);
			expect(withNote.summary?.minutesRecipients).toBe(1);

			const bare = await preview({ name: "Bare Guest", phone: "+14155550143" });
			expect(bare.entries?.map((e) => e.outcome)).toEqual(["matched"]);
			expect(bare.summary?.minutesRecipients).toBe(0);
		});
	},
);
