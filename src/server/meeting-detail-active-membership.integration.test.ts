/**
 * DB-backed tests that a membership which is not `active` counts as no
 * membership for the two reads `loadMeetingDetail` decides from it: the admin
 * payload (`canManage`) and the roll-aware unavailable list (`viewerIsMember`).
 *
 * Ending (`former`) or deactivating (`inactive`) a membership leaves its stored
 * `club_role` alone, so a row can say "admin" for someone who no longer is. The
 * seed here puts the viewer in exactly that state by writing the status column
 * and nothing else.
 *
 * `getMeeting` is called through the real server fn with `createServerFn`,
 * the session and the request mocked, the way
 * `meeting-detail-unavailable.integration.test.ts` does.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	impersonationSessions,
	meetingAttendance,
	meetingAttendancePlan,
	members,
	people,
	roleSlots,
	user,
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
const { canManageClub } = await import("#/server/guards");

type NotActive = "inactive" | "former";
const NOT_ACTIVE: NotActive[] = ["inactive", "former"];

let seeded: SeededClub | null = null;
afterEach(async () => {
	sessionUserId = null;
	if (!seeded) return;
	await testDb
		.delete(impersonationSessions)
		.where(eq(impersonationSessions.clubId, seeded.clubId));
	await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	seeded = null;
});

/** Change only the status column, as ending or deactivating a membership does. */
async function setStatus(memberId: string, status: "active" | NotActive) {
	await testDb
		.update(members)
		.set({
			status,
			endedAt: status === "former" ? "2026-01-01" : null,
		})
		.where(eq(members.id, memberId));
}

async function seed(): Promise<SeededClub> {
	const s = await seedClub();
	seeded = s;
	return s;
}

describe.skipIf(!hasTestDb)(
	"meeting detail: a membership that is not active grants no admin read",
	() => {
		/** Everything `canManage` unlocks, plus the data it is meant to withhold. */
		async function seedAdminPayload(s: SeededClub) {
			// The slot holder's contact details (`loadHolderContacts`).
			await testDb
				.update(people)
				.set({ email: `holder-${s.memberId}@test.example`, phone: "5550100" })
				.where(eq(people.id, s.personId));
			await testDb
				.update(roleSlots)
				.set({
					assignedMemberId: s.memberId,
					status: "claimed",
					claimedAt: new Date(),
				})
				.where(eq(roleSlots.id, s.slotId));
			// The officer's private record of having asked (`reached_out`) and a
			// member's own answer, both in the plan ladder.
			const other = await seedPerson({ name: "Ladder Member" });
			const [ladder] = await testDb
				.insert(members)
				.values({ clubId: s.clubId, personId: other, name: "Ladder Member" })
				.returning({ id: members.id });
			await testDb.insert(meetingAttendancePlan).values([
				{ memberId: s.memberId, meetingId: s.meetingId, status: "reached_out" },
				{
					memberId: ladder?.id ?? "",
					meetingId: s.meetingId,
					status: "coming",
				},
			]);
		}

		async function adminView(s: SeededClub) {
			sessionUserId = s.adminUserId;
			const detail = await getMeeting({ data: s.meetingId });
			const held = detail.slots.find((slot) => slot.id === s.slotId);
			return {
				canManage: detail.canManage,
				rosterRows: detail.roster.length,
				rosterWithEmail: detail.roster.filter((r) => r.email).length,
				holderEmail: held?.holderEmail ?? null,
				ladderRows: detail.plan.length,
				reachedOut: detail.plan.filter((r) => r.status === "reached_out")
					.length,
			};
		}

		it("an active admin gets the admin payload, unchanged", async () => {
			const s = await seed();
			await seedAdminPayload(s);
			const view = await adminView(s);
			expect(await canManageClub(s.adminUserId, s.clubId)).toBe(true);
			expect(view.canManage).toBe(true);
			expect(view.rosterRows).toBeGreaterThan(0);
			expect(view.holderEmail).toBe(`holder-${s.memberId}@test.example`);
			expect(view.ladderRows).toBe(2);
			expect(view.reachedOut).toBe(1);
		});

		it.each(
			NOT_ACTIVE,
		)("a %s admin gets no canManage, no roster, no contact details and an empty plan ladder", async (status) => {
			// protects=a membership that is not active grants no admin read; fails_when=canManageClub (or the payload) reads clubRole without the active test; no_claim=impersonation is covered by the case below
			const s = await seed();
			await seedAdminPayload(s);
			await setStatus(s.adminMemberId, status);
			// The stored role is untouched: that is the state under test.
			const [row] = await testDb
				.select({ clubRole: members.clubRole, status: members.status })
				.from(members)
				.where(eq(members.id, s.adminMemberId));
			expect(row).toEqual({ clubRole: "admin", status });

			expect(await canManageClub(s.adminUserId, s.clubId)).toBe(false);
			expect(await adminView(s)).toEqual({
				canManage: false,
				rosterRows: 0,
				rosterWithEmail: 0,
				holderEmail: null,
				ladderRows: 0,
				reachedOut: 0,
			});
		});

		it("an admin who becomes active again gets the payload back", async () => {
			const s = await seed();
			await seedAdminPayload(s);
			await setStatus(s.adminMemberId, "inactive");
			expect((await adminView(s)).canManage).toBe(false);
			await setStatus(s.adminMemberId, "active");
			expect((await adminView(s)).canManage).toBe(true);
		});

		it("a signed-out reader still gets no admin payload", async () => {
			const s = await seed();
			await seedAdminPayload(s);
			sessionUserId = null;
			const detail = await getMeeting({ data: s.meetingId });
			expect(detail.canManage).toBe(false);
			expect(detail.roster).toEqual([]);
			expect(detail.plan).toEqual([]);
		});

		it.each(
			NOT_ACTIVE,
		)("a read_write impersonation still grants canManage to a superadmin whose own membership is %s", async (status) => {
			// protects=the impersonation arm survives the active test (a non-active membership falls through to it); fails_when=the status check returns false instead of falling through; no_claim=none
			const s = await seed();
			await testDb
				.update(user)
				.set({ isSuperadmin: true })
				.where(eq(user.id, s.adminUserId));
			await setStatus(s.adminMemberId, status);
			expect(await canManageClub(s.adminUserId, s.clubId)).toBe(false);

			await testDb.insert(impersonationSessions).values({
				superadminUserId: s.adminUserId,
				clubId: s.clubId,
				mode: "read_only",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			});
			// read_only never grants.
			expect(await canManageClub(s.adminUserId, s.clubId)).toBe(false);

			await testDb
				.delete(impersonationSessions)
				.where(eq(impersonationSessions.superadminUserId, s.adminUserId));
			await testDb.insert(impersonationSessions).values({
				superadminUserId: s.adminUserId,
				clubId: s.clubId,
				mode: "read_write",
				reason: "test",
				expiresAt: new Date(Date.now() + 15 * 60 * 1000),
			});
			expect(await canManageClub(s.adminUserId, s.clubId)).toBe(true);
			sessionUserId = s.adminUserId;
			expect((await getMeeting({ data: s.meetingId })).canManage).toBe(true);
		});
	},
);

describe.skipIf(!hasTestDb)(
	"meeting detail: the roll-aware unavailable list is for active members",
	() => {
		/**
		 * `rollAbsent`: plan Coming, roll Absent. Only the roll-aware reading lists them.
		 * `notComingPresent`: plan Not coming, roll Present. Only the plan-only
		 * reading lists them.
		 */
		async function seedRoll(s: SeededClub) {
			const personId = await seedPerson({ name: "Not Coming Present" });
			const [third] = await testDb
				.insert(members)
				.values({ clubId: s.clubId, personId, name: "Not Coming Present" })
				.returning({ id: members.id });
			const notComingPresent = third?.id ?? "";
			const rollAbsent = s.adminMemberId;
			await testDb.insert(meetingAttendancePlan).values([
				{ memberId: rollAbsent, meetingId: s.meetingId, status: "coming" },
				{
					memberId: notComingPresent,
					meetingId: s.meetingId,
					status: "not_coming",
				},
			]);
			await testDb.insert(meetingAttendance).values([
				{ memberId: rollAbsent, meetingId: s.meetingId, status: "absent" },
				{
					memberId: notComingPresent,
					meetingId: s.meetingId,
					status: "present",
				},
			]);
			return { rollAbsent, notComingPresent };
		}

		async function unavailableFor(s: SeededClub, userId: string | null) {
			sessionUserId = userId;
			return (await getMeeting({ data: s.meetingId })).unavailableMembers
				.map((m) => m.id)
				.sort();
		}

		it("an active member gets the roll-aware list: Absent is in, Present-after-Not-coming is out", async () => {
			const s = await seed();
			const { rollAbsent, notComingPresent } = await seedRoll(s);
			const ids = await unavailableFor(s, s.memberUserId);
			expect(ids).toContain(rollAbsent);
			expect(ids).not.toContain(notComingPresent);
		});

		it.each(
			NOT_ACTIVE,
		)("a %s member gets the plan-only list, the same one a signed-out reader gets", async (status) => {
			// protects=only an active membership reads the members-only roll; fails_when=viewerIsMember is true for any membership row; no_claim=the roll is members-only, the plan is public (answeredRungs)
			const s = await seed();
			const { rollAbsent, notComingPresent } = await seedRoll(s);
			await setStatus(s.memberId, status);
			const ids = await unavailableFor(s, s.memberUserId);
			expect(ids).toContain(notComingPresent);
			expect(ids).not.toContain(rollAbsent);
			expect(ids).toEqual(await unavailableFor(s, null));
		});

		it.each(
			NOT_ACTIVE,
		)("a %s admin gets the plan-only list as well", async (status) => {
			const s = await seed();
			const { rollAbsent, notComingPresent } = await seedRoll(s);
			await setStatus(s.adminMemberId, status);
			const ids = await unavailableFor(s, s.adminUserId);
			expect(ids).toContain(notComingPresent);
			expect(ids).not.toContain(rollAbsent);
		});

		it("an active admin gets the roll-aware list (canManage implies a member)", async () => {
			const s = await seed();
			const { rollAbsent, notComingPresent } = await seedRoll(s);
			const ids = await unavailableFor(s, s.adminUserId);
			expect(ids).toContain(rollAbsent);
			expect(ids).not.toContain(notComingPresent);
		});

		it("a viewer with no membership in the club gets the plan-only list", async () => {
			const s = await seed();
			const { rollAbsent, notComingPresent } = await seedRoll(s);
			const strangerId = randomUUID();
			await testDb.insert(user).values({
				id: strangerId,
				name: "Stranger",
				email: `stranger-${strangerId}@test.example`,
				emailVerified: true,
			});
			try {
				const ids = await unavailableFor(s, strangerId);
				expect(ids).toContain(notComingPresent);
				expect(ids).not.toContain(rollAbsent);
			} finally {
				sessionUserId = null;
				await testDb.delete(user).where(eq(user.id, strangerId));
			}
		});
	},
);
