/**
 * #1442 AC 2, the two-role case, through the real server path the SIGNED-IN rsvp
 * page reaches: `declinePlannedAttendance` (the seam `setPlannedAttendance`
 * calls for `not_coming`) with `releaseHeldRoles: true` and a session bound to
 * the member.
 *
 * Covers: a member holding two roles on one meeting taps "Can't make it" and
 * ends with BOTH slots open, the plan `not_coming`, and two `dropped`
 * cover-request rows. Also the signed-out arm (ADR-0026): the same call with no
 * session is refused and changes nothing.
 * Does NOT cover: the page's own refusal to send that call signed out (the
 * rsvp route test), the per-gate matrix (`attendance-decline.integration.test.ts`).
 *
 *   TEST_DATABASE_URL=… bunx vitest run src/server/rsvp-two-roles-decline.integration.test.ts
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingAttendancePlan,
	meetings,
	roleDefinitions,
	roleSlots,
	slotCoverRequests,
} from "#/db/schema";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

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

const { declinePlannedAttendance } = await import("./attendance-decline-logic");

describe.skipIf(!hasTestDb)(
	"rsvp: Can't make it with two roles (#1442)",
	() => {
		let seed: SeededClub;
		let secondSlotId: string;

		beforeEach(async () => {
			seed = await seedClub();
			sessionUserId = null;
			// Under 48h away, so each freed slot leaves a `dropped` request.
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() + 24 * 3_600_000) })
				.where(eq(meetings.id, seed.meetingId));
			await testDb
				.update(roleSlots)
				.set({
					assignedMemberId: seed.memberId,
					status: "claimed",
					claimedAt: new Date(),
				})
				.where(eq(roleSlots.id, seed.slotId));
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Timer",
					key: null,
					category: "leadership",
					isSpeakerRole: false,
					sortOrder: 2,
				})
				.returning({ id: roleDefinitions.id });
			if (!def) throw new Error("Failed to insert role definition");
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: seed.meetingId,
					roleDefinitionId: def.id,
					status: "claimed",
					assignedMemberId: seed.memberId,
					claimedAt: new Date(),
				})
				.returning({ id: roleSlots.id });
			if (!slot) throw new Error("Failed to insert role slot");
			secondSlotId = slot.id;
		});

		afterEach(async () => {
			sessionUserId = null;
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		async function slots() {
			return testDb
				.select({
					id: roleSlots.id,
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, seed.meetingId));
		}

		async function plan() {
			return testDb
				.select({ status: meetingAttendancePlan.status })
				.from(meetingAttendancePlan)
				.where(
					and(
						eq(meetingAttendancePlan.memberId, seed.memberId),
						eq(meetingAttendancePlan.meetingId, seed.meetingId),
					),
				);
		}

		async function covers() {
			return testDb
				.select({
					slotId: slotCoverRequests.slotId,
					kind: slotCoverRequests.kind,
					releasedByMemberId: slotCoverRequests.releasedByMemberId,
				})
				.from(slotCoverRequests)
				.where(eq(slotCoverRequests.meetingId, seed.meetingId));
		}

		const decline = () =>
			declinePlannedAttendance(testDb, {
				memberId: seed.memberId,
				claimedActorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
				releaseHeldRoles: true,
			});

		it("signed in: both slots open, plan not_coming, two dropped rows", async () => {
			// protects=AC 2's two-role case, as one outcome rather than three facts
			// fails_when=only the first slot is freed, the plan is not written with the
			//   release, or a freed slot leaves no `dropped` request
			sessionUserId = seed.memberUserId;
			await decline();

			const held = await slots();
			expect(held).toHaveLength(2);
			for (const s of held) {
				expect(s.status).toBe("open");
				expect(s.assignedMemberId).toBeNull();
			}
			expect(await plan()).toEqual([{ status: "not_coming" }]);
			const rows = await covers();
			expect(rows.map((r) => r.slotId).sort()).toEqual(
				[seed.slotId, secondSlotId].sort(),
			);
			for (const r of rows) {
				expect(r.kind).toBe("dropped");
				expect(r.releasedByMemberId).toBe(seed.memberId);
			}
		});

		it("signed out: refused, slots, plan and cover rows unchanged", async () => {
			// protects=ADR-0026 on the rsvp page's behalf: a session-less release is
			//   refused at the seam, not only by the page declining to send it
			// fails_when=the proof gate is removed from the release
			await expect(decline()).rejects.toThrow(SIGN_IN_REQUIRED_MESSAGE);

			const held = await slots();
			expect(held.every((s) => s.status === "claimed")).toBe(true);
			expect(held.every((s) => s.assignedMemberId === seed.memberId)).toBe(
				true,
			);
			expect(await plan()).toEqual([]);
			expect(await covers()).toEqual([]);
		});
	},
);
