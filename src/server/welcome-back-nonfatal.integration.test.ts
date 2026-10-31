/**
 * The welcome-back lookup runs AFTER the Present write committed (#1446), so a
 * throwing lookup must not fail the write: the offline path would replay it.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetingAttendance, meetings } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
	}),
}));

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { currentUser } = vi.hoisted(() => ({ currentUser: { id: "" } }));

vi.mock("./guards", async (importOriginal) => ({
	...(await importOriginal<typeof import("./guards")>()),
	requireUser: vi.fn(async () => ({ id: currentUser.id })),
}));

vi.mock("./welcome-back-logic", () => ({
	loadWelcomeBack: vi.fn(async () => {
		throw new Error("lookup down");
	}),
}));

const { setAttendance } = await import("./minutes");

describe.skipIf(!hasTestDb)("setAttendance welcome-back is non-fatal", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		currentUser.id = seed.adminUserId;
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 60 * 1000) })
			.where(eq(meetings.id, seed.meetingId));
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("still succeeds, with welcomeBack null, and the write stands", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await setAttendance({
			data: {
				meetingId: seed.meetingId,
				memberId: seed.memberId,
				status: "present",
			},
		} as never);
		expect(result).toMatchObject({ ok: true, welcomeBack: null });
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
		const rows = await testDb
			.select({ status: meetingAttendance.status })
			.from(meetingAttendance)
			.where(
				and(
					eq(meetingAttendance.meetingId, seed.meetingId),
					eq(meetingAttendance.memberId, seed.memberId),
				),
			);
		expect(rows).toEqual([{ status: "present" }]);
	});
});
