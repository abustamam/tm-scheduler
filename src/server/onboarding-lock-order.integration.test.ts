/**
 * The superadmin console's two `people` + `members` writers lock the Person
 * BEFORE the membership (#906 review), the order `applyMemberEdit` takes them
 * in. Each used to go membership-then-Person and deadlocked against an edit of
 * the same human:
 *   - `updateUnclaimedAdminEmail` wrote `members` and then `people`;
 *   - `deleteClubPermanently` deleted the club (whose cascade takes every
 *     membership) and only then locked the club's Persons.
 *
 * Driven deterministically, as in `edit-convert-lock-order.integration.test.ts`:
 * an edit-shaped transaction takes the Person lock exactly as `applyMemberEdit`
 * opens and parks; the console writer starts and the test waits until it is
 * provably blocked BY that transaction (`pg_blocking_pids`); then the edit-shaped
 * transaction writes the membership, the edit's second lock. With the fix the
 * console writer holds no membership yet and both commit; with the old order it
 * already does, and Postgres aborts one side with 40P01.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clubs, members, people } from "#/db/schema";
import { hasTestDb, testDb, waitForLockWait } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { updateUnclaimedAdminEmail, deleteClubPermanently } = await import(
	"./onboarding-logic"
);

function pgCode(reason: unknown): string | undefined {
	const e = reason as { code?: string; cause?: { code?: string } };
	return e?.code ?? e?.cause?.code;
}

const createdClubs: string[] = [];
const createdPeople: string[] = [];

/** A club whose only admin is an UNCLAIMED Person (no sign-in account). */
async function clubWithUnclaimedAdmin(archived: boolean) {
	const clubId = randomUUID();
	const name = `Lock Order ${clubId.slice(0, 8)}`;
	await testDb.insert(clubs).values({
		id: clubId,
		name,
		slug: `lock-order-${clubId}`,
		archivedAt: archived ? new Date() : null,
	});
	createdClubs.push(clubId);
	const email = `admin-${clubId}@test.example`;
	const [person] = await testDb
		.insert(people)
		.values({ name: "Unclaimed Admin", email })
		.returning({ id: people.id });
	if (!person) throw new Error("person insert failed");
	createdPeople.push(person.id);
	const [member] = await testDb
		.insert(members)
		.values({
			clubId,
			personId: person.id,
			name: "Unclaimed Admin",
			email,
			clubRole: "admin",
			status: "active",
		})
		.returning({ id: members.id });
	if (!member) throw new Error("membership insert failed");
	return { clubId, name, personId: person.id, memberId: member.id };
}

/**
 * An edit-shaped transaction: Person `FOR UPDATE`, park until released, then
 * write the membership. Returns once it holds the Person lock.
 */
async function editShaped(personId: string, memberId: string) {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let holding!: (pid: number) => void;
	const pidReady = new Promise<number>((r) => {
		holding = r;
	});
	const done = testDb.transaction(async (tx) => {
		const res = await tx.execute(sql`select pg_backend_pid() as pid`);
		await tx.execute(
			sql`select id from people where id = ${personId} for update`,
		);
		holding(Number((res.rows[0] as { pid: number }).pid));
		await gate;
		await tx.execute(
			sql`update members set name = name where id = ${memberId}`,
		);
	});
	done.catch(() => {});
	return { pid: await pidReady, release, done };
}

async function settleWithoutDeadlock(...work: Promise<unknown>[]) {
	const results = await Promise.allSettled(work);
	const codes = results
		.filter((r) => r.status === "rejected")
		.map((r) => pgCode((r as PromiseRejectedResult).reason));
	expect(codes, "a deadlock (40P01) means the lock orders differ").toEqual([]);
}

describe.skipIf(!hasTestDb)(
	"console writers lock the Person first (#906)",
	() => {
		afterEach(async () => {
			if (createdClubs.length > 0) {
				await testDb.delete(clubs).where(inArray(clubs.id, createdClubs));
			}
			if (createdPeople.length > 0) {
				await testDb.delete(people).where(inArray(people.id, createdPeople));
			}
			createdClubs.length = 0;
			createdPeople.length = 0;
		});

		it("updateUnclaimedAdminEmail racing an edit of that admin does not deadlock", async () => {
			const c = await clubWithUnclaimedAdmin(false);
			const edit = await editShaped(c.personId, c.memberId);
			const next = `fixed-${randomUUID()}@test.example`;

			const repairing = updateUnclaimedAdminEmail({
				clubId: c.clubId,
				email: next,
			});
			repairing.catch(() => {});
			await waitForLockWait('"people"', edit.pid);
			edit.release();

			await settleWithoutDeadlock(edit.done, repairing);
			const [p] = await testDb
				.select({ email: people.email })
				.from(people)
				.where(eq(people.id, c.personId));
			const [m] = await testDb
				.select({ email: members.email })
				.from(members)
				.where(eq(members.id, c.memberId));
			expect(p?.email).toBe(next);
			expect(m?.email).toBe(next);
		}, 20_000);

		it("deleteClubPermanently racing an edit of one of its members does not deadlock", async () => {
			const c = await clubWithUnclaimedAdmin(true);
			const edit = await editShaped(c.personId, c.memberId);

			const deleting = deleteClubPermanently(c.clubId, c.name);
			deleting.catch(() => {});
			await waitForLockWait('"people"', edit.pid);
			edit.release();

			await settleWithoutDeadlock(edit.done, deleting);
			const club = await testDb
				.select({ id: clubs.id })
				.from(clubs)
				.where(eq(clubs.id, c.clubId));
			const person = await testDb
				.select({ id: people.id })
				.from(people)
				.where(eq(people.id, c.personId));
			expect(club).toEqual([]);
			expect(person).toEqual([]);
		}, 20_000);
	},
);
