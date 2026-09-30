/**
 * "New members in orientation" (#942), DB-backed: who `loadOrientationRoster`
 * lists, in what order, with which ticks and mentors, and that it stays inside
 * one club. The server fn's admin gate is held two ways, as for the rest of
 * `reporting.ts`: `requireClubAdminView` refusing a plain member here, and its
 * wiring into `getOrientationRoster` by `reporting-orientation-authz.guard.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	members,
	mentorships,
	pathEnrollments,
	pathwaysPaths,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { cleanup, hasTestDb, seedClub, seedPerson, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadOrientationRoster } = await import("./reporting-logic");
const { getOrientation } = await import("./orientation-logic");
const { requireClubAdminView } = await import("./guards");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-30T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const createdClubs: string[] = [];
const createdUsers: string[] = [];
const createdPaths: string[] = [];

afterEach(async () => {
	for (const clubId of createdClubs) await cleanup(clubId, createdUsers);
	createdClubs.length = 0;
	createdUsers.length = 0;
	// Club-less catalog rows: delete only the ones this file made.
	if (createdPaths.length > 0) {
		await testDb
			.delete(pathwaysPaths)
			.where(inArray(pathwaysPaths.id, createdPaths));
		createdPaths.length = 0;
	}
});

/**
 * A club whose seeded admin is a veteran (not in orientation) and whose seeded
 * member started orientation `startedDaysAgo` days before NOW.
 */
async function seed(startedDaysAgo = 3) {
	const s = await seedClub();
	createdClubs.push(s.clubId);
	createdUsers.push(s.adminUserId, s.memberUserId);
	await testDb
		.update(members)
		.set({ orientationStartedAt: null })
		.where(eq(members.id, s.adminMemberId));
	await testDb
		.update(members)
		.set({ orientationStartedAt: daysAgo(startedDaysAgo) })
		.where(eq(members.id, s.memberId));
	return s;
}

/** Another active membership in the club, started `startedDaysAgo` days ago. */
async function addMember(
	clubId: string,
	name: string,
	over: Partial<typeof members.$inferInsert> & { startedDaysAgo?: number } = {},
) {
	const { startedDaysAgo = 1, ...rest } = over;
	const personId = await seedPerson({ name });
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId,
			name,
			clubRole: "member",
			status: "active",
			orientationStartedAt: daysAgo(startedDaysAgo),
			...rest,
		})
		.returning({ id: members.id, personId: members.personId });
	if (!row) throw new Error("no member");
	return row;
}

async function enroll(personId: string) {
	const [path] = await testDb
		.insert(pathwaysPaths)
		.values({ courseCode: `T942-${randomUUID()}`, name: "Test Path 942" })
		.returning({ id: pathwaysPaths.id });
	if (!path) throw new Error("no path");
	createdPaths.push(path.id);
	await testDb.insert(pathEnrollments).values({ personId, pathId: path.id });
}

/** Distinct meeting times, since (club, scheduled_at) is unique. */
let meetingSeq = 0;

async function assignSlot(clubId: string, memberId: string, speaker: boolean) {
	meetingSeq += 1;
	const [def] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: `${speaker ? "Speaker" : "Timer"} ${randomUUID()}`,
			category: speaker ? "speaker" : "functionary",
			isSpeakerRole: speaker,
		})
		.returning({ id: roleDefinitions.id });
	const [meeting] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(daysAgo(1).getTime() + meetingSeq * 60_000),
			status: "completed",
		})
		.returning({ id: meetings.id });
	if (!def || !meeting) throw new Error("fixture");
	await testDb.insert(roleSlots).values({
		meetingId: meeting.id,
		roleDefinitionId: def.id,
		assignedMemberId: memberId,
		status: "claimed",
	});
}

describe.skipIf(!hasTestDb)("loadOrientationRoster (#942)", () => {
	it("lists only members in orientation: not veterans, dismissed, complete or inactive", async () => {
		const s = await seed();
		await addMember(s.clubId, "Dismissed Dee", {
			orientationDismissedAt: daysAgo(0),
		});
		await addMember(s.clubId, "Inactive Ian", { status: "inactive" });
		await addMember(s.clubId, "Veteran Val", { orientationStartedAt: null });
		const done = await addMember(s.clubId, "Complete Cam", {
			basecampSetupAt: daysAgo(0),
		});
		await enroll(done.personId);
		await assignSlot(s.clubId, done.id, true);
		await assignSlot(s.clubId, done.id, false);
		await testDb.insert(mentorships).values({
			clubId: s.clubId,
			mentorMemberId: s.adminMemberId,
			menteeMemberId: done.id,
			focus: "new_member",
		});
		expect((await getOrientation(done.id))?.complete).toBe(true);

		const rows = await loadOrientationRoster(s.clubId, NOW);
		expect(rows.map((r) => r.memberId)).toEqual([s.memberId]);
	});

	it("sorts longest in orientation first and counts whole days", async () => {
		// Inserted NEWEST first, so the result's order is the sort's, not the
		// table's.
		const s = await seed(27);
		const b = await addMember(s.clubId, "Bea", { startedDaysAgo: 28 });
		const c = await addMember(s.clubId, "Cy", { startedDaysAgo: 29 });
		const rows = await loadOrientationRoster(s.clubId, NOW);
		expect(rows.map((r) => [r.memberId, r.days])).toEqual([
			[c.id, 29],
			[b.id, 28],
			[s.memberId, 27],
		]);
	});

	it("never lists another club's members", async () => {
		const a = await seed();
		const b = await seed();
		const rows = await loadOrientationRoster(a.clubId, NOW);
		expect(rows.map((r) => r.memberId)).toEqual([a.memberId]);
		expect(rows.map((r) => r.memberId)).not.toContain(b.memberId);
	});

	it("its ticks are the member's own checklist, item for item", async () => {
		const s = await seed();
		await enroll(s.personId);
		await assignSlot(s.clubId, s.memberId, false);
		const [row] = await loadOrientationRoster(s.clubId, NOW);
		const own = await getOrientation(s.memberId);
		expect(row?.items).toEqual(
			own?.items.map(({ key, label, done }) => ({ key, label, done })),
		);
		expect(row?.items.map((i) => i.done)).toEqual([
			true,
			false,
			true,
			false,
			false,
		]);
	});

	it("names ACTIVE new-member mentors only", async () => {
		const s = await seed();
		const ended = await addMember(s.clubId, "Ended Ed", {
			orientationStartedAt: null,
		});
		const contest = await addMember(s.clubId, "Contest Cora", {
			orientationStartedAt: null,
		});
		await testDb.insert(mentorships).values([
			{
				clubId: s.clubId,
				mentorMemberId: ended.id,
				menteeMemberId: s.memberId,
				focus: "new_member",
				endedAt: daysAgo(1),
			},
			{
				clubId: s.clubId,
				mentorMemberId: contest.id,
				menteeMemberId: s.memberId,
				focus: "contest",
			},
		]);
		let [row] = await loadOrientationRoster(s.clubId, NOW);
		expect(row?.mentorNames).toEqual([]);
		expect(row?.items.find((i) => i.key === "get-a-mentor")?.done).toBe(false);

		await testDb.insert(mentorships).values({
			clubId: s.clubId,
			mentorMemberId: s.adminMemberId,
			menteeMemberId: s.memberId,
			focus: "new_member",
		});
		[row] = await loadOrientationRoster(s.clubId, NOW);
		expect(row?.mentorNames).toEqual(["Admin User"]);
		expect(row?.items.find((i) => i.key === "get-a-mentor")?.done).toBe(true);
	});

	it("carries contact for the draft, with a blank email as none", async () => {
		const s = await seed();
		await testDb
			.update(members)
			.set({ email: "  ", phone: "+14155550123" })
			.where(eq(members.id, s.memberId));
		const [row] = await loadOrientationRoster(s.clubId, NOW);
		expect(row?.email).toBeNull();
		expect(row?.phone).toBe("+14155550123");
	});

	it("the admin gate refuses a plain member", async () => {
		const s = await seed();
		await expect(
			requireClubAdminView(s.memberUserId, s.clubId),
		).rejects.toThrow();
		await expect(
			requireClubAdminView(s.adminUserId, s.clubId),
		).resolves.toBeDefined();
	});
});
