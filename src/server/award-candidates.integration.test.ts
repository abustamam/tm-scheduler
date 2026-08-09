/**
 * The single derivation of who may win each award (#510). Both the public
 * ballot and the server-side vote validator read this, so a drift between them
 * is impossible by construction rather than by discipline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
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

const { loadAwardCandidates } = await import("#/server/award-candidates-logic");

describe.skipIf(!hasTestDb)("loadAwardCandidates (#510)", () => {
	let seed: SeededClub;

	beforeEach(async () => {
		seed = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function addRole(name: string, category: "speaker" | "evaluator") {
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({ clubId: seed.clubId, name, category, sortOrder: 99 })
			.returning({ id: roleDefinitions.id });
		return def.id;
	}

	it("lists speaker-slot holders under best_speaker, with names", async () => {
		const roleId = await addRole("Speaker", "speaker");
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: roleId,
			slotIndex: 0,
			assignedMemberId: seed.memberId,
		});
		const c = await loadAwardCandidates(seed.meetingId);
		expect(c.best_speaker).toHaveLength(1);
		expect(c.best_speaker[0]).toMatchObject({
			kind: "member",
			id: seed.memberId,
		});
		expect(typeof c.best_speaker[0].name).toBe("string");
		expect(c.best_speaker[0].name.length).toBeGreaterThan(0);
	});

	it("lists evaluator-slot holders under best_evaluator only", async () => {
		const roleId = await addRole("Evaluator", "evaluator");
		await testDb.insert(roleSlots).values({
			meetingId: seed.meetingId,
			roleDefinitionId: roleId,
			slotIndex: 0,
			assignedMemberId: seed.memberId,
		});
		const c = await loadAwardCandidates(seed.meetingId);
		expect(c.best_evaluator.map((x) => x.id)).toEqual([seed.memberId]);
		expect(c.best_speaker).toEqual([]);
	});

	it("lists table topics speakers, members and guests alike", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({ clubId: seed.clubId, name: "Okafor, Chidi" })
			.returning({ id: guests.id });
		await testDb.insert(tableTopicsSpeakers).values([
			{ meetingId: seed.meetingId, memberId: seed.memberId, sortOrder: 0 },
			{ meetingId: seed.meetingId, guestId: g.id, sortOrder: 1 },
		]);
		const c = await loadAwardCandidates(seed.meetingId);
		expect(c.best_table_topics).toHaveLength(2);
		expect(c.best_table_topics.map((x) => x.kind).sort()).toEqual([
			"guest",
			"member",
		]);
		expect(c.best_table_topics.find((x) => x.kind === "guest")?.name).toBe(
			"Okafor, Chidi",
		);
	});

	it("de-dupes a member holding two speaker slots", async () => {
		const roleId = await addRole("Speaker", "speaker");
		await testDb.insert(roleSlots).values([
			{
				meetingId: seed.meetingId,
				roleDefinitionId: roleId,
				slotIndex: 0,
				assignedMemberId: seed.memberId,
			},
			{
				meetingId: seed.meetingId,
				roleDefinitionId: roleId,
				slotIndex: 1,
				assignedMemberId: seed.memberId,
			},
		]);
		const c = await loadAwardCandidates(seed.meetingId);
		expect(c.best_speaker).toHaveLength(1);
	});

	it("returns no contact details on any candidate", async () => {
		const [g] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Rivera, Ana",
				email: "ana@example.com",
				phone: "+15551234567",
			})
			.returning({ id: guests.id });
		await testDb
			.insert(tableTopicsSpeakers)
			.values({ meetingId: seed.meetingId, guestId: g.id, sortOrder: 0 });
		const c = await loadAwardCandidates(seed.meetingId);
		const serialized = JSON.stringify(c);
		expect(serialized).not.toContain("ana@example.com");
		expect(serialized).not.toContain("5551234567");
	});
});
