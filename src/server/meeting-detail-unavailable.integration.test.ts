/**
 * DB-backed test that the REAL `getMeeting` loader feeds `unavailableMembers`
 * from the roll-wins-over-plan helper (#1257). Mocked the way
 * `meeting-detail-evaluates.integration.test.ts` does it.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	impersonationSessions,
	meetingAttendance,
	meetingAttendancePlan,
	user,
} from "#/db/schema";
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
		// protects=an admin's own active membership reads the roll-aware list; fails_when=an admin is treated as public; no_claim=this does NOT tell the canManage arm of the gate from the membership arm, because the seeded admin passes both (the impersonating-superadmin cases below do)
		const s = await seedClub();
		seeded = s;
		sessionUserId = s.adminUserId;
		await setup(s);
		const ids = await unavailableIds(s);
		expect(ids).toContain(s.memberId);
		expect(ids).not.toContain(s.adminMemberId);
	});

	describe("a superadmin impersonating the club: canManage with no membership", () => {
		// The only viewer for whom the gate's two arms disagree: `canManageClub`
		// is true (read_write) while `getMembership` finds no seat of their own,
		// so the membership arm alone would hand them the public list.
		async function superadminImpersonating(
			s: SeededClub,
			mode: "read_only" | "read_write",
		) {
			const id = randomUUID();
			await testDb.insert(user).values({
				id,
				name: "Superadmin",
				email: `superadmin-${id}@test.example`,
				emailVerified: true,
				isSuperadmin: true,
			});
			await testDb.insert(impersonationSessions).values({
				superadminUserId: id,
				clubId: s.clubId,
				mode,
				reason: mode === "read_write" ? "test" : null,
				expiresAt: new Date(Date.now() + 15 * 60 * 1000),
			});
			return id;
		}

		async function dropSuperadmin(id: string) {
			sessionUserId = null;
			await testDb
				.delete(impersonationSessions)
				.where(eq(impersonationSessions.superadminUserId, id));
			await testDb.delete(user).where(eq(user.id, id));
		}

		it("a read_write impersonator gets the roll-wins rule", async () => {
			// protects=the canManage arm of the gate, on its own: an impersonator with no membership of their own reads the roll-aware list (an admin does, so the list is not the public one); fails_when=the gate checks the viewer's own membership only, or `viewerIsMember` no longer starts from canManage; no_claim=the session is faked at the auth boundary; canManageClub's own impersonation arm is meeting-detail-active-membership.integration.test.ts
			const s = await seedClub();
			seeded = s;
			const id = await superadminImpersonating(s, "read_write");
			try {
				sessionUserId = id;
				await setup(s);
				const ids = await unavailableIds(s);
				expect(ids).toContain(s.memberId);
				expect(ids).not.toContain(s.adminMemberId);
			} finally {
				await dropSuperadmin(id);
			}
		});

		it("a read_only impersonator gets the plan-only list: no canManage, no membership", async () => {
			// protects=the other side of the same arm: viewing a club does not unlock its roll; fails_when=an impersonation session of any mode counts as membership; no_claim=the session is faked at the auth boundary
			const s = await seedClub();
			seeded = s;
			const id = await superadminImpersonating(s, "read_only");
			try {
				sessionUserId = id;
				await setup(s);
				const ids = await unavailableIds(s);
				expect(ids).not.toContain(s.memberId);
				expect(ids).toContain(s.adminMemberId);
			} finally {
				await dropSuperadmin(id);
			}
		});
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
