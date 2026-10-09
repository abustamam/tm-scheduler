/**
 * In person / online (#1049), DB-backed: what `setMemberPresence` and
 * `addGuestPresent` store in `meeting_attendance.mode`, what `loadMinutes`
 * reads back, and what the minutes PDF's attendance line then says — against
 * the worktree's real test database. Every row here hangs off a seeded club
 * and `cleanup` cascades from it; nothing club-less is created.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAttendance,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { addGuestPresent, loadMinutes, setMemberPresence } = await import(
	"#/server/minutes-logic"
);
const { buildAttendanceSection } = await import("#/server/minutes-pdf-logic");

describe.skipIf(!hasTestDb)("attendance mode (#1049)", () => {
	let seed: SeededClub;
	const suffix = Math.random().toString(36).slice(2, 8);

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function storedMemberMode(memberId: string) {
		const [row] = await testDb
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
		return row;
	}

	async function storedGuestMode(guestId: string) {
		const [row] = await testDb
			.select({ mode: meetingAttendance.mode })
			.from(meetingAttendance)
			.where(
				and(
					eq(meetingAttendance.meetingId, seed.meetingId),
					eq(meetingAttendance.guestId, guestId),
				),
			);
		return row;
	}

	async function newGuest(name: string): Promise<string> {
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: seed.clubId, name: `${name} ${suffix}` },
					testDb,
				),
			)
			.returning({ id: guests.id });
		return g!.id;
	}

	it("writes the mode given with a present write", async () => {
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
			mode: "online",
		});
		expect(await storedMemberMode(seed.memberId)).toEqual({
			status: "present",
			mode: "online",
		});
		const m = await loadMinutes(seed.meetingId);
		expect(m.members.find((x) => x.memberId === seed.memberId)?.mode).toBe(
			"online",
		);
	});

	it("a later toggle flips it", async () => {
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
			mode: "in_person",
		});
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
			mode: "online",
		});
		expect((await storedMemberMode(seed.memberId))?.mode).toBe("online");
	});

	it("never defaults: a present write with no mode stores NULL", async () => {
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
		});
		expect((await storedMemberMode(seed.memberId))?.mode).toBeNull();
		const m = await loadMinutes(seed.meetingId);
		// Omitted on the row, not guessed.
		expect(
			m.members.find((x) => x.memberId === seed.memberId),
		).not.toHaveProperty("mode");
	});

	it("a present write with no mode leaves a recorded mode alone", async () => {
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
			mode: "online",
		});
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
		});
		expect((await storedMemberMode(seed.memberId))?.mode).toBe("online");
	});

	it("present → absent clears the mode to NULL (decision 4)", async () => {
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
			mode: "online",
		});
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "absent",
		});
		expect(await storedMemberMode(seed.memberId)).toEqual({
			status: "absent",
			mode: null,
		});
	});

	it("present → excused clears it even if a mode is passed", async () => {
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
			mode: "in_person",
		});
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "excused",
			mode: "online",
		});
		expect(await storedMemberMode(seed.memberId)).toEqual({
			status: "excused",
			mode: null,
		});
	});

	it("an existing guest added with a mode stores it", async () => {
		const guestId = await newGuest("Walk-in");
		await addGuestPresent({
			meetingId: seed.meetingId,
			guestId,
			mode: "online",
		});
		expect((await storedGuestMode(guestId))?.mode).toBe("online");
	});

	it("a guest's toggle updates an existing row; a mode-less add leaves it", async () => {
		const guestId = await newGuest("Regular");
		await addGuestPresent({ meetingId: seed.meetingId, guestId });
		expect((await storedGuestMode(guestId))?.mode).toBeNull();
		await addGuestPresent({
			meetingId: seed.meetingId,
			guestId,
			mode: "in_person",
			replaceMode: true,
		});
		expect((await storedGuestMode(guestId))?.mode).toBe("in_person");
		await addGuestPresent({ meetingId: seed.meetingId, guestId });
		expect((await storedGuestMode(guestId))?.mode).toBe("in_person");
	});

	it("re-adding a guest already present BY ID keeps their recorded mode (decision 1)", async () => {
		const guestId = await newGuest("Returning");
		await addGuestPresent({
			meetingId: seed.meetingId,
			guestId,
			mode: "online",
		});
		// The officer picks them again from the list; the add carries the
		// meeting's default, which must not overwrite what was recorded.
		await addGuestPresent({
			meetingId: seed.meetingId,
			guestId,
			mode: "in_person",
		});
		expect((await storedGuestMode(guestId))?.mode).toBe("online");
	});

	it("re-typing a present visitor as a NEW guest dedupes and keeps their mode (decision 1)", async () => {
		const email = `returning-${suffix}@test.example`;
		const [g] = await testDb
			.insert(guests)
			.values(
				await withGuestPerson(
					{ clubId: seed.clubId, name: `Rita ${suffix}`, email },
					testDb,
				),
			)
			.returning({ id: guests.id });
		await addGuestPresent({
			meetingId: seed.meetingId,
			guestId: g!.id,
			mode: "online",
		});
		// Same person typed in again through "New guest": `resolveGuestId`
		// matches the email (#773) and lands on the SAME guest row.
		const { guestId } = await addGuestPresent({
			meetingId: seed.meetingId,
			newGuest: { name: `Rita ${suffix}`, email },
			mode: "in_person",
		});
		expect(guestId).toBe(g!.id);
		expect((await storedGuestMode(g!.id))?.mode).toBe("online");
	});

	it("a role-only guest's plain ADD inserts their row with the default", async () => {
		const guestId = await newGuest("Role Add");
		const [rd] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: `Grammarian ${suffix}`,
				category: "functionary",
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: rd!.id,
			assignedGuestId: guestId,
			status: "claimed",
		});
		await addGuestPresent({
			meetingId: seed.meetingId,
			guestId,
			mode: "in_person",
		});
		expect((await storedGuestMode(guestId))?.mode).toBe("in_person");
	});

	it("a role-only guest's toggle CREATES their present row (decision 3)", async () => {
		const guestId = await newGuest("Role Guest");
		const [rd] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: `Timer ${suffix}`,
				category: "functionary",
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: rd!.id,
			assignedGuestId: guestId,
			status: "claimed",
		});
		let m = await loadMinutes(seed.meetingId);
		expect(m.guests.find((g) => g.guestId === guestId)).toMatchObject({
			fromRole: true,
		});
		expect(await storedGuestMode(guestId)).toBeUndefined();

		await addGuestPresent({
			meetingId: seed.meetingId,
			guestId,
			mode: "online",
			replaceMode: true,
		});
		m = await loadMinutes(seed.meetingId);
		expect(m.guests.find((g) => g.guestId === guestId)).toMatchObject({
			fromRole: false,
			mode: "online",
		});
	});

	it("minutes: a mix of recorded and unrecorded modes shows only what was recorded", async () => {
		// Member: present, online. Admin: present from before #1049 (NULL).
		// Guest: present, in person.
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
			mode: "online",
		});
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
			status: "present",
		});
		const guestId = await newGuest("Visitor");
		await addGuestPresent({
			meetingId: seed.meetingId,
			guestId,
			mode: "in_person",
		});

		const m = await loadMinutes(seed.meetingId);
		expect(m.members.find((x) => x.memberId === seed.memberId)?.mode).toBe(
			"online",
		);
		expect(
			m.members.find((x) => x.memberId === seed.adminMemberId),
		).not.toHaveProperty("mode");
		expect(m.guests.find((g) => g.guestId === guestId)?.mode).toBe("in_person");
		const { countsLine } = buildAttendanceSection(m);
		expect(countsLine).toBe(
			"Present: 2   Absent: 0   Excused: 0   Guests: 1   Attending incl. guests: 1 + 1 online, 1 not recorded",
		);
	});

	it("minutes: all-NULL modes show the plain total", async () => {
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "present",
		});
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
			status: "present",
		});
		const m = await loadMinutes(seed.meetingId);
		expect(buildAttendanceSection(m).countsLine).toBe(
			"Present: 2   Absent: 0   Excused: 0   Guests: 0",
		);
	});
});
