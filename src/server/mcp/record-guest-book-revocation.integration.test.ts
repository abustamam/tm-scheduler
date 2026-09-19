/**
 * The grant is re-proved after the club lock is held (#776 item 8).
 *
 * `record_guest_book` authorizes, THEN opens a transaction, and that
 * transaction waits on `pg_advisory_xact_lock`. Everything the re-plan re-reads
 * inside it is read against `tx` — the meetings, the guests, who is already
 * present — and two things were not: the caller's own membership and the club's
 * `archived_at`. A revocation landing during the wait still committed.
 *
 * The window is bounded to 5 seconds by `lock.ts`'s `lock_timeout`, which is
 * why this was low priority and not urgent. It is still a window.
 *
 * ## How the race is made deterministic
 *
 * A second connection takes the club's advisory lock and HOLDS it. The apply is
 * then started and blocks. `pg_locks` is polled until an ungranted advisory
 * lock on this club's key appears — that observation is the control: it proves
 * the apply is already inside its transaction and past `authorizeToken`, so a
 * refusal afterwards cannot be the up-front check firing. Only then is the
 * grant revoked, and only then is the lock released.
 *
 * Without that observation the test would pass for the wrong reason: revoking
 * before the apply reaches `authorizeToken` produces the same `FORBIDDEN`, with
 * the same message, from the check that already existed.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/mcp/record-guest-book-revocation.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubs,
	guests,
	meetingAttendance,
	meetings,
	members,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { utcToZonedWallTime } from "#/lib/datetime";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { recordGuestBookTool } = await import(
	"#/server/mcp/tools/record-guest-book"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");

interface Preview {
	applied: false;
	planHash: string | null;
	blocking: unknown[];
}

/** Take the club's advisory lock on a connection of its own and hold it. */
function holdClubLock(clubId: string) {
	let letGo!: () => void;
	let taken!: () => void;
	const held = new Promise<void>((resolve) => {
		letGo = resolve;
	});
	const acquired = new Promise<void>((resolve) => {
		taken = resolve;
	});
	const finished = testDb.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${clubId}))`);
		taken();
		await held;
	});
	return {
		acquired,
		async release() {
			letGo();
			await finished;
		},
	};
}

/** How many sessions are WAITING on this club's advisory lock right now. */
async function waitersOnClubLock(clubId: string): Promise<number> {
	const res = await testDb.execute<{ n: number }>(sql`
		SELECT count(*)::int AS n
		FROM pg_locks
		WHERE locktype = 'advisory'
		  AND NOT granted
		  AND objid::bigint = (hashtext(${clubId})::bigint & 4294967295)
	`);
	return Number(res.rows[0]?.n ?? 0);
}

/** Resolve once the apply is parked on the lock, or fail loudly. */
async function awaitLockWaiter(clubId: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if ((await waitersOnClubLock(clubId)) > 0) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(
		"the apply never parked on the club advisory lock — the race this test sets up did not happen, so a refusal below would prove nothing",
	);
}

describe.skipIf(!hasTestDb)("record_guest_book across the lock wait", () => {
	let seed: SeededClub;
	let token: string;
	let meetingDate: string;

	function call(args: Record<string, unknown>) {
		return recordGuestBookTool.handler(args, { rawToken: token });
	}

	async function rows() {
		const g = await testDb
			.select({ id: guests.id })
			.from(guests)
			.where(eq(guests.clubId, seed.clubId));
		const a = await testDb
			.select({ id: meetingAttendance.meetingId })
			.from(meetingAttendance)
			.where(eq(meetingAttendance.meetingId, pastMeetingId));
		return { guests: g.length, attendance: a.length };
	}

	let pastMeetingId: string;

	beforeEach(async () => {
		seed = await seedClub();
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId: seed.adminUserId, tokenHash: hashApiToken(raw) });
		token = raw;

		const past = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		const [row] = await testDb
			.insert(meetings)
			.values({ clubId: seed.clubId, scheduledAt: past, status: "completed" })
			.returning({ id: meetings.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		pastMeetingId = row!.id;
		meetingDate = utcToZonedWallTime(past, "America/Chicago").slice(0, 10);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	/** A fresh preview, so the apply below carries a hash that matches. */
	async function previewHash() {
		const p = (await call({
			clubId: seed.clubId,
			meetingDate,
			entries: [{ name: "Wanda Visitor", email: "wanda@example.com" }],
		})) as Preview;
		expect(p.blocking).toEqual([]);
		expect(p.planHash).toBeTruthy();
		return p.planHash as string;
	}

	it("refuses an apply whose membership was revoked while it waited", async () => {
		const planHash = await previewHash();
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const apply = call({
			clubId: seed.clubId,
			meetingDate,
			entries: [{ name: "Wanda Visitor", email: "wanda@example.com" }],
			planHash,
		});
		// The control: the apply is inside its transaction and past the up-front
		// authorization before anything is revoked.
		await awaitLockWaiter(seed.clubId);

		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, seed.adminMemberId));
		await lock.release();

		await expect(apply).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "You are not an admin or officer of that club.",
		});
		// The actual claim. A thrown error rolls the transaction back, so this is
		// what says the writes did not land.
		expect(await rows()).toEqual({ guests: 0, attendance: 0 });
	});

	it("refuses an apply whose club was archived while it waited", async () => {
		const planHash = await previewHash();
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const apply = call({
			clubId: seed.clubId,
			meetingDate,
			entries: [{ name: "Wanda Visitor", email: "wanda@example.com" }],
			planHash,
		});
		await awaitLockWaiter(seed.clubId);

		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await lock.release();

		// ARCHIVED, not FORBIDDEN: a real admin is told the club was taken down,
		// the same distinction `authorizeToken` makes up front.
		await expect(apply).rejects.toMatchObject({
			code: "ARCHIVED",
			message: CLUB_ARCHIVED_MESSAGE,
		});
		expect(await rows()).toEqual({ guests: 0, attendance: 0 });

		// Archiving is reversible, so put it back before cleanup cascades.
		await testDb
			.update(clubs)
			.set({ archivedAt: null })
			.where(eq(clubs.id, seed.clubId));
	});

	it("says the same thing as the up-front refusal", async () => {
		// `authz-logic.ts` does not export its message, so the re-check restates
		// it. Two copies of a sentence is how two paths start telling one member
		// different things about the same club; this is the gate on that.
		const planHash = await previewHash();
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const apply = call({
			clubId: seed.clubId,
			meetingDate,
			entries: [{ name: "Wanda Visitor", email: "wanda@example.com" }],
			planHash,
		});
		await awaitLockWaiter(seed.clubId);
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, seed.adminMemberId));
		await lock.release();

		const afterTheLock = await apply.then(
			() => null,
			(e: unknown) => e as { code: string; message: string },
		);

		// The same call again, now that the revocation is plainly visible: this
		// one never reaches the transaction.
		const upFront = await call({
			clubId: seed.clubId,
			meetingDate,
			entries: [{ name: "Wanda Visitor" }],
		}).then(
			() => null,
			(e: unknown) => e as { code: string; message: string },
		);

		expect(afterTheLock?.code).toBe("FORBIDDEN");
		expect(upFront?.code).toBe("FORBIDDEN");
		expect(afterTheLock?.message).toBe(upFront?.message);
	});

	it("still applies when nothing changed during the wait", async () => {
		// The floor under all of the above: the re-check must not refuse a caller
		// whose grant is intact, or every apply that ever queues would fail.
		const planHash = await previewHash();
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const apply = call({
			clubId: seed.clubId,
			meetingDate,
			entries: [{ name: "Wanda Visitor", email: "wanda@example.com" }],
			planHash,
		});
		await awaitLockWaiter(seed.clubId);
		await lock.release();

		await expect(apply).resolves.toMatchObject({ applied: true });
		expect(await rows()).toEqual({ guests: 1, attendance: 1 });
	});
});
