/**
 * DB-backed integration tests for the VP Education reporting queries
 * (issues #8 / #9): speaker rotation, overdue members, and the inline
 * Pathways surface — all over existing tables (ADR-0005 "no new tables").
 *
 * Runs against a real Postgres identified by TEST_DATABASE_URL; the suite is
 * skipped when it's unset (never touches dev/prod).
 *
 *   TEST_DATABASE_URL=postgresql://test:test@localhost:5433/tm_test \
 *     bunx vitest run src/server/reporting.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const DAY = 24 * 60 * 60 * 1000;

async function addMember(
	clubId: string,
	name: string,
): Promise<{ memberId: string; personId: string }> {
	const personId = await seedPerson({ name });
	const [row] = await testDb
		.insert(members)
		.values({ clubId, personId, name, clubRole: "member", status: "active" })
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return { memberId: row.id, personId };
}

async function addMeeting(clubId: string, daysAgo: number): Promise<string> {
	const [row] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() - daysAgo * DAY),
			status: "scheduled",
		})
		.returning({ id: meetings.id });
	if (!row) throw new Error("meeting insert failed");
	return row.id;
}

async function addSlot(opts: {
	meetingId: string;
	roleDefinitionId: string;
	memberId: string;
	speechId?: string;
}): Promise<string> {
	const [row] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: opts.meetingId,
			roleDefinitionId: opts.roleDefinitionId,
			assignedMemberId: opts.memberId,
			status: "confirmed",
			speechId: opts.speechId ?? null,
		})
		.returning({ id: roleSlots.id });
	if (!row) throw new Error("slot insert failed");
	return row.id;
}

async function addSpeech(
	personId: string,
	fields: { pathwayPath: string; projectName: string; projectLevel: string },
): Promise<string> {
	const [row] = await testDb
		.insert(speeches)
		.values({ personId, title: "A speech", ...fields })
		.returning({ id: speeches.id });
	if (!row) throw new Error("speech insert failed");
	return row.id;
}

describe.skipIf(!hasTestDb)("VPE reporting queries", () => {
	let seeded: SeededClub;
	let speakerRoleId: string;

	beforeEach(async () => {
		seeded = await seedClub();
		// seedClub gives a non-speaker "Timer" role (seeded.roleDefinitionId);
		// add a speaker role definition for the rotation query.
		const [speaker] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seeded.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		if (!speaker) throw new Error("speaker role insert failed");
		speakerRoleId = speaker.id;
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	});

	it("ranks the speaker queue never-spoken-first, then oldest speaker", async () => {
		const { loadSpeakerRotation } = await import("#/server/reporting-logic");

		const alex = await addMember(seeded.clubId, "Alex Rivera"); // spoke 60d ago
		const sam = await addMember(seeded.clubId, "Sam Chen"); // spoke 14d ago
		const casey = await addMember(seeded.clubId, "Casey Kim"); // functionary only
		const dana = await addMember(seeded.clubId, "Dana Lee"); // no roles at all

		const m60 = await addMeeting(seeded.clubId, 60);
		const m45 = await addMeeting(seeded.clubId, 45);
		const m14 = await addMeeting(seeded.clubId, 14);

		await addSlot({
			meetingId: m60,
			roleDefinitionId: speakerRoleId,
			memberId: alex.memberId,
		});
		await addSlot({
			meetingId: m14,
			roleDefinitionId: speakerRoleId,
			memberId: sam.memberId,
		});
		// Casey held only a non-speaker (Timer) role — must NOT count as spoken.
		await addSlot({
			meetingId: m45,
			roleDefinitionId: seeded.roleDefinitionId,
			memberId: casey.memberId,
		});

		const rotation = await loadSpeakerRotation(seeded.clubId);
		const byId = new Map(rotation.map((r) => [r.memberId, r]));

		// Non-speaker slot did not leak into the speaker count (the spike's bug).
		expect(byId.get(casey.memberId)?.timesSpoken).toBe(0);
		expect(byId.get(casey.memberId)?.lastSpokenAt).toBeNull();
		expect(byId.get(alex.memberId)?.timesSpoken).toBe(1);

		// Order: never-spoken (Casey, Dana + the two seedClub members) sort first
		// (name-tiebroken), then Alex (60d), then Sam (14d) last.
		const ids = rotation.map((r) => r.memberId);
		expect(ids.indexOf(alex.memberId)).toBeLessThan(ids.indexOf(sam.memberId));
		expect(ids.indexOf(casey.memberId)).toBeLessThan(
			ids.indexOf(alex.memberId),
		);
		expect(ids.indexOf(dana.memberId)).toBeLessThan(ids.indexOf(alex.memberId));
		// Sam spoke most recently → bottom of the queue.
		expect(ids[ids.length - 1]).toBe(sam.memberId);
	});

	it("surfaces the latest speech's Pathways path/project (issue #9)", async () => {
		const { loadSpeakerRotation } = await import("#/server/reporting-logic");
		const sam = await addMember(seeded.clubId, "Sam Chen");
		const m14 = await addMeeting(seeded.clubId, 14);
		const speechId = await addSpeech(sam.personId, {
			pathwayPath: "Presentation Mastery",
			projectName: "Ice Breaker",
			projectLevel: "Level 1",
		});
		await addSlot({
			meetingId: m14,
			roleDefinitionId: speakerRoleId,
			memberId: sam.memberId,
			speechId,
		});

		const rotation = await loadSpeakerRotation(seeded.clubId);
		const row = rotation.find((r) => r.memberId === sam.memberId);
		expect(row?.latestPathwayPath).toBe("Presentation Mastery");
		expect(row?.latestProjectName).toBe("Ice Breaker");
		expect(row?.latestProjectLevel).toBe("Level 1");
	});

	it("flags overdue members by any-role recency and the threshold", async () => {
		const { loadOverdueMembers } = await import("#/server/reporting-logic");
		const recent = await addMember(seeded.clubId, "Recent Role"); // 10d ago
		const stale = await addMember(seeded.clubId, "Stale Role"); // 90d ago
		const never = await addMember(seeded.clubId, "Never Role"); // no roles

		const m10 = await addMeeting(seeded.clubId, 10);
		const m90 = await addMeeting(seeded.clubId, 90);
		await addSlot({
			meetingId: m10,
			roleDefinitionId: seeded.roleDefinitionId,
			memberId: recent.memberId,
		});
		await addSlot({
			meetingId: m90,
			roleDefinitionId: seeded.roleDefinitionId,
			memberId: stale.memberId,
		});

		const overdue = await loadOverdueMembers(seeded.clubId, 60);
		const byId = new Map(overdue.map((m) => [m.memberId, m]));

		// Functionary participation counts — 10 days ago is not overdue.
		expect(byId.get(recent.memberId)?.isOverdue).toBe(false);
		expect(byId.get(recent.memberId)?.daysSinceLastRole).toBeGreaterThanOrEqual(
			9,
		);
		// 90 days ago exceeds the 60-day window.
		expect(byId.get(stale.memberId)?.isOverdue).toBe(true);
		// Never held a role → overdue with null recency.
		expect(byId.get(never.memberId)?.isOverdue).toBe(true);
		expect(byId.get(never.memberId)?.daysSinceLastRole).toBeNull();

		// Oldest-participation-first: never (null) sorts before stale before recent.
		const ids = overdue.map((m) => m.memberId);
		expect(ids.indexOf(never.memberId)).toBeLessThan(
			ids.indexOf(stale.memberId),
		);
		expect(ids.indexOf(stale.memberId)).toBeLessThan(
			ids.indexOf(recent.memberId),
		);
	});
});
