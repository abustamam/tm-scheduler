/**
 * The grant is re-proved after the club lock is held (#776 item 8, moved to the
 * session path by #806).
 *
 * The confirm page authorizes, THEN opens a transaction, and that transaction
 * waits on `pg_advisory_xact_lock`. Everything the re-plan re-reads inside it is
 * read against `tx` — the meetings, the guests, who is already present — and
 * the caller's own standing was not. A membership deactivated, an officer term
 * closed, or a club taken down during that wait still committed its writes.
 *
 * The window is bounded to 5 seconds by `lock.ts`'s `lock_timeout`. It is still
 * a window, and a confirm link is open for up to a DAY before the click that
 * opens it, so the standing being re-asked about is a great deal older here
 * than it was on the token path.
 *
 * ## What came over from the token path, and what did not
 *
 * Six of `record-guest-book-revocation.integration.test.ts`'s seven cases moved
 * here with their `pg_locks` harness intact: membership revoked, club archived,
 * refusal parity, officer term closed, and the two positive controls. They
 * guard the two arms the session apply KEEPS.
 *
 * The seventh — a bearer token revoked mid-apply — is gone, and deliberately.
 * The MCP tool no longer applies anything, so there is no lock for a token to
 * be revoked during; revocation is still honoured at the front door, where
 * `resolveActiveApiToken` filters `isNull(revokedAt)`, so a revoked token
 * cannot even create a pending row.
 *
 * ## How the race is made deterministic
 *
 * The harness is `src/test/club-lock.ts`, shared with `upsert_agendas` since
 * #808. A second connection takes the club's advisory lock and HOLDS it. The apply is
 * then started and blocks. `pg_locks` is polled until an ungranted advisory
 * lock on this club's key appears — that observation is the control: it proves
 * the apply is already inside its transaction and past the up-front check, so a
 * refusal afterwards cannot be that check firing. Only then is the grant
 * revoked, and only then is the lock released.
 *
 * Without that observation the test would pass for the wrong reason.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/guest-book-confirm-revocation.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubs,
	guests,
	meetingAttendance,
	meetings,
	members,
	officerTerms,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import { utcToZonedWallTime } from "#/lib/datetime";
import { awaitLockWaiter, holdClubLock } from "#/test/club-lock";
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
const { applyPendingPlan, loadPendingPlan } = await import(
	"#/server/guest-book-pending-logic"
);
const { NO_PERMISSION_MESSAGE, NOT_A_MEMBER_MESSAGE } = await import(
	"#/server/guards"
);

describe.skipIf(!hasTestDb)("the confirm apply across the lock wait", () => {
	let seed: SeededClub;
	let token: string;
	let meetingDate: string;
	let pastMeetingId: string;

	/** A fresh personal access token for `userId`; returns the raw value. */
	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	/**
	 * Make the seeded `club_role: "member"` an effective admin the only OTHER way
	 * there is — an open officer term — and hand back a token of their own.
	 *
	 * This is what reaches the officer arm of the re-check. Nothing in `seedClub`
	 * creates an officer term, so without this the arm is unexercised by the
	 * whole suite. Cascades away with the club.
	 */
	async function seedOfficer(): Promise<{ token: string; termId: string }> {
		const [term] = await testDb
			.insert(officerTerms)
			.values({
				membershipId: seed.memberId,
				position: "secretary",
				termStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
			})
			.returning({ id: officerTerms.id });
		if (!term) throw new Error("failed to open an officer term");
		return { token: await mintToken(seed.memberUserId), termId: term.id };
	}

	/**
	 * A pending plan previewed by `as`, and the hash its page would render.
	 *
	 * Taken as `as`, never as a fixed caller: the plan hash is computed over the
	 * CREATING user's id as well as the plan, and only the creator can open the
	 * link — so an officer's apply previewed by the admin would be a not-found
	 * and prove nothing about the officer arm.
	 */
	async function pendingFor(userId: string, rawToken: string) {
		const { pendingId } = (await recordGuestBookTool.handler(
			{
				clubId: seed.clubId,
				meetingDate,
				entries: [{ name: "Wanda Visitor", email: "wanda@example.com" }],
			},
			{ rawToken },
		)) as { pendingId: string };
		const view = await loadPendingPlan({ pendingId, userId });
		if (view.status !== "editable") {
			throw new Error(`expected an editable plan, got ${view.status}`);
		}
		return { pendingId, planHash: view.planHash };
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

	beforeEach(async () => {
		seed = await seedClub();
		token = await mintToken(seed.adminUserId);

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

	it("refuses an apply whose membership was revoked while it waited", async () => {
		const { pendingId, planHash } = await pendingFor(seed.adminUserId, token);
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const apply = applyPendingPlan({
			pendingId,
			userId: seed.adminUserId,
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

		const result = await apply;
		expect(result.ok).toBe(false);
		expect(result.message).toBe(NOT_A_MEMBER_MESSAGE);
		// The actual claim. A thrown error rolls the transaction back, so this is
		// what says the writes did not land.
		expect(await rows()).toEqual({ guests: 0, attendance: 0 });
	});

	it("refuses an apply whose club was archived while it waited", async () => {
		const { pendingId, planHash } = await pendingFor(seed.adminUserId, token);
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const apply = applyPendingPlan({
			pendingId,
			userId: seed.adminUserId,
			planHash,
		});
		await awaitLockWaiter(seed.clubId);

		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, seed.clubId));
		await lock.release();

		const result = await apply;
		// ARCHIVED, not not-found: a real admin is told the club was taken down,
		// the same distinction `requireMembership` makes up front.
		expect(result.view).toEqual({
			status: "archived",
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
		// Two paths refusing the same fact must say the same thing, or one member
		// gets told two different stories about the same club. The re-check is
		// `requireClubRole` asked again against `tx`, so this is structural — but
		// the MAPPING from its throw back to a page state is not, and that is what
		// this case pins.
		const { pendingId, planHash } = await pendingFor(seed.adminUserId, token);
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const apply = applyPendingPlan({
			pendingId,
			userId: seed.adminUserId,
			planHash,
		});
		await awaitLockWaiter(seed.clubId);
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, seed.adminMemberId));
		await lock.release();

		const afterTheLock = await apply;

		// The same page, loaded now that the revocation is plainly visible: this
		// one never reaches the transaction.
		const upFront = await loadPendingPlan({
			pendingId,
			userId: seed.adminUserId,
		});

		expect(afterTheLock.view).toEqual(upFront);
		expect(upFront).toEqual({ status: "not_found" });
	});

	it("refuses an officer whose TERM was closed while it waited", async () => {
		// The other arm of "admin OR open officer term". This caller is
		// `club_role: "member"` throughout: the term is the whole grant, so
		// closing it is the only thing that can refuse them.
		const officer = await seedOfficer();
		const { pendingId, planHash } = await pendingFor(
			seed.memberUserId,
			officer.token,
		);
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const apply = applyPendingPlan({
			pendingId,
			userId: seed.memberUserId,
			planHash,
		});
		await awaitLockWaiter(seed.clubId);

		await testDb
			.update(officerTerms)
			.set({ termEnd: new Date() })
			.where(eq(officerTerms.id, officer.termId));
		await lock.release();

		const result = await apply;
		expect(result.ok).toBe(false);
		// WHICH refusal fired, not just that one did. This is the only case that
		// reaches the `NO_PERMISSION_MESSAGE` arm of the mapping — an officer who
		// is still an active MEMBER but no longer holds an office — and the
		// deleted original pinned the same distinction as a FORBIDDEN code.
		expect(result.message).toBe(NO_PERMISSION_MESSAGE);
		expect(result.view).toEqual({ status: "not_found" });
		expect(await rows()).toEqual({ guests: 0, attendance: 0 });
	});

	it("still applies for an officer-only caller when nothing changed", async () => {
		// The control the case above needs. Without it, a re-check that refused
		// every officer — by reading the disjunction as "admin" alone — would pass
		// that test for the wrong reason, and every officer-only caller in the
		// product would be broken with the suite green.
		const officer = await seedOfficer();
		const { pendingId, planHash } = await pendingFor(
			seed.memberUserId,
			officer.token,
		);
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const apply = applyPendingPlan({
			pendingId,
			userId: seed.memberUserId,
			planHash,
		});
		await awaitLockWaiter(seed.clubId);
		await lock.release();

		await expect(apply).resolves.toMatchObject({ ok: true });
		expect(await rows()).toEqual({ guests: 1, attendance: 1 });

		// And they really were officer-only — not an admin who would have passed
		// the other arm.
		const [who] = await testDb
			.select({ clubRole: members.clubRole })
			.from(members)
			.where(eq(members.id, seed.memberId));
		expect(who?.clubRole).toBe("member");
	});

	it("applies ONCE when a second click lands while the first is queued", async () => {
		// The `applied_at IS NULL` guard inside the locked transaction is the
		// only thing standing between a double-click and a page recorded twice,
		// and it is unreachable serially: `applyPendingPlan` answers from its own
		// cheap pre-read before a transaction is ever opened. So this drives the
		// race the guard exists for — B commits while A is parked on the club
		// lock — and asserts on the sentence only the LOCKED guard says.
		const { pendingId, planHash } = await pendingFor(seed.adminUserId, token);
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const first = applyPendingPlan({
			pendingId,
			userId: seed.adminUserId,
			planHash,
		});
		// The control: A is inside its transaction and past every pre-read.
		await awaitLockWaiter(seed.clubId);

		const second = applyPendingPlan({
			pendingId,
			userId: seed.adminUserId,
			planHash,
		});
		await lock.release();

		const [a, b] = await Promise.all([first, second]);
		const winners = [a, b].filter((r) => r.ok);
		const losers = [a, b].filter((r) => !r.ok);
		expect(winners).toHaveLength(1);
		expect(losers).toHaveLength(1);
		// Not "That page has already been recorded." — that is the pre-read's
		// sentence, and matching it here would mean the locked guard never ran.
		expect(losers[0]?.message).toBe(
			"That page was recorded while this one was open.",
		);
		// The claim that matters: one guest, one attendance row, not two.
		expect(await rows()).toEqual({ guests: 1, attendance: 1 });
	});

	it("still applies when nothing changed during the wait", async () => {
		// The floor under all of the above: the re-check must not refuse a caller
		// whose grant is intact, or every apply that ever queues would fail.
		const { pendingId, planHash } = await pendingFor(seed.adminUserId, token);
		const lock = holdClubLock(seed.clubId);
		await lock.acquired;

		const apply = applyPendingPlan({
			pendingId,
			userId: seed.adminUserId,
			planHash,
		});
		await awaitLockWaiter(seed.clubId);
		await lock.release();

		await expect(apply).resolves.toMatchObject({ ok: true });
		expect(await rows()).toEqual({ guests: 1, attendance: 1 });
	});
});
