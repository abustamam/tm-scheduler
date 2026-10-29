/**
 * `applyMemberEdit` retries ONCE when Postgres picks it as a deadlock victim
 * (#1388) — the pair with a speaker claim, which holds the member row
 * `FOR SHARE` and then key-shares the Person the edit holds `FOR UPDATE`.
 * The first attempt here runs the real edit body to the end and is then failed
 * with a 40P01 (so it rolls back), standing in for the abort.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members, people } from "#/db/schema";
import { CONTACT_METHOD_UNAVAILABLE_MESSAGE } from "#/lib/preferred-contact";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";
import { failingTransaction } from "#/test/deadlock";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { applyMemberEdit } = await import("./members-logic");
const { CLUB_BUSY_MESSAGE } = await import("./club-write-lock");

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
		spy.mockImplementationOnce(failingTransaction(real as never));
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
		const failing = failingTransaction(real as never);
		spy.mockImplementationOnce(failing).mockImplementationOnce(failing);
		const err = await applyMemberEdit(input("Never Written")).catch(
			(e: unknown) => e,
		);
		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
		expect((err as { cause?: { code?: string } }).cause?.code).toBe("40P01");
		expect(spy).toHaveBeenCalledTimes(2);
		expect(await personName()).toBe(before);
	}, 20_000);

	// protects=an error thrown from INSIDE the transaction body that is not a 40P01 propagates at once: the transaction ran exactly once;
	// fails_when=withDeadlockRetry retries every error (the body would run twice);
	// no_claim=a deadlock wrapped in another error (deadlock-retry.test.ts).
	it("a non-deadlock error thrown inside the transaction is not retried", async () => {
		const spy = vi.spyOn(testDb, "transaction");
		// SMS with no phone on file: refused from the transaction body.
		await expect(
			applyMemberEdit({ ...input("x"), preferredContact: "sms" }),
		).rejects.toThrow(CONTACT_METHOD_UNAVAILABLE_MESSAGE);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(await personName()).not.toBe("x");
	}, 20_000);

	// protects=the email outcome in the result comes from the second attempt only: the first attempt finds the Person bound and refuses the address (emailRefused "bound"), is rolled back, the Person is then unbound, and the second attempt writes it;
	// fails_when=the outer emailRefused / emailChange are declared outside withDeadlockRetry's callback, so the aborted attempt's refusal survives;
	// no_claim=the real claim/edit deadlock.
	it("reports the email outcome of the second attempt only", async () => {
		const [row] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, seed.memberId));
		if (!row) throw new Error("no person");
		const { personId } = row;
		const real = testDb.transaction.bind(testDb);
		const spy = vi.spyOn(testDb, "transaction");
		spy.mockImplementationOnce(
			failingTransaction(real as never, async () => {
				// Between the attempts the address becomes writable.
				await testDb
					.update(people)
					.set({ userId: null })
					.where(eq(people.id, personId));
			}),
		);
		const result = await applyMemberEdit({
			...input("Second Attempt"),
			email: "second-attempt@example.com",
		});
		expect(spy).toHaveBeenCalledTimes(2);
		expect(result.emailRefused).toBeNull();
		const [after] = await testDb
			.select({ email: people.email })
			.from(people)
			.where(eq(people.id, personId));
		expect(after?.email).toBe("second-attempt@example.com");
	}, 20_000);
});
