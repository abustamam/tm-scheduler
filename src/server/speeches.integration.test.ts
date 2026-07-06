/**
 * DB-backed integration tests for the unscheduled-speech surface (ADR-0009 /
 * #102): deriving the unscheduled set from slot linkage, the archived flag, and
 * the attach-to-open-slot (reschedule) flow.
 *
 * Exercises the REAL speeches-logic helpers against a live Postgres identified
 * by TEST_DATABASE_URL. #/db is mocked to the test client; the helpers take an
 * explicit connection, so we pass `testDb`. When TEST_DATABASE_URL is unset the
 * whole suite is skipped.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("unscheduled speeches (ADR-0009 / #102)", () => {
	let seed: SeededClub;
	let speakerRoleId: string;

	async function addSpeakerSlot(opts?: {
		assignedMemberId?: string | null;
		status?: "open" | "claimed" | "confirmed";
		speechId?: string | null;
		meetingId?: string;
	}): Promise<string> {
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: opts?.meetingId ?? seed.meetingId,
				roleDefinitionId: speakerRoleId,
				status: opts?.status ?? "open",
				assignedMemberId: opts?.assignedMemberId ?? null,
				speechId: opts?.speechId ?? null,
			})
			.returning({ id: roleSlots.id });
		return slot!.id;
	}

	async function addSpeech(opts?: {
		personId?: string;
		title?: string;
		archived?: boolean;
	}): Promise<string> {
		const [row] = await testDb
			.insert(speeches)
			.values({
				personId: opts?.personId ?? seed.personId,
				title: opts?.title ?? "Ice Breaker",
				archived: opts?.archived ?? false,
			})
			.returning({ id: speeches.id });
		return row!.id;
	}

	beforeEach(async () => {
		seed = await seedClub();
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		speakerRoleId = def!.id;
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	describe("listUnscheduledSpeeches derivation", () => {
		it("includes a speech with no slot reference", async () => {
			const { listUnscheduledSpeeches } = await import("./speeches-logic");
			const speechId = await addSpeech({ title: "Orphan draft" });

			const rows = await listUnscheduledSpeeches(testDb, {
				clubId: seed.clubId,
			});
			expect(rows.map((r) => r.id)).toContain(speechId);
			const row = rows.find((r) => r.id === speechId)!;
			expect(row.ownerName).toBe("Member User");
			expect(row.title).toBe("Orphan draft");
		});

		it("excludes a speech referenced by an active (non-cancelled) slot", async () => {
			const { listUnscheduledSpeeches } = await import("./speeches-logic");
			const speechId = await addSpeech();
			await addSpeakerSlot({
				assignedMemberId: seed.memberId,
				status: "claimed",
				speechId,
			});

			const rows = await listUnscheduledSpeeches(testDb, {
				clubId: seed.clubId,
			});
			expect(rows.map((r) => r.id)).not.toContain(speechId);
		});

		it("becomes unscheduled again when its slot's speech link is released", async () => {
			const { listUnscheduledSpeeches } = await import("./speeches-logic");
			const speechId = await addSpeech();
			const slotId = await addSpeakerSlot({
				assignedMemberId: seed.memberId,
				status: "claimed",
				speechId,
			});
			// Sanity: scheduled while linked.
			let rows = await listUnscheduledSpeeches(testDb, { clubId: seed.clubId });
			expect(rows.map((r) => r.id)).not.toContain(speechId);

			// Release the slot (unlink the speech) — the speech persists.
			await testDb
				.update(roleSlots)
				.set({ speechId: null, assignedMemberId: null, status: "open" })
				.where(eq(roleSlots.id, slotId));

			rows = await listUnscheduledSpeeches(testDb, { clubId: seed.clubId });
			expect(rows.map((r) => r.id)).toContain(speechId);
		});

		it("treats a speech on a cancelled meeting's slot as unscheduled", async () => {
			const { listUnscheduledSpeeches } = await import("./speeches-logic");
			const [cancelled] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() + 3 * 86400000),
					status: "cancelled",
				})
				.returning({ id: meetings.id });
			const speechId = await addSpeech();
			await addSpeakerSlot({
				meetingId: cancelled!.id,
				assignedMemberId: seed.memberId,
				status: "claimed",
				speechId,
			});

			const rows = await listUnscheduledSpeeches(testDb, {
				clubId: seed.clubId,
			});
			expect(rows.map((r) => r.id)).toContain(speechId);
		});

		it("hides archived speeches by default; includeArchived surfaces them", async () => {
			const { listUnscheduledSpeeches } = await import("./speeches-logic");
			const archivedId = await addSpeech({
				title: "Abandoned",
				archived: true,
			});

			let rows = await listUnscheduledSpeeches(testDb, { clubId: seed.clubId });
			expect(rows.map((r) => r.id)).not.toContain(archivedId);

			rows = await listUnscheduledSpeeches(testDb, {
				clubId: seed.clubId,
				includeArchived: true,
			});
			expect(rows.map((r) => r.id)).toContain(archivedId);
		});

		it("scopes to a single Person when personId is given", async () => {
			const { listUnscheduledSpeeches } = await import("./speeches-logic");
			const mine = await addSpeech({ personId: seed.personId, title: "Mine" });
			// A speech owned by a different Person (the admin's).
			const [adminMember] = await testDb
				.select({ personId: members.personId })
				.from(members)
				.where(eq(members.id, seed.adminMemberId))
				.limit(1);
			const theirs = await addSpeech({
				personId: adminMember!.personId,
				title: "Theirs",
			});

			const rows = await listUnscheduledSpeeches(testDb, {
				personId: seed.personId,
			});
			expect(rows.map((r) => r.id)).toContain(mine);
			expect(rows.map((r) => r.id)).not.toContain(theirs);
		});
	});

	describe("listOpenSpeakerSlots", () => {
		it("returns only open, unassigned, speechless speaker slots on upcoming meetings", async () => {
			const { listOpenSpeakerSlots } = await import("./speeches-logic");
			const openSlot = await addSpeakerSlot({ status: "open" });
			// Taken (assigned) — excluded.
			await addSpeakerSlot({
				assignedMemberId: seed.memberId,
				status: "claimed",
			});
			// Past meeting — excluded.
			const [past] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() - 5 * 86400000),
					status: "scheduled",
				})
				.returning({ id: meetings.id });
			await addSpeakerSlot({ meetingId: past!.id, status: "open" });

			const slots = await listOpenSpeakerSlots(testDb, seed.clubId);
			expect(slots.map((s) => s.slotId)).toEqual([openSlot]);
			expect(slots[0]!.roleName).toBe("Speaker");
		});
	});

	describe("setSpeechArchived", () => {
		it("archives and unarchives a speech", async () => {
			const { setSpeechArchived } = await import("./speeches-logic");
			const speechId = await addSpeech();

			await setSpeechArchived(testDb, {
				speechId,
				clubId: seed.clubId,
				archived: true,
			});
			let [row] = await testDb
				.select({ archived: speeches.archived })
				.from(speeches)
				.where(eq(speeches.id, speechId));
			expect(row!.archived).toBe(true);

			await setSpeechArchived(testDb, {
				speechId,
				clubId: seed.clubId,
				archived: false,
			});
			[row] = await testDb
				.select({ archived: speeches.archived })
				.from(speeches)
				.where(eq(speeches.id, speechId));
			expect(row!.archived).toBe(false);
		});

		it("rejects toggling a speech whose owner isn't in the club", async () => {
			const { setSpeechArchived } = await import("./speeches-logic");
			const otherClub = await seedClub();
			const speechId = await addSpeech({ personId: otherClub.personId });
			await expect(
				setSpeechArchived(testDb, {
					speechId,
					clubId: seed.clubId,
					archived: true,
				}),
			).rejects.toThrow(/owned by a member of this club/);
			await cleanup(otherClub.clubId, [
				otherClub.adminUserId,
				otherClub.memberUserId,
			]);
		});
	});

	describe("attachSpeechToOpenSlot (reschedule)", () => {
		it("attaches an unscheduled speech to an open speaker slot", async () => {
			const { attachSpeechToOpenSlot, listUnscheduledSpeeches } = await import(
				"./speeches-logic"
			);
			const speechId = await addSpeech();
			const slotId = await addSpeakerSlot({ status: "open" });

			const res = await attachSpeechToOpenSlot(testDb, {
				speechId,
				slotId,
				actorMemberId: seed.adminMemberId,
			});
			expect(res.assignedMemberId).toBe(seed.memberId);

			const [slot] = await testDb
				.select({
					speechId: roleSlots.speechId,
					assignedMemberId: roleSlots.assignedMemberId,
					status: roleSlots.status,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId));
			expect(slot!.speechId).toBe(speechId);
			expect(slot!.assignedMemberId).toBe(seed.memberId);
			expect(slot!.status).toBe("claimed");

			// No longer unscheduled.
			const rows = await listUnscheduledSpeeches(testDb, {
				clubId: seed.clubId,
			});
			expect(rows.map((r) => r.id)).not.toContain(speechId);
		});

		it("rejects a non-speaker slot", async () => {
			const { attachSpeechToOpenSlot } = await import("./speeches-logic");
			const speechId = await addSpeech();
			// seed.slotId is a functionary (Timer) slot.
			await expect(
				attachSpeechToOpenSlot(testDb, {
					speechId,
					slotId: seed.slotId,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(/speaker slot/);
		});

		it("rejects a slot that already has a speech or assignee", async () => {
			const { attachSpeechToOpenSlot } = await import("./speeches-logic");
			const speechId = await addSpeech();
			const takenSlot = await addSpeakerSlot({
				assignedMemberId: seed.adminMemberId,
				status: "claimed",
			});
			await expect(
				attachSpeechToOpenSlot(testDb, {
					speechId,
					slotId: takenSlot,
					actorMemberId: seed.adminMemberId,
				}),
			).rejects.toThrow(/already taken/);
		});

		it("clears a lingering cancelled-meeting link so the invariant holds", async () => {
			const { attachSpeechToOpenSlot } = await import("./speeches-logic");
			// Speech physically linked to a slot on a cancelled meeting (derived as
			// unscheduled, but the unique speech_id index still binds it).
			const [cancelled] = await testDb
				.insert(meetings)
				.values({
					clubId: seed.clubId,
					scheduledAt: new Date(Date.now() + 2 * 86400000),
					status: "cancelled",
				})
				.returning({ id: meetings.id });
			const speechId = await addSpeech();
			const oldSlot = await addSpeakerSlot({
				meetingId: cancelled!.id,
				assignedMemberId: seed.memberId,
				status: "claimed",
				speechId,
			});
			const newSlot = await addSpeakerSlot({ status: "open" });

			await attachSpeechToOpenSlot(testDb, {
				speechId,
				slotId: newSlot,
				actorMemberId: seed.adminMemberId,
			});

			const [oldRow] = await testDb
				.select({ speechId: roleSlots.speechId })
				.from(roleSlots)
				.where(eq(roleSlots.id, oldSlot));
			const [newRow] = await testDb
				.select({ speechId: roleSlots.speechId })
				.from(roleSlots)
				.where(eq(roleSlots.id, newSlot));
			expect(oldRow!.speechId).toBeNull();
			expect(newRow!.speechId).toBe(speechId);
		});
	});
});
