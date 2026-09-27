/**
 * The club write lock (#925): guest check-in, a ballot join and a template
 * save take one club-level advisory lock before any row lock, so they no longer
 * deadlock each other (Postgres 40P01).
 *
 * The two cycle tests below are built to deadlock DETERMINISTICALLY without the
 * lock, not merely to run things at the same time and hope. A blocker holds the
 * club row so a NEW guest's check-in queues on it first; the other writer is
 * then started and parks too. Without the lock that writer has already taken
 * the MEETING by the time it parks (it locks meeting, then club), so when the
 * blocker commits the check-in gets the club, reaches its attendance insert,
 * and waits on the meeting the other writer holds while that writer waits on
 * the club — a cycle, every time. With the lock the other writer parks on the
 * lock the check-in already holds, before it has touched the meeting, and the
 * two run one after the other.
 *
 * Run with the worktree's own database (`bun run worktree:setup`), or:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/club-write-lock.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAttendance,
	meetingBallotGuests,
	meetings,
	meetingTemplates,
	meetingVoteSessions,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { holdClubLock } from "#/test/club-lock";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { CLUB_BUSY_MESSAGE, CLUB_WRITE_LOCK_NAMESPACE, lockClubForWrite } =
	await import("./club-write-lock");
const { captureGuestVisit } = await import("./guest-pipeline-logic");
const { joinBallotAsGuest, openVote } = await import("./voting-logic");
const { saveMeetingAgendaAsClubTemplate } = await import(
	"./meeting-templates-logic"
);
const { isDeadlock, isLockTimeout } = await import("./pg-errors");

/** Resolve to the call's error message, or null when it succeeded — so a test
 *  can assert on every writer's outcome rather than stopping at the first. */
function outcome(p: Promise<unknown>): Promise<string | null> {
	return p.then(
		() => null,
		(e: unknown) => (e instanceof Error ? e.message : String(e)),
	);
}

/**
 * Block until some backend OTHER than `except` is waiting on a lock held by one
 * of `holders`. Which holder depends on the code under test — without the club
 * write lock the second writer parks behind the blocker's row lock, with it it
 * parks behind the check-in's advisory lock — and the test needs to know only
 * that it has parked, i.e. that it has taken every lock it takes before its
 * first wait.
 */
async function waitForParkedBehind(
	holders: number[],
	except: number[],
	timeoutMs = 10_000,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await testDb.execute(sql`
			select pid from pg_stat_activity
			where datname = current_database()
			  and state = 'active' and wait_event_type = 'Lock'
			  and pid <> all(${`{${except.join(",")}}`}::int[])
			  and pg_blocking_pids(pid) && ${`{${holders.join(",")}}`}::int[]
			limit 1`);
		const pid = (res.rows[0] as { pid?: number } | undefined)?.pid;
		if (pid) return pid;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for a backend to park behind ${holders}`);
}

describe.skipIf(!hasTestDb)("the club write lock (#925)", () => {
	let club: SeededClub;

	beforeEach(async () => {
		club = await seedClub();
		// In progress now, so a check-in records attendance against it — the
		// insert whose foreign key locks the meeting row.
		await testDb
			.update(meetings)
			.set({ scheduledAt: new Date(Date.now() - 10 * 60 * 1000) })
			.where(eq(meetings.id, club.meetingId));
	});

	afterEach(async () => {
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	function newGuest(label: string) {
		return captureGuestVisit({
			clubId: club.clubId,
			name: `${label} ${randomUUID().slice(0, 8)}`,
			email: `${label.toLowerCase()}-${randomUUID()}@example.com`,
		});
	}

	function saveNew(name: string) {
		return saveMeetingAgendaAsClubTemplate({
			mode: "new",
			meetingId: club.meetingId,
			clubId: club.clubId,
			actorMemberId: null,
			name,
			description: null,
		});
	}

	/**
	 * The deterministic cycle harness described at the top of the file.
	 * `other` is the writer that locks the meeting and then the club.
	 */
	async function checkInRacing(other: () => Promise<unknown>) {
		const blocker = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select id from clubs where id = ${club.clubId} for update`,
			);
		});
		let checkIn: Promise<string | null> | undefined;
		let second: Promise<string | null> | undefined;
		try {
			checkIn = outcome(newGuest("Visitor"));
			const checkInPid = await waitForLockWait('from "clubs"', blocker.pid);
			second = outcome(other());
			await waitForParkedBehind(
				[blocker.pid, checkInPid],
				[checkInPid, blocker.pid],
			);
		} finally {
			await blocker.commit();
		}
		return { checkIn: await checkIn, second: await second };
	}

	it("a ballot join and a new guest's check-in both land", async () => {
		const voter = `Voter ${randomUUID().slice(0, 8)}`;
		const { checkIn, second } = await checkInRacing(() =>
			joinBallotAsGuest({ meetingId: club.meetingId, name: voter }),
		);
		expect({ checkIn, join: second }).toEqual({ checkIn: null, join: null });
		const present = await testDb
			.select({ id: meetingAttendance.id })
			.from(meetingAttendance)
			.where(eq(meetingAttendance.meetingId, club.meetingId));
		expect(present).toHaveLength(1);
		const onBallot = await testDb
			.select({ guestId: meetingBallotGuests.guestId })
			.from(meetingBallotGuests)
			.where(eq(meetingBallotGuests.meetingId, club.meetingId));
		expect(onBallot).toHaveLength(1);
	});

	it("a template save and a new guest's check-in both land", async () => {
		const { checkIn, second } = await checkInRacing(() =>
			saveNew("Contest night"),
		);
		expect({ checkIn, save: second }).toEqual({ checkIn: null, save: null });
		const saved = await testDb
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(
				and(
					eq(meetingTemplates.clubId, club.clubId),
					isNull(meetingTemplates.meetingId),
				),
			);
		expect(saved).toHaveLength(1);
	});

	it("check-ins, ballot joins and template saves run concurrently without a deadlock, round after round", async () => {
		const failures: string[] = [];
		for (let round = 0; round < 6; round++) {
			const results = await Promise.all([
				outcome(newGuest("Visitor")),
				outcome(newGuest("Visitor")),
				outcome(
					joinBallotAsGuest({
						meetingId: club.meetingId,
						name: `Voter ${round}-a`,
					}),
				),
				outcome(
					joinBallotAsGuest({
						meetingId: club.meetingId,
						name: `Voter ${round}-b`,
					}),
				),
				outcome(saveNew(`Contest night ${round}`)),
			]);
			for (const r of results) if (r !== null) failures.push(r);
		}
		expect(failures).toEqual([]);
		const [{ n } = { n: 0 }] = await testDb
			.select({ n: sql<number>`count(*)::int` })
			.from(guests)
			.where(eq(guests.clubId, club.clubId));
		// 12 check-ins and 12 ballot joins, each a new name.
		expect(n).toBe(24);
	});

	it("a new guest's club lock does not wait on a foreign-key insert's KEY SHARE", async () => {
		// Strength, not presence. Any insert referencing the club — an officer's
		// first agenda edit materialising the meeting's template, a slot, an
		// activity row — holds KEY SHARE on the club row until it commits, and
		// that edit takes the meeting FOR UPDATE first. A check-in taking FOR
		// UPDATE on the club queued behind it and then locked the meeting in the
		// other order. NO KEY UPDATE does not conflict with KEY SHARE.
		const blocker = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select id from clubs where id = ${club.clubId} for key share`,
			);
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				newGuest("Visitor").then((r) => (r.created ? "created" : "matched")),
				new Promise((r) => {
					timer = setTimeout(() => r("blocked"), 4000);
				}),
			]);
			expect(result).toBe("created");
		} finally {
			clearTimeout(timer);
			await blocker.commit();
		}
	});

	it("a new guest's club lock still waits on an archive in flight (the gate stays under it)", async () => {
		// Positive control for the strength change above: NO KEY UPDATE must
		// still conflict with the archiving UPDATE, or the in-lock archive gate
		// would read the club as live.
		const archiver = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`update clubs set archived_at = now() where id = ${club.clubId}`,
			);
		});
		const checkIn = outcome(newGuest("Visitor"));
		try {
			await waitForLockWait('from "clubs"', archiver.pid);
		} finally {
			await archiver.commit();
		}
		expect(await checkIn).toBe(CLUB_ARCHIVED_MESSAGE);
	});

	describe("the archive gate under the ballot's club lock (#925 review)", () => {
		/**
		 * Archive the club while `write` is in flight: the takedown's UPDATE holds
		 * the club row uncommitted, so the writer's pre-transaction
		 * `assertClubNotArchived` reads it live and lets it through; the writer
		 * then parks on its FOR SHARE of the club, and only then does the
		 * takedown commit. Only a gate read UNDER that lock can refuse it.
		 * Races the park against the writer settling, so a writer that never
		 * parks fails on the data assertions rather than on a timeout.
		 */
		async function archiveMid(write: () => Promise<unknown>) {
			const archiver = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`update clubs set archived_at = now() where id = ${club.clubId}`,
				);
			});
			const result = outcome(write());
			try {
				await Promise.race([
					waitForLockWait('from "meetings"', archiver.pid).catch(() => {}),
					result,
				]);
			} finally {
				await archiver.commit();
			}
			return result;
		}

		it("a guest joining the ballot of a club archived after the pre-check is refused and no name is minted", async () => {
			const name = `Late Voter ${randomUUID().slice(0, 8)}`;
			const result = await archiveMid(() =>
				joinBallotAsGuest({ meetingId: club.meetingId, name }),
			);
			const minted = await testDb
				.select({ id: guests.id })
				.from(guests)
				.where(eq(guests.clubId, club.clubId));
			expect(minted).toEqual([]);
			expect(result).toBe(CLUB_ARCHIVED_MESSAGE);
		});

		it("openVote on a club archived after the pre-check opens nothing", async () => {
			const result = await archiveMid(() =>
				openVote({
					meetingId: club.meetingId,
					clubId: club.clubId,
					category: "best_speaker",
					actorMemberId: club.adminMemberId,
				}),
			);
			const sessions = await testDb
				.select({ id: meetingVoteSessions.id })
				.from(meetingVoteSessions)
				.where(eq(meetingVoteSessions.meetingId, club.meetingId));
			expect(sessions).toEqual([]);
			expect(result).toBe(CLUB_ARCHIVED_MESSAGE);
		});
	});

	describe("the bounded wait", () => {
		/** Hold this club's write lock on a connection of its own. */
		function holdWriteLock() {
			return openBlockingTx((tx) => lockClubForWrite(tx, club.clubId));
		}

		it("a visitor checking in behind a stuck holder reads the busy sentence, and nothing is written", async () => {
			const holder = await holdWriteLock();
			let caught: unknown;
			try {
				caught = await newGuest("Visitor").catch((e: unknown) => e);
			} finally {
				await holder.commit();
			}
			expect((caught as Error).message).toBe(CLUB_BUSY_MESSAGE);
			expect(isLockTimeout(caught)).toBe(true);
			const minted = await testDb
				.select({ id: guests.id })
				.from(guests)
				.where(eq(guests.clubId, club.clubId));
			expect(minted).toEqual([]);
		});

		it("a guest joining the ballot behind a stuck holder reads the busy sentence, and nothing is written", async () => {
			const holder = await holdWriteLock();
			let caught: unknown;
			try {
				caught = await joinBallotAsGuest({
					meetingId: club.meetingId,
					name: "Voter",
				}).catch((e: unknown) => e);
			} finally {
				await holder.commit();
			}
			expect((caught as Error).message).toBe(CLUB_BUSY_MESSAGE);
			expect(isLockTimeout(caught)).toBe(true);
			const minted = await testDb
				.select({ id: guests.id })
				.from(guests)
				.where(eq(guests.clubId, club.clubId));
			expect(minted).toEqual([]);
		});

		it("bounds only its own wait: a row-lock wait after it keeps the transaction's patience", async () => {
			// The timeout is put back once the lock is granted. Without that, the
			// meeting lock below would inherit a 200ms limit and fail on a row
			// held for longer.
			const rowHolder = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select id from meetings where id = ${club.meetingId} for update`,
				);
			});
			const locking = testDb.transaction(async (tx) => {
				await lockClubForWrite(tx, club.clubId, "200ms");
				await tx.execute(
					sql`select id from meetings where id = ${club.meetingId} for update`,
				);
			});
			locking.catch(() => {});
			try {
				await waitForLockWait("from meetings where id", rowHolder.pid);
				await new Promise((r) => setTimeout(r, 600));
			} finally {
				await rowHolder.commit();
			}
			await expect(locking).resolves.toBeUndefined();
		});
	});

	describe("the key", () => {
		it("is the two-int form under its own namespace, keyed on the club", async () => {
			await testDb.transaction(async (tx) => {
				await lockClubForWrite(tx, club.clubId);
				const res = await tx.execute(sql`
					select classid::bigint as classid, objid::bigint as objid, objsubid
					from pg_locks
					where locktype = 'advisory' and pid = pg_backend_pid()
					  and granted`);
				const [expected] = (
					await tx.execute(
						sql`select (hashtext(${club.clubId})::bigint & 4294967295) as objid`,
					)
				).rows as { objid: string }[];
				expect(
					(
						res.rows as { classid: string; objid: string; objsubid: number }[]
					).map((r) => ({
						classid: Number(r.classid),
						objid: String(r.objid),
						objsubid: r.objsubid,
					})),
				).toEqual([
					{
						classid: CLUB_WRITE_LOCK_NAMESPACE,
						objid: String(expected?.objid),
						objsubid: 2,
					},
				]);
			});
		});

		it("is not blocked by the access-request lock or the MCP apply lock", async () => {
			const accessRequests = await openBlockingTx(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtextextended('access-requests:submit', 0))`,
				);
			});
			const mcp = holdClubLock(club.clubId);
			await mcp.acquired;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					testDb
						.transaction((tx) => lockClubForWrite(tx, club.clubId))
						.then(() => "taken"),
					new Promise((r) => {
						timer = setTimeout(() => r("blocked"), 4000);
					}),
				]);
				expect(result).toBe("taken");
			} finally {
				clearTimeout(timer);
				await mcp.release();
				await accessRequests.commit();
			}
		});

		it("IS blocked by the same club's write lock (the control that makes the test above mean something)", async () => {
			const holder = await openBlockingTx((tx) =>
				lockClubForWrite(tx, club.clubId),
			);
			const taking = testDb.transaction((tx) =>
				lockClubForWrite(tx, club.clubId),
			);
			try {
				await waitForLockWait("pg_advisory_xact_lock", holder.pid);
			} finally {
				await holder.commit();
			}
			await expect(taking).resolves.toBeUndefined();
		});
	});

	describe("a residual deadlock on a public path", () => {
		// A cycle through a writer that does not take the club lock can still
		// pick one of these as its victim. Simulated at the transaction boundary
		// the way drizzle hands a `pg` error back: the SQLSTATE on `cause`.
		function driverError(code: string): Error {
			return new Error('Failed query: insert into "meeting_attendance" …', {
				cause: Object.assign(new Error("pg"), { code }),
			});
		}

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("reaches a visitor checking in as a try-again sentence", async () => {
			const original = driverError("40P01");
			vi.spyOn(testDb, "transaction").mockRejectedValueOnce(original);
			const caught = await newGuest("Visitor").catch((e: unknown) => e);
			expect((caught as Error).message).toBe(CLUB_BUSY_MESSAGE);
			expect((caught as Error).cause).toBe(original);
			expect(isDeadlock(caught)).toBe(true);
		});

		it("reaches a guest joining the ballot as a try-again sentence", async () => {
			const original = driverError("40P01");
			vi.spyOn(testDb, "transaction").mockRejectedValueOnce(original);
			const caught = await joinBallotAsGuest({
				meetingId: club.meetingId,
				name: "Voter",
			}).catch((e: unknown) => e);
			expect((caught as Error).message).toBe(CLUB_BUSY_MESSAGE);
			expect((caught as Error).cause).toBe(original);
			expect(isDeadlock(caught)).toBe(true);
		});

		it("leaves every other failure alone", async () => {
			const other = driverError("23505");
			vi.spyOn(testDb, "transaction").mockRejectedValueOnce(other);
			expect(await newGuest("Visitor").catch((e: unknown) => e)).toBe(other);
			vi.spyOn(testDb, "transaction").mockRejectedValueOnce(other);
			expect(
				await joinBallotAsGuest({
					meetingId: club.meetingId,
					name: "Voter",
				}).catch((e: unknown) => e),
			).toBe(other);
		});
	});
});
