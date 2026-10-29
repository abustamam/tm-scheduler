/**
 * `applyMemberEdit` retries ONCE when Postgres picks it as a deadlock victim
 * (#1388) — the pair with a speaker claim, which holds the member row
 * `FOR SHARE` and then key-shares the Person the edit holds `FOR UPDATE`.
 * The first attempt here runs the real edit body to the end and is then failed
 * with a 40P01 (so it rolls back), standing in for the abort.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMemberEdit } = await import("./members-logic");
const { CLUB_BUSY_MESSAGE } = await import("./club-write-lock");

const deadlock = () =>
	Object.assign(new Error("deadlock detected"), { code: "40P01" });

describe.skipIf(!hasTestDb)("applyMemberEdit deadlock retry (#1388)", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	const input = (name: string) => ({
		clubId: seed.clubId,
		memberId: seed.memberId,
		actorMemberId: seed.adminMemberId,
		name,
	});
	const personName = async () =>
		(
			await testDb
				.select({ name: members.name })
				.from(members)
				.where(eq(members.id, seed.memberId))
		)[0]?.name;

	// protects=an edit chosen as a deadlock victim reruns on a new transaction and commits;
	// fails_when=applyMemberEdit is not wrapped in withDeadlockRetry;
	// no_claim=the real claim/edit deadlock.
	it("commits on the second attempt after one 40P01", async () => {
		const real = testDb.transaction.bind(testDb);
		const spy = vi.spyOn(testDb, "transaction");
		spy.mockImplementationOnce(((cb: (tx: never) => Promise<unknown>) =>
			real(async (tx) => {
				await cb(tx as never);
				throw deadlock();
			})) as never);
		await expect(applyMemberEdit(input("Retried Name"))).resolves.toMatchObject(
			{ ok: true, emailRefused: null },
		);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(await personName()).toBe("Retried Name");
	}, 20_000);

	it("two 40P01s give CLUB_BUSY_MESSAGE and write nothing", async () => {
		const before = await personName();
		const real = testDb.transaction.bind(testDb);
		const spy = vi.spyOn(testDb, "transaction");
		const failing = ((cb: (tx: never) => Promise<unknown>) =>
			real(async (tx) => {
				await cb(tx as never);
				throw deadlock();
			})) as never;
		spy.mockImplementationOnce(failing).mockImplementationOnce(failing);
		const err = await applyMemberEdit(input("Never Written")).catch(
			(e: unknown) => e,
		);
		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
		expect((err as { cause?: { code?: string } }).cause?.code).toBe("40P01");
		expect(spy).toHaveBeenCalledTimes(2);
		expect(await personName()).toBe(before);
	}, 20_000);

	it("a non-deadlock error is not retried", async () => {
		const spy = vi.spyOn(testDb, "transaction");
		await expect(
			applyMemberEdit({
				...input("x"),
				memberId: seed.adminMemberId,
				clubId: "00000000-0000-4000-8000-000000000000",
			}),
		).rejects.toThrow("Member not found.");
		expect(spy).not.toHaveBeenCalled();
	});
});
