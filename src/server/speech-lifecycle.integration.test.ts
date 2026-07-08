/**
 * DB-backed integration tests for the Speech pointer lifecycle (ADR-0009 / #79).
 *
 * These exercise the REAL slots-logic helpers (attach / unlink / reassign / edit)
 * against a live Postgres identified by TEST_DATABASE_URL. #/db is mocked to the
 * test client so importing slots-logic doesn't require a DATABASE_URL; the helpers
 * take an explicit connection, so we pass `testDb`.
 *
 * When TEST_DATABASE_URL is unset the whole suite is skipped.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, roleDefinitions, roleSlots, speeches } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("speech pointer lifecycle (ADR-0009)", () => {
	let seed: SeededClub;
	let speakerRoleId: string;
	let speakerSlotId: string;
	let secondPersonId: string;

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
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: speakerRoleId,
				status: "claimed",
				assignedMemberId: seed.memberId,
			})
			.returning({ id: roleSlots.id });
		speakerSlotId = slot!.id;
		secondPersonId = await seedPerson({ name: "Second Person" });
		// A membership for the second Person so cleanup collects+removes it.
		await testDb.insert(members).values({
			clubId: seed.clubId,
			personId: secondPersonId,
			name: "Second Person",
		});
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function speechIdOf(slotId: string): Promise<string | null> {
		const [row] = await testDb
			.select({ speechId: roleSlots.speechId })
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId))
			.limit(1);
		return row?.speechId ?? null;
	}

	it("attachSpeechToSlot creates a Person-owned speech and links it; empty input creates none", async () => {
		const { attachSpeechToSlot } = await import("./slots-logic");
		// Pure-TBA input → no speech, slot stays TBA.
		const none = await attachSpeechToSlot(testDb, {
			slotId: speakerSlotId,
			personId: seed.personId,
			input: { speechTitle: "TBA" },
		});
		expect(none).toBeNull();
		expect(await speechIdOf(speakerSlotId)).toBeNull();

		// Real content → speech created + linked, owned by the claimant's Person.
		const id = await attachSpeechToSlot(testDb, {
			slotId: speakerSlotId,
			personId: seed.personId,
			input: { speechTitle: "Ice Breaker", pathwayPath: "Dynamic Leadership" },
		});
		expect(id).not.toBeNull();
		const [sp] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, id!));
		expect(sp?.title).toBe("Ice Breaker");
		expect(sp?.pathwayPath).toBe("Dynamic Leadership");
		expect(sp?.personId).toBe(seed.personId);
		expect(await speechIdOf(speakerSlotId)).toBe(id);
	});

	it("reassign to a DIFFERENT person clears the pointer but preserves the speech", async () => {
		const { attachSpeechToSlot, reassignSlotSpeech } = await import(
			"./slots-logic"
		);
		const speechId = await attachSpeechToSlot(testDb, {
			slotId: speakerSlotId,
			personId: seed.personId,
			input: { speechTitle: "My Talk" },
		});

		const unlinked = await reassignSlotSpeech(testDb, {
			slotId: speakerSlotId,
			fromPersonId: seed.personId,
			toPersonId: secondPersonId,
		});
		expect(unlinked).toBe(true);
		expect(await speechIdOf(speakerSlotId)).toBeNull();

		// The speech is NOT deleted — it persists, still owned by the original Person.
		const [sp] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, speechId!));
		expect(sp?.title).toBe("My Talk");
		expect(sp?.personId).toBe(seed.personId);
	});

	it("reassign within the SAME person keeps the speech attached", async () => {
		const { attachSpeechToSlot, reassignSlotSpeech } = await import(
			"./slots-logic"
		);
		const speechId = await attachSpeechToSlot(testDb, {
			slotId: speakerSlotId,
			personId: seed.personId,
			input: { speechTitle: "Keep Me" },
		});
		const unlinked = await reassignSlotSpeech(testDb, {
			slotId: speakerSlotId,
			fromPersonId: seed.personId,
			toPersonId: seed.personId,
		});
		expect(unlinked).toBe(false);
		expect(await speechIdOf(speakerSlotId)).toBe(speechId);
	});

	it("reschedule moves the speech pointer to a new slot; the old slot clears", async () => {
		const { attachSpeechToSlot, unlinkSlotSpeech } = await import(
			"./slots-logic"
		);
		const speechId = await attachSpeechToSlot(testDb, {
			slotId: speakerSlotId,
			personId: seed.personId,
			input: { speechTitle: "Reschedule Me" },
		});
		const [newSlot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: speakerRoleId,
				slotIndex: 1,
				status: "claimed",
				assignedMemberId: seed.memberId,
			})
			.returning({ id: roleSlots.id });

		// Reschedule = clear old, point new (clear first to honor the unique index).
		await unlinkSlotSpeech(testDb, speakerSlotId);
		await testDb
			.update(roleSlots)
			.set({ speechId })
			.where(eq(roleSlots.id, newSlot!.id));

		expect(await speechIdOf(speakerSlotId)).toBeNull();
		expect(await speechIdOf(newSlot!.id)).toBe(speechId);
	});

	it("enforces at most one slot per speech (unique index)", async () => {
		const { attachSpeechToSlot } = await import("./slots-logic");
		const speechId = await attachSpeechToSlot(testDb, {
			slotId: speakerSlotId,
			personId: seed.personId,
			input: { speechTitle: "Only Once" },
		});
		const [otherSlot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: speakerRoleId,
				slotIndex: 2,
				status: "open",
			})
			.returning({ id: roleSlots.id });

		await expect(
			testDb
				.update(roleSlots)
				.set({ speechId })
				.where(eq(roleSlots.id, otherSlot!.id)),
		).rejects.toThrow();
	});

	it("editSlotSpeech creates when absent, updates in place, and unlinks on blank", async () => {
		const { editSlotSpeech } = await import("./slots-logic");
		// No speech yet + real content → create + link.
		await editSlotSpeech(testDb, {
			slotId: speakerSlotId,
			personId: seed.personId,
			currentSpeechId: null,
			input: { speechTitle: "First" },
		});
		const created = await speechIdOf(speakerSlotId);
		expect(created).not.toBeNull();

		// Existing speech + real content → update in place (same id).
		await editSlotSpeech(testDb, {
			slotId: speakerSlotId,
			personId: seed.personId,
			currentSpeechId: created,
			input: { speechTitle: "Second" },
		});
		expect(await speechIdOf(speakerSlotId)).toBe(created);
		const [sp] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, created!));
		expect(sp?.title).toBe("Second");

		// Blank input → unlink the slot, but the speech persists.
		await editSlotSpeech(testDb, {
			slotId: speakerSlotId,
			personId: seed.personId,
			currentSpeechId: created,
			input: { speechTitle: "" },
		});
		expect(await speechIdOf(speakerSlotId)).toBeNull();
		const [still] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, created!));
		expect(still?.title).toBe("Second");
	});

	// -------------------------------------------------------------------------
	// attachSpeechToOpenSlot race guard (ADR-0005 / #125). The conditional
	// UPDATE is the last-line guard: concurrent attaches onto one open slot must
	// resolve to exactly one winner, never last-writer-wins.
	// -------------------------------------------------------------------------

	/** Insert an unscheduled Person-owned speech and return its id. */
	async function seedSpeech(personId: string, title: string): Promise<string> {
		const [row] = await testDb
			.insert(speeches)
			.values({ personId, title })
			.returning({ id: speeches.id });
		return row!.id;
	}

	/** Insert an OPEN speaker slot on the seeded meeting and return its id. */
	async function seedOpenSpeakerSlot(slotIndex: number): Promise<string> {
		const [row] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: speakerRoleId,
				slotIndex,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		return row!.id;
	}

	it("concurrent attach onto one open slot: exactly one wins, one is rejected", async () => {
		const { attachSpeechToOpenSlot } = await import("./speeches-logic");
		const openSlotId = await seedOpenSpeakerSlot(10);
		// Two unscheduled speeches owned by two DIFFERENT active members.
		const speechA = await seedSpeech(seed.personId, "Talk A");
		const speechB = await seedSpeech(secondPersonId, "Talk B");

		// Pass `testDb` (not a tx) so the two calls actually interleave.
		const results = await Promise.allSettled([
			attachSpeechToOpenSlot(testDb, {
				speechId: speechA,
				slotId: openSlotId,
				actorMemberId: null,
			}),
			attachSpeechToOpenSlot(testDb, {
				speechId: speechB,
				slotId: openSlotId,
				actorMemberId: null,
			}),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);

		const winner = (
			fulfilled[0] as PromiseFulfilledResult<{
				clubId: string;
				assignedMemberId: string;
			}>
		).value;

		// The slot ends claimed with the winner's assignee and one of the speeches.
		const [row] = await testDb
			.select({
				status: roleSlots.status,
				speechId: roleSlots.speechId,
				assignedMemberId: roleSlots.assignedMemberId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, openSlotId))
			.limit(1);
		expect(row?.status).toBe("claimed");
		expect(row?.assignedMemberId).toBe(winner.assignedMemberId);
		expect([speechA, speechB]).toContain(row?.speechId);
	});

	it("attach onto an already-claimed slot is rejected", async () => {
		const { attachSpeechToOpenSlot } = await import("./speeches-logic");
		// Pre-claim a fresh speaker slot directly.
		const takenSlotId = await seedOpenSpeakerSlot(11);
		await testDb
			.update(roleSlots)
			.set({ status: "claimed", assignedMemberId: seed.memberId })
			.where(eq(roleSlots.id, takenSlotId));

		const speechId = await seedSpeech(secondPersonId, "Too Late");
		await expect(
			attachSpeechToOpenSlot(testDb, {
				speechId,
				slotId: takenSlotId,
				actorMemberId: null,
			}),
		).rejects.toThrow();

		// The slot is untouched — still the original claimant, no speech.
		const [row] = await testDb
			.select({
				assignedMemberId: roleSlots.assignedMemberId,
				speechId: roleSlots.speechId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, takenSlotId))
			.limit(1);
		expect(row?.assignedMemberId).toBe(seed.memberId);
		expect(row?.speechId).toBeNull();
	});
});
