/**
 * #1049 acceptance criterion 3: the authz on the attendance write is
 * unchanged by the new `mode` field. A plain member still cannot record
 * another person's attendance — or their mode — and an admin still can.
 *
 * `createServerFn` handlers need the Start runtime, so this runs the REAL
 * `setAttendance` / `addMinutesGuest` handlers through the minimal adapter
 * `slots.transport.test.ts` uses, against the worktree's real test database.
 * Only `requireUser` is stubbed (there is no request to read a session from);
 * `requireClubRole` — the gate actually under test — runs for real against the
 * seeded membership rows.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, meetingAttendance, meetings } from "#/db/schema";
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

const { currentUser } = vi.hoisted(() => ({
	currentUser: { id: "" },
}));

vi.mock("./guards", async (importOriginal) => ({
	...(await importOriginal<typeof import("./guards")>()),
	requireUser: vi.fn(async () => ({ id: currentUser.id })),
}));

const { addMinutesGuest, setAttendance } = await import("./minutes");
const { NO_PERMISSION_MESSAGE } = await import("./guards");

/** The adapter runs the validator synchronously, so a validation refusal is a
 *  THROW rather than a rejection; this folds both into one promise. */
const attempt = (fn: () => unknown) => (async () => fn())();

describe.skipIf(!hasTestDb)("attendance mode authz (#1049)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		// The day must have arrived, or `assertAttendanceRecordable` refuses
		// first and the authz half is never reached.
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
			.where(eq(meetings.id, seed.meetingId));
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function attendanceRows(memberId: string) {
		return testDb
			.select({
				status: meetingAttendance.status,
				mode: meetingAttendance.mode,
			})
			.from(meetingAttendance)
			.where(
				and(
					eq(meetingAttendance.meetingId, seed.meetingId),
					eq(meetingAttendance.memberId, memberId),
				),
			);
	}

	it("a plain member cannot record another member present with a mode", async () => {
		currentUser.id = seed.memberUserId;
		await expect(
			setAttendance({
				data: {
					meetingId: seed.meetingId,
					memberId: seed.adminMemberId,
					status: "present",
					mode: "online",
				},
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		expect(await attendanceRows(seed.adminMemberId)).toEqual([]);
	});

	it("a plain member cannot flip an existing record's mode", async () => {
		currentUser.id = seed.adminUserId;
		await setAttendance({
			data: {
				meetingId: seed.meetingId,
				memberId: seed.adminMemberId,
				status: "present",
				mode: "in_person",
			},
		});
		currentUser.id = seed.memberUserId;
		await expect(
			setAttendance({
				data: {
					meetingId: seed.meetingId,
					memberId: seed.adminMemberId,
					status: "present",
					mode: "online",
				},
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		expect(await attendanceRows(seed.adminMemberId)).toEqual([
			{ status: "present", mode: "in_person" },
		]);
	});

	it("a plain member cannot set a guest's mode", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Authz Guest" })
			.returning({ id: guests.id });
		currentUser.id = seed.memberUserId;
		await expect(
			addMinutesGuest({
				data: {
					meetingId: seed.meetingId,
					guestId: g!.id,
					mode: "online",
					replaceMode: true,
				},
			}),
		).rejects.toThrow(NO_PERMISSION_MESSAGE);
		const rows = await testDb
			.select({ id: meetingAttendance.id })
			.from(meetingAttendance)
			.where(eq(meetingAttendance.guestId, g!.id));
		expect(rows).toEqual([]);
	});

	it("an admin records a member present with the mode", async () => {
		currentUser.id = seed.adminUserId;
		await setAttendance({
			data: {
				meetingId: seed.meetingId,
				memberId: seed.memberId,
				status: "present",
				mode: "online",
			},
		});
		expect(await attendanceRows(seed.memberId)).toEqual([
			{ status: "present", mode: "online" },
		]);
	});

	it("refuses a mode on an absent write before it reaches the gate", async () => {
		currentUser.id = seed.adminUserId;
		await expect(
			attempt(() =>
				setAttendance({
					data: {
						meetingId: seed.meetingId,
						memberId: seed.memberId,
						status: "absent",
						mode: "online",
					},
				}),
			),
		).rejects.toThrow("Only a present attendee has an attendance mode.");
		expect(await attendanceRows(seed.memberId)).toEqual([]);
	});

	it("refuses a value outside the enum", async () => {
		currentUser.id = seed.adminUserId;
		await expect(
			attempt(() =>
				setAttendance({
					data: {
						meetingId: seed.meetingId,
						memberId: seed.memberId,
						status: "present",
						mode: "hybrid",
					},
				}),
			),
		).rejects.toThrow();
		expect(await attendanceRows(seed.memberId)).toEqual([]);
	});
});
