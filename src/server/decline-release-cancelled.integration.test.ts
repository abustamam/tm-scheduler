/**
 * `releaseSlotsAndMarkUnavailable` on a cancelled meeting (#1057, review of
 * #1084 H).
 *
 * The releasing decline frees every role a member holds and then records
 * `not_coming`, in one transaction. On a cancelled meeting that would drop the
 * member's roles (and unlink a speaker's speech) for a meeting whose
 * assignments are meant to survive until a restore. It is refused by the plan
 * seam it writes through (`setPlanStatus`, which refuses a cancelled meeting),
 * and the throw rolls the slot release back with it — this suite holds that
 * the release does not land on its own.
 *
 * The seam resolves its actor from the SESSION (`resolveActor`, ADR-0026), so
 * the cookie → session lookup is faked at the library boundary exactly as
 * `availability.integration.test.ts` does, and nothing else is.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingAttendancePlan,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

let sessionUserId: string | null = null;
/** Fresh per test: the impersonation marker is keyed on this object. */
let request = { headers: new Headers() };
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

const { releaseSlotsAndMarkUnavailable } = await import("./availability-logic");

describe.skipIf(!hasTestDb)(
	"a releasing decline on a cancelled meeting (#1057)",
	() => {
		let seed: SeededClub;
		let speakerSlotId: string;
		let speechId: string;

		beforeEach(async () => {
			request = { headers: new Headers() };
			seed = await seedClub();
			// The MEMBER holds a speaker slot with a linked speech, and declines
			// for themselves from their own session.
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			const [me] = await testDb
				.select({ personId: members.personId })
				.from(members)
				.where(eq(members.id, seed.memberId));
			if (!def || !me) throw new Error("Failed to seed the speaker role");
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: me.personId, title: "Ice Breaker" })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("Failed to seed the speech");
			speechId = speech.id;
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: seed.meetingId,
					roleDefinitionId: def.id,
					status: "claimed",
					assignedMemberId: seed.memberId,
					speechId,
				})
				.returning({ id: roleSlots.id });
			if (!slot) throw new Error("Failed to seed the speaker slot");
			speakerSlotId = slot.id;
			sessionUserId = seed.memberUserId;
		});

		afterEach(async () => {
			sessionUserId = null;
			await testDb.delete(speeches).where(eq(speeches.id, speechId));
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		async function speakerSlot() {
			const [row] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
					speechId: roleSlots.speechId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, speakerSlotId));
			return row;
		}

		async function planRow() {
			return testDb
				.select({ status: meetingAttendancePlan.status })
				.from(meetingAttendancePlan)
				.where(
					and(
						eq(meetingAttendancePlan.meetingId, seed.meetingId),
						eq(meetingAttendancePlan.memberId, seed.memberId),
					),
				);
		}

		it("is refused, and the holder and the speech are both kept", async () => {
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seed.meetingId));
			await expect(
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: seed.memberId,
					meetingId: seed.meetingId,
					clubId: seed.clubId,
				}),
			).rejects.toThrow(MEETING_CANCELLED_MESSAGE);
			expect(await speakerSlot()).toEqual({
				status: "claimed",
				assignedMemberId: seed.memberId,
				speechId,
			});
			expect(await planRow()).toEqual([]);
		});

		it("the control: on the scheduled meeting the same decline releases the role", async () => {
			const { released } = await releaseSlotsAndMarkUnavailable(testDb, {
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
			expect(released).toBeGreaterThanOrEqual(1);
			expect(await speakerSlot()).toEqual({
				status: "open",
				assignedMemberId: null,
				speechId: null,
			});
			expect(await planRow()).toEqual([{ status: "not_coming" }]);
		});
	},
);
