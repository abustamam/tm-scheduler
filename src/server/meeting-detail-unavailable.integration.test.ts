/**
 * DB-backed test that the REAL `getMeeting` loader feeds `unavailableMembers`
 * from the roll-wins-over-plan helper (#1257). Mocked the way
 * `meeting-detail-evaluates.integration.test.ts` does it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingAttendance } from "#/db/schema";
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

describe.skipIf(!hasTestDb)("getMeeting: unavailableMembers (#1257)", () => {
	it("carries a member recorded Absent, and not one recorded Present", async () => {
		// protects=the loader field the pickers read includes Absent members; fails_when=the loader still calls the plan-only helper; no_claim=the session is faked at the auth boundary, the rows are real
		const s = await seedClub();
		seeded = s;
		sessionUserId = s.adminUserId;
		await testDb.insert(meetingAttendance).values([
			{ memberId: s.memberId, meetingId: s.meetingId, status: "absent" },
			{ memberId: s.adminMemberId, meetingId: s.meetingId, status: "present" },
		]);
		const detail = await getMeeting({ data: s.meetingId });
		const ids = detail.unavailableMembers.map((m) => m.id);
		expect(ids).toContain(s.memberId);
		expect(ids).not.toContain(s.adminMemberId);
	});
});
