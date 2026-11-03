/**
 * DB-backed tests for the first-time Toastmaster note (#1481): the detection
 * query and the officer-only payload field.
 *
 *   bunx vitest run src/server/first-time-toastmaster-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	guests,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	withGuestPerson,
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

const { firstTimeToastmaster } = await import("./first-time-toastmaster-logic");
const { getMeeting } = await import("#/server/meetings");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

describe.skipIf(!hasTestDb)("first-time Toastmaster (#1481)", () => {
	let seeded: SeededClub;
	let otherClubId: string | null = null;
	/** The Toastmaster role at the seeded club, and at the other club. */
	let tmDef: string;

	async function addDef(clubId: string): Promise<string> {
		const [d] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId,
				name: "Toastmaster of the Day",
				key: "toastmaster_of_the_day",
				category: "leadership",
				sortOrder: -10,
			})
			.returning({ id: roleDefinitions.id });
		return d.id;
	}

	async function addMeeting(
		offsetDays: number,
		over: Partial<typeof meetings.$inferInsert> = {},
	): Promise<string> {
		const [m] = await testDb
			.insert(meetings)
			.values({
				clubId: seeded.clubId,
				scheduledAt: new Date(NOW + offsetDays * DAY),
				status: "scheduled",
				...over,
			})
			.returning({ id: meetings.id });
		return m.id;
	}

	async function holdTm(
		meetingId: string,
		holder: { memberId?: string; guestId?: string },
		def = tmDef,
		status: "claimed" | "confirmed" = "claimed",
		slotIndex = 0,
	) {
		await testDb.insert(roleSlots).values({
			meetingId,
			roleDefinitionId: def,
			slotIndex,
			status,
			assignedMemberId: holder.memberId ?? null,
			assignedGuestId: holder.guestId ?? null,
		});
	}

	beforeEach(async () => {
		seeded = await seedClub();
		tmDef = await addDef(seeded.clubId);
	});

	afterEach(async () => {
		sessionUserId = null;
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
		if (otherClubId)
			await testDb.delete(clubs).where(eq(clubs.id, otherClubId));
		otherClubId = null;
	});

	describe("firstTimeToastmaster", () => {
		// protects=a member with no earlier Toastmaster slot is reported, with their name; fails_when=the query reports nobody, or a different member; no_claim=who may see it (the payload tests)
		it("reports a member with no earlier Toastmaster slot at this club", async () => {
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			const got = await firstTimeToastmaster(seeded.meetingId);
			expect(got).toMatchObject({
				memberId: seeded.memberId,
				name: "Member User",
				preferredName: "Member",
				phone: null,
			});
		});

		// protects=an earlier, non-cancelled Toastmaster slot (claimed or confirmed) makes them not a first-timer; fails_when=the `scheduled_at <` condition or the role-key condition is dropped, or the earlier slot is ignored; no_claim=cancelled meetings (next test)
		it.each([
			"claimed",
			"confirmed",
		] as const)("is null when they held it earlier (%s)", async (status) => {
			await holdTm(
				await addMeeting(-14),
				{ memberId: seeded.memberId },
				tmDef,
				status,
			);
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			expect(await firstTimeToastmaster(seeded.meetingId)).toBeNull();
		});

		// protects=only the Toastmaster role counts as "held it before"; fails_when=the role-key condition is dropped (any earlier role disqualifies); no_claim=what that other role is
		it("still a first-timer when their earlier slot was a different role", async () => {
			const [timer] = await testDb
				.select({ id: roleDefinitions.id })
				.from(roleDefinitions)
				.where(eq(roleDefinitions.name, "Timer"));
			await holdTm(
				await addMeeting(-14),
				{ memberId: seeded.memberId },
				timer.id,
			);
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			expect(await firstTimeToastmaster(seeded.meetingId)).not.toBeNull();
		});

		// protects=an earlier slot at a CANCELLED meeting does not count; fails_when=the `status <> 'cancelled'` condition is dropped; no_claim=a cancelled THIS meeting (payload tests)
		it("still a first-timer when the earlier slot is at a cancelled meeting", async () => {
			await holdTm(await addMeeting(-14, { status: "cancelled" }), {
				memberId: seeded.memberId,
			});
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			expect(await firstTimeToastmaster(seeded.meetingId)).not.toBeNull();
		});

		// protects=history is per club; fails_when=the `meetings.club_id` condition is dropped (an earlier slot at ANOTHER club of the same person's membership disqualifies); no_claim=cross-club identity of the person
		it("still a first-timer when the earlier slot is at another club", async () => {
			otherClubId = randomUUID();
			await testDb.insert(clubs).values({
				id: otherClubId,
				name: "Other Club",
				slug: `other-${otherClubId}`,
			});
			const otherDef = await addDef(otherClubId);
			const [otherMember] = await testDb
				.insert(members)
				.values({
					clubId: otherClubId,
					personId: seeded.personId,
					name: "Member User",
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			const [theirMeeting] = await testDb
				.insert(meetings)
				.values({
					clubId: otherClubId,
					scheduledAt: new Date(NOW - 14 * DAY),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			await holdTm(theirMeeting.id, { memberId: otherMember.id }, otherDef);
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			expect(await firstTimeToastmaster(seeded.meetingId)).not.toBeNull();
		});

		// protects=a LATER meeting's Toastmaster slot does not count; fails_when=the comparison is flipped or dropped so a future slot disqualifies; no_claim=a same-instant meeting
		it("a later meeting's Toastmaster slot does not count", async () => {
			await holdTm(await addMeeting(21), { memberId: seeded.memberId });
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			expect(await firstTimeToastmaster(seeded.meetingId)).not.toBeNull();
		});

		// protects=a guest Toastmaster, or no one, is never reported; fails_when=a guest-held slot is treated as a member's; no_claim=a guest's own history
		it("is null for a guest Toastmaster and for no one assigned", async () => {
			const [g] = await testDb
				.insert(guests)
				.values(
					await withGuestPerson({
						clubId: seeded.clubId,
						name: "Visiting Guest",
					}),
				)
				.returning({ id: guests.id });
			const guestId = g.id;
			await holdTm(seeded.meetingId, { guestId });
			expect(await firstTimeToastmaster(seeded.meetingId)).toBeNull();

			const empty = await addMeeting(3);
			await testDb.insert(roleSlots).values({
				meetingId: empty,
				roleDefinitionId: tmDef,
				status: "open",
			});
			expect(await firstTimeToastmaster(empty)).toBeNull();
		});

		// protects=the lowest slot_index member is the one reported; fails_when=the ordering is dropped; no_claim=multi-Toastmaster meetings being common
		it("with two Toastmaster slots, reports the lowest slot_index holder", async () => {
			const [admin] = [seeded.adminMemberId];
			await holdTm(seeded.meetingId, { memberId: admin }, tmDef, "claimed", 1);
			await holdTm(
				seeded.meetingId,
				{ memberId: seeded.memberId },
				tmDef,
				"claimed",
				0,
			);
			expect((await firstTimeToastmaster(seeded.meetingId))?.memberId).toBe(
				seeded.memberId,
			);
		});

		// protects=a cancelled meeting reports nothing; fails_when=the status guard is dropped; no_claim=the earlier-meeting cancelled rule (above)
		it("is null for a cancelled meeting", async () => {
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seeded.meetingId));
			expect(await firstTimeToastmaster(seeded.meetingId)).toBeNull();
		});

		// protects=the phone comes back normalized from the person's record; fails_when=phone is dropped; no_claim=the draft (nudge.test.ts)
		it("carries the member's phone and preferred name", async () => {
			await testDb
				.update(people)
				.set({ phone: "+15555550122", preferredName: "Sammy" })
				.where(eq(people.id, seeded.personId));
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			const got = await firstTimeToastmaster(seeded.meetingId);
			expect(got?.phone).toBe("+15555550122");
			expect(got?.preferredName).toBe("Sammy");
		});
	});

	describe("the meeting payload", () => {
		// protects=an officer's payload carries the first-timer; fails_when=the field is dropped from the payload or never gated open; no_claim=the panel
		it("an officer gets it", async () => {
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			sessionUserId = seeded.adminUserId;
			const detail = await getMeeting({ data: seeded.meetingId });
			expect(detail.firstTimeToastmaster?.memberId).toBe(seeded.memberId);
		});

		// protects=a member, and a signed-out reader, get null (the field names a person's inexperience and carries a phone); fails_when=the canManage gate is dropped; no_claim=that the Toastmaster themselves is denied other fields
		it("a member, a Toastmaster who is not an officer, and a signed-out reader get null", async () => {
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			sessionUserId = seeded.memberUserId; // the first-timer, not an officer
			expect(
				(await getMeeting({ data: seeded.meetingId })).firstTimeToastmaster,
			).toBeNull();
			sessionUserId = null;
			expect(
				(await getMeeting({ data: seeded.meetingId })).firstTimeToastmaster,
			).toBeNull();
		});

		// protects=a cancelled meeting's payload carries none, even for an officer; fails_when=the cancelled guard is dropped; no_claim=how the page renders a cancelled meeting
		it("a cancelled meeting gets null", async () => {
			await holdTm(seeded.meetingId, { memberId: seeded.memberId });
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seeded.meetingId));
			sessionUserId = seeded.adminUserId;
			expect(
				(await getMeeting({ data: seeded.meetingId })).firstTimeToastmaster,
			).toBeNull();
		});
	});
});
