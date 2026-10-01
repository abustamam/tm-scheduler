/**
 * DB-backed tests for loadSeasonGrid. Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/season-grid.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clubs,
	meetingAttendancePlan,
	meetings,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	setMemberPhone,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("loadSeasonGrid", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
		// Pin the seeded meeting to a clearly-future date so it stays
		// "upcoming"/anchor regardless of when the suite runs.
		const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		await testDb
			.update(meetings)
			.set({ scheduledAt: future })
			.where(eq(meetings.id, seed.meetingId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("windows past lookback + upcoming, expands multi-count rows, counts open", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");

		// seedClub gives: a Timer role def, one upcoming meeting (pinned future
		// in beforeEach), one open Timer slot. Add a past meeting + a 3-count
		// Speaker role.
		const [speaker] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				defaultCount: 3,
				sortOrder: 5,
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });

		const [pastMeeting] = await testDb
			.insert(meetings)
			.values({
				clubId: seed.clubId,
				scheduledAt: new Date("2020-01-01T19:00:00Z"),
				status: "scheduled",
			})
			.returning({ id: meetings.id });

		// 3 speaker slots on the upcoming meeting; assign the seeded member to slot 0.
		await testDb.insert(roleSlots).values([
			{
				meetingId: seed.meetingId,
				roleDefinitionId: speaker!.id,
				slotIndex: 0,
				status: "claimed",
				assignedMemberId: seed.memberId,
			},
			{
				meetingId: seed.meetingId,
				roleDefinitionId: speaker!.id,
				slotIndex: 1,
			},
			{
				meetingId: seed.meetingId,
				roleDefinitionId: speaker!.id,
				slotIndex: 2,
			},
		]);

		// member is NA for the past meeting
		await testDb.insert(meetingAttendancePlan).values({
			memberId: seed.memberId,
			meetingId: pastMeeting!.id,
			status: "not_coming",
		});

		const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });

		// columns: the past meeting (lookback) + the upcoming meeting
		expect(data.meetings).toHaveLength(2);
		expect(data.meetings[0]!.id).toBe(pastMeeting!.id);
		expect(data.meetings[0]!.isPast).toBe(true);
		expect(data.meetings[1]!.id).toBe(seed.meetingId);
		expect(data.meetings[1]!.isAnchor).toBe(true);

		// rows: Timer (1) + Speaker expanded (3) = 4, ordered by sortOrder
		const speakerRows = data.rows.filter(
			(r) => r.roleDefinitionId === speaker!.id,
		);
		expect(speakerRows.map((r) => r.label)).toEqual([
			"Speaker 1",
			"Speaker 2",
			"Speaker 3",
		]);
		expect(speakerRows[1]!.shortCode).toBe("SP2");

		// open count on the upcoming meeting: 1 Timer + 2 unassigned speakers = 3
		const upcoming = data.meetings.find((m) => m.id === seed.meetingId)!;
		expect(upcoming.openCount).toBe(3);

		// the assigned cell + availability surfaced
		const assigned = data.cells.find(
			(c) => c.memberId === seed.memberId && c.meetingId === seed.meetingId,
		);
		expect(assigned?.status).toBe("claimed");
		expect(data.unavailable).toContainEqual({
			memberId: seed.memberId,
			meetingId: pastMeeting!.id,
		});
	});

	it("keeps numbering an UNORDERED role's rows — here the number is the row's identity (#624)", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		// The printed roster collapses an unordered role into one unnumbered entry
		// because the number there asserts a speaking order that does not exist.
		// The season grid is a matrix: each row IS one slot across the season and
		// cannot collapse, so three rows all reading "Contestant" would be
		// indistinguishable. `season-grid-logic` therefore deliberately does NOT
		// pass the flag to `slotLabel`; this pins that choice so a later "thread it
		// everywhere" sweep changes the grid on purpose or not at all.
		const [contestant] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Contestant",
				category: "speaker",
				defaultCount: 3,
				sortOrder: 5,
				isSpeakerRole: true,
				slotsUnordered: true,
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values(
			[0, 1, 2].map((slotIndex) => ({
				meetingId: seed.meetingId,
				roleDefinitionId: contestant!.id,
				slotIndex,
			})),
		);

		const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });
		const rows = data.rows.filter((r) => r.roleDefinitionId === contestant!.id);
		expect(rows.map((r) => r.label)).toEqual([
			"Contestant 1",
			"Contestant 2",
			"Contestant 3",
		]);
	});

	it("count: 4 limits upcoming meetings", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		// seedClub already inserted 1 upcoming meeting; add 5 more upcoming.
		for (let i = 0; i < 5; i++) {
			await testDb.insert(meetings).values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + (i + 2) * 7 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			});
		}
		const data = await loadSeasonGrid({ clubId: seed.clubId, count: 4 });
		const upcomingCols = data.meetings.filter((m) => !m.isPast);
		expect(upcomingCols).toHaveLength(4);
	});

	it("count: 'all' returns every upcoming meeting", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		// seedClub already inserted 1 upcoming meeting; add 2 more (3 total).
		for (let i = 0; i < 2; i++) {
			await testDb.insert(meetings).values({
				clubId: seed.clubId,
				scheduledAt: new Date(Date.now() + (i + 2) * 7 * 24 * 60 * 60 * 1000),
				status: "scheduled",
			});
		}
		const data = await loadSeasonGrid({ clubId: seed.clubId, count: "all" });
		const upcomingCols = data.meetings.filter((m) => !m.isPast);
		expect(upcomingCols).toHaveLength(3);
	});

	it("includeContact: true puts email + phone on the member axis", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		const data = await loadSeasonGrid({
			clubId: seed.clubId,
			count: 8,
			includeContact: true,
		});
		const member = data.members.find((m) => m.id === seed.memberId);
		expect(member).toBeDefined();
		// seedClub sets the member's email but no phone.
		expect(member?.email).toBe(`member-${seed.memberUserId}@test.example`);
		expect(member).toHaveProperty("phone");
		expect(member?.phone).toBeNull();
	});

	it("coalesces a pre-#397 national number to E.164 on the contact axis", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		// A row as it was stored BEFORE normalize-on-write (#295/#397): no country
		// code. The club has no `default_country_code`, so `+1` applies.
		await setMemberPhone(seed.memberId, "(415) 555-2671");

		const grid = await loadSeasonGrid({
			clubId: seed.clubId,
			count: 8,
			includeContact: true,
		});
		const member = grid.members.find((m) => m.id === seed.memberId);
		expect(member?.phone).toBe("+14155552671");
	});

	it("normalizes with the CLUB's country code, not the +1 default", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		// Pins that `loadClubDefaultCountryCode` is actually consulted: with the
		// code hard-coded to the `+1` default this number normalizes to
		// "+10207946018"-ish garbage rather than a UK number.
		await testDb
			.update(clubs)
			.set({ defaultCountryCode: "+44" })
			.where(eq(clubs.id, seed.clubId));
		await setMemberPhone(seed.memberId, "020 7946 0018");

		const grid = await loadSeasonGrid({
			clubId: seed.clubId,
			count: 8,
			includeContact: true,
		});
		const member = grid.members.find((m) => m.id === seed.memberId);
		expect(member?.phone).toBe("+442079460018");
	});

	it("keeps an un-normalizable phone as stored rather than dropping it", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		// `toStoredPhone` stores input with no derivable number verbatim, and the
		// roster editor's phone field has no digit requirement — so this is a
		// reachable stored value. `toE164` returns null for it; the payload must
		// still carry the text, because `WhatsAppPhoneLink` renders a digit-less
		// value as readable plain text instead of a dead link.
		await setMemberPhone(seed.memberId, "call the office");

		const grid = await loadSeasonGrid({
			clubId: seed.clubId,
			count: 8,
			includeContact: true,
		});
		const member = grid.members.find((m) => m.id === seed.memberId);
		expect(member?.phone).toBe("call the office");
	});

	it("includeContact omitted (default) leaves contact off the member axis", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });
		const member = data.members.find((m) => m.id === seed.memberId);
		expect(member).toBeDefined();
		expect(member).not.toHaveProperty("email");
		expect(member).not.toHaveProperty("phone");
	});

	it("returns the club slug on the payload", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		const [club] = await testDb
			.select({ slug: clubs.slug })
			.from(clubs)
			.where(eq(clubs.id, seed.clubId));
		const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });
		expect(data.clubSlug).toBe(club!.slug);
	});

	it("includes the contacted set only when includeOutreach is set", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		await testDb
			.insert(meetingAttendancePlan)
			.values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "reached_out",
			})
			.onConflictDoNothing();

		const withFlag = await loadSeasonGrid({
			clubId: seed.clubId,
			count: 8,
			includeOutreach: true,
		});
		expect(withFlag.contacted).toContainEqual({
			memberId: seed.memberId,
			meetingId: seed.meetingId,
		});

		const withoutFlag = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });
		expect(withoutFlag.contacted).toEqual([]);
	});

	// The grid's `unavailable` used to mean "a row exists in member_availability",
	// which was safe only while every row meant "not available". A plan row can
	// now say the OPPOSITE, so presence is no longer the answer: a member who
	// confirmed they are COMING must not be greyed out on their own sign-up
	// sheet, and a member who has merely been ASKED is contacted, not unavailable.
	it("treats only not_coming as unavailable", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		await testDb.insert(meetingAttendancePlan).values([
			{
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "coming",
			},
			{
				memberId: seed.adminMemberId,
				meetingId: seed.meetingId,
				status: "reached_out",
			},
		]);

		const data = await loadSeasonGrid({
			clubId: seed.clubId,
			count: 8,
			includeOutreach: true,
		});
		expect(data.unavailable).toEqual([]);
		expect(data.contacted).toEqual([
			{ memberId: seed.adminMemberId, meetingId: seed.meetingId },
		]);
	});

	it("public season grid never includes the contacted set", async () => {
		const { loadPublicSeasonGrid } = await import("#/server/season-grid-logic");
		// A contacted row exists for the seeded (member, meeting); the public
		// loader must never surface it — who-was-contacted is officer-private.
		await testDb
			.insert(meetingAttendancePlan)
			.values({
				memberId: seed.memberId,
				meetingId: seed.meetingId,
				status: "reached_out",
			})
			.onConflictDoNothing();

		const result = await loadPublicSeasonGrid({
			clubId: seed.clubId,
			count: 8,
		});
		expect(result.contacted).toEqual([]);
	});

	it("loadPublicSeasonGrid strips contact even though the DB has it", async () => {
		const { loadPublicSeasonGrid } = await import("#/server/season-grid-logic");
		// The seeded member HAS an email in the DB; the public variant (used by
		// getPublicSeasonGrid for the effectively-public /club/:clubId sheet) must
		// still never expose email/phone. Guards against a regression that wires
		// the public fn to include contact.
		const data = await loadPublicSeasonGrid({ clubId: seed.clubId, count: 8 });
		const member = data.members.find((m) => m.id === seed.memberId);
		expect(member).toBeDefined();
		expect(member).not.toHaveProperty("email");
		expect(member).not.toHaveProperty("phone");
	});

	describe("past lookback (#1048)", () => {
		/** Fourteen past meetings, one a week back from 2020-06-01 — one more
		 *  than the widest allowed lookback, so a bound that let 14 through (or
		 *  an unbounded one) is visible. Returned NEWEST first. */
		async function seedPast(n = 14): Promise<string[]> {
			const base = Date.parse("2020-06-01T19:00:00Z");
			const rows = await testDb
				.insert(meetings)
				.values(
					Array.from({ length: n }, (_, i) => ({
						clubId: seed.clubId,
						scheduledAt: new Date(base - i * 7 * 24 * 60 * 60 * 1000),
						status: "scheduled" as const,
					})),
				)
				.returning({ id: meetings.id, scheduledAt: meetings.scheduledAt });
			return rows
				.sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime())
				.map((r) => r.id);
		}

		it.each([
			4, 8, 13,
		])("pastCount %i shows that many past meetings, newest last, then the upcoming one", async (n) => {
			const { loadSeasonGrid } = await import("#/server/season-grid-logic");
			const newestFirst = await seedPast();
			const data = await loadSeasonGrid({
				clubId: seed.clubId,
				count: 8,
				pastCount: n,
			});
			const past = data.meetings.filter((m) => m.isPast);
			expect(past).toHaveLength(n);
			// The n MOST RECENT, oldest first — the columns read left to right.
			expect(past.map((m) => m.id)).toEqual(newestFirst.slice(0, n).reverse());
			expect(data.meetings.at(-1)?.id).toBe(seed.meetingId);
			expect(data.meetings).toHaveLength(n + 1);
		});

		it("omitting pastCount keeps today's 2", async () => {
			const { loadSeasonGrid } = await import("#/server/season-grid-logic");
			await seedPast();
			const data = await loadSeasonGrid({ clubId: seed.clubId, count: 8 });
			expect(data.meetings.filter((m) => m.isPast)).toHaveLength(2);
		});

		it.each([
			99,
			500,
			14,
			3,
			0,
			-1,
			Number.NaN,
		])("bounds pastCount %s to 2 on the SERVER, whatever the route allowed", async (n) => {
			// A client can call the server fn directly with any number; the
			// route's validateSearch is not the only gate.
			const { loadSeasonGrid } = await import("#/server/season-grid-logic");
			await seedPast();
			const data = await loadSeasonGrid({
				clubId: seed.clubId,
				count: 8,
				pastCount: n,
			});
			expect(data.meetings.filter((m) => m.isPast)).toHaveLength(2);
		});

		it("the PUBLIC grid shows 2 past meetings even when handed a larger pastCount", async () => {
			const { loadPublicSeasonGrid } = await import(
				"#/server/season-grid-logic"
			);
			await seedPast();
			// Its type has no `pastCount`, so the cast models a caller (or a
			// future spread) that forwards one anyway. It must not reach the loader.
			const input = { clubId: seed.clubId, count: 8, pastCount: 13 } as {
				clubId: string;
				count: 8;
			};
			const data = await loadPublicSeasonGrid(input);
			expect(data.meetings.filter((m) => m.isPast)).toHaveLength(2);
			// And plainly, with nothing extra.
			const plain = await loadPublicSeasonGrid({
				clubId: seed.clubId,
				count: "all",
			});
			expect(plain.meetings.filter((m) => m.isPast)).toHaveLength(2);
		});
	});
});
