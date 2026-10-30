import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingAttendance,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadMilestoneCounts } = await import("./milestones-logic");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe.skipIf(!hasTestDb)("loadMilestoneCounts", () => {
	let club: SeededClub;
	let speakerRoleId: string;
	beforeEach(async () => {
		club = await seedClub();
		const [r] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		speakerRoleId = r.id;
	});
	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	async function speakerSlot(opts: {
		at: Date;
		status?: "completed" | "scheduled" | "cancelled";
		memberId?: string | null;
		guestOwned?: boolean;
		withSpeech?: boolean;
		roleId?: string;
	}) {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: club.clubId,
				scheduledAt: opts.at,
				status: opts.status ?? "completed",
			})
			.returning({ id: meetings.id });
		let speechId: string | null = null;
		if (opts.withSpeech !== false) {
			const [s] = await testDb
				.insert(speeches)
				.values({ personId: club.personId, title: `S ${randomUUID()}` })
				.returning({ id: speeches.id });
			speechId = s.id;
		}
		await testDb.insert(roleSlots).values({
			meetingId: m.id,
			roleDefinitionId: opts.roleId ?? speakerRoleId,
			assignedMemberId:
				opts.memberId === undefined ? club.memberId : opts.memberId,
			speechId,
			status: "confirmed",
		});
		return m.id;
	}

	// protects=a delivered speech counts; fails_when=an ended meeting with a speech reads 0; no_claim=attendance
	it("counts a speech at a meeting that ended yesterday", async () => {
		await speakerSlot({ at: new Date(Date.now() - DAY) });
		expect((await loadMilestoneCounts(club.memberId)).speechesDelivered).toBe(
			1,
		);
	});

	// protects=a cancelled meeting's speech is never counted; fails_when=cancelled counts; no_claim=other statuses
	it("ignores a cancelled meeting", async () => {
		await speakerSlot({ at: new Date(Date.now() - DAY), status: "cancelled" });
		expect((await loadMilestoneCounts(club.memberId)).speechesDelivered).toBe(
			0,
		);
	});

	// protects=a meeting still running or in the future does not count; fails_when=start-time-only comparison counts a meeting in progress; no_claim=timezone
	it("ignores a future meeting and one still in progress", async () => {
		await speakerSlot({ at: new Date(Date.now() + DAY), status: "scheduled" });
		// Started 10 minutes ago, 90 minute default length: not over.
		await speakerSlot({
			at: new Date(Date.now() - 10 * 60_000),
			status: "scheduled",
		});
		expect((await loadMilestoneCounts(club.memberId)).speechesDelivered).toBe(
			0,
		);
	});

	// protects=only THIS member's slots count; fails_when=another member's slot or a guest's slot counts; no_claim=attendance
	it("does not count another member's or a guest's slot", async () => {
		const [p] = await testDb
			.insert(people)
			.values({ name: "Other", email: `${randomUUID()}@test.example` })
			.returning({ id: people.id });
		const [other] = await testDb
			.insert(members)
			.values({
				clubId: club.clubId,
				personId: p.id,
				name: "Other",
				clubRole: "member",
				status: "active",
			})
			.returning({ id: members.id });
		await speakerSlot({ at: new Date(Date.now() - DAY), memberId: other.id });
		// Guest-held slot: no assigned member at all.
		await speakerSlot({ at: new Date(Date.now() - 2 * DAY), memberId: null });
		expect((await loadMilestoneCounts(club.memberId)).speechesDelivered).toBe(
			0,
		);
		expect((await loadMilestoneCounts(other.id)).speechesDelivered).toBe(1);
	});

	// protects=a speaker slot with no speech attached (TBA) is not a delivered speech; fails_when=TBA counts; no_claim=none
	it("ignores a speaker slot with no speech", async () => {
		await speakerSlot({ at: new Date(Date.now() - DAY), withSpeech: false });
		expect((await loadMilestoneCounts(club.memberId)).speechesDelivered).toBe(
			0,
		);
	});

	// protects=only SPEAKER-role slots count; fails_when=a non-speaker slot carrying a speech_id counts; no_claim=whether that state is reachable in the UI
	it("ignores a non-speaker slot even when it carries a speech", async () => {
		const [r] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: club.clubId,
				name: "Timer",
				category: "functionary",
				isSpeakerRole: false,
			})
			.returning({ id: roleDefinitions.id });
		await speakerSlot({ at: new Date(Date.now() - DAY), roleId: r.id });
		expect((await loadMilestoneCounts(club.memberId)).speechesDelivered).toBe(
			0,
		);
	});

	// protects=meetingsAttended counts only this member's present rows; fails_when=absent rows or another member's rows count; no_claim=speeches
	it("counts only this member's present attendance", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const [m] = await testDb
				.insert(meetings)
				.values({
					clubId: club.clubId,
					scheduledAt: new Date(Date.now() - (i + 1) * DAY),
					status: "completed",
				})
				.returning({ id: meetings.id });
			ids.push(m.id);
		}
		await testDb.insert(meetingAttendance).values([
			{ meetingId: ids[0], memberId: club.memberId, status: "present" },
			{ meetingId: ids[1], memberId: club.memberId, status: "absent" },
			{ meetingId: ids[2], memberId: club.adminMemberId, status: "present" },
		]);
		expect((await loadMilestoneCounts(club.memberId)).meetingsAttended).toBe(1);
	});
});
