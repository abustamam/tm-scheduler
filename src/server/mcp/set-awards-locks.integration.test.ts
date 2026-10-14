/**
 * The locks `set_awards` (#1172) takes, driven on real connections.
 *
 * Two interleavings, each made deterministic by a third connection holding the
 * lock the subject must wait for (proved through `pg_blocking_pids`, so the
 * subject is provably parked and not merely slow), the way
 * `membership-merge-race.integration.test.ts` does it. No timing sleeps.
 *
 * 1. A ruling or a vote opening while the call waits on the meeting row. The
 *    holder takes `FOR SHARE` on the meeting, as `disqualifyCandidate` and
 *    `openVote` do, which conflicts with the tool's `FOR NO KEY UPDATE`. The
 *    holder's write is invisible until it commits, so a read taken BEFORE the
 *    lock misses it; the tool reads after the lock and refuses.
 * 2. A membership merge absorbing the winner (#1035). The merge parks on its
 *    final DELETE, the writer is started, and the merge then commits. Without
 *    the merge lock the writer records a winner inside that window and `on
 *    delete set null` leaves a row naming nobody under a success; with it the
 *    writer waits for the merge and is refused with `CLUB_BUSY_MESSAGE`. The
 *    web `setAward` has the same gap and is covered the same way.
 *
 * Each case carries its card: protects / fails_when / no_claim.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	meetingAwards,
	meetingCandidateDisqualifications,
	meetingVoteSessions,
	members,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { setAwardsTool } = await import("#/server/mcp/tools/set-awards");
const { McpError } = await import("#/server/mcp/errors");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { collapseMemberships } = await import(
	"#/server/membership-collapse-logic"
);
const { setAward } = await import("#/server/minutes-logic");
const { CLUB_BUSY_MESSAGE } = await import("#/server/club-write-lock");

const inFlight: Promise<unknown>[] = [];
const openHolds: Array<{ commit: () => Promise<void> }> = [];

async function openHold(work: Parameters<typeof openBlockingTx>[0]) {
	const h = await openBlockingTx(work);
	openHolds.push(h);
	return h;
}

const outcome = (p: Promise<unknown>) =>
	p.then(
		() => null,
		(e: unknown) => e,
	);

/** Resolve once `subject` settled OR a statement matching `match` is parked behind `blockedBy`. */
async function settledOrBlocked(
	subject: Promise<unknown>,
	match: string,
	blockedBy: number,
): Promise<void> {
	let settled = false;
	subject.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (settled) return;
		const res = await testDb.execute(sql`
			select pid from pg_stat_activity
			where datname = current_database()
			  and state = 'active' and wait_event_type = 'Lock'
			  and query ilike ${`%${match}%`}
			  and ${blockedBy} = any(pg_blocking_pids(pid))
			limit 1`);
		if (res.rows.length > 0) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("the writer neither finished nor parked behind the holder");
}

describe.skipIf(!hasTestDb)("set_awards locks (#1172)", () => {
	let seed: SeededClub;
	let token: string;

	const call = (args: Record<string, unknown>) =>
		setAwardsTool.handler(args, { rawToken: token });

	const awardRows = () =>
		testDb
			.select()
			.from(meetingAwards)
			.where(eq(meetingAwards.meetingId, seed.meetingId));

	beforeEach(async () => {
		seed = await seedClub();
		token = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: seed.adminUserId, tokenHash: hashApiToken(token) });
	});

	afterEach(async () => {
		for (const h of openHolds.splice(0)) await h.commit().catch(() => {});
		await Promise.allSettled(inFlight.splice(0));
		await testDb
			.delete(apiTokens)
			.where(inArray(apiTokens.userId, [seed.adminUserId, seed.memberUserId]));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/** A call parked on the meeting row behind a `FOR SHARE` holder that wrote `work`. */
	async function callParkedBehindMeetingShare(
		args: Record<string, unknown>,
		work: Parameters<typeof openBlockingTx>[0],
	) {
		const hold = await openHold(async (tx) => {
			await tx.execute(
				sql`select 1 from meetings where id = ${seed.meetingId} for share`,
			);
			await work(tx);
		});
		const running = call(args);
		inFlight.push(running);
		const settled = outcome(running);
		await waitForLockWait("no key update", hold.pid);
		await hold.commit();
		return settled;
	}

	it("sees a ruling that committed while it waited on the meeting lock, and refuses", async () => {
		// protects=the ruling is read AFTER the meeting lock, so a ruling in flight is not missed
		// fails_when=the ruling is read before the lock: the call records the ruled-out candidate
		// no_claim=a ruling committed after the tool's lock is released is the web setAward's window, not this tool's
		const result = await callParkedBehindMeetingShare(
			{
				meetingId: seed.meetingId,
				awards: [{ category: "best_speaker", memberId: seed.memberId }],
			},
			async (tx) => {
				await tx.insert(meetingCandidateDisqualifications).values({
					meetingId: seed.meetingId,
					category: "best_speaker",
					candidateMemberId: seed.memberId,
					reason: "Spoke over time",
				});
			},
		);

		expect(result).toBeInstanceOf(McpError);
		const blocking = (
			(result as InstanceType<typeof McpError>).detail as {
				blocking: { code: string }[];
			}
		).blocking;
		expect(blocking.map((b) => b.code)).toEqual(["AWARD_RULED_OUT"]);
		expect(await awardRows()).toHaveLength(0);
	});

	it("sees a vote that opened while it waited on the meeting lock, and refuses", async () => {
		// protects=the open-vote check reads through the transaction after the meeting lock
		// fails_when=the vote state is read before the lock: the winner is written under an open ballot
		// no_claim=none beyond protects
		const result = await callParkedBehindMeetingShare(
			{
				meetingId: seed.meetingId,
				awards: [{ category: "best_evaluator", memberId: seed.memberId }],
			},
			async (tx) => {
				await tx.insert(meetingVoteSessions).values({
					meetingId: seed.meetingId,
					category: "best_evaluator",
				});
			},
		);

		expect(result).toBeInstanceOf(McpError);
		const blocking = (
			(result as InstanceType<typeof McpError>).detail as {
				blocking: { code: string }[];
			}
		).blocking;
		expect(blocking.map((b) => b.code)).toEqual(["VOTE_OPEN"]);
		expect(await awardRows()).toHaveLength(0);
	});

	describe("membership merge (#1035)", () => {
		let keeperId: string;
		let absorbedId: string;

		beforeEach(async () => {
			keeperId = seed.memberId;
			const personId = await seedPerson({
				name: `Absorbed ${randomUUID()}`,
			});
			const [row] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId,
					name: "Absorbed Duplicate",
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			absorbedId = row!.id;
		});

		/** Park a merge on its final DELETE, run `writer`, then let the merge commit. */
		async function writerInsideMergeWindow(writer: () => Promise<unknown>) {
			const hold = await openHold(async (tx) => {
				await tx.execute(
					sql`select 1 from members where id = ${absorbedId} for key share`,
				);
			});
			let gotPid!: (pid: number) => void;
			const pid = new Promise<number>((r) => {
				gotPid = r;
			});
			const merge = testDb.transaction(async (tx) => {
				const res = await tx.execute(sql`select pg_backend_pid() as pid`);
				gotPid(Number((res.rows[0] as { pid: number }).pid));
				await collapseMemberships(tx, seed.clubId, keeperId, absorbedId);
			});
			merge.catch(() => {});
			inFlight.push(merge);
			// Past every re-point: the DELETE is the merge's last statement.
			await waitForLockWait('delete from "members"', hold.pid);

			const running = writer();
			inFlight.push(running);
			const settled = outcome(running);
			await settledOrBlocked(running, "pg_advisory", await pid);

			await hold.commit();
			await merge;
			return settled;
		}

		it("set_awards for the absorbed member waits for the merge and is refused, leaving no row", async () => {
			// protects=a winner is never recorded inside the merge's re-point-to-DELETE window
			// fails_when=the row is written (and then set null by the DELETE): a row naming nobody under a success
			// no_claim=the keeper is not recorded here; the refusal tells the caller to retry, not where the member went
			const result = await writerInsideMergeWindow(() =>
				call({
					meetingId: seed.meetingId,
					awards: [{ category: "best_speaker", memberId: absorbedId }],
				}),
			);

			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).toBe(CLUB_BUSY_MESSAGE);
			expect(await awardRows()).toEqual([]);
		});

		it("the web setAward for the absorbed member waits for the merge and is refused, leaving no row", async () => {
			// protects=the same window is closed on the minutes writer, which shares the table
			// fails_when=the row is written inside the window and then set null by the DELETE
			// no_claim=the message of a member who was never in the club is unchanged and covered by the minutes suites
			const result = await writerInsideMergeWindow(() =>
				setAward({
					meetingId: seed.meetingId,
					category: "best_speaker",
					memberId: absorbedId,
				}),
			);

			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).toBe(CLUB_BUSY_MESSAGE);
			expect(await awardRows()).toEqual([]);
		});
	});
});
