/**
 * DB-backed integration tests for the meeting-number resolver + freeze (#358).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/meeting-number-logic.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { freezeMeetingNumber, resolveMeetingNumber } = await import(
	"./meeting-number-logic"
);
const { applyCompleteMeeting, applyMeetingUpdate } = await import(
	"./meetings-logic"
);

/** A Date → the "YYYY-MM-DDTHH:mm" wall-time string the update input expects.
 *  The seeded club is UTC, so a plain ISO slice round-trips unchanged. */
const wallTime = (d: Date) => d.toISOString().slice(0, 16);

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("meeting numbers (#358)", () => {
	let seeded: SeededClub;

	/** Add a meeting `days` from now; returns its id. */
	async function addMeeting(
		days: number,
		opts: {
			meetingNumber?: number | null;
			status?: "scheduled" | "cancelled" | "completed";
		} = {},
	): Promise<string> {
		const [row] = await testDb
			.insert(meetings)
			.values({
				clubId: seeded.clubId,
				scheduledAt: new Date(Date.now() + days * DAY),
				status: opts.status ?? "scheduled",
				meetingNumber: opts.meetingNumber ?? null,
			})
			.returning({ id: meetings.id });
		return row.id;
	}

	const scheduledAtOf = async (id: string) => {
		const [row] = await testDb
			.select({ at: meetings.scheduledAt })
			.from(meetings)
			.where(eq(meetings.id, id));
		return row.at;
	};

	const storedNumber = async (id: string) => {
		const [row] = await testDb
			.select({ n: meetings.meetingNumber })
			.from(meetings)
			.where(eq(meetings.id, id));
		return row.n;
	};

	beforeEach(async () => {
		seeded = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	});

	it("derives the next number from the last numbered meeting", async () => {
		// The #358 scenario: last night's meeting is 56, next one already exists.
		await addMeeting(-7, { meetingNumber: 56, status: "completed" });
		const next = await addMeeting(1);

		expect(await resolveMeetingNumber(next)).toBe(57);
		// Deriving must NOT write — the number stays provisional until frozen.
		expect(await storedNumber(next)).toBeNull();
	});

	it("skips a cancelled meeting when numbering forward", async () => {
		await addMeeting(-7, { meetingNumber: 56, status: "completed" });
		await addMeeting(-1, { status: "cancelled" });
		const next = await addMeeting(1);

		expect(await resolveMeetingNumber(next)).toBe(57);
	});

	it("freezes the derived number onto the row", async () => {
		await addMeeting(-7, { meetingNumber: 56, status: "completed" });
		const next = await addMeeting(1);

		await freezeMeetingNumber(next);

		expect(await storedNumber(next)).toBe(57);
	});

	it("freezing is idempotent and never overwrites an existing number", async () => {
		await addMeeting(-7, { meetingNumber: 56, status: "completed" });
		const explicit = await addMeeting(1, { meetingNumber: 90 });

		await freezeMeetingNumber(explicit);
		await freezeMeetingNumber(explicit);

		expect(await storedNumber(explicit)).toBe(90);
	});

	it("freezes the number when the meeting is completed", async () => {
		// Completing is the moment a number stops being provisional: the agenda is
		// history now, so the number must never move again.
		await addMeeting(-14, { meetingNumber: 56, status: "completed" });
		const held = await addMeeting(-1);

		await applyCompleteMeeting({ meetingId: held, actorMemberId: null });

		expect(await storedNumber(held)).toBe(57);
	});

	it("typing a number on one meeting numbers the ones after it", async () => {
		// The workflow from #358: the club's last meeting was #56, so the VPE types
		// 56 on it and the already-created next meeting reads 57 with no extra work.
		const last = await addMeeting(-1);
		const next = await addMeeting(6);

		await applyMeetingUpdate({
			meetingId: last,
			actorMemberId: null,
			scheduledAt: wallTime(await scheduledAtOf(last)),
			meetingNumber: 56,
		});

		expect(await storedNumber(last)).toBe(56);
		expect(await resolveMeetingNumber(next)).toBe(57);
	});

	it("is a no-op when the club has never numbered a meeting", async () => {
		const only = await addMeeting(1);

		expect(await resolveMeetingNumber(only)).toBeNull();
		await freezeMeetingNumber(only);
		expect(await storedNumber(only)).toBeNull();
	});
});
