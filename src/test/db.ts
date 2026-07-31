/**
 * Test-only Drizzle client + seed/cleanup helpers.
 *
 * NEVER import the production `db` from `#/db` here — this module reads
 * `TEST_DATABASE_URL` so tests never accidentally touch dev/prod data.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "#/db/schema";
import {
	clubs,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
	user,
} from "#/db/schema";

/**
 * True only when a test database URL is configured. Integration suites gate on
 * this (`describe.skipIf(!hasTestDb)`) so a plain `vitest run` with no DB skips
 * them instead of failing. NEVER fall back to the production `DATABASE_URL`.
 */
export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

// Build the client without throwing at module load so importing this file never
// fails when TEST_DATABASE_URL is unset. The placeholder URL is never connected
// to: gated suites run no queries when `hasTestDb` is false.
export const testDb = drizzle(
	process.env.TEST_DATABASE_URL ?? "postgresql://invalid",
	{ schema },
);

export interface SeededClub {
	clubId: string;
	adminUserId: string;
	memberUserId: string;
	personId: string; // person the seeded (member-role) roster member belongs to
	memberId: string; // roster member (club_role=member) linked to memberUserId
	adminMemberId: string; // roster member (club_role=admin) linked to adminUserId
	roleDefinitionId: string;
	meetingId: string;
	slotId: string;
}

/**
 * Insert a Person and return its id. Every roster member belongs to a person
 * (ADR-0008 / #64); tests that insert extra members need a person first.
 */
export async function seedPerson(overrides?: {
	name?: string;
	email?: string | null;
	customerId?: string | null;
	userId?: string | null;
}): Promise<string> {
	const [row] = await testDb
		.insert(people)
		.values({
			name: overrides?.name ?? "Test Person",
			email: overrides?.email ?? null,
			customerId: overrides?.customerId ?? null,
			userId: overrides?.userId ?? null,
		})
		.returning({ id: people.id });
	if (!row) throw new Error("Failed to insert person");
	return row.id;
}

/** Insert a minimal club fixture and return the ids. */
export async function seedClub(): Promise<SeededClub> {
	const clubId = randomUUID();
	const adminUserId = randomUUID();
	const memberUserId = randomUUID();

	// club
	await testDb.insert(clubs).values({
		id: clubId,
		name: "Test Club",
		slug: `test-club-${clubId}`,
	});

	// users
	await testDb.insert(user).values([
		{
			id: adminUserId,
			name: "Admin User",
			email: `admin-${adminUserId}@test.example`,
			emailVerified: true,
		},
		{
			id: memberUserId,
			name: "Member User",
			email: `member-${memberUserId}@test.example`,
			emailVerified: true,
		},
	]);

	// People carry the auth link (ADR-0008 Phase B: people.user_id). Each sign-in
	// user gets a Person; the membership's role lives on the members row.
	const [adminPersonRow, personRow] = await testDb
		.insert(people)
		.values([
			{
				name: "Admin User",
				email: `admin-${adminUserId}@test.example`,
				userId: adminUserId,
			},
			{
				name: "Member User",
				email: `member-${memberUserId}@test.example`,
				userId: memberUserId,
			},
		])
		.returning({ id: people.id });

	if (!adminPersonRow || !personRow) {
		throw new Error("Failed to insert people");
	}

	// Memberships: role resolved on the auth path via person → members row.
	const [adminMemberRow, memberRow] = await testDb
		.insert(members)
		.values([
			{
				clubId,
				personId: adminPersonRow.id,
				name: "Admin User",
				email: `admin-${adminUserId}@test.example`,
				clubRole: "admin",
				status: "active",
			},
			{
				clubId,
				personId: personRow.id,
				name: "Member User",
				email: `member-${memberUserId}@test.example`,
				clubRole: "member",
				status: "active",
			},
		])
		.returning({ id: members.id });

	if (!adminMemberRow || !memberRow) {
		throw new Error("Failed to insert members");
	}

	// role definition (non-speaker, e.g. Timer)
	const [roleDef] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: "Timer",
			category: "functionary",
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });

	if (!roleDef) {
		throw new Error("Failed to insert role definition");
	}

	// meeting
	const [meeting] = await testDb
		.insert(meetings)
		.values({
			clubId,
			// Always in the future so "upcoming meeting" queries include it
			// regardless of when the suite runs (avoids a wall-clock time bomb).
			scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			status: "scheduled",
		})
		.returning({ id: meetings.id });

	if (!meeting) {
		throw new Error("Failed to insert meeting");
	}

	// one open role slot
	const [slot] = await testDb
		.insert(roleSlots)
		.values({
			meetingId: meeting.id,
			roleDefinitionId: roleDef.id,
			status: "open",
		})
		.returning({ id: roleSlots.id });

	if (!slot) {
		throw new Error("Failed to insert role slot");
	}

	return {
		clubId,
		adminUserId,
		memberUserId,
		personId: personRow.id,
		memberId: memberRow.id,
		adminMemberId: adminMemberRow.id,
		roleDefinitionId: roleDef.id,
		meetingId: meeting.id,
		slotId: slot.id,
	};
}

/**
 * Delete all rows created by `seedClub` for the given club.
 * The club cascade handles meetings, slots, role defs, memberships, and members.
 * People are club-less (ADR-0008), so the club cascade does NOT remove them —
 * collect the person ids from this club's members first, then delete them after
 * the cascade. Users must be deleted separately (referenced across clubs).
 */
export async function cleanup(
	clubId: string,
	userIds: string[],
): Promise<void> {
	// person ids to remove — captured before the cascade deletes the members.
	const memberPeople = await testDb
		.select({ personId: members.personId })
		.from(members)
		.where(eq(members.clubId, clubId));
	const personIds = [...new Set(memberPeople.map((m) => m.personId))];

	// club cascade removes meetings, role_slots, role_definitions, members
	await testDb.delete(clubs).where(eq(clubs.id, clubId));
	// people are club-less; delete the ones this club's members belonged to
	if (personIds.length > 0) {
		await testDb.delete(people).where(inArray(people.id, personIds));
	}
	// delete test users
	if (userIds.length > 0) {
		await testDb.delete(user).where(inArray(user.id, userIds));
	}
}

// ---------------------------------------------------------------------------
// Concurrency helpers — for testing check-then-write races against real
// Postgres. A serial test cannot distinguish a correct guard from a missing
// one: check-then-insert always looks right when nothing else is running.
// ---------------------------------------------------------------------------

/** A drizzle transaction handle for the test client. */
export type TestTx = Parameters<
	Parameters<(typeof testDb)["transaction"]>[0]
>[0];

/**
 * Run `work` in a transaction that STAYS OPEN — holding its row locks, and
 * invisible to READ COMMITTED readers — until the returned `commit()` is
 * called. Lets a test drive a real interleaving: the concurrent writer takes
 * the lock, the code under test reads stale state and then blocks on its own
 * write, and only then does the writer commit.
 */
export async function openBlockingTx(
	work: (tx: TestTx) => Promise<void>,
): Promise<{ commit: () => Promise<void> }> {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let ready!: () => void;
	let failed!: (e: unknown) => void;
	const started = new Promise<void>((res, rej) => {
		ready = res;
		failed = rej;
	});
	const done = testDb.transaction(async (tx) => {
		try {
			await work(tx);
		} catch (e) {
			failed(e);
			throw e;
		}
		ready();
		await gate;
	});
	// Claim the rejection now so a failure inside `work` never surfaces as an
	// unhandled rejection; `commit()` still re-throws it.
	done.catch(() => {});
	await started;
	return {
		commit: async () => {
			release();
			await done;
		},
	};
}

/**
 * Wait until some backend on THIS database is blocked waiting for a lock —
 * i.e. the code under test has reached its write and parked behind
 * `openBlockingTx`. Polling the real wait state beats sleeping a guessed
 * interval, which either flakes under load or wastes time when idle.
 */
export async function waitForLockWait(timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await testDb.execute(sql`
			select count(*)::int as n from pg_stat_activity
			where datname = current_database()
			  and state = 'active' and wait_event_type = 'Lock'`);
		if (Number((res.rows[0] as { n: number }).n) > 0) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error("timed out waiting for a statement to block on a row lock");
}
