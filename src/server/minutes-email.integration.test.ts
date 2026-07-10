/**
 * DB-backed integration test for the minutes-email port's REAL method,
 * `loadHeader` (meetings + clubs are existing tables). The other two port
 * methods (renderMinutesPdf, loadRecipients) depend on #152 and are stubbed to
 * throw, so they are not exercised here — see minutes-email-port.stub.ts.
 *
 * It also drives `sendMinutesEmail` end-to-end against the real header + a mock
 * PDF/recipients, capturing the sendEmail params, to prove recipient resolution
 * + attachment assembly work against a real meeting row.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/minutes-email.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings } from "#/db/schema";
import type { SendEmailParams } from "#/lib/email";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { type MinutesEmailPort, sendMinutesEmail } from "./minutes-email-logic";

// The stub's loadHeader queries the shared `db` (production pool), so run it
// against testDb instead by reproducing the same query here — mirrors how the
// other integration tests replicate server-fn query logic with `testDb`.
async function loadHeaderVia(meetingId: string) {
	const [row] = await testDb
		.select({ clubName: clubs.name, meetingDate: meetings.scheduledAt })
		.from(meetings)
		.innerJoin(clubs, eq(clubs.id, meetings.clubId))
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) throw new Error("Meeting not found.");
	return { clubName: row.clubName, meetingDate: row.meetingDate };
}

describe.skipIf(!hasTestDb)(
	"minutes-email integration (loadHeader + send)",
	() => {
		let seeded: SeededClub;

		beforeEach(async () => {
			seeded = await seedClub();
		});

		afterEach(async () => {
			await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
			vi.restoreAllMocks();
		});

		it("loadHeader returns the real club name + meeting date", async () => {
			const header = await loadHeaderVia(seeded.meetingId);
			expect(header.clubName).toBe("Test Club");
			expect(header.meetingDate).toBeInstanceOf(Date);
		});

		it("resolves recipients + attaches the PDF for a real meeting", async () => {
			const port: MinutesEmailPort = {
				loadHeader: loadHeaderVia,
				renderMinutesPdf: async () => new Uint8Array([9, 8, 7]),
				loadRecipients: async () => ({
					members: [
						{ name: "Ada", email: "ada@example.com" },
						{ name: "NoEmail", email: null },
					],
					presentGuests: [{ name: "Gwen", email: "gwen@example.com" }],
				}),
			};
			const sendEmail = vi
				.fn<(params: SendEmailParams) => Promise<void>>()
				.mockResolvedValue();

			const result = await sendMinutesEmail(
				port,
				{ sendEmail },
				{
					meetingId: seeded.meetingId,
				},
			);

			expect(result.sent.map((r) => r.email)).toEqual([
				"ada@example.com",
				"gwen@example.com",
			]);
			expect(result.skipped).toEqual([{ name: "NoEmail" }]);

			const params = sendEmail.mock.calls[0][0];
			expect(params.subject).toContain("Test Club — Minutes for");
			expect(params.attachments?.[0].content).toBe(
				Buffer.from(new Uint8Array([9, 8, 7])).toString("base64"),
			);
		});
	},
);
