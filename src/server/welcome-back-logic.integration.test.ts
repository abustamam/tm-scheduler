/**
 * DB-backed tests for the roll's "Welcome back" lookup (#1446). `loadWelcomeBack`
 * is called directly for the streak rules, and the REAL `setAttendance` handler
 * (through the minimal `createServerFn` adapter `absent-release.integration.test.ts`
 * uses) for the wiring: Present returns it, Absent never does.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingAttendance,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
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

const { loadWelcomeBack } = await import("./welcome-back-logic");
const { setAttendance } = await import("./minutes");

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestDb)("loadWelcomeBack (#1446)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
		currentUser.id = seed.adminUserId;
		// Members are scored from created_at; meetings here are backdated.
		await testDb
			.update(members)
			.set({ createdAt: new Date(Date.now() - 400 * DAY) })
			.where(eq(members.clubId, seed.clubId));
		// The current meeting: its day has arrived, so the roll is recordable.
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 60 * 1000) })
			.where(eq(meetings.id, seed.meetingId));
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function addMeeting(
		daysAgo: number,
		opts: {
			status?: "scheduled" | "cancelled" | "completed";
			rollTaken?: boolean;
			member?: "present" | "absent" | "excused";
		} = {},
	): Promise<{ id: string; at: Date }> {
		const at = new Date(Date.now() - daysAgo * DAY);
		const [row] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: at,
				status: opts.status ?? "completed",
			})
			.returning({ id: meetings.id });
		const id = row!.id;
		// Somebody's roll (the admin's) makes the meeting count, as in the lapse
		// list; `rollTaken: false` leaves the meeting with no member row at all.
		if (opts.rollTaken !== false) {
			await testDb.insert(meetingAttendance).values({
				meetingId: id,
				memberId: seed.adminMemberId,
				status: "present",
			});
		}
		if (opts.member) {
			await testDb.insert(meetingAttendance).values({
				meetingId: id,
				memberId: seed.memberId,
				status: opts.member,
			});
		}
		return { id, at };
	}

	const lookup = () =>
		loadWelcomeBack(testDb, {
			clubId: seed.clubId,
			memberId: seed.memberId,
			meetingId: seed.meetingId,
		});

	it("welcomes back a member with a streak of 2, naming the last present date", async () => {
		const seen = await addMeeting(40, { member: "present" });
		await addMeeting(14, { member: "absent" });
		await addMeeting(7); // no row for the member: a miss
		const result = await lookup();
		expect(result?.lastPresentAt?.getTime()).toBe(seen.at.getTime());
	});

	it("says nothing for a streak of 0 or 1", async () => {
		await addMeeting(14, { member: "present" });
		expect(await lookup()).toBeNull();
		await addMeeting(7, { member: "absent" });
		expect(await lookup()).toBeNull();
	});

	it("never counts the current meeting, even if the member was marked absent there", async () => {
		await addMeeting(14, { member: "absent" });
		await testDb.insert(meetingAttendance).values({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
			status: "present",
		});
		await testDb.insert(meetingAttendance).values({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "absent",
		});
		// One prior miss; the current meeting's own absent row must not make two.
		expect(await lookup()).toBeNull();
	});

	it("returns a null date for a member never present since joining", async () => {
		await addMeeting(14);
		await addMeeting(7);
		expect(await lookup()).toEqual({ lastPresentAt: null });
	});

	it("treats excused as transparent", async () => {
		await addMeeting(21, { member: "absent" });
		await addMeeting(14, { member: "excused" });
		// One miss either side of an excused meeting is still a streak of 1.
		expect(await lookup()).toBeNull();
		await addMeeting(7, { member: "absent" });
		expect(await lookup()).toEqual({ lastPresentAt: null });
	});

	it("ignores cancelled meetings", async () => {
		const seen = await addMeeting(40, { member: "present" });
		await addMeeting(14, { member: "absent" });
		await addMeeting(7, { member: "absent", status: "cancelled" });
		expect(await lookup()).toBeNull();
		await addMeeting(3);
		expect((await lookup())?.lastPresentAt?.getTime()).toBe(seen.at.getTime());
	});

	it("says nothing when the meetings before this one had no roll taken", async () => {
		await addMeeting(14, { rollTaken: false });
		await addMeeting(7, { rollTaken: false });
		expect(await lookup()).toBeNull();
	});

	it("counts a role held at a meeting with no row for the member as the last present", async () => {
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Evaluator",
				category: "speaker",
				sortOrder: 9,
			})
			.returning({ id: roleDefinitions.id });
		const ran = await addMeeting(30); // roll taken for others, none for the member
		await testDb.insert(roleSlots).values({
			meetingId: ran.id,
			roleDefinitionId: def!.id,
			slotIndex: 0,
			status: "claimed",
			assignedMemberId: seed.memberId,
			claimedAt: new Date(),
		});
		await addMeeting(14, { member: "absent" });
		await addMeeting(7);
		const result = await lookup();
		expect(result?.lastPresentAt?.getTime()).toBe(ran.at.getTime());
	});

	describe("setAttendance", () => {
		beforeEach(async () => {
			await addMeeting(14, { member: "absent" });
			await addMeeting(7);
		});

		it("returns welcomeBack when marking Present", async () => {
			const result = await setAttendance({
				data: {
					meetingId: seed.meetingId,
					memberId: seed.memberId,
					status: "present",
				},
			} as never);
			expect(result.welcomeBack).toEqual({ lastPresentAt: null });
		});

		it("returns none when marking Absent", async () => {
			const result = await setAttendance({
				data: {
					meetingId: seed.meetingId,
					memberId: seed.memberId,
					status: "absent",
				},
			} as never);
			expect(result.welcomeBack).toBeNull();
		});
	});
});
