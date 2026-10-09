/**
 * DB-backed tests for the area health reader (#1117): what `loadAreaHealth`
 * counts, what it leaves untracked, and what it never returns. `#/db` is
 * redirected to the test database.
 *
 * Every time here is relative to a fixed `NOW` passed to `loadAreaHealth`, so
 * the suite does not depend on the wall clock. Every row carries a per-run
 * suffix and is deleted by id afterwards: vitest runs files in parallel against
 * one shared database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/area-health-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	areaClubs,
	areaDirectors,
	areas,
	clubMeetingRecurrence,
	clubs,
	dcpGoalProgress,
	dcpScoreboards,
	districts,
	divisions,
	duesPeriods,
	guests,
	meetingAttendance,
	meetings,
	memberDues,
	members,
	membersEmailBackup,
	membersPhoneBackup,
	officerTerms,
	officerTrainingPeriods,
	officerTrainingRecords,
	people,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";
import { DCP_GOALS } from "#/lib/dcp";
import { hasTestDb, testDb, withGuestPerson } from "#/test/db";
import { statementsDuring } from "#/test/query-spy";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadAreaHealth, AREA_NOT_FOUND_MESSAGE } = await import(
	"./area-health-logic"
);
const { ensureScheduleToppedUp } = await import("./schedule-topup-logic");

/** Program year 2026, training year 2026, and period 2's default window open. */
const NOW = new Date("2026-11-15T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number, extraMs = 0) =>
	new Date(NOW.getTime() - days * DAY - extraMs);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

const run = () => randomUUID().slice(0, 8);

const created = {
	districts: [] as string[],
	clubs: [] as string[],
	people: [] as string[],
	users: [] as string[],
	memberBackups: [] as string[],
	areaIds: [] as string[],
};

async function teardown() {
	if (created.areaIds.length > 0) {
		await testDb
			.delete(areaDirectors)
			.where(inArray(areaDirectors.areaId, created.areaIds));
		await testDb
			.delete(areaClubs)
			.where(inArray(areaClubs.areaId, created.areaIds));
	}
	if (created.clubs.length > 0) {
		// Cascades to meetings, slots, members, terms, dues, scoreboards, guests.
		await testDb.delete(clubs).where(inArray(clubs.id, created.clubs));
	}
	if (created.memberBackups.length > 0) {
		await testDb
			.delete(membersEmailBackup)
			.where(inArray(membersEmailBackup.memberId, created.memberBackups));
		await testDb
			.delete(membersPhoneBackup)
			.where(inArray(membersPhoneBackup.memberId, created.memberBackups));
	}
	if (created.people.length > 0) {
		await testDb.delete(people).where(inArray(people.id, created.people));
	}
	if (created.users.length > 0) {
		await testDb.delete(user).where(inArray(user.id, created.users));
	}
	if (created.areaIds.length > 0) {
		await testDb.delete(areas).where(inArray(areas.id, created.areaIds));
	}
	if (created.districts.length > 0) {
		await testDb
			.delete(divisions)
			.where(inArray(divisions.districtId, created.districts));
		await testDb
			.delete(districts)
			.where(inArray(districts.id, created.districts));
	}
	for (const k of Object.keys(created) as (keyof typeof created)[]) {
		created[k].length = 0;
	}
}

async function makeArea(letter = "B", number = "2") {
	const [district] = await testDb
		.insert(districts)
		.values({ number: `H${run()}` })
		.returning({ id: districts.id });
	if (!district) throw new Error("district");
	created.districts.push(district.id);
	const [division] = await testDb
		.insert(divisions)
		.values({ districtId: district.id, programYear: 2026, letter })
		.returning({ id: divisions.id });
	if (!division) throw new Error("division");
	const [area] = await testDb
		.insert(areas)
		.values({ divisionId: division.id, number })
		.returning({ id: areas.id });
	if (!area) throw new Error("area");
	created.areaIds.push(area.id);
	return area.id;
}

/** A club number nothing else in the shared test database is likely to hold. */
const uniqueClubNumber = () =>
	String(Math.floor(10_000_000 + Math.random() * 89_999_999));

async function makeClub(opts?: {
	name?: string;
	archived?: boolean;
	clubNumber?: string;
}) {
	const id = randomUUID();
	await testDb.insert(clubs).values({
		id,
		name: opts?.name ?? `Health Club ${run()}`,
		slug: `area-health-1117-${id}`,
		clubNumber: opts?.clubNumber ?? null,
		archivedAt: opts?.archived ? new Date() : null,
	});
	created.clubs.push(id);
	return id;
}

/** Place a club (or a name-only row) in an area; returns the area_clubs id. */
async function place(
	areaId: string,
	opts: { clubId?: string; name: string; clubNumber?: string },
) {
	const [row] = await testDb
		.insert(areaClubs)
		.values({
			areaId,
			clubId: opts.clubId ?? null,
			name: opts.name,
			clubNumber: opts.clubNumber ?? null,
		})
		.returning({ id: areaClubs.id });
	if (!row) throw new Error("area club");
	return row.id;
}

async function makeMeeting(
	clubId: string,
	scheduledAt: Date,
	status: "scheduled" | "cancelled" | "completed" = "scheduled",
) {
	const [row] = await testDb
		.insert(meetings)
		.values({ clubId, scheduledAt, status })
		.returning({ id: meetings.id });
	if (!row) throw new Error("meeting");
	return row.id;
}

const roleDefinitionByClub = new Map<string, string>();
async function roleDefinitionFor(clubId: string) {
	let roleDefinitionId = roleDefinitionByClub.get(clubId);
	if (!roleDefinitionId) {
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({ clubId, name: "Timer", category: "functionary" })
			.returning({ id: roleDefinitions.id });
		if (!def) throw new Error("role definition");
		roleDefinitionId = def.id;
		roleDefinitionByClub.set(clubId, roleDefinitionId);
	}
	return roleDefinitionId;
}

async function makeSlots(
	clubId: string,
	meetingId: string,
	statuses: ("open" | "claimed" | "confirmed")[],
) {
	const roleDefinitionId = await roleDefinitionFor(clubId);
	await testDb.insert(roleSlots).values(
		statuses.map((status, slotIndex) => ({
			meetingId,
			roleDefinitionId,
			slotIndex,
			status,
		})),
	);
}

async function makePerson(
	name: string,
	extra?: { email?: string; phone?: string; preferredName?: string },
) {
	const [row] = await testDb
		.insert(people)
		.values({ name, ...extra })
		.returning({ id: people.id });
	if (!row) throw new Error("person");
	created.people.push(row.id);
	return row.id;
}

async function makeMember(
	clubId: string,
	opts?: {
		name?: string;
		status?: "active" | "inactive";
		preferredName?: string;
	},
) {
	const name = opts?.name ?? `Member ${run()}`;
	const personId = await makePerson(name);
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId,
			name,
			preferredName: opts?.preferredName ?? null,
			status: opts?.status ?? "active",
		})
		.returning({ id: members.id });
	if (!row) throw new Error("member");
	return row.id;
}

async function makeGuest(clubId: string, name: string) {
	const [row] = await testDb
		.insert(guests)
		.values(
			await withGuestPerson(
				{
					clubId,
					name,
					email: `${name}@guest.example`,
					phone: `${name}-phone`,
				},
				testDb,
			),
		)
		.returning({ id: guests.id });
	if (!row) throw new Error("guest");
	return row.id;
}

async function rollMember(
	meetingId: string,
	memberId: string,
	status: "present" | "absent" | "excused" = "present",
) {
	await testDb
		.insert(meetingAttendance)
		.values({ meetingId, memberId, status });
}

async function rollGuest(meetingId: string, guestId: string) {
	await testDb
		.insert(meetingAttendance)
		.values({ meetingId, guestId, status: "present" });
}

type Office =
	| "president"
	| "vp_education"
	| "vp_membership"
	| "vp_public_relations"
	| "secretary"
	| "treasurer"
	| "sergeant_at_arms"
	| "immediate_past_president";

async function hold(memberId: string, position: Office, ended = false) {
	await testDb.insert(officerTerms).values({
		membershipId: memberId,
		position,
		termStart: ago(200),
		termEnd: ended ? ago(10) : null,
	});
}

async function train(
	memberId: string,
	position: Office,
	period: 1 | 2,
	programYear = 2026,
) {
	await testDb
		.insert(officerTrainingRecords)
		.values({ membershipId: memberId, position, period, programYear });
}

async function health(areaId: string, clubIndex = 0) {
	const result = await loadAreaHealth(areaId, NOW);
	const club = result.clubs[clubIndex];
	if (!club) throw new Error("no club row");
	return { result, club };
}

describe.skipIf(!hasTestDb)("area health reader (#1117)", () => {
	afterEach(async () => {
		roleDefinitionByClub.clear();
		await teardown();
	});

	it("returns a linked club, a name-only club and an archived club, in that order, the last two untracked", async () => {
		const areaId = await makeArea("C", "3");
		const liveNumber = uniqueClubNumber();
		const live = await makeClub({
			name: "Zulu Live Name",
			clubNumber: liveNumber,
		});
		const archivedNumber = uniqueClubNumber();
		const archived = await makeClub({
			name: "Aardvark Archived",
			archived: true,
			clubNumber: archivedNumber,
		});
		await makeMeeting(live, ago(7));
		// The names are chosen so a plain sort by name would put the archived
		// row first and the linked one last. The area's own copies of a linked
		// club's name and number differ from the club's, so a read of the copy
		// shows.
		await place(areaId, {
			clubId: live,
			name: "Zulu Stale Copy",
			clubNumber: "000",
		});
		await place(areaId, { name: "Beta Name Only", clubNumber: "4242" });
		await place(areaId, {
			clubId: archived,
			name: "Aardvark Copy",
			clubNumber: "999",
		});

		const result = await loadAreaHealth(areaId, NOW);

		expect(result.label).toBe("C3");
		expect(result.programYear).toBe(2026);
		expect(result.asOf).toBe(NOW.toISOString());
		expect(result.clubs.map((c) => [c.name, c.status])).toEqual([
			["Zulu Live Name", "on_gavelup"],
			["Beta Name Only", "not_on_gavelup"],
			["Aardvark Archived", "archived"],
		]);
		// A linked row, archived or not, reads the club's own name AND number
		// live, not the area's copy; a name-only row reads the copy.
		expect(result.clubs.map((c) => c.clubNumber)).toEqual([
			liveNumber,
			"4242",
			archivedNumber,
		]);
		for (const untracked of result.clubs.slice(1)) {
			expect(untracked).toMatchObject({
				meetings: { tracked: false },
				roleFillRate: { tracked: false },
				attendance: { tracked: false },
				officers: { tracked: false },
				dcp: { tracked: false },
				renewals: { tracked: false },
			});
		}
		expect(result.clubs[0]?.meetings.tracked).toBe(true);
	});

	it("treats a row whose club was permanently deleted as not on GavelUp, reading the stored name", async () => {
		const areaId = await makeArea();
		const gone = await makeClub();
		await place(areaId, { clubId: gone, name: "Remembered Name" });
		await testDb.delete(clubs).where(eq(clubs.id, gone));

		const { club } = await health(areaId);
		expect(club).toMatchObject({
			name: "Remembered Name",
			status: "not_on_gavelup",
			officers: { tracked: false },
		});
	});

	it("throws for an area that does not exist", async () => {
		await expect(loadAreaHealth(randomUUID(), NOW)).rejects.toThrow(
			AREA_NOT_FOUND_MESSAGE,
		);
	});

	it("reads none of a club's data, in two statements, when every club is archived or name-only", async () => {
		const areaId = await makeArea("E", "1");
		const archived = await makeClub({ archived: true });
		const deleted = await makeClub();
		// Data an archived club would show if it were read.
		await makeMeeting(archived, ago(7));
		await place(areaId, { clubId: archived, name: "x" });
		await place(areaId, { clubId: deleted, name: "Deleted Club" });
		await place(areaId, { name: "Name Only" });
		await testDb.delete(clubs).where(eq(clubs.id, deleted));

		const statements = await statementsDuring(() =>
			loadAreaHealth(areaId, NOW),
		);
		// The area and its clubs: nothing else is asked about any of them.
		expect(statements).toHaveLength(2);
		expect(statements.join("\n")).not.toMatch(/from "meetings"/);

		const empty = await makeArea("E", "2");
		expect(
			await statementsDuring(() => loadAreaHealth(empty, NOW)),
		).toHaveLength(2);
	});

	it("returns attendance as untracked, not zero, for a club with meetings and no roll", async () => {
		const areaId = await makeArea();
		const clubId = await makeClub();
		await place(areaId, { clubId, name: "x" });
		await makeMeeting(clubId, ago(10));
		await makeMeeting(clubId, ago(24));

		const { club } = await health(areaId);
		expect(club.meetings).toMatchObject({
			tracked: true,
			value: { held: 2 },
		});
		expect(club.attendance).toEqual({ tracked: false });
	});

	it("counts training only when the club has records, and then by office in the chosen period", async () => {
		const areaId = await makeArea();
		const bare = await makeClub({ name: "A bare" });
		const trained = await makeClub({ name: "B trained" });
		await place(areaId, { clubId: bare, name: "x" });
		await place(areaId, { clubId: trained, name: "y" });
		const president = await makeMember(trained);
		const treasurer = await makeMember(trained);
		await makeMember(bare);
		// NOW falls in period 2's default window, so period 2 is the one counted.
		await train(president, "president", 2);
		await train(treasurer, "treasurer", 2);
		// A second member trained for the same office adds nothing.
		await train(treasurer, "president", 2);
		// Period 1 and last year's records are the club's, but not the number.
		await train(president, "secretary", 1);
		await train(president, "vp_education", 2, 2025);

		const { result } = await health(areaId);
		const [first, second] = result.clubs;
		expect(first?.officers).toMatchObject({
			tracked: true,
			value: { trained: { tracked: false } },
		});
		expect(second?.officers).toMatchObject({
			tracked: true,
			value: { trained: { tracked: true, value: 2 } },
		});
	});

	it("reads only last year's records as tracked at zero, not untracked", async () => {
		const areaId = await makeArea();
		const clubId = await makeClub();
		await place(areaId, { clubId, name: "x" });
		await train(await makeMember(clubId), "president", 2, 2025);

		const { club } = await health(areaId);
		expect(club.officers).toMatchObject({
			value: { trained: { tracked: true, value: 0 } },
		});
	});

	it("chooses the training period from the club's own windows", async () => {
		const areaId = await makeArea();
		const clubId = await makeClub();
		await place(areaId, { clubId, name: "x" });
		const member = await makeMember(clubId);
		await train(member, "president", 1);
		await train(member, "treasurer", 2);
		await train(member, "secretary", 2);

		// Default windows: period 2 is open on NOW, so two offices count.
		expect((await health(areaId)).club.officers).toMatchObject({
			value: { trained: { value: 2 } },
		});

		// This club opens period 2 in December: period 1, the latest closed
		// window, is the one counted, and it holds one office.
		await testDb.insert(officerTrainingPeriods).values({
			clubId,
			programYear: 2026,
			period: 2,
			startsOn: "2026-12-01",
			endsOn: "2027-01-31",
		});
		expect((await health(areaId)).club.officers).toMatchObject({
			value: { trained: { value: 1 } },
		});

		// Both of this club's windows overlap and are open: the higher period.
		await testDb
			.update(officerTrainingPeriods)
			.set({ startsOn: "2026-10-01", endsOn: "2026-12-31" })
			.where(eq(officerTrainingPeriods.clubId, clubId));
		await testDb.insert(officerTrainingPeriods).values({
			clubId,
			programYear: 2026,
			period: 1,
			startsOn: "2026-10-15",
			endsOn: "2026-12-15",
		});
		expect((await health(areaId)).club.officers).toMatchObject({
			value: { trained: { value: 2 } },
		});
	});

	it("counts seats for the seven elected offices only, on active members, with open terms", async () => {
		const areaId = await makeArea();
		const ipp = await makeClub({ name: "A only past president" });
		const full = await makeClub({ name: "B all seven" });
		const mixed = await makeClub({ name: "C mixed" });
		for (const clubId of [ipp, full, mixed]) {
			await place(areaId, { clubId, name: clubId });
		}

		await hold(await makeMember(ipp), "immediate_past_president");

		const elected: Office[] = [
			"president",
			"vp_education",
			"vp_membership",
			"vp_public_relations",
			"secretary",
			"treasurer",
			"sergeant_at_arms",
		];
		for (const position of elected) {
			await hold(await makeMember(full), position);
		}

		const open = await makeMember(mixed);
		await hold(open, "president");
		// The same office held by a second member is still one seat.
		await hold(await makeMember(mixed), "president");
		// A term that has ended, an inactive member's term, and a past president
		// are not seats.
		await hold(open, "secretary", true);
		await hold(await makeMember(mixed, { status: "inactive" }), "treasurer");
		await hold(await makeMember(mixed), "immediate_past_president");
		// Held on top of the open one: the same member in two offices is two seats.
		await hold(open, "vp_education");

		const { result } = await health(areaId);
		const seats = result.clubs.map((c) =>
			c.officers.tracked
				? [c.officers.value.seatsFilled, c.officers.value.seatsTotal]
				: null,
		);
		expect(seats).toEqual([
			[0, 7],
			[7, 7],
			[2, 7],
		]);
	});

	it("reports every number for a club that records everything", async () => {
		const areaId = await makeArea();
		const clubId = await makeClub();
		await place(areaId, { clubId, name: "x" });
		const alpha = await makeMember(clubId);
		const bravo = await makeMember(clubId);
		const charlie = await makeMember(clubId);
		const guest = await makeGuest(clubId, `Guest ${run()}`);

		// Held long ago: not recent, so it is in no rate, but it is the club's
		// history and a roll here must not count.
		const old = await makeMeeting(clubId, ago(100), "completed");
		await makeSlots(clubId, old, ["claimed", "claimed", "claimed"]);
		await rollMember(old, alpha);
		await rollMember(old, bravo);
		// Recent and held.
		const m2 = await makeMeeting(clubId, ago(60), "completed");
		await makeSlots(clubId, m2, ["claimed", "confirmed", "claimed", "open"]);
		await rollMember(m2, alpha);
		await rollMember(m2, bravo);
		await rollMember(m2, charlie);
		await rollMember(m2, await makeMember(clubId), "absent");
		await rollGuest(m2, guest);
		const m3 = await makeMeeting(clubId, ago(30), "completed");
		await makeSlots(clubId, m3, ["open", "open"]);
		await rollMember(m3, alpha);
		// Recent, held, with a plan but no roll.
		const m5 = await makeMeeting(clubId, ago(5, 3 * 3_600_000));
		await makeSlots(clubId, m5, ["claimed"]);
		// Recent and cancelled: counted as cancelled, not held, with no rate.
		const m4 = await makeMeeting(clubId, ago(10), "cancelled");
		await makeSlots(clubId, m4, ["claimed", "claimed"]);
		// Upcoming: the next two non-cancelled, soonest first; slots do not count.
		const m6 = await makeMeeting(clubId, ahead(10));
		await makeSlots(clubId, m6, ["claimed"]);
		await makeMeeting(clubId, ahead(3));
		await makeMeeting(clubId, ahead(17));
		await makeMeeting(clubId, ahead(5), "cancelled");

		// DCP: three goals met, one short of its target.
		const [board] = await testDb
			.insert(dcpScoreboards)
			.values({ clubId, programYear: 2026 })
			.returning({ id: dcpScoreboards.id });
		if (!board) throw new Error("scoreboard");
		const target = (key: string) =>
			DCP_GOALS.find((g) => g.key === key)?.target ?? 0;
		await testDb.insert(dcpGoalProgress).values([
			{ scoreboardId: board.id, goalKey: "g1", achieved: target("g1") },
			{ scoreboardId: board.id, goalKey: "g2", achieved: target("g2") },
			{ scoreboardId: board.id, goalKey: "g5", achieved: target("g5") },
			{ scoreboardId: board.id, goalKey: "g3", achieved: target("g3") - 1 },
		]);

		// Dues: the active period is the second; the third is still upcoming.
		const [p1, p2, p3] = await testDb
			.insert(duesPeriods)
			.values([
				{ clubId, label: "one", dueDate: ago(200) },
				{ clubId, label: "two", dueDate: ago(20) },
				{ clubId, label: "three", dueDate: ahead(160) },
			])
			.returning({ id: duesPeriods.id });
		if (!p1 || !p2 || !p3) throw new Error("periods");
		await testDb.insert(memberDues).values([
			{ membershipId: alpha, duesPeriodId: p1.id, status: "paid" },
			{ membershipId: bravo, duesPeriodId: p1.id, status: "waived" },
			{ membershipId: charlie, duesPeriodId: p1.id, status: "paid" },
			{ membershipId: alpha, duesPeriodId: p2.id, status: "paid" },
			{ membershipId: bravo, duesPeriodId: p2.id, status: "paid" },
			{ membershipId: alpha, duesPeriodId: p3.id, status: "paid" },
		]);
		await hold(alpha, "president");
		await hold(bravo, "secretary");

		const { club } = await health(areaId);

		// m2, m3 and m5 are the recent held meetings; m4 is the recent cancelled.
		expect(club.meetings).toEqual({
			tracked: true,
			value: {
				held: 3,
				cancelled: 1,
				daysSinceLast: 5,
				next: [ahead(3).toISOString(), ahead(10).toISOString()],
			},
		});
		// Slots at m2, m3 and m5: 4 claimed or confirmed of 7.
		expect(club.roleFillRate).toEqual({
			tracked: true,
			value: { filled: 4, total: 7 },
		});
		// Rolls at m2 (3 members present, 1 guest) and m3 (1 member): m5 has none.
		expect(club.attendance).toEqual({
			tracked: true,
			value: { avgMembers: 2, avgGuests: 0.5, rollTaken: 2, held: 3 },
		});
		expect(club.officers).toMatchObject({
			value: { seatsFilled: 2, seatsTotal: 7, trained: { tracked: false } },
		});
		expect(club.dcp).toEqual({ tracked: true, value: { goalsMet: 3 } });
		expect(club.renewals).toEqual({
			tracked: true,
			value: { paidThisPeriod: 2, paidLastPeriod: 3 },
		});
	});

	it("scores DCP from this program year's scoreboard only", async () => {
		const areaId = await makeArea();
		const lastYearOnly = await makeClub({ name: "A last year only" });
		const both = await makeClub({ name: "B both years" });
		await place(areaId, { clubId: lastYearOnly, name: "x" });
		await place(areaId, { clubId: both, name: "y" });
		const target = (key: string) =>
			DCP_GOALS.find((g) => g.key === key)?.target ?? 0;
		const board = async (
			clubId: string,
			programYear: number,
			keys: string[],
		) => {
			const [row] = await testDb
				.insert(dcpScoreboards)
				.values({ clubId, programYear })
				.returning({ id: dcpScoreboards.id });
			if (!row) throw new Error("scoreboard");
			await testDb.insert(dcpGoalProgress).values(
				keys.map((goalKey) => ({
					scoreboardId: row.id,
					goalKey,
					achieved: target(goalKey),
				})),
			);
		};
		await board(lastYearOnly, 2025, ["g1", "g2", "g5"]);
		await board(both, 2025, ["g1", "g2", "g5"]);
		await board(both, 2026, ["g1"]);

		const { result } = await health(areaId);
		expect(result.clubs.map((c) => c.dcp)).toEqual([
			{ tracked: false },
			{ tracked: true, value: { goalsMet: 1 } },
		]);
	});

	it("draws the recent window and the held line exactly: 90 days back is in, a second further is out, now is upcoming", async () => {
		const areaId = await makeArea();
		const held = await makeClub({ name: "A held boundary" });
		const cancelled = await makeClub({ name: "B cancelled boundary" });
		await place(areaId, { clubId: held, name: "x" });
		await place(areaId, { clubId: cancelled, name: "y" });
		await makeMeeting(held, ago(90)); // the first instant of the window
		await makeMeeting(held, ago(90, 1000)); // a second before it
		await makeMeeting(held, new Date(NOW.getTime() - 1)); // just held
		await makeMeeting(held, NOW); // not before now: upcoming, not held
		await makeMeeting(cancelled, ago(90), "cancelled"); // in the window
		await makeMeeting(cancelled, ago(90, 1000), "cancelled"); // outside it
		await makeMeeting(cancelled, NOW, "cancelled"); // upcoming and cancelled

		const { result } = await health(areaId);
		expect(result.clubs[0]?.meetings).toEqual({
			tracked: true,
			value: {
				held: 2,
				cancelled: 0,
				daysSinceLast: 0,
				next: [NOW.toISOString()],
			},
		});
		expect(result.clubs[1]?.meetings).toEqual({
			tracked: true,
			value: { held: 0, cancelled: 1, daysSinceLast: null, next: [] },
		});
	});

	it("leaves role fill untracked when recent held meetings have no slots, and renewals untracked with two upcoming periods", async () => {
		const areaId = await makeArea();
		const clubId = await makeClub();
		await place(areaId, { clubId, name: "x" });
		await makeMeeting(clubId, ago(14));
		// Slots exist, at a meeting too old to count.
		await makeSlots(clubId, await makeMeeting(clubId, ago(120)), ["claimed"]);
		await testDb.insert(duesPeriods).values([
			{ clubId, label: "later", dueDate: ahead(30) },
			{ clubId, label: "latest", dueDate: ahead(200) },
		]);

		const { club } = await health(areaId);
		expect(club.roleFillRate).toEqual({ tracked: false });
		expect(club.renewals).toEqual({ tracked: false });
	});

	it("returns no person data: no name, email or phone from any table", async () => {
		const areaId = await makeArea();
		const mark = `PIIMARK${run()}`;
		const markers: string[] = [];
		const clubId = await makeClub();
		await place(areaId, { clubId, name: "x" });

		// A roster of members with names, preferred names, emails and phones,
		// each also left in the two backup tables the migrations kept.
		const memberIds: string[] = [];
		for (const n of [1, 2, 3]) {
			const person = {
				name: `${mark}-person-${n}`,
				email: `${mark}-person-${n}@marker.example`,
				phone: `${mark}-person-phone-${n}`,
				preferredName: `${mark}-person-goes-by-${n}`,
			};
			const personId = await makePerson(person.name, person);
			const member = {
				name: `${mark}-member-${n}`,
				preferredName: `${mark}-member-goes-by-${n}`,
			};
			const [row] = await testDb
				.insert(members)
				.values({ clubId, personId, ...member })
				.returning({ id: members.id });
			if (!row) throw new Error("member");
			memberIds.push(row.id);
			const backup = {
				email: `${mark}-backup-${n}@marker.example`,
				phone: `${mark}-backup-phone-${n}`,
			};
			await testDb
				.insert(membersEmailBackup)
				.values({ memberId: row.id, clubId, personId, email: backup.email });
			await testDb
				.insert(membersPhoneBackup)
				.values({ memberId: row.id, clubId, personId, phone: backup.phone });
			created.memberBackups.push(row.id);
			markers.push(
				...Object.values(person),
				...Object.values(member),
				...Object.values(backup),
			);
		}
		const guestName = `${mark}-guest`;
		const guest = await makeGuest(clubId, guestName);
		markers.push(guestName, `${guestName}@guest.example`, `${guestName}-phone`);

		// Officers, a roll with members and a guest, training, and a held role.
		const [a, b, c] = memberIds as [string, string, string];
		await hold(a, "president");
		await hold(b, "secretary");
		await train(a, "president", 2);
		const meeting = await makeMeeting(clubId, ago(7));
		await makeSlots(clubId, meeting, ["claimed", "open"]);
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: c })
			.where(eq(roleSlots.meetingId, meeting));
		await rollMember(meeting, a);
		await rollMember(meeting, b);
		await rollGuest(meeting, guest);

		// The Area Director, as a user and as a term.
		const directorId = randomUUID();
		const director = {
			name: `${mark}-director-name`,
			email: `${mark}-director@marker.example`,
		};
		await testDb
			.insert(user)
			.values({ id: directorId, ...director, emailVerified: true });
		created.users.push(directorId);
		const displayName = `${mark}-director-display`;
		await testDb
			.insert(areaDirectors)
			.values({ areaId, userId: directorId, displayName });
		markers.push(...Object.values(director), displayName);

		const json = JSON.stringify(await loadAreaHealth(areaId, NOW));

		// The control: the numbers are there, so an empty response cannot pass.
		expect(json).toContain('"seatsFilled":2');
		expect(json).toContain('"rollTaken":1');
		expect(markers.length).toBeGreaterThan(20);
		for (const marker of markers) {
			expect(json, `leaked ${marker}`).not.toContain(marker);
		}
		expect(json).not.toContain(mark);
	});

	it("writes nothing: a club whose standing schedule has a gap keeps its meetings and slots", async () => {
		const areaId = await makeArea();
		const clubId = await makeClub();
		const control = await makeClub();
		await place(areaId, { clubId, name: "x" });
		for (const id of [clubId, control]) {
			await roleDefinitionFor(id);
			await testDb.insert(clubMeetingRecurrence).values({
				clubId: id,
				mode: "interval",
				weekday: 3,
				intervalWeeks: 1,
				anchorDate: "2026-01-07",
				timeOfDay: "18:30",
				keepAhead: 4,
				enabled: true,
			});
		}
		// One old meeting with slots and nothing ahead: the schedule has a gap of
		// four meetings, each of which the top-up would give a slot.
		await makeSlots(clubId, await makeMeeting(clubId, ago(200)), [
			"claimed",
			"open",
		]);

		const counts = async (id: string) => {
			const m = await testDb
				.select({ id: meetings.id })
				.from(meetings)
				.where(eq(meetings.clubId, id));
			const s = await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.innerJoin(meetings, eq(roleSlots.meetingId, meetings.id))
				.where(eq(meetings.clubId, id));
			return { meetings: m.length, slots: s.length };
		};

		// The control proves this fixture is one the top-up writes meetings AND
		// slots to, so both counts below mean something.
		expect(
			(await ensureScheduleToppedUp(control, NOW)).created,
		).toBeGreaterThan(0);
		const topped = await counts(control);
		expect(topped.meetings).toBeGreaterThan(0);
		expect(topped.slots).toBeGreaterThan(0);

		const before = await counts(clubId);
		expect(before).toEqual({ meetings: 1, slots: 2 });
		await loadAreaHealth(areaId, NOW);
		await loadAreaHealth(areaId);
		expect(await counts(clubId)).toEqual(before);
	});

	it("issues the same number of statements for one club as for six", async () => {
		const small = await makeArea("D", "1");
		const large = await makeArea("D", "2");
		for (let i = 0; i < 6; i++) {
			const clubId = await makeClub();
			await place(i === 0 ? small : large, { clubId, name: `c${i}` });
			if (i > 0) {
				await makeMeeting(clubId, ago(10 + i));
				await makeMeeting(clubId, ahead(i));
			}
		}
		await place(large, { clubId: await makeClub(), name: "six" });
		await place(large, { name: "name only" });

		const one = await statementsDuring(() => loadAreaHealth(small, NOW));
		const many = await statementsDuring(() => loadAreaHealth(large, NOW));
		expect(one.length).toBeGreaterThan(0);
		expect(many.length).toBe(one.length);
	});
});
