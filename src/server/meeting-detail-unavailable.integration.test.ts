/**
 * DB-backed test that the REAL `getMeeting` loader feeds `unavailableMembers`
 * from the roll-wins-over-plan helper (#1257). Mocked the way
 * `meeting-detail-evaluates.integration.test.ts` does it.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingAttendance, meetingAttendancePlan, user } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
		handler:
			(handle: (input: { data: unknown }) => unknown) =>
			({ data }: { data: unknown }) =>
				handle({ data }),
	}),
}));

let sessionUserId: string | null = null;
const request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const { getMeeting } = await import("#/server/meetings");

let seeded: SeededClub | null = null;
afterEach(async () => {
	sessionUserId = null;
	if (seeded) {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		seeded = null;
	}
});

/** Plan rows (the member's own answer) and roll rows (the record). */
async function setup(s: SeededClub) {
	// memberId: plan Coming, roll Absent. adminMemberId: plan Not coming, roll Present.
	await testDb.insert(meetingAttendancePlan).values([
		{ memberId: s.memberId, meetingId: s.meetingId, status: "coming" },
		{ memberId: s.adminMemberId, meetingId: s.meetingId, status: "not_coming" },
	]);
	await testDb.insert(meetingAttendance).values([
		{ memberId: s.memberId, meetingId: s.meetingId, status: "absent" },
		{ memberId: s.adminMemberId, meetingId: s.meetingId, status: "present" },
	]);
}

async function unavailableIds(s: SeededClub) {
	const detail = await getMeeting({ data: s.meetingId });
	return detail.unavailableMembers.map((m) => m.id);
}

describe.skipIf(!hasTestDb)("getMeeting: unavailableMembers (#1257)", () => {
	it("a signed-in member gets the roll-wins rule: Absent in, Present out", async () => {
		// protects=members see the roll-aware list the pickers need; fails_when=the member branch reads the plan only; no_claim=the session is faked at the auth boundary, the rows are real
		const s = await seedClub();
		seeded = s;
		sessionUserId = s.memberUserId;
		await setup(s);
		const ids = await unavailableIds(s);
		expect(ids).toContain(s.memberId);
		expect(ids).not.toContain(s.adminMemberId);
	});

	it("an admin gets the roll-wins rule too", async () => {
		// protects=the admin (canManage) arm of the gate; fails_when=the gate demands a plain membership lookup only and an admin is treated as public; no_claim=the session is faked at the auth boundary
		const s = await seedClub();
		seeded = s;
		sessionUserId = s.adminUserId;
		await setup(s);
		const ids = await unavailableIds(s);
		expect(ids).toContain(s.memberId);
		expect(ids).not.toContain(s.adminMemberId);
	});

	it("signed out gets the plan-only list: an Absent member is not leaked, a Present one still shows as Not coming", async () => {
		// protects=the public payload reveals nothing of the members-only roll; fails_when=the loader hands the roll-aware list to a signed-out reader; no_claim=the session is faked at the auth boundary
		const s = await seedClub();
		seeded = s;
		sessionUserId = null;
		await setup(s);
		const ids = await unavailableIds(s);
		expect(ids).not.toContain(s.memberId);
		expect(ids).toContain(s.adminMemberId);
	});

	it("a signed-in NON-member of the club gets the same plan-only list", async () => {
		// protects=holding a session is not the gate, membership of THIS club is; fails_when=the gate checks only that a user is signed in; no_claim=the session is faked at the auth boundary
		const s = await seedClub();
		seeded = s;
		const outsiderId = randomUUID();
		await testDb.insert(user).values({
			id: outsiderId,
			name: "Outsider",
			email: `outsider-${outsiderId}@test.example`,
			emailVerified: true,
		});
		try {
			sessionUserId = outsiderId;
			await setup(s);
			const ids = await unavailableIds(s);
			expect(ids).not.toContain(s.memberId);
			expect(ids).toContain(s.adminMemberId);
		} finally {
			await testDb.delete(user).where(eq(user.id, outsiderId));
		}
	});
});
