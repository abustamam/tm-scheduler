/**
 * `assign_roles`' meeting lock against real concurrent writers (#874).
 *
 * The tool locks the meeting row before it locks the slots it names. A plain
 * member claim takes those in the OTHER order without meaning to: its
 * conditional UPDATE holds the slot row, and its attendance-plan write then
 * needs `FOR KEY SHARE` on the meeting row for the foreign key. If the tool's
 * meeting lock conflicts with `KEY SHARE` that is a cycle, and Postgres aborts
 * one side with `40P01`. `FOR NO KEY UPDATE` admits `KEY SHARE` while still
 * excluding another editor, which is what #839 did for the lineup editors.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/assign-roles-lock.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiTokens, meetingAttendancePlan, roleSlots } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/**
 * Parks the FIRST `reassignSlotCore` of a call until released, so one
 * `assign_roles` transaction can be held open, locks and all, while a second
 * one starts. Wrapped, not replaced: the real write still runs.
 */
const gate = vi.hoisted(() => ({
	armed: false,
	entered: null as null | ((pid: number) => void),
	release: null as null | Promise<void>,
}));

vi.mock("#/server/slots-logic", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/server/slots-logic")>();
	return {
		...actual,
		reassignSlotCore: async (
			...args: Parameters<typeof actual.reassignSlotCore>
		) => {
			if (gate.armed) {
				gate.armed = false;
				// The held call's backend: the one a second call must wait behind.
				const res = await args[0].execute(sql`select pg_backend_pid() as pid`);
				gate.entered?.(Number((res.rows[0] as { pid: number }).pid));
				await gate.release;
			}
			return actual.reassignSlotCore(...args);
		},
	};
});

const { assignRolesTool } = await import("#/server/mcp/tools/assign-roles");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { claimSlotCore, markComingOnSelfClaim } = await import(
	"#/server/slots-logic"
);

/**
 * Await `signal`, unless `work` settles first — in which case `signal` can
 * never fire, and waiting on it would hang to the test timeout and lose the
 * real error. `work` rejecting rethrows its own error; `work` resolving
 * without signalling names the step that was never reached.
 */
function settledFirst<T>(
	signal: Promise<T>,
	work: Promise<unknown>,
	what: string,
): Promise<T> {
	return Promise.race([
		signal,
		work.then(() => {
			throw new Error(`${what} finished without reaching its hold point`);
		}),
	]);
}

/** "ok", or the SQLSTATE and message of whatever a settled side threw. */
function outcome(r: PromiseSettledResult<unknown>): string {
	if (r.status === "fulfilled") return "ok";
	const e = r.reason as { message?: string; cause?: { code?: string } };
	return `${e.cause?.code ?? "no-sqlstate"}: ${e.message?.split("\n")[0]}`;
}

describe.skipIf(!hasTestDb)("assign_roles meeting lock (#874)", () => {
	let seed: SeededClub;
	let token: string;

	function call(args: Record<string, unknown>) {
		return assignRolesTool.handler(args, { rawToken: token });
	}

	async function slotState(slotId: string) {
		const [row] = await testDb
			.select({
				status: roleSlots.status,
				assignedMemberId: roleSlots.assignedMemberId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		return row;
	}

	beforeEach(async () => {
		gate.armed = false;
		gate.entered = null;
		gate.release = null;
		seed = await seedClub();
		token = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: seed.adminUserId, tokenHash: hashApiToken(token) });
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("does not deadlock against a member claim that is mid-way through its attendance write", async () => {
		// The claim, in the order the interleaving needs. `claimSlotCore` with no
		// actor runs its conditional UPDATE and skips the attendance write; the
		// attendance write is then `markComingOnSelfClaim`, the exact call
		// `claimSlotCore` makes for a self-claim. Split only so the tool can be
		// parked between the two halves — no single call can be paused there.
		let resume!: () => void;
		const resumed = new Promise<void>((r) => {
			resume = r;
		});
		let holding!: (pid: number) => void;
		const held = new Promise<number>((r) => {
			holding = r;
		});
		const claim = testDb.transaction(async (tx) => {
			const res = await tx.execute(sql`select pg_backend_pid() as pid`);
			const pid = Number((res.rows[0] as { pid: number }).pid);
			await claimSlotCore(tx, {
				slotId: seed.slotId,
				memberId: seed.memberId,
				actorMemberId: null,
			});
			holding(pid);
			await resumed;
			await markComingOnSelfClaim(tx, {
				memberId: seed.memberId,
				actorMemberId: seed.memberId,
				meetingId: seed.meetingId,
				clubId: seed.clubId,
			});
		});
		claim.catch(() => {});

		let tool: Promise<unknown> | undefined;
		try {
			const claimPid = await settledFirst(held, claim, "the claim");

			// The tool locks the meeting, then parks on the slot the claim holds.
			tool = call({
				meetingId: seed.meetingId,
				assignments: [{ slotId: seed.slotId, memberId: seed.adminMemberId }],
			});
			tool.catch(() => {});
			await waitForLockWait("role_slots", claimPid);
		} finally {
			// Now the claim writes attendance, which needs KEY SHARE on the
			// meeting. In `finally` so a failed wait still lets the claim commit
			// and release its slot lock, rather than leaving afterEach's cascade
			// delete blocked behind it.
			resume();
			await Promise.allSettled([claim, tool]);
		}
		const [claimResult, toolResult] = await Promise.allSettled([claim, tool]);

		// A deadlock surfaces as a failed query whose `cause.code` is `40P01`,
		// on whichever side Postgres picked — so both sides are checked.
		expect(outcome(claimResult)).toBe("ok");
		expect(outcome(toolResult)).toBe("ok");

		// Both landed. The tool overwrote X exactly as it overwrites any held
		// slot, and its plan names the claimant it took the slot from. That half
		// is the lock-then-read split in `lockSlots`: one joined
		// `SELECT … FOR UPDATE` that waited here re-read the slot row after the
		// claim committed but kept the holder join from before it, and said
		// "open".
		const plan = (
			toolResult as PromiseFulfilledResult<{
				plan: { from: string; to: string }[];
			}>
		).value.plan;
		expect(plan[0]?.from).toBe("Member User");
		expect(await slotState(seed.slotId)).toEqual({
			status: "claimed",
			assignedMemberId: seed.adminMemberId,
		});
		const [planned] = await testDb
			.select({ status: meetingAttendancePlan.status })
			.from(meetingAttendancePlan)
			.where(
				and(
					eq(meetingAttendancePlan.meetingId, seed.meetingId),
					eq(meetingAttendancePlan.memberId, seed.memberId),
				),
			);
		expect(planned?.status).toBe("coming");
	}, 30_000);

	it("still serialises two assign_roles calls on one meeting", async () => {
		// A second slot, so the two calls share no slot row: the meeting lock is
		// the only thing that can make the second wait.
		const [other] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: seed.roleDefinitionId,
				slotIndex: 1,
				status: "open",
			})
			.returning({ id: roleSlots.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		const otherSlotId = other!.id;

		let release!: () => void;
		gate.release = new Promise<void>((r) => {
			release = r;
		});
		const entered = new Promise<number>((r) => {
			gate.entered = r;
		});
		gate.armed = true;

		const first = call({
			meetingId: seed.meetingId,
			assignments: [{ slotId: seed.slotId, memberId: seed.memberId }],
		});
		first.catch(() => {});

		let second: Promise<unknown> | undefined;
		let blocked = false;
		try {
			const firstPid = await settledFirst(entered, first, "the first call");

			second = call({
				meetingId: seed.meetingId,
				assignments: [{ slotId: otherSlotId, memberId: seed.adminMemberId }],
			});
			second.catch(() => {});

			// Parked on the meeting row, behind the held first call.
			await waitForLockWait('from "meetings"', firstPid, 5_000);
			blocked = true;
		} finally {
			release();
			await Promise.allSettled([first, second]);
		}
		expect(blocked).toBe(true);
		await expect(first).resolves.toMatchObject({ applied: true });
		await expect(second).resolves.toMatchObject({ applied: true });
		expect((await slotState(otherSlotId))?.assignedMemberId).toBe(
			seed.adminMemberId,
		);
	}, 30_000);
});
