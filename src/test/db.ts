/**
 * Test-only Drizzle client + seed/cleanup helpers.
 *
 * NEVER import the production `db` from `#/db` here — this module reads
 * `TEST_DATABASE_URL` so tests never accidentally touch dev/prod data.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "#/db/schema";
import {
	clubs,
	guests,
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
	phone?: string | null;
	customerId?: string | null;
	userId?: string | null;
}): Promise<string> {
	const [row] = await testDb
		.insert(people)
		.values({
			name: overrides?.name ?? "Test Person",
			email: overrides?.email ?? null,
			phone: overrides?.phone ?? null,
			customerId: overrides?.customerId ?? null,
			userId: overrides?.userId ?? null,
		})
		.returning({ id: people.id });
	if (!row) throw new Error("Failed to insert person");
	return row.id;
}

/**
 * Set a member's phone. A phone number is a Person fact (#906), so this writes
 * `people.phone` for the membership's Person — there is no membership copy.
 * Every club holding that Person sees the change, as in production.
 */
export async function setMemberPhone(
	memberId: string,
	phone: string | null,
): Promise<void> {
	const [m] = await testDb
		.select({ personId: members.personId })
		.from(members)
		.where(eq(members.id, memberId));
	if (!m) throw new Error(`setMemberPhone: no membership ${memberId}`);
	await testDb.update(people).set({ phone }).where(eq(people.id, m.personId));
}

/** The Person phone behind a membership (#906), for assertions. */
export async function memberPhone(memberId: string): Promise<string | null> {
	const [row] = await testDb
		.select({ phone: people.phone })
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(eq(members.id, memberId));
	if (!row) throw new Error(`memberPhone: no membership ${memberId}`);
	return row.phone;
}

/**
 * Set the email behind a membership. An address is a Person fact (#907), so a
 * fixture that used to write `members.email` writes the Person's instead.
 * A fixture helper, never shipped: it is the one waived test-side writer in
 * `person-email-writers.guard.test.ts`.
 */
export async function setMemberEmail(
	memberId: string,
	email: string | null,
): Promise<void> {
	const [m] = await testDb
		.select({ personId: members.personId })
		.from(members)
		.where(eq(members.id, memberId));
	if (!m) throw new Error(`setMemberEmail: no membership ${memberId}`);
	await testDb.update(people).set({ email }).where(eq(people.id, m.personId));
}

/** The Person email behind a membership (#907), for assertions. */
export async function memberEmail(memberId: string): Promise<string | null> {
	const [row] = await testDb
		.select({ email: people.email })
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(eq(members.id, memberId));
	if (!row) throw new Error(`memberEmail: no membership ${memberId}`);
	return row.email;
}

// ---------------------------------------------------------------------------
// Guest fixtures (#1125). A guest is a Person (ADR-0031): `guests.person_id` is
// NOT NULL, and the guest's email and phone live on that Person. A fixture that
// used to insert `{ clubId, name, email, phone }` straight into `guests` now goes
// through `withGuestPerson`, which mints the Person (carrying the contact) first.
// ---------------------------------------------------------------------------

/** The test client or a transaction on it. */
export type TestConn = typeof testDb | TestTx;

/** What a guest fixture may hand over: a `guests` insert, contact included. */
export type GuestFixtureInput = Omit<typeof guests.$inferInsert, "personId"> & {
	email?: string | null;
	phone?: string | null;
	/** An EXISTING Person (a converted guest's member Person). Its contact is
	 *  left alone: a guest row never writes a member's. */
	personId?: string;
	/** The name of the Person minted for this guest, when it must differ from the
	 *  guest's own (a test that counts `people` by name). Never reaches the row. */
	personName?: string;
};

/** The same row as the `guests` insert takes it: a Person, no contact columns. */
export type GuestFixtureRow<T extends GuestFixtureInput> = Omit<
	T,
	"email" | "phone" | "personId" | "personName"
> & { personId: string };

/**
 * A guest fixture with its Person: inserts the Person (name, and the email and
 * phone the row carried) and returns the row ready for `insert(guests)`.
 * Persons are club-less, so `cleanup` removes the ones this club's guests name.
 */
export async function withGuestPerson<T extends GuestFixtureInput>(
	row: T,
	conn: TestConn = testDb,
): Promise<GuestFixtureRow<T>> {
	const [out] = await withGuestPersons([row], conn);
	if (!out) throw new Error("withGuestPerson: no row");
	return out;
}

/** {@link withGuestPerson} for several rows, in ONE insert of the Persons. */
export async function withGuestPersons<T extends GuestFixtureInput>(
	rows: T[],
	conn: TestConn = testDb,
): Promise<GuestFixtureRow<T>[]> {
	const named = rows.filter((r) => !r.personId);
	const minted =
		named.length === 0
			? []
			: await conn
					.insert(people)
					.values(
						named.map((r) => ({
							name: r.personName ?? r.name,
							preferredName: r.preferredName ?? null,
							email: r.email ?? null,
							phone: r.phone ?? null,
						})),
					)
					.returning({ id: people.id });
	let next = 0;
	return rows.map((r) => {
		const {
			email: _email,
			phone: _phone,
			personName: _personName,
			personId,
			...rest
		} = r;
		const id = personId ?? minted[next++]?.id;
		if (!id) throw new Error("withGuestPersons: a Person was not created");
		return { ...rest, personId: id } as GuestFixtureRow<T>;
	});
}

/**
 * Set a guest's email and/or phone, as a fixture. They are the guest's PERSON's
 * (#1125), so this writes `people`, with no predicate: it is a test helper, the
 * way `setMemberEmail` is, and one of the waived test-side writers in
 * `person-email-writers.guard.test.ts`. A field left out is left alone.
 */
export async function setGuestContact(
	guestId: string,
	contact: { email?: string | null; phone?: string | null },
	conn: TestConn = testDb,
): Promise<void> {
	const [g] = await conn
		.select({
			personId: guests.personId,
			email: people.email,
			phone: people.phone,
		})
		.from(guests)
		.innerJoin(people, eq(people.id, guests.personId))
		.where(eq(guests.id, guestId));
	if (!g) throw new Error(`setGuestContact: no guest ${guestId}`);
	await conn
		.update(people)
		.set({
			email: contact.email === undefined ? g.email : contact.email,
			phone: contact.phone === undefined ? g.phone : contact.phone,
		})
		.where(eq(people.id, g.personId));
}

/** A guest's contact as the app reads it: the Person's (#1125), for assertions. */
export async function guestContactOf(
	guestId: string,
	conn: TestConn = testDb,
): Promise<{ email: string | null; phone: string | null }> {
	const [row] = await conn
		.select({ email: people.email, phone: people.phone })
		.from(guests)
		.innerJoin(people, eq(people.id, guests.personId))
		.where(eq(guests.id, guestId));
	if (!row) throw new Error(`guestContactOf: no guest ${guestId}`);
	return row;
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
				clubRole: "admin",
				status: "active",
			},
			{
				clubId,
				personId: personRow.id,
				name: "Member User",
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
	// A guest is a Person too (#1125), and its row cascades with the club while
	// the Person does not. Collected before the cascade, deleted after it, and
	// only when no other club's guest row (or membership) still names it.
	const guestPeople = await testDb
		.selectDistinct({ personId: guests.personId })
		.from(guests)
		.where(eq(guests.clubId, clubId));
	const guestPersonIds = guestPeople
		.map((g) => g.personId)
		.filter((id) => !personIds.includes(id));

	// club cascade removes meetings, role_slots, role_definitions, members
	await testDb.delete(clubs).where(eq(clubs.id, clubId));
	// people are club-less; delete the ones this club's members belonged to
	if (personIds.length > 0) {
		await testDb.delete(people).where(inArray(people.id, personIds));
	}
	if (guestPersonIds.length > 0) {
		await testDb
			.delete(people)
			.where(
				and(
					inArray(people.id, guestPersonIds),
					notExists(
						testDb
							.select({ one: sql`1` })
							.from(guests)
							.where(eq(guests.personId, people.id)),
					),
					notExists(
						testDb
							.select({ one: sql`1` })
							.from(members)
							.where(eq(members.personId, people.id)),
					),
				),
			);
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
): Promise<{ commit: () => Promise<void>; pid: number }> {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	let ready!: (pid: number) => void;
	let failed!: (e: unknown) => void;
	const started = new Promise<number>((res, rej) => {
		ready = res;
		failed = rej;
	});
	const done = testDb.transaction(async (tx) => {
		let pid: number;
		try {
			// The backend holding this transaction's locks. Callers pass it to
			// `waitForLockWait` to prove the subject is blocked BY THIS writer and
			// not merely blocked by something, somewhere, on a busy shared database.
			const res = await tx.execute(sql`select pg_backend_pid() as pid`);
			pid = Number((res.rows[0] as { pid: number }).pid);
			await work(tx);
		} catch (e) {
			failed(e);
			throw e;
		}
		ready(pid);
		await gate;
	});
	// Claim the rejection now so a failure inside `work` never surfaces as an
	// unhandled rejection; `commit()` still re-throws it.
	done.catch(() => {});
	const pid = await started;
	return {
		pid,
		commit: async () => {
			release();
			await done;
		},
	};
}

/**
 * Block until the code under test is provably parked behind `blockedBy` — a
 * backend running a statement matching `match`, whose `pg_blocking_pids` include
 * the writer's backend. Returns the blocked pid.
 *
 * Both arguments are load-bearing, and neither is paranoia:
 *
 * - `match` — ~50 DB-backed suites run in parallel against ONE Postgres (see
 *   `vitest.config.ts`). A bare "is anything waiting?" poll is satisfied by an
 *   unrelated suite's lock.
 * - `blockedBy` — even a matching statement could belong to another suite
 *   running the same code. `pg_blocking_pids` closes it: the subject must be
 *   waiting on THIS test's writer.
 *
 * Get this wrong and the blocking transaction commits before the subject has
 * blocked; the race test then exercises the uncontended fast path and still
 * passes, because every assertion in it holds on both paths. A green run that
 * proves nothing is the exact failure these tests exist to rule out — note that
 * asserting the subject promise is merely "not settled yet" does NOT catch it
 * (it is legitimately still in flight), which is why this waits on the lock
 * graph instead.
 */
export async function waitForLockWait(
	match: string,
	blockedBy: number,
	timeoutMs = 10_000,
): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await testDb.execute(sql`
			select pid from pg_stat_activity
			where datname = current_database()
			  and state = 'active' and wait_event_type = 'Lock'
			  and query ilike ${`%${match}%`}
			  and ${blockedBy} = any(pg_blocking_pids(pid))
			limit 1`);
		const pid = (res.rows[0] as { pid?: number } | undefined)?.pid;
		if (pid) return pid;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(
		`timed out waiting for a statement matching ${match} to block on pid ${blockedBy}`,
	);
}
