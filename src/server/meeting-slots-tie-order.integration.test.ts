/**
 * `loadMeetingSlots` orders ties deterministically (#1372).
 *
 * Nothing stops two roles sharing a `sortOrder`. Without a unique tail on the
 * ORDER BY, Postgres may return tied rows in a different order on each read,
 * so the meeting page and `get_agenda` could list such roles differently from
 * one load to the next (and get-agenda-readiness flaked on it).
 */
import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roleDefinitions, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadMeetingSlots } = await import("./meeting-slots-logic");

describe.skipIf(!hasTestDb)("loadMeetingSlots tied sortOrder", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	// protects=roles sharing a sortOrder come back role by role (lower role id
	// first), each role's slots together in slotIndex order, identically on
	// every read;
	// fails_when=the ORDER BY drops the role id or the slot id from its tail, so
	// tied rows come back in heap order and the roles interleave;
	// no_claim=rows that do not tie keep their order: every other loader test.
	it("keeps each tied role's slots together and reads the same every time", async () => {
		const defs = await testDb
			.insert(roleDefinitions)
			.values(
				["Alpha", "Beta"].map((name) => ({
					clubId: seed.clubId,
					name,
					category: "functionary" as const,
					sortOrder: 50,
				})),
			)
			.returning({ id: roleDefinitions.id });
		const [low, high] = defs.map((d) => d.id).sort();
		if (!low || !high) throw new Error("role insert failed");

		// Inserted so heap order is the OPPOSITE of the expected order.
		const values = [
			{ roleDefinitionId: high, slotIndex: 0 },
			{ roleDefinitionId: low, slotIndex: 1 },
			{ roleDefinitionId: low, slotIndex: 0 },
		];
		const inserted = await testDb
			.insert(roleSlots)
			.values(values.map((v) => ({ ...v, meetingId: seed.meetingId })))
			.returning({ id: roleSlots.id });
		const mine = new Set(inserted.map((s) => s.id));
		await testDb
			.select()
			.from(roleSlots)
			.where(inArray(roleSlots.id, [...mine]));

		const read = async () =>
			(await loadMeetingSlots(seed.meetingId))
				.filter((s) => mine.has(s.id))
				.map((s) => `${s.roleDefinitionId}:${s.slotIndex}`);

		const expected = [`${low}:0`, `${low}:1`, `${high}:0`];
		const first = await read();
		expect(first).toEqual(expected);
		for (let i = 0; i < 5; i++) expect(await read()).toEqual(first);
	});

	// protects=two slots of one role at the same slotIndex still come back in
	// slot id order, every read;
	// fails_when=the slot id is dropped from the ORDER BY tail;
	// no_claim=whether such duplicates arise in practice: the schema allows them.
	it("orders slots tied on role and slotIndex by slot id", async () => {
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Gamma",
				category: "functionary",
				sortOrder: 60,
			})
			.returning({ id: roleDefinitions.id });
		if (!def) throw new Error("role insert failed");
		const ids: string[] = [];
		for (let i = 0; i < 8; i++) {
			const [row] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: seed.meetingId,
					roleDefinitionId: def.id,
					slotIndex: 0,
				})
				.returning({ id: roleSlots.id });
			if (!row) throw new Error("slot insert failed");
			ids.push(row.id);
		}
		// Heap order is insertion order (random uuids), so only the id tail sorts.
		const read = async () =>
			(await loadMeetingSlots(seed.meetingId))
				.filter((s) => ids.includes(s.id))
				.map((s) => s.id);
		const expected = [...ids].sort();
		expect(await read()).toEqual(expected);
		expect(await read()).toEqual(expected);
	});
});
