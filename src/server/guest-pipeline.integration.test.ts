/**
 * DB-backed integration tests for the VP-Membership guest pipeline (#208 /
 * ADR-0017): guest-book capture (create-or-find + attendance), derived visits,
 * manual stage transitions, and convert-to-member (Person dedup, membership
 * create, slot re-point, stage=joined, picker exclusion, activity log).
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the whole suite skips when
 * that env is unset.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	guests,
	meetingAttendance,
	meetings,
	members,
	people,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyConvertGuestToMember,
	applySetGuestStage,
	captureGuestVisit,
	loadGuestPipeline,
} = await import("#/server/guest-pipeline-logic");
const { applyAssignGuestToSlot, listClubGuests } = await import(
	"#/server/guests-logic"
);

/** Insert a second, sooner meeting so the next capture resolves against IT. */
async function seedSoonerMeeting(clubId: string, daysOut = 1): Promise<string> {
	const [m] = await testDb
		.insert(meetings)
		.values({
			clubId,
			scheduledAt: new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000),
			status: "scheduled",
		})
		.returning({ id: meetings.id });
	if (!m) throw new Error("Failed to seed meeting");
	return m.id;
}

async function attendanceForGuest(guestId: string) {
	return testDb
		.select({ meetingId: meetingAttendance.meetingId })
		.from(meetingAttendance)
		.where(eq(meetingAttendance.guestId, guestId));
}

describe.skipIf(!hasTestDb)("guest pipeline (#208)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	describe("capture (guest book)", () => {
		it("creates a prospect + an attendance row against the current meeting", async () => {
			const res = await captureGuestVisit({
				clubId: seed.clubId,
				name: "  Jamie Rivera  ",
				phone: "(555) 123-4567",
			});
			expect(res.created).toBe(true);
			expect(res.attendanceRecorded).toBe(true);
			expect(res.meetingId).toBe(seed.meetingId);

			const [g] = await testDb
				.select()
				.from(guests)
				.where(eq(guests.id, res.guestId))
				.limit(1);
			expect(g).toMatchObject({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				stage: "prospect",
				phone: "(555) 123-4567",
			});

			const att = await attendanceForGuest(res.guestId);
			expect(att).toHaveLength(1);
			expect(att[0]!.meetingId).toBe(seed.meetingId);
		});

		it("dedups by PHONE across formats — reuses the guest, adds a new visit", async () => {
			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie Rivera",
				phone: "555-123-4567",
			});
			// A sooner meeting becomes the nearest for the next visit.
			const m2 = await seedSoonerMeeting(seed.clubId);
			const second = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Jamie R.",
				phone: "(555) 123.4567",
			});

			expect(second.created).toBe(false);
			expect(second.guestId).toBe(first.guestId);
			expect(second.meetingId).toBe(m2);

			const clubGuests = await testDb
				.select()
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(clubGuests).toHaveLength(1);

			const att = await attendanceForGuest(first.guestId);
			expect(att.map((a) => a.meetingId).sort()).toEqual(
				[seed.meetingId, m2].sort(),
			);
		});

		it("dedups by EMAIL when phone differs; a total mismatch creates a new guest", async () => {
			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Pat Lee",
				email: "Pat@Example.com",
				phone: "555-000-1111",
			});
			const sameEmail = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Pat Lee",
				email: "pat@example.com", // case-insensitive match
				phone: "555-999-8888", // different phone
			});
			expect(sameEmail.created).toBe(false);
			expect(sameEmail.guestId).toBe(first.guestId);

			const fresh = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Someone Else",
				email: "else@example.com",
				phone: "555-222-3333",
			});
			expect(fresh.created).toBe(true);
			expect(fresh.guestId).not.toBe(first.guestId);
		});

		it("still creates the guest when the club has no resolvable meeting", async () => {
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seed.meetingId));

			const res = await captureGuestVisit({
				clubId: seed.clubId,
				name: "No Meeting Guest",
				phone: "555-444-5555",
			});
			expect(res.created).toBe(true);
			expect(res.meetingId).toBeNull();
			expect(res.attendanceRecorded).toBe(false);
			expect(await attendanceForGuest(res.guestId)).toHaveLength(0);
		});
	});

	describe("derived visits", () => {
		it("computes visitCount + firstVisitAt from attendance (no stored counter)", async () => {
			const first = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Repeat Visitor",
				phone: "555-777-8888",
			});
			await seedSoonerMeeting(seed.clubId);
			await captureGuestVisit({
				clubId: seed.clubId,
				name: "Repeat Visitor",
				phone: "555-777-8888",
			});

			const pipeline = await loadGuestPipeline(seed.clubId);
			const row = pipeline.find((g) => g.id === first.guestId);
			expect(row).toBeDefined();
			expect(row!.visitCount).toBe(2);
			expect(row!.firstVisitAt).toBeInstanceOf(Date);

			// A guest with no attendance derives zero visits / null first-visit.
			const [orphan] = await testDb
				.insert(guests)
				.values({ clubId: seed.clubId, name: "Never Attended" })
				.returning({ id: guests.id });
			const pipeline2 = await loadGuestPipeline(seed.clubId);
			const orphanRow = pipeline2.find((g) => g.id === orphan!.id);
			expect(orphanRow!.visitCount).toBe(0);
			expect(orphanRow!.firstVisitAt).toBeNull();
		});
	});

	describe("manual stage transitions", () => {
		it("moves a guest between prospect/following_up/lost", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Stage Mover",
				phone: "555-321-0000",
			});
			await applySetGuestStage({
				clubId: seed.clubId,
				guestId,
				stage: "following_up",
			});
			const [g] = await testDb
				.select({ stage: guests.stage })
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g!.stage).toBe("following_up");
		});

		it("rejects a stage change on a converted (joined) guest", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Joined Already",
				phone: "555-111-0000",
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});
			await expect(
				applySetGuestStage({ clubId: seed.clubId, guestId, stage: "lost" }),
			).rejects.toThrow(/already joined/i);
		});
	});

	describe("convert to member", () => {
		it("creates a membership, re-points slots, joins the guest, and logs it", async () => {
			// A guest holding a role slot.
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Convert Me",
				email: "convert@example.com",
				phone: "555-246-8100",
			});
			await applyAssignGuestToSlot({
				slotId: seed.slotId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: seed.adminMemberId,
			});

			// Membership created for this club, member role, joinedAt stamped.
			const [m] = await testDb
				.select()
				.from(members)
				.where(eq(members.id, res.membershipId));
			expect(m).toMatchObject({
				clubId: seed.clubId,
				name: "Convert Me",
				clubRole: "member",
				status: "active",
			});
			expect(m!.joinedAt).toBeInstanceOf(Date);
			expect(m!.personId).toBe(res.personId);

			// Slot re-pointed guest → member (XOR holds).
			const [slot] = await testDb
				.select({
					assignedMemberId: roleSlots.assignedMemberId,
					assignedGuestId: roleSlots.assignedGuestId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			expect(slot!.assignedMemberId).toBe(res.membershipId);
			expect(slot!.assignedGuestId).toBeNull();

			// Guest persists at joined with the membership pointer.
			const [g] = await testDb
				.select({
					stage: guests.stage,
					convertedMembershipId: guests.convertedMembershipId,
				})
				.from(guests)
				.where(eq(guests.id, guestId));
			expect(g!.stage).toBe("joined");
			expect(g!.convertedMembershipId).toBe(res.membershipId);

			// Excluded from the assign picker, still visible in the pipeline.
			const picker = await listClubGuests(seed.clubId);
			expect(picker.map((p) => p.id)).not.toContain(guestId);
			const pipeline = await loadGuestPipeline(seed.clubId);
			expect(pipeline.find((p) => p.id === guestId)?.stage).toBe("joined");

			// Activity log entry.
			const log = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.targetId, res.membershipId),
					),
				);
			expect(log).toHaveLength(1);
			expect(log[0]!.action).toBe("member_add");
			expect((log[0]!.detail as { fromGuestId?: string }).fromGuestId).toBe(
				guestId,
			);
		});

		it("links an existing Person by phone rather than creating a duplicate", async () => {
			const [existingPerson] = await testDb
				.insert(people)
				.values({ name: "Existing Human", phone: "5559990000" })
				.returning({ id: people.id });

			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Existing Human",
				phone: "(555) 999-0000", // same digits, different format
			});
			const res = await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: null,
			});
			expect(res.personId).toBe(existingPerson!.id);
		});

		it("is idempotent-safe: converting an already-joined guest throws", async () => {
			const { guestId } = await captureGuestVisit({
				clubId: seed.clubId,
				name: "Once Only",
				phone: "555-808-8080",
			});
			await applyConvertGuestToMember({
				clubId: seed.clubId,
				guestId,
				actorMemberId: null,
			});
			await expect(
				applyConvertGuestToMember({
					clubId: seed.clubId,
					guestId,
					actorMemberId: null,
				}),
			).rejects.toThrow(/already been converted/i);
		});
	});
});
