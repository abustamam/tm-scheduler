/**
 * DB-backed integration tests for meeting minutes (ADR-0014 / #152).
 *
 * Exercises the REAL minutes logic against a live Postgres identified by
 * TEST_DATABASE_URL: the unmarked attendance default (#218 — no saved record
 * means `status: null`, never inferred from role slots), guest add/reuse,
 * the member-XOR-guest DB check constraints, Table Topics ordering, award
 * upsert/clear, and the loaded minutes shape. `#/db` is mocked to the test
 * client so the logic modules import cleanly without a production DATABASE_URL.
 *
 * When TEST_DATABASE_URL is unset the whole suite is skipped.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAttendance,
	meetingAwards,
	roleDefinitions,
	roleSlots,
	tableTopicsSpeakers,
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
	addGuestPresent,
	addTableTopicsSpeaker,
	clearAward,
	loadMinutes,
	moveTableTopicsSpeaker,
	removeGuestPresent,
	removeTableTopicsSpeaker,
	setAward,
	setMemberPresence,
} = await import("#/server/minutes-logic");
const { buildAttendanceSection, renderMinutesPdf } = await import(
	"#/server/minutes-pdf-logic"
);

describe.skipIf(!hasTestDb)("meeting minutes (#152)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function newGuest(name: string): Promise<string> {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name })
			.returning({ id: guests.id });
		return g!.id;
	}

	async function assignSlotToMember(memberId: string) {
		await testDb
			.update(roleSlots)
			.set({ assignedMemberId: memberId, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));
	}

	/** Create a role definition + a role slot on the seeded meeting, optionally assigned. */
	async function addRoleSlot(opts: {
		name: string;
		category: "leadership" | "speaker" | "evaluator" | "functionary";
		memberId?: string;
		guestId?: string;
	}) {
		const [rd] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: opts.name,
				category: opts.category,
				isSpeakerRole: opts.category === "speaker",
			})
			.returning({ id: roleDefinitions.id });
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: rd!.id,
			assignedMemberId: opts.memberId ?? null,
			assignedGuestId: opts.guestId ?? null,
			status: opts.memberId || opts.guestId ? "claimed" : "open",
		});
	}

	it("defaults every member without a saved record to unmarked (#218)", async () => {
		const m = await loadMinutes(seed.meetingId);
		expect(m.members).toHaveLength(2);
		expect(m.members.every((x) => x.status === null)).toBe(true);
		expect(m.counts).toEqual({
			present: 0,
			absent: 0,
			excused: 0,
			unmarked: 2,
			guests: 0,
		});
	});

	it("does NOT infer attendance from a role slot — holders stay unmarked (#218)", async () => {
		await assignSlotToMember(seed.memberId);

		const m = await loadMinutes(seed.meetingId);
		const withRole = m.members.find((x) => x.memberId === seed.memberId);
		const without = m.members.find((x) => x.memberId === seed.adminMemberId);
		expect(withRole).toMatchObject({ status: null, hasRole: true });
		expect(without).toMatchObject({ status: null, hasRole: false });
		expect(m.counts.present).toBe(0);
		expect(m.counts.absent).toBe(0);
		expect(m.counts.unmarked).toBe(2);
	});

	it("setMemberPresence saves, round-trips, and upserts idempotently", async () => {
		await assignSlotToMember(seed.memberId);

		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "excused",
		});
		let m = await loadMinutes(seed.meetingId);
		expect(m.members.find((x) => x.memberId === seed.memberId)?.status).toBe(
			"excused",
		);
		// The other member is still unmarked — recording one member never
		// implicitly marks the rest.
		expect(
			m.members.find((x) => x.memberId === seed.adminMemberId)?.status,
		).toBeNull();
		expect(m.counts.excused).toBe(1);
		expect(m.counts.unmarked).toBe(1);
		expect(m.counts.absent).toBe(0);

		// Second write updates the same row (no duplicate — the unique index).
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "absent",
		});
		m = await loadMinutes(seed.meetingId);
		expect(m.members.find((x) => x.memberId === seed.memberId)?.status).toBe(
			"absent",
		);
		// Only the explicitly saved record counts as absent.
		expect(m.counts.absent).toBe(1);
		expect(m.counts.unmarked).toBe(1);
		const rows = await testDb
			.select({ id: meetingAttendance.id })
			.from(meetingAttendance)
			.where(eq(meetingAttendance.meetingId, seed.meetingId));
		expect(rows).toHaveLength(1);
	});

	it("renders the minutes PDF with unmarked members separate from absent (#218)", async () => {
		// One explicit absentee, one unmarked member.
		await setMemberPresence({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			status: "absent",
		});
		const minutes = await loadMinutes(seed.meetingId);
		const section = buildAttendanceSection(minutes);
		expect(section.countsLine).toContain("Absent: 1");
		expect(section.countsLine).toContain("Unmarked: 1");
		const absentRow = section.rows.find((r) => r.label === "Absent");
		const unmarkedRow = section.rows.find((r) => r.label === "Unmarked");
		expect(absentRow?.names).toBe("Member User");
		expect(unmarkedRow?.names).toBe("Admin User");

		// The full renderer consumes that section model and produces a real PDF.
		const pdf = await renderMinutesPdf(seed.meetingId);
		expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
	});

	it("adds a NEW present guest and reuses an existing one without duplicating", async () => {
		const { guestId } = await addGuestPresent({
			meetingId: seed.meetingId,
			newGuest: { name: "Ben Carter", email: "ben@example.com" },
		});
		let m = await loadMinutes(seed.meetingId);
		expect(m.guests).toEqual([
			{ guestId, name: "Ben Carter", fromRole: false },
		]);
		expect(m.counts.guests).toBe(1);

		// Re-adding the same guest is a no-op (unique per meeting+guest).
		await addGuestPresent({ meetingId: seed.meetingId, guestId });
		m = await loadMinutes(seed.meetingId);
		expect(m.guests).toHaveLength(1);

		await removeGuestPresent({ meetingId: seed.meetingId, guestId });
		m = await loadMinutes(seed.meetingId);
		expect(m.guests).toHaveLength(0);
	});

	it("pre-lists a guest holding a role slot as present (fromRole)", async () => {
		const guestId = await newGuest("Nadia Visitor");
		await testDb
			.update(roleSlots)
			.set({ assignedGuestId: guestId, status: "claimed" })
			.where(eq(roleSlots.id, seed.slotId));

		const m = await loadMinutes(seed.meetingId);
		expect(m.guests).toEqual([
			{ guestId, name: "Nadia Visitor", fromRole: true },
		]);
	});

	it("rejects an attendance row holding BOTH a member and a guest (DB check)", async () => {
		const guestId = await newGuest("Both");
		await expect(
			testDb.insert(meetingAttendance).values({
				meetingId: seed.meetingId,
				memberId: seed.memberId,
				guestId,
				status: "present",
			}),
		).rejects.toThrow();
	});

	it("rejects a Table Topics / award row holding BOTH assignees (DB check)", async () => {
		const guestId = await newGuest("Both2");
		await expect(
			testDb.insert(tableTopicsSpeakers).values({
				meetingId: seed.meetingId,
				memberId: seed.memberId,
				guestId,
			}),
		).rejects.toThrow();
		await expect(
			testDb.insert(meetingAwards).values({
				meetingId: seed.meetingId,
				category: "best_speaker",
				memberId: seed.memberId,
				guestId,
			}),
		).rejects.toThrow();
	});

	it("adds, orders, reorders, and removes Table Topics speakers", async () => {
		const first = await addTableTopicsSpeaker({
			meetingId: seed.meetingId,
			memberId: seed.memberId,
			topic: "Your favorite season?",
		});
		const second = await addTableTopicsSpeaker({
			meetingId: seed.meetingId,
			newGuest: { name: "Guesty" },
		});

		let m = await loadMinutes(seed.meetingId);
		expect(m.tableTopicsSpeakers.map((s) => s.id)).toEqual([
			first.id,
			second.id,
		]);
		expect(m.tableTopicsSpeakers[0]).toMatchObject({
			memberId: seed.memberId,
			isGuest: false,
			topic: "Your favorite season?",
		});
		expect(m.tableTopicsSpeakers[1]).toMatchObject({
			isGuest: true,
			name: "Guesty",
		});

		// Move the guest up — order flips.
		await moveTableTopicsSpeaker({
			meetingId: seed.meetingId,
			id: second.id,
			direction: "up",
		});
		m = await loadMinutes(seed.meetingId);
		expect(m.tableTopicsSpeakers.map((s) => s.id)).toEqual([
			second.id,
			first.id,
		]);

		await removeTableTopicsSpeaker({ meetingId: seed.meetingId, id: first.id });
		m = await loadMinutes(seed.meetingId);
		expect(m.tableTopicsSpeakers.map((s) => s.id)).toEqual([second.id]);
	});

	it("sets a single-valued award per category (upsert), then clears it", async () => {
		await setAward({
			meetingId: seed.meetingId,
			category: "best_speaker",
			memberId: seed.memberId,
		});
		// Re-set the same category to a guest — replaces, does not add a 2nd row.
		await setAward({
			meetingId: seed.meetingId,
			category: "best_speaker",
			newGuest: { name: "Award Guest" },
		});

		let m = await loadMinutes(seed.meetingId);
		const bestSpeaker = m.awards.find((a) => a.category === "best_speaker");
		expect(bestSpeaker).toMatchObject({
			name: "Award Guest",
			isGuest: true,
			memberId: null,
		});
		const awardRows = await testDb
			.select({ id: meetingAwards.id })
			.from(meetingAwards)
			.where(eq(meetingAwards.meetingId, seed.meetingId));
		expect(awardRows).toHaveLength(1);

		await clearAward({ meetingId: seed.meetingId, category: "best_speaker" });
		m = await loadMinutes(seed.meetingId);
		expect(
			m.awards.find((a) => a.category === "best_speaker")?.name,
		).toBeNull();
	});

	it("awardEligible scopes each award to that meeting's participants (#170)", async () => {
		const guestSpeakerId = await newGuest("Guest Speaker");
		// Speaker slots: one member, one guest. Evaluator slot: the admin member.
		await addRoleSlot({
			name: "Speaker",
			category: "speaker",
			memberId: seed.memberId,
		});
		await addRoleSlot({
			name: "Speaker",
			category: "speaker",
			guestId: guestSpeakerId,
		});
		await addRoleSlot({
			name: "Evaluator",
			category: "evaluator",
			memberId: seed.adminMemberId,
		});
		// A functionary role holder must NOT be eligible for any award, even though
		// the same member also holds a speaker slot above.
		await addRoleSlot({
			name: "Ah-Counter",
			category: "functionary",
			memberId: seed.memberId,
		});

		// Table Topics: the admin member + a guest.
		const ttGuestId = await newGuest("TT Guest");
		await addTableTopicsSpeaker({
			meetingId: seed.meetingId,
			memberId: seed.adminMemberId,
		});
		await addTableTopicsSpeaker({
			meetingId: seed.meetingId,
			guestId: ttGuestId,
		});

		const m = await loadMinutes(seed.meetingId);

		expect(m.awardEligible.best_speaker.memberIds).toEqual([seed.memberId]);
		expect(m.awardEligible.best_speaker.guestIds).toEqual([guestSpeakerId]);
		expect(m.awardEligible.best_evaluator.memberIds).toEqual([
			seed.adminMemberId,
		]);
		expect(m.awardEligible.best_evaluator.guestIds).toEqual([]);
		expect(m.awardEligible.best_table_topics.memberIds).toEqual([
			seed.adminMemberId,
		]);
		expect(m.awardEligible.best_table_topics.guestIds).toEqual([ttGuestId]);
	});

	it("always returns all three award categories, unset ones as null", async () => {
		const m = await loadMinutes(seed.meetingId);
		expect(m.awards.map((a) => a.category)).toEqual([
			"best_speaker",
			"best_evaluator",
			"best_table_topics",
		]);
		expect(m.awards.every((a) => a.name === null)).toBe(true);
	});
});
