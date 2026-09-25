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
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	meetingAttendance,
	meetings,
	members,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPathLevels,
	pathwaysPaths,
	pathwaysProjects,
	projectCompletionMarks,
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

/**
 * A meeting that has NOT happened yet (#543). Separate from `addMeeting` rather
 * than a negative `daysAgo` because the upcoming-claim tests also need to vary
 * the meeting's status, and "cancelled, 3 days from now" is the case the marker
 * has to stay off.
 */
async function addUpcomingMeeting(
	clubId: string,
	daysAhead: number,
	status: "scheduled" | "cancelled" = "scheduled",
): Promise<{ meetingId: string; scheduledAt: Date }> {
	const scheduledAt = new Date(Date.now() + daysAhead * DAY);
	const [row] = await testDb
		.insert(meetings)
		.values({ clubId, scheduledAt, status })
		.returning({ id: meetings.id });
	if (!row) throw new Error("meeting insert failed");
	return { meetingId: row.id, scheduledAt };
}

async function addSlot(opts: {
	meetingId: string;
	roleDefinitionId: string;
	memberId: string;
	speechId?: string;
	status?: "open" | "claimed" | "confirmed";
}): Promise<string> {
	const [row] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: opts.meetingId,
			roleDefinitionId: opts.roleDefinitionId,
			assignedMemberId: opts.memberId,
			status: opts.status ?? "confirmed",
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

		// #543 — nobody in this club holds a future claim, so no row carries the
		// marker. `seedClub` DOES leave a meeting a week out, with an OPEN slot
		// assigned to nobody: an unclaimed slot is not a commitment.
		for (const row of overdue) {
			expect(row.upcomingRoleAt).toBeUndefined();
		}
	});

	// #543 — the VPE dashboard ranks by PAST participation, so a member who has
	// signed up for Monday still reads "Never held a role" beside the club's own
	// sign-up sheet. These cover the additive marker that resolves the
	// contradiction, and — just as importantly — that it is only a marker: the
	// ordering, `isOverdue` and the overdue count are unchanged by a future claim.
	describe("upcoming role claims (#543)", () => {
		it("marks an overdue member who holds a confirmed future role, without changing isOverdue or the rank", async () => {
			const { loadOverdueMembers } = await import("#/server/reporting-logic");

			const booked = await addMember(seeded.clubId, "Booked Member");
			const stale = await addMember(seeded.clubId, "Stale Member");

			const past = await addMeeting(seeded.clubId, 90);
			await addSlot({
				meetingId: past,
				roleDefinitionId: seeded.roleDefinitionId,
				memberId: stale.memberId,
			});
			const next = await addUpcomingMeeting(seeded.clubId, 3);
			await addSlot({
				meetingId: next.meetingId,
				roleDefinitionId: seeded.roleDefinitionId,
				memberId: booked.memberId,
			});

			const overdue = await loadOverdueMembers(seeded.clubId, 60);
			const byId = new Map(overdue.map((m) => [m.memberId, m]));
			const row = byId.get(booked.memberId);

			// The marker is present and points at the meeting they claimed.
			expect(row?.upcomingRoleAt?.getTime()).toBe(next.scheduledAt.getTime());
			// …and NOTHING backward-looking moved. A claim is not participation
			// until it happens: this member is still counted, still flagged, still
			// has no role history, and still sorts above the member who last held
			// a role 90 days ago.
			expect(row?.isOverdue).toBe(true);
			expect(row?.daysSinceLastRole).toBeNull();
			expect(row?.lastAnyRoleAt).toBeNull();
			const ids = overdue.map((m) => m.memberId);
			expect(ids.indexOf(booked.memberId)).toBeLessThan(
				ids.indexOf(stale.memberId),
			);
			// The OVERDUE MEMBERS stat card counts `isOverdue` rows; the marker must
			// not quietly remove this member from it. Option (b) in #543 — dropping
			// them from the count — was considered and explicitly rejected.
			const counted = overdue.filter((m) => m.isOverdue).map((m) => m.memberId);
			expect(counted).toContain(booked.memberId);
		});

		it("marks a never-spoken member in the speaker queue too", async () => {
			const { loadSpeakerRotation } = await import("#/server/reporting-logic");

			const booked = await addMember(seeded.clubId, "Booked Speaker");
			const next = await addUpcomingMeeting(seeded.clubId, 5);
			await addSlot({
				meetingId: next.meetingId,
				roleDefinitionId: speakerRoleId,
				memberId: booked.memberId,
			});

			const rotation = await loadSpeakerRotation(seeded.clubId);
			const row = rotation.find((r) => r.memberId === booked.memberId);

			expect(row?.upcomingRoleAt?.getTime()).toBe(next.scheduledAt.getTime());
			// Still "Never spoken" — the speech has not happened yet.
			expect(row?.timesSpoken).toBe(0);
			expect(row?.lastSpokenAt).toBeNull();
		});

		it("marks a speaker-queue row for a NON-speaker future claim", async () => {
			// The marker is any-role BY DESIGN — overdue means "no claimed role of
			// any kind", and a member booked as Timer is exactly the person a VPE
			// should not chase. It is also why the dashboard's marker is worded
			// role-neutrally: adding an `is_speaker_role` filter here to make "Up
			// next" honest in the speaker queue would fail this test, and changing
			// the copy back to "Up next" fails the component suite. The two halves
			// cannot drift apart quietly.
			const { loadSpeakerRotation } = await import("#/server/reporting-logic");

			const timer = await addMember(seeded.clubId, "Timer Only");
			const next = await addUpcomingMeeting(seeded.clubId, 5);
			await addSlot({
				meetingId: next.meetingId,
				// seedClub's role definition is a non-speaker "Timer".
				roleDefinitionId: seeded.roleDefinitionId,
				memberId: timer.memberId,
			});

			const rotation = await loadSpeakerRotation(seeded.clubId);
			const row = rotation.find((r) => r.memberId === timer.memberId);

			expect(row?.upcomingRoleAt?.getTime()).toBe(next.scheduledAt.getTime());
			// …and the queue's own ranking still says they have never spoken, which
			// is true: a Timer booking is not a speech.
			expect(row?.timesSpoken).toBe(0);
			expect(row?.lastSpokenAt).toBeNull();
		});

		it("does NOT mark a claim at a cancelled future meeting", async () => {
			const { loadOverdueMembers } = await import("#/server/reporting-logic");

			const ghost = await addMember(seeded.clubId, "Ghost Meeting");
			const off = await addUpcomingMeeting(seeded.clubId, 4, "cancelled");
			await addSlot({
				meetingId: off.meetingId,
				roleDefinitionId: seeded.roleDefinitionId,
				memberId: ghost.memberId,
			});

			const overdue = await loadOverdueMembers(seeded.clubId, 60);
			const row = overdue.find((m) => m.memberId === ghost.memberId);
			expect(row?.upcomingRoleAt).toBeUndefined();
		});

		it("does NOT mark an open slot that merely names a member", async () => {
			// A slot can carry `assigned_member_id` while still sitting at status
			// `open` — that is a suggestion, not a commitment, and the past-facing
			// queries already refuse to count it.
			const { loadOverdueMembers } = await import("#/server/reporting-logic");

			const pencilled = await addMember(seeded.clubId, "Pencilled In");
			const next = await addUpcomingMeeting(seeded.clubId, 2);
			await addSlot({
				meetingId: next.meetingId,
				roleDefinitionId: seeded.roleDefinitionId,
				memberId: pencilled.memberId,
				status: "open",
			});

			const overdue = await loadOverdueMembers(seeded.clubId, 60);
			const row = overdue.find((m) => m.memberId === pencilled.memberId);
			expect(row?.upcomingRoleAt).toBeUndefined();
		});

		it("shows the SOONEST of two future claims", async () => {
			const { loadOverdueMembers } = await import("#/server/reporting-logic");

			const busy = await addMember(seeded.clubId, "Busy Member");
			const soon = await addUpcomingMeeting(seeded.clubId, 3);
			const later = await addUpcomingMeeting(seeded.clubId, 17);
			await addSlot({
				meetingId: later.meetingId,
				roleDefinitionId: seeded.roleDefinitionId,
				memberId: busy.memberId,
			});
			await addSlot({
				meetingId: soon.meetingId,
				roleDefinitionId: seeded.roleDefinitionId,
				memberId: busy.memberId,
				status: "claimed",
			});

			const overdue = await loadOverdueMembers(seeded.clubId, 60);
			const row = overdue.find((m) => m.memberId === busy.memberId);
			// The later meeting was inserted FIRST, so a query that took any row
			// rather than the minimum would pass on insertion order alone.
			expect(row?.upcomingRoleAt?.getTime()).toBe(soon.scheduledAt.getTime());
		});

		it("leaves the attendance-lapse rows untouched", async () => {
			// The three loaders share `HELD_SLOT_STATUSES` and the
			// past/not-cancelled predicate, and `loadAttendanceLapse` reads role
			// slots too (holding a role counts as being there, #530). Widening
			// either to reach future meetings would quietly mark a member present
			// at a meeting that has not happened, breaking their absence streak.
			const { loadAttendanceLapse } = await import("#/server/reporting-logic");

			const drifter = await addMember(seeded.clubId, "Drifting Member");
			// Members are scored from `joined_at ?? created_at`, and these fixtures
			// backdate meetings — an ordering production never produces. Backdate
			// the member so the window is eligible for them at all.
			await testDb
				.update(members)
				.set({ createdAt: new Date(Date.now() - 400 * DAY) })
				.where(eq(members.id, drifter.memberId));
			// Three held meetings where somebody took the register and the drifter
			// is not on it — an absence each.
			for (const daysAgo of [7, 14, 21]) {
				const past = await addMeeting(seeded.clubId, daysAgo);
				await testDb.insert(meetingAttendance).values({
					meetingId: past,
					memberId: seeded.memberId,
					status: "present",
				});
			}
			// …and they are booked for next week, which must NOT rescue the streak.
			const next = await addUpcomingMeeting(seeded.clubId, 6);
			await addSlot({
				meetingId: next.meetingId,
				roleDefinitionId: seeded.roleDefinitionId,
				memberId: drifter.memberId,
			});

			const rows = await loadAttendanceLapse(seeded.clubId);
			const row = rows.find((r) => r.memberId === drifter.memberId);
			expect(row?.streak).toBe(3);
			expect(row?.isLapsed).toBe(true);
			// The row shape is the lapse row's own — no upcoming marker leaked in.
			expect(row && "upcomingRoleAt" in row).toBe(false);
		});
	});
});

describe.skipIf(!hasTestDb)("Close to a level (#898)", () => {
	let seeded: SeededClub;
	let speakerRoleId: string;
	// `pathways_paths` is CLUB-LESS, so `cleanup` cannot reach it: this suite
	// deletes the ones it made (projects, levels, enrollments and marks cascade).
	const createdPathIds: string[] = [];

	beforeEach(async () => {
		seeded = await seedClub();
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
		if (createdPathIds.length > 0) {
			await testDb
				.delete(pathwaysPaths)
				.where(inArray(pathwaysPaths.id, createdPathIds));
			createdPathIds.length = 0;
		}
	});

	it("loadUpcomingSpeakerSlots returns the soonest future SPEAKER slot only", async () => {
		const { loadUpcomingSpeakerSlots } = await import(
			"#/server/reporting-logic"
		);
		const ana = await addMember(seeded.clubId, "Ana Speaker");
		const tim = await addMember(seeded.clubId, "Tim Timer");
		const cal = await addMember(seeded.clubId, "Cal Cancelled");
		const ope = await addMember(seeded.clubId, "Opal Open");
		const pat = await addMember(seeded.clubId, "Pat Past");

		const in1 = await addUpcomingMeeting(seeded.clubId, 1);
		const in2 = await addUpcomingMeeting(seeded.clubId, 2, "cancelled");
		const in5 = await addUpcomingMeeting(seeded.clubId, 5);
		const in10 = await addUpcomingMeeting(seeded.clubId, 10);
		const past = await addMeeting(seeded.clubId, 3);

		// Ana: a Timer slot sooner than either speaker slot must not win.
		await addSlot({
			meetingId: in1.meetingId,
			roleDefinitionId: seeded.roleDefinitionId,
			memberId: ana.memberId,
		});
		await addSlot({
			meetingId: in10.meetingId,
			roleDefinitionId: speakerRoleId,
			memberId: ana.memberId,
		});
		await addSlot({
			meetingId: in5.meetingId,
			roleDefinitionId: speakerRoleId,
			memberId: ana.memberId,
			status: "claimed",
		});
		// Each of these is the only thing its member holds.
		await addSlot({
			meetingId: in5.meetingId,
			roleDefinitionId: seeded.roleDefinitionId,
			memberId: tim.memberId,
		});
		await addSlot({
			meetingId: in2.meetingId,
			roleDefinitionId: speakerRoleId,
			memberId: cal.memberId,
		});
		await addSlot({
			meetingId: in10.meetingId,
			roleDefinitionId: speakerRoleId,
			memberId: ope.memberId,
			status: "open",
		});
		await addSlot({
			meetingId: past,
			roleDefinitionId: speakerRoleId,
			memberId: pat.memberId,
		});

		const slots = await loadUpcomingSpeakerSlots(seeded.clubId);
		expect(slots.get(ana.memberId)).toEqual(in5.scheduledAt);
		expect(slots.has(tim.memberId)).toBe(false);
		expect(slots.has(cal.memberId)).toBe(false);
		expect(slots.has(ope.memberId)).toBe(false);
		expect(slots.has(pat.memberId)).toBe(false);
	});

	it("loadLevelProximity selects close and awaiting rows for active members, with the club's timezone", async () => {
		const { loadLevelProximity } = await import("#/server/reporting-logic");
		await testDb
			.update(clubs)
			.set({ timezone: "America/Los_Angeles" })
			.where(eq(clubs.id, seeded.clubId));

		const tag = randomUUID().slice(0, 8);
		const [path] = await testDb
			.insert(pathwaysPaths)
			.values({ courseCode: `898-${tag}`, name: `Proximity Path ${tag}` })
			.returning({ id: pathwaysPaths.id });
		if (!path) throw new Error("path insert failed");
		createdPathIds.push(path.id);

		const projects = await testDb
			.insert(pathwaysProjects)
			.values([
				{ pathId: path.id, level: 1, name: "L1 A", isRequired: true },
				{ pathId: path.id, level: 1, name: "L1 B", isRequired: true },
				{ pathId: path.id, level: 1, name: "L1 C", isRequired: true },
				{ pathId: path.id, level: 2, name: "L2 Required", isRequired: true },
				{ pathId: path.id, level: 2, name: "L2 Elective X", isRequired: false },
				{ pathId: path.id, level: 2, name: "L2 Elective Y", isRequired: false },
			])
			.returning({
				id: pathwaysProjects.id,
				level: pathwaysProjects.level,
			});
		await testDb.insert(pathwaysPathLevels).values([
			{ pathId: path.id, level: 1, minReqElectives: 0 },
			{ pathId: path.id, level: 2, minReqElectives: 1 },
		]);
		const level1Ids = projects.filter((p) => p.level === 1).map((p) => p.id);

		async function enroll(personId: string) {
			const [enr] = await testDb
				.insert(pathEnrollments)
				.values({ personId, pathId: path?.id as string })
				.returning({ id: pathEnrollments.id });
			if (!enr) throw new Error("enrollment insert failed");
			return enr.id;
		}
		async function markLevel1(enrollmentId: string) {
			await testDb
				.insert(projectCompletionMarks)
				.values(level1Ids.map((projectId) => ({ enrollmentId, projectId })));
		}

		// Maya: catalog branch, Level 1 fully marked → Level 2, 2 left.
		const maya = await addMember(seeded.clubId, "Maya Close");
		await markLevel1(await enroll(maya.personId));
		const speaking = await addUpcomingMeeting(seeded.clubId, 4);
		await addSlot({
			meetingId: speaking.meetingId,
			roleDefinitionId: speakerRoleId,
			memberId: maya.memberId,
		});

		// Ina: the same progress, but not an active member.
		const ina = await addMember(seeded.clubId, "Ina Inactive");
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, ina.memberId));
		await markLevel1(await enroll(ina.personId));

		// Fay: declared, nothing marked → Level 1 with 3 left. Not close.
		const fay = await addMember(seeded.clubId, "Fay Far");
		await enroll(fay.personId);

		// Bo: Base Camp says Level 1 done but unapproved, Level 2 one short.
		const bo = await addMember(seeded.clubId, "Bo Basecamp");
		const boEnrollment = await enroll(bo.personId);
		await testDb.insert(pathLevelProgress).values([
			{
				enrollmentId: boEnrollment,
				level: 1,
				completed: 3,
				total: 3,
				approved: false,
			},
			{
				enrollmentId: boEnrollment,
				level: 2,
				completed: 1,
				total: 2,
				approved: false,
			},
		]);

		const result = await loadLevelProximity(seeded.clubId);
		expect(result.timezone).toBe("America/Los_Angeles");
		expect(
			result.rows.map((r) => [r.name, r.kind, r.level, r.projectsLeft]),
		).toEqual([
			["Bo Basecamp", "awaiting_approval", 1, 0],
			["Bo Basecamp", "close", 2, 1],
			["Maya Close", "close", 2, 2],
		]);
		const mayaRow = result.rows.find((r) => r.name === "Maya Close");
		expect(mayaRow).toMatchObject({
			pathName: `Proximity Path ${tag}`,
			projectNames: ["L2 Required"],
			electivesToChoose: 1,
			upcomingSpeakerAt: speaking.scheduledAt,
		});
		// Base Camp's summary alone names nothing (#456); the count still shows.
		expect(
			result.rows.find((r) => r.name === "Bo Basecamp" && r.kind === "close")
				?.projectNames,
		).toEqual([]);
	});
});
