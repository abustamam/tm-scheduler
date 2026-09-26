/**
 * Marketing blasts (#931) against the real schema: the template's default and
 * round trip, the Promote sheet's context, the public flyer's archive gate,
 * the promo note on the meeting patch, and who may do any of it.
 *
 * `#/db` is mocked to the TEST_DATABASE_URL client; the suite skips without it.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, meetings } from "#/db/schema";
import { DEFAULT_PROMO_TEMPLATE, ONLINE_TEXT } from "#/lib/promo-template";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const {
	applyResetPromoTemplate,
	applyUpdatePromoTemplate,
	clubIdForMeeting,
	loadPromoContext,
	loadPromoTemplate,
	loadPromoTemplateState,
	loadPublicFlyer,
} = await import("#/server/promo-logic");
const { applyMeetingMetaPatch, loadNextMeetingSummary } = await import(
	"#/server/meetings-logic"
);
const { requireClubAdminView, requireClubRole } = await import(
	"#/server/guards"
);

describe.skipIf(!hasTestDb)("marketing blasts (#931)", () => {
	let seed: SeededClub;
	const ROOM = `https://zoom.example/j/${randomUUID()}`;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	describe("the blast template", () => {
		it("a new club gets the seeded default", async () => {
			expect(await loadPromoTemplate(seed.clubId)).toEqual(
				DEFAULT_PROMO_TEMPLATE,
			);
		});

		it("round-trips an edit, and reset puts the default back", async () => {
			const edited = { ...DEFAULT_PROMO_TEMPLATE, headline: "Come to {club}" };
			await applyUpdatePromoTemplate(seed.clubId, edited);
			expect(await loadPromoTemplate(seed.clubId)).toEqual(edited);
			await applyResetPromoTemplate(seed.clubId);
			expect(await loadPromoTemplate(seed.clubId)).toEqual(
				DEFAULT_PROMO_TEMPLATE,
			);
		});

		it("a stored value that no longer parses reads as the default", async () => {
			await testDb
				.update(clubs)
				.set({ promoTemplate: { headline: 42 } })
				.where(eq(clubs.id, seed.clubId));
			expect(await loadPromoTemplate(seed.clubId)).toEqual(
				DEFAULT_PROMO_TEMPLATE,
			);
			// …and the editor's read says so, rather than passing the default off
			// as the club's own template.
			expect((await loadPromoTemplateState(seed.clubId)).storedInvalid).toBe(
				true,
			);
		});

		it("a new club's template is not flagged invalid", async () => {
			expect((await loadPromoTemplateState(seed.clubId)).storedInvalid).toBe(
				false,
			);
		});
	});

	describe("the Promote sheet's context", () => {
		it("opens on the next meeting, says it is online, and never carries the link", async () => {
			await testDb
				.update(meetings)
				.set({ joinUrl: ROOM, theme: "Beginnings", promoNote: "Open house!" })
				.where(eq(meetings.id, seed.meetingId));
			const ctx = await loadPromoContext(seed.clubId, new Date());
			expect(ctx.selectedId).toBe(seed.meetingId);
			const m = ctx.meetings.find((x) => x.id === seed.meetingId);
			expect(m?.online).toBe(true);
			expect(m?.theme).toBe("Beginnings");
			expect(m?.promoNote).toBe("Open house!");
			const json = JSON.stringify(ctx);
			expect(json).not.toContain(ROOM);
			expect(json).not.toMatch(/join[_-]?url/i);
			expect(ctx.template).toEqual(DEFAULT_PROMO_TEMPLATE);
		});

		it("a meeting with no link reads as not online", async () => {
			const ctx = await loadPromoContext(seed.clubId, new Date());
			expect(ctx.meetings[0]?.online).toBe(false);
		});

		it("opens on a requested PAST meeting, which is not among the upcoming", async () => {
			const [past] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() - 3 * 86_400_000),
					status: "completed",
				})
				.returning({ id: meetings.id });
			if (!past) throw new Error("seed failed");
			const ctx = await loadPromoContext(seed.clubId, new Date(), past.id);
			expect(ctx.selectedId).toBe(past.id);
			expect(ctx.meetings[0]?.id).toBe(past.id);
			expect(await clubIdForMeeting(past.id)).toBe(seed.clubId);
		});

		it("refuses a meeting from another club", async () => {
			const other = await seedClub();
			try {
				await expect(
					loadPromoContext(seed.clubId, new Date(), other.meetingId),
				).rejects.toThrow("Meeting not found.");
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		it("has nothing selected when nothing is scheduled ahead", async () => {
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seed.meetingId));
			const ctx = await loadPromoContext(seed.clubId, new Date());
			expect(ctx.selectedId).toBeNull();
			expect(ctx.meetings).toEqual([]);
		});
	});

	describe("loadNextMeetingSummary carries theme and number (#931 decision 4)", () => {
		it("returns the theme and the stored meeting number", async () => {
			await testDb
				.update(meetings)
				.set({ theme: "Beginnings", meetingNumber: 57 })
				.where(eq(meetings.id, seed.meetingId));
			const s = await loadNextMeetingSummary(seed.clubId, new Date());
			expect(s.nextMeeting?.theme).toBe("Beginnings");
			expect(s.nextMeeting?.meetingNumber).toBe(57);
		});
	});

	describe("the public flyer", () => {
		it("serves the meeting, slim, with no link", async () => {
			await testDb
				.update(meetings)
				.set({ joinUrl: ROOM })
				.where(eq(meetings.id, seed.meetingId));
			const flyer = await loadPublicFlyer(seed.clubId, seed.meetingId);
			expect(flyer?.meeting.id).toBe(seed.meetingId);
			expect(flyer?.meeting.online).toBe(true);
			expect(flyer?.club.name).toBe("Test Club");
			expect(JSON.stringify(flyer)).not.toContain(ROOM);
		});

		it("is null for an ARCHIVED club", async () => {
			expect(await loadPublicFlyer(seed.clubId, seed.meetingId)).not.toBeNull();
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
			expect(await loadPublicFlyer(seed.clubId, seed.meetingId)).toBeNull();
		});

		it("is null for a key naming no meeting of this club", async () => {
			expect(await loadPublicFlyer(seed.clubId, "1999-01-01")).toBeNull();
			const other = await seedClub();
			try {
				expect(await loadPublicFlyer(seed.clubId, other.meetingId)).toBeNull();
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});
	});

	describe("the promo note on the meeting patch", () => {
		const stored = async () =>
			(
				await testDb
					.select({ promoNote: meetings.promoNote })
					.from(meetings)
					.where(eq(meetings.id, seed.meetingId))
			)[0]?.promoNote;

		it("an admin sets it, and a blank clears it", async () => {
			await applyMeetingMetaPatch({
				meetingId: seed.meetingId,
				actorMemberId: seed.adminMemberId,
				promoNote: "  Open house, bring a friend!  ",
			});
			expect(await stored()).toBe("Open house, bring a friend!");
			await applyMeetingMetaPatch({
				meetingId: seed.meetingId,
				actorMemberId: seed.adminMemberId,
				promoNote: "",
			});
			expect(await stored()).toBeNull();
		});

		it("an omitted note is left alone", async () => {
			await testDb
				.update(meetings)
				.set({ promoNote: "Keep me" })
				.where(eq(meetings.id, seed.meetingId));
			await applyMeetingMetaPatch({
				meetingId: seed.meetingId,
				actorMemberId: seed.adminMemberId,
				theme: "Something",
			});
			expect(await stored()).toBe("Keep me");
		});

		it("a non-admin (self-serve TMOD) is refused, even for a blank", async () => {
			for (const promoNote of ["Mine now", ""]) {
				await expect(
					applyMeetingMetaPatch({
						meetingId: seed.meetingId,
						actorMemberId: seed.memberId,
						promoNote,
						canReschedule: false,
					}),
				).rejects.toThrow("Only an admin can set this meeting's promo note.");
			}
		});
	});

	describe("only admins (#931 decision 1)", () => {
		it("a member-role user is refused the write gate and the admin read gate", async () => {
			await expect(
				requireClubRole(seed.memberUserId, seed.clubId, ["admin"]),
			).rejects.toThrow();
			await expect(
				requireClubAdminView(seed.memberUserId, seed.clubId),
			).rejects.toThrow();
		});

		it("an admin passes both (control)", async () => {
			await expect(
				requireClubRole(seed.adminUserId, seed.clubId, ["admin"]),
			).resolves.toBeTruthy();
			await expect(
				requireClubAdminView(seed.adminUserId, seed.clubId),
			).resolves.toBeTruthy();
		});
	});

	it("says online with the constant text, which carries no URL", () => {
		expect(ONLINE_TEXT).not.toMatch(/https?:/);
	});
});
