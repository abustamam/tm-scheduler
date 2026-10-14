/**
 * DB-backed tests for the demo club (#1199): `resetDemoClub` builds the club
 * from the fixture and rebuilds it by deleting the old one (`deleteClubCore`,
 * #914) and building again, in one transaction.
 *
 * Which builder runs: the REAL Harbor City fixture in the first-build and
 * rebuild cases, and a small stand-in (`stubBuild`, below) everywhere else. The
 * fixture's roster addresses are fixed (`priya@example.com`, ...), the fixture
 * suite (`club-fixture.integration.test.ts`) deletes the rows at them around its
 * own tests, and files run in parallel against one database, so every real build
 * here is a window in which the two suites can delete each other's rows. The
 * stand-in writes the same contract (a club flagged `is_demo`, an admin Person
 * linked to `admin.userId`, a fictional `@example.com` member with an account)
 * under per-run addresses; what these tests pin is the orchestration around the
 * builder, which does not care which one ran. The one global the suite owns is
 * the single `is_demo` row, which nothing else creates.
 *
 * Every test carries its card: what it protects, the wrong result it rejects,
 * and what green does not prove.
 *
 * Run with (in a worktree, nothing exported):
 *   bunx vitest run src/server/demo-reset-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { buildFixtureClub as BuildFixtureClub } from "#/db/fixtures/club-fixture";
import { fixtureRosterEmails } from "#/db/fixtures/club-fixture";
import {
	apiTokens,
	clubs,
	guests,
	meetings,
	meetingTimings,
	meetingVoteSessions,
	meetingVotes,
	members,
	pathwaysPaths,
	pathwaysProjects,
	people,
	peopleEmailBackup,
	roleDefinitions,
	roleFeedbackNotes,
	roleSlots,
	session,
	user,
} from "#/db/schema";
import { PATHWAYS_CATALOG } from "#/lib/pathways-catalog";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

const RUN = vi.hoisted(() => Math.random().toString(36).slice(2, 8));

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// The public-write cases call the real `submitGuestBook` handler through the
// minimal adapter the other authz suites use; the cookie -> session lookup is the
// only thing faked, and it answers "nobody signed in".
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
		handler:
			(handle: (input: { data: unknown }) => unknown) =>
			({ data }: { data: unknown }) =>
				handle({ data }),
	}),
}));
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => ({ headers: new Headers() }),
}));
vi.mock("#/lib/auth", () => ({
	auth: { api: { getSession: async () => null } },
}));

/** Which builder `resetDemoClub` reaches. */
const builder = vi.hoisted(() => ({
	mode: "stub" as "real" | "stub" | "stubThenThrow",
}));

vi.mock("#/db/fixtures/club-fixture", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("#/db/fixtures/club-fixture")>();
	const stubBuild: typeof BuildFixtureClub = async (tx, o) => {
		const schema = await import("#/db/schema");
		const [club] = await tx
			.insert(schema.clubs)
			.values({
				name: o.name,
				slug: o.slug,
				timezone: o.timeZone,
				isDemo: o.isDemo ?? false,
			})
			.returning({ id: schema.clubs.id });
		if (!club) throw new Error("stub: club");
		const fakeId = randomUUID();
		const fakeEmail = `stub-${RUN}@example.com`;
		await tx.insert(schema.user).values({
			id: fakeId,
			name: "Stub Member",
			email: fakeEmail,
			emailVerified: true,
		});
		const persons = await tx
			.insert(schema.people)
			.values([
				{ name: o.admin.name, email: o.admin.email, userId: o.admin.userId },
				{ name: "Stub Member", email: fakeEmail, userId: fakeId },
			])
			.returning({ id: schema.people.id, email: schema.people.email });
		await tx.insert(schema.members).values(
			persons.map((p) => ({
				clubId: club.id,
				personId: p.id,
				name: p.email === o.admin.email ? o.admin.name : "Stub Member",
				clubRole: (p.email === o.admin.email ? "admin" : "member") as
					| "admin"
					| "member",
				status: "active" as const,
			})),
		);
		return { clubId: club.id };
	};
	return {
		...real,
		buildFixtureClub: (async (tx, o) => {
			if (builder.mode === "real") return real.buildFixtureClub(tx, o);
			const out = await stubBuild(tx, o);
			if (builder.mode === "stubThenThrow") {
				throw new Error("fixture exploded mid-build");
			}
			return out;
		}) as typeof BuildFixtureClub,
	};
});

const { DEMO_LOCK_KEY, DEMO_LOCK_NAMESPACE, DemoError, resetDemoClub } =
	await import("./demo-reset-logic");
const { CLUB_BUSY_MESSAGE } = await import("./club-write-lock");
const { deleteClubCore } = await import("./onboarding-logic");

const DEMO_EMAIL = `demo-${RUN}@test.example`;
/** A real, deliverable address: not on a reserved domain. */
const realEmail = (tag: string) => `${tag}-${RUN}@club.org`;
const GUEST_EMAILS = [
	"lucia.moreno@example.com",
	"ethan.brooks@example.com",
	"imani.clarke@example.com",
	"theo.marchetti@example.com",
];

const tracked = {
	clubs: [] as string[],
	users: [] as string[],
	people: [] as string[],
	emails: new Set<string>([
		DEMO_EMAIL,
		`stub-${RUN}@example.com`,
		...fixtureRosterEmails(DEMO_EMAIL),
		...GUEST_EMAILS,
	]),
};

// ---- the real fixture's catalog (read, never written by the fixture) ----
const CATALOG_CODES = ["8706", "8700", "8705", "8701"];
const addedPathIds: string[] = [];

async function ensureCatalog() {
	for (const path of PATHWAYS_CATALOG.filter((p) =>
		CATALOG_CODES.includes(p.courseCode),
	)) {
		const [inserted] = await testDb
			.insert(pathwaysPaths)
			.values({
				courseCode: path.courseCode,
				name: path.name,
				status: path.status,
			})
			.onConflictDoNothing({ target: pathwaysPaths.courseCode })
			.returning({ id: pathwaysPaths.id });
		if (!inserted) continue;
		addedPathIds.push(inserted.id);
		await testDb.insert(pathwaysProjects).values(
			path.projects.map((project, sortOrder) => ({
				pathId: inserted.id,
				level: project.level,
				name: project.name,
				isRequired: project.isRequired,
				series: project.series ?? null,
				sortOrder,
			})),
		);
	}
}

async function removeAddedCatalog() {
	if (addedPathIds.length === 0) return;
	await testDb
		.delete(pathwaysPaths)
		.where(inArray(pathwaysPaths.id, addedPathIds.splice(0)));
}

// ---- seeding ----
async function makeUser(opts: { email: string; superadmin?: boolean }) {
	const id = randomUUID();
	await testDb.insert(user).values({
		id,
		name: "U",
		email: opts.email,
		emailVerified: true,
		isSuperadmin: opts.superadmin ?? false,
	});
	tracked.users.push(id);
	tracked.emails.add(opts.email.toLowerCase());
	return id;
}

async function makePerson(userId: string | null, email: string) {
	const [row] = await testDb
		.insert(people)
		.values({ name: "P", userId, email })
		.returning({ id: people.id });
	if (!row) throw new Error("person");
	tracked.people.push(row.id);
	tracked.emails.add(email.toLowerCase());
	return row.id;
}

async function join(
	clubId: string,
	personId: string,
	role: "admin" | "member" = "member",
	status: "active" | "inactive" = "active",
) {
	const [row] = await testDb
		.insert(members)
		.values({ clubId, personId, name: "M", clubRole: role, status })
		.returning({ id: members.id });
	if (!row) throw new Error("member");
	return row.id;
}

async function makeRealClub() {
	const id = randomUUID();
	await testDb.insert(clubs).values({
		id,
		name: `Real Club ${RUN}`,
		slug: `demo-1199-real-${id}`,
	});
	tracked.clubs.push(id);
	return id;
}

async function demoClubs() {
	return testDb
		.select({ id: clubs.id, archivedAt: clubs.archivedAt })
		.from(clubs)
		.where(eq(clubs.isDemo, true));
}

async function exists(table: "clubs" | "user" | "people", id: string) {
	const t = { clubs, user, people }[table];
	const rows = await testDb
		.select({ id: t.id })
		.from(t)
		.where(eq(t.id, id as never));
	return rows.length === 1;
}

async function userByEmail(email: string) {
	const [row] = await testDb
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email));
	return row?.id ?? null;
}

async function teardown() {
	vi.unstubAllEnvs();
	builder.mode = "stub";
	await testDb.delete(clubs).where(eq(clubs.isDemo, true));
	if (tracked.clubs.length)
		await testDb.delete(clubs).where(inArray(clubs.id, tracked.clubs));
	const emails = [...tracked.emails];
	const personIds = tracked.people.slice();
	await testDb
		.delete(peopleEmailBackup)
		.where(
			inArray(
				peopleEmailBackup.personId,
				testDb
					.select({ id: people.id })
					.from(people)
					.where(inArray(people.email, emails)),
			),
		);
	await testDb.delete(people).where(inArray(people.email, emails));
	if (personIds.length)
		await testDb.delete(people).where(inArray(people.id, personIds));
	if (tracked.users.length)
		await testDb.delete(user).where(inArray(user.id, tracked.users));
	await testDb.delete(user).where(inArray(user.email, emails));
	tracked.clubs.length = 0;
	tracked.users.length = 0;
	tracked.people.length = 0;
}

describe.skipIf(!hasTestDb)("resetDemoClub (#1199)", () => {
	let superId: string;
	const reset = (extra?: Partial<Parameters<typeof resetDemoClub>[0]>) =>
		resetDemoClub({
			now: new Date(),
			actor: { kind: "superadmin", userId: superId },
			...extra,
		});

	// Both this suite and `src/db/fixtures/club-fixture.integration.test.ts` build the
	// fixture club, whose roster addresses are FIXED and which each suite deletes
	// around its tests. Run in parallel they would delete each other's rows, so
	// each holds this advisory lock for the whole suite. The key pair must match
	// the other file's. It is declared first so its release runs last.
	let releaseFixtureAddressLock: (() => Promise<void>) | undefined;
	beforeAll(async () => {
		const holder = await openBlockingTx(async (tx) => {
			await tx.execute(sql`select pg_advisory_xact_lock(1199, 1)`);
		});
		releaseFixtureAddressLock = holder.commit;
	}, 180_000);
	afterAll(async () => {
		await releaseFixtureAddressLock?.();
	});

	beforeAll(ensureCatalog);
	afterAll(removeAddedCatalog);
	afterAll(teardown);
	beforeEach(async () => {
		await teardown();
		vi.stubEnv("DEMO_ACCOUNT_EMAIL", DEMO_EMAIL);
		superId = await makeUser({
			email: realEmail("super"),
			superadmin: true,
		});
	});
	afterEach(teardown);

	/** The demo account with a session and an API token, as a presenter has. */
	async function demoAccount() {
		const id = await makeUser({ email: DEMO_EMAIL });
		await testDb.insert(session).values({
			id: randomUUID(),
			token: randomUUID(),
			userId: id,
			expiresAt: new Date(Date.now() + 86_400_000),
			updatedAt: new Date(),
		});
		await testDb
			.insert(apiTokens)
			.values({ userId: id, tokenHash: `h-${randomUUID()}` });
		return id;
	}

	async function accountRows(userId: string) {
		const s = await testDb
			.select({ id: session.id })
			.from(session)
			.where(eq(session.userId, userId));
		const t = await testDb
			.select({ id: apiTokens.id })
			.from(apiTokens)
			.where(eq(apiTokens.userId, userId));
		return { sessions: s.length, tokens: t.length };
	}

	// protects=the first build: the club exists, is the one flagged demo, carries
	//   the demo names and zone, is built by the REAL fixture, and its admin
	//   Person is the existing demo account's, so the presenter is signed in on it;
	// fails_when=the flag is not written (the club is a plain club), the admin
	//   Person has no user_id, or the fixture is not reached;
	// no_claim=what the fixture contains is the fixture suite's claim; this reads
	//   only that its meetings exist. Real fixture; its fixed addresses are removed
	//   around the test.
	it("builds the demo club from the real fixture, linked to the demo account", async () => {
		builder.mode = "real";
		const demoUser = await demoAccount();

		const { clubId } = await reset();

		const [club] = await testDb
			.select()
			.from(clubs)
			.where(eq(clubs.id, clubId));
		expect(club).toMatchObject({
			isDemo: true,
			name: "GavelUp Demo Club",
			slug: "gavelup-demo-club",
			timezone: "America/Chicago",
		});
		const [admin] = await testDb
			.select({ name: people.name, userId: people.userId })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(and(eq(members.clubId, clubId), eq(members.clubRole, "admin")))
			.limit(1);
		expect(admin).toMatchObject({ name: "Demo Presenter", userId: demoUser });
		const ms = await testDb
			.select({ id: meetings.id })
			.from(meetings)
			.where(eq(meetings.clubId, clubId));
		expect(ms.length).toBeGreaterThan(0);
		expect(await demoClubs()).toHaveLength(1);
	});

	// protects=a rebuild replaces the club (old id and rows gone, new club flagged)
	//   but never the presenter's sign-in: the demo user, its sessions and its API
	//   tokens survive, the new admin Person is linked to the same user, and the
	//   previous build's fictional accounts are removed;
	// fails_when=the old club survives, the demo account (or its session or token)
	//   is deleted by the club delete, the new admin is unlinked, or a fictional
	//   account from the previous build is left behind;
	// no_claim=real fixture both times; a presenter's hand-added people are the
	//   next cases.
	it("rebuilds: old club gone, demo account kept with its session and token, old fictional accounts gone", async () => {
		builder.mode = "real";
		const demoUser = await demoAccount();
		const first = await reset();
		const priyaBefore = await userByEmail("priya@example.com");
		expect(priyaBefore).not.toBeNull();
		const oldPeople = await testDb
			.select({ id: people.id })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(eq(members.clubId, first.clubId));
		expect(oldPeople.length).toBeGreaterThan(3);

		const second = await reset();

		expect(second.clubId).not.toBe(first.clubId);
		expect(await exists("clubs", first.clubId)).toBe(false);
		expect(await demoClubs()).toEqual([
			expect.objectContaining({ id: second.clubId }),
		]);
		expect(await exists("user", demoUser)).toBe(true);
		expect(await accountRows(demoUser)).toEqual({ sessions: 1, tokens: 1 });
		const [admin] = await testDb
			.select({ userId: people.userId })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(
				and(eq(members.clubId, second.clubId), eq(members.clubRole, "admin")),
			)
			.limit(1);
		expect(admin?.userId).toBe(demoUser);
		// Priya's account was the previous build's; the new one is a different row.
		const priyaAfter = await userByEmail("priya@example.com");
		expect(priyaAfter).not.toBe(priyaBefore);
		const survivors = await testDb
			.select({ id: people.id })
			.from(people)
			.where(
				inArray(
					people.id,
					oldPeople.map((p) => p.id),
				),
			);
		expect(survivors).toEqual([]);
	});

	// protects=with no demo account configured nothing is written, an existing demo
	//   club included;
	// fails_when=the call proceeds without an address, deletes the existing club,
	//   or throws something other than NOT_CONFIGURED;
	// no_claim=none beyond protects.
	it("throws NOT_CONFIGURED and writes nothing when the env var is unset", async () => {
		const existing = await reset();
		vi.stubEnv("DEMO_ACCOUNT_EMAIL", "");

		await expect(reset()).rejects.toMatchObject({ code: "NOT_CONFIGURED" });

		expect((await demoClubs()).map((c) => c.id)).toEqual([existing.clubId]);
	});

	// protects=the demo account may not be anyone who belongs to a real club (the
	//   first sign-in would show a real club's people on a shared screen, and the
	//   rebuild would remove their membership of nothing but keep their account);
	// fails_when=a membership of any status in a non-demo club is not refused, the
	//   real club is touched, or a demo club is built anyway;
	// no_claim=an inactive membership is the case run, since "any status" is the
	//   broader claim; an active one takes the same path.
	it("refuses ACCOUNT_IN_REAL_CLUB, and leaves the real club untouched", async () => {
		const demoUser = await makeUser({ email: DEMO_EMAIL });
		const realClub = await makeRealClub();
		const person = await makePerson(demoUser, realEmail("rp"));
		await join(realClub, person, "member", "inactive");

		await expect(reset()).rejects.toMatchObject({
			code: "ACCOUNT_IN_REAL_CLUB",
		});

		expect(await demoClubs()).toEqual([]);
		expect(await exists("clubs", realClub)).toBe(true);
		const kept = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.clubId, realClub));
		expect(kept).toHaveLength(1);
	});

	// protects=a superadmin account is never the demo account;
	// fails_when=the call proceeds, or throws a different code;
	// no_claim=none beyond protects.
	it("refuses ACCOUNT_IS_SUPERADMIN and builds nothing", async () => {
		await makeUser({ email: DEMO_EMAIL, superadmin: true });

		await expect(reset()).rejects.toMatchObject({
			code: "ACCOUNT_IS_SUPERADMIN",
		});

		expect(await demoClubs()).toEqual([]);
	});

	// protects=the rebuild's keep rule: a presenter who changed their account
	//   email, and a real person added by hand, lose their demo Person and
	//   membership but keep the account; only reserved-address accounts go;
	// fails_when=an account at a non-reserved address is deleted with the club,
	//   its Person or membership survives in the new world, or the fictional
	//   account is NOT deleted (the keep rule keeping everything);
	// no_claim=stand-in builder; the account kept is one with no other club.
	it("keeps the accounts of a presenter who changed email and of a hand-added real member", async () => {
		const demoUser = await demoAccount();
		const first = await reset();
		const drifted = realEmail("drift");
		await testDb
			.update(user)
			.set({ email: drifted })
			.where(eq(user.id, demoUser));
		tracked.emails.add(drifted);
		// A real address added by hand to the demo club.
		const handUser = await makeUser({ email: realEmail("hand") });
		const handPerson = await makePerson(handUser, realEmail("hand"));
		await join(first.clubId, handPerson);
		const fakeUser = await userByEmail(`stub-${RUN}@example.com`);
		expect(fakeUser).not.toBeNull();

		await reset();

		expect(await exists("user", demoUser)).toBe(true);
		expect(await exists("user", handUser)).toBe(true);
		expect(await exists("people", handPerson)).toBe(false);
		expect(await exists("clubs", first.clubId)).toBe(false);
		// The fictional account is the previous build's: replaced, not kept.
		expect(await userByEmail(`stub-${RUN}@example.com`)).not.toBe(fakeUser);
		// And the demo membership of the kept accounts is gone with the club.
		const stillMembers = await testDb
			.select({ id: members.id })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(inArray(people.userId, [demoUser, handUser]));
		expect(stillMembers).toEqual([]);
	});

	// protects=a rebuild deletes the club flagged `is_demo` and no other: a real
	//   club that predates the demo club is found first by an unfiltered read, so
	//   only the `is_demo` predicate keeps it out of the delete;
	// fails_when=the lookup of the existing club drops its `is_demo` filter, so the
	//   rebuild deletes the older real club and leaves the previous demo club;
	// no_claim=none beyond protects; `expectClubId` is the next case.
	it("deletes only the flagged demo club, never an older real club", async () => {
		const realClub = await makeRealClub();
		const first = await reset();

		const second = await reset();

		expect(await exists("clubs", realClub)).toBe(true);
		expect(await exists("clubs", first.clubId)).toBe(false);
		expect((await demoClubs()).map((c) => c.id)).toEqual([second.clubId]);
	});

	// protects=a caller that believes a club is the demo club cannot delete a real
	//   one: `expectClubId` must be the demo club's own id;
	// fails_when=the call deletes anything when the id is a real club's (even
	//   though a demo club exists), or throws a different code;
	// no_claim=none beyond protects.
	it("refuses NOT_DEMO_CLUB when expectClubId is a real club, deleting nothing", async () => {
		const existing = await reset();
		const realClub = await makeRealClub();

		await expect(reset({ expectClubId: realClub })).rejects.toMatchObject({
			code: "NOT_DEMO_CLUB",
		});

		expect((await demoClubs()).map((c) => c.id)).toEqual([existing.clubId]);
		expect(await exists("clubs", realClub)).toBe(true);
	});

	// protects=authority is re-read on the snapshot the delete acts on: a
	//   superadmin whose flag was cleared while the reset was queued deletes
	//   nothing;
	// fails_when=the call trusts the check made before it queued, or throws a code
	//   other than NOT_AUTHORIZED, or deletes first;
	// no_claim=the flag is cleared before the call rather than mid-call; the
	//   re-check reads at the point after the locks, so the two are the same read.
	it("refuses NOT_AUTHORIZED for a superadmin who lost the flag, deleting nothing", async () => {
		const existing = await reset();
		await testDb
			.update(user)
			.set({ isSuperadmin: false })
			.where(eq(user.id, superId));

		await expect(reset()).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });

		expect((await demoClubs()).map((c) => c.id)).toEqual([existing.clubId]);
	});

	// protects=the same re-check for a club admin: demoted before the rebuild
	//   runs, they delete nothing; while still an admin the same call works;
	// fails_when=a demoted admin's rebuild goes through, or the control (a current
	//   admin) is refused, which would make the refusal meaningless;
	// no_claim=a club admin is not yet reachable from the console; this is the
	//   logic's own contract for #1200's in-club button.
	it("re-checks a club admin actor, refusing one demoted since", async () => {
		const demoUser = await demoAccount();
		const first = await reset();

		const second = await reset({
			actor: { kind: "clubAdmin", userId: demoUser },
			expectClubId: first.clubId,
		});
		expect(second.clubId).not.toBe(first.clubId);

		await testDb
			.update(members)
			.set({ clubRole: "member" })
			.where(eq(members.clubId, second.clubId));
		await expect(
			reset({
				actor: { kind: "clubAdmin", userId: demoUser },
				expectClubId: second.clubId,
			}),
		).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
		expect((await demoClubs()).map((c) => c.id)).toEqual([second.clubId]);
	});

	// protects=a fixture that throws after the old club was deleted rolls the whole
	//   rebuild back: the previous demo club, its members and its fictional account
	//   are all still there;
	// fails_when=the delete commits without the build (no demo club), or half of
	//   it does (the club is back but its fictional account is gone);
	// no_claim=the builder is the stand-in that throws after it has written, which
	//   is what the real fixture's own throw looks like to the caller.
	it("rolls back to the previous demo club when the build throws", async () => {
		const first = await reset();
		const fake = await userByEmail(`stub-${RUN}@example.com`);
		builder.mode = "stubThenThrow";

		await expect(reset()).rejects.toThrow("fixture exploded mid-build");

		builder.mode = "stub";
		expect((await demoClubs()).map((c) => c.id)).toEqual([first.clubId]);
		expect(await userByEmail(`stub-${RUN}@example.com`)).toBe(fake);
		const kept = await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.clubId, first.clubId));
		expect(kept).toHaveLength(2);
	});

	// protects=an archived demo club can still be rebuilt, and the new one is not
	//   archived;
	// fails_when=the archive gate refuses the superadmin's reset, or the new club
	//   inherits the archive;
	// no_claim=none beyond protects.
	it("rebuilds an archived demo club", async () => {
		const first = await reset();
		await testDb
			.update(clubs)
			.set({ archivedAt: new Date() })
			.where(eq(clubs.id, first.clubId));

		const second = await reset();

		expect(await exists("clubs", first.clubId)).toBe(false);
		expect(await demoClubs()).toEqual([
			{ id: second.clubId, archivedAt: null },
		]);
	});

	// protects=two resets that overlap queue behind one lock and end with exactly
	//   one demo club (the second deletes the first's build and builds again);
	// fails_when=both run at once and a second demo club (or a unique violation)
	//   appears, or one of them is lost;
	// no_claim=two calls from one process on separate pooled connections.
	it("ends with exactly one demo club when two resets run at once", async () => {
		const [a, b] = await Promise.all([reset(), reset()]);

		expect(a.clubId).not.toBe(b.clubId);
		const rows = await demoClubs();
		expect(rows).toHaveLength(1);
		expect([a.clubId, b.clubId]).toContain(rows[0]?.id);
	});

	// protects=a reset that cannot get the lock in time says the club is busy and
	//   writes nothing, instead of waiting on its pooled connection;
	// fails_when=it waits forever, throws the driver's text, or proceeds past the
	//   lock and deletes the club;
	// no_claim=the wait is shortened to 300ms through `lockTimeout`; the production
	//   value is CLUB_WRITE_LOCK_TIMEOUT ("5s"), which is the same code path.
	it("throws CLUB_BUSY_MESSAGE when the rebuild lock is held too long", async () => {
		const existing = await reset();
		const holder = await openBlockingTx(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(${DEMO_LOCK_NAMESPACE}::int4, hashtext(${DEMO_LOCK_KEY}))`,
			);
		});
		try {
			const err = await reset({ lockTimeout: "300ms" }).then(
				() => null,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
		} finally {
			await holder.commit();
		}
		expect((await demoClubs()).map((c) => c.id)).toEqual([existing.clubId]);
	});

	// protects=at most one club is ever flagged demo, enforced by the database;
	// fails_when=a second `is_demo = true` row is accepted;
	// no_claim=a plain club (is_demo false) is unrestricted, which the other cases
	//   rely on by creating real clubs beside the demo one.
	it("rejects a second is_demo club at the unique index", async () => {
		await reset();
		await expect(
			testDb.insert(clubs).values({
				name: `Second demo ${RUN}`,
				slug: `second-demo-${RUN}`,
				isDemo: true,
			}),
		).rejects.toMatchObject({
			cause: { constraint: "clubs_single_demo_unique" },
		});
		await makeRealClub();
		await makeRealClub();
	});

	// protects=`DemoError` carries a code a caller can branch on;
	// fails_when=the class loses its code;
	// no_claim=the message wording.
	it("throws a DemoError carrying its code", async () => {
		vi.stubEnv("DEMO_ACCOUNT_EMAIL", "");
		const err = await reset().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DemoError);
	});
});

describe.skipIf(!hasTestDb)("deleteClubCore keepUserIds (#1199)", () => {
	afterEach(teardown);

	async function twoPersonClub() {
		const clubId = await makeRealClub();
		const keepUser = await makeUser({ email: realEmail("keep") });
		const dropUser = await makeUser({ email: realEmail("drop") });
		const keepPerson = await makePerson(keepUser, realEmail("keep"));
		const dropPerson = await makePerson(dropUser, realEmail("drop"));
		await join(clubId, keepPerson);
		await join(clubId, dropPerson);
		await testDb.insert(session).values({
			id: randomUUID(),
			token: randomUUID(),
			userId: keepUser,
			expiresAt: new Date(Date.now() + 86_400_000),
			updatedAt: new Date(),
		});
		return { clubId, keepUser, dropUser, keepPerson, dropPerson };
	}

	// protects=an account named in keepUserIds survives the club delete with its
	//   session while its Person (held only by this club) is deleted, and the
	//   club's other accounts are deleted as before;
	// fails_when=the kept account is deleted, its Person is kept, or the list
	//   keeps accounts it does not name;
	// no_claim=the existing delete rules are the #914 suite's, run unmodified.
	it("keeps a named account and its session, still deleting its Person", async () => {
		const f = await twoPersonClub();

		await testDb.transaction((tx) =>
			deleteClubCore(tx, f.clubId, { keepUserIds: [f.keepUser] }),
		);

		expect(await exists("clubs", f.clubId)).toBe(false);
		expect(await exists("user", f.keepUser)).toBe(true);
		expect(await exists("people", f.keepPerson)).toBe(false);
		expect(await exists("user", f.dropUser)).toBe(false);
		expect(await exists("people", f.dropPerson)).toBe(false);
		const s = await testDb
			.select({ id: session.id })
			.from(session)
			.where(eq(session.userId, f.keepUser));
		expect(s).toHaveLength(1);
	});

	// protects=the control for the case above: with no keepUserIds both accounts
	//   go, so the keep list is what held the account;
	// fails_when=the first case would pass with an empty list;
	// no_claim=none beyond protects.
	it("deletes both accounts when keepUserIds is empty", async () => {
		const f = await twoPersonClub();

		await testDb.transaction((tx) =>
			deleteClubCore(tx, f.clubId, { keepUserIds: [] }),
		);

		expect(await exists("user", f.keepUser)).toBe(false);
		expect(await exists("user", f.dropUser)).toBe(false);
	});
});

describe.skipIf(!hasTestDb)(
	"the demo club keeps no public data (#1199)",
	() => {
		// In THIS file, not its own: there is one `is_demo` row in the database, and
		// two files flagging a club at once would delete each other's.
		const seeds: SeededClub[] = [];
		afterEach(async () => {
			await testDb.delete(clubs).where(eq(clubs.isDemo, true));
			for (const sd of seeds.splice(0).reverse()) {
				await cleanup(sd.clubId, [sd.adminUserId, sd.memberUserId]);
			}
			await teardown();
		});

		const MIN = 60_000;

		/** A seeded club with a live meeting (started 10 minutes ago) whose Timer
		 *  slot the seeded member holds: the feedback window is open. */
		async function liveClub(demo: boolean): Promise<SeededClub> {
			const sd = await seedClub();
			seeds.push(sd);
			if (demo) {
				await testDb
					.update(clubs)
					.set({ isDemo: true })
					.where(eq(clubs.id, sd.clubId));
			}
			await testDb
				.update(meetings)
				.set({
					scheduledAt: new Date(Date.now() - 10 * MIN),
					lengthMinutes: 90,
				})
				.where(eq(meetings.id, sd.meetingId));
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: sd.memberId, status: "claimed" })
				.where(eq(roleSlots.id, sd.slotId));
			return sd;
		}

		const notesFor = (meetingId: string) =>
			testDb
				.select({ id: roleFeedbackNotes.id })
				.from(roleFeedbackNotes)
				.where(eq(roleFeedbackNotes.meetingId, meetingId));

		const guestsOf = (clubId: string) =>
			testDb
				.select({ id: guests.id })
				.from(guests)
				.where(eq(guests.clubId, clubId));

		const book = async (clubId: string, email: string) => {
			const { submitGuestBook } = await import("./guest-pipeline");
			return (
				submitGuestBook as unknown as (i: {
					data: unknown;
				}) => Promise<{ ok: true; created: boolean }>
			)({ data: { clubId, name: "Visiting Vera", email } });
		};

		// protects=the public guest book answers success on the demo club and stores
		//   nothing: no guest row, and no Person carrying the typed address; and on a
		//   real club the same submission still stores a guest (so the discard is the
		//   flag and not a broken harness);
		// fails_when=a demo-club submission inserts a guest or a Person, or the real
		//   club's submission stores nothing;
		// no_claim=the form's reply is `created: true` on the demo club whether or not
		//   the person was new, because nothing is looked up; the handler runs through
		//   a minimal createServerFn adapter.
		it("discards a guest-book submission on the demo club and stores one on a real club", async () => {
			const demo = await liveClub(true);
			const real = await liveClub(false);
			const demoEmail = `vera-demo-${RUN}@club.org`;
			const realMail = `vera-real-${RUN}@club.org`;
			tracked.emails.add(demoEmail);
			tracked.emails.add(realMail);

			expect(await book(demo.clubId, demoEmail)).toEqual({
				ok: true,
				created: true,
			});
			expect(await guestsOf(demo.clubId)).toEqual([]);
			expect(
				await testDb
					.select({ id: people.id })
					.from(people)
					.where(eq(people.email, demoEmail)),
			).toEqual([]);

			await book(real.clubId, realMail);
			expect(await guestsOf(real.clubId)).toHaveLength(1);
		});

		// protects=anonymous feedback on the demo club answers success and stores no
		//   note, while the same note on a real club is stored;
		// fails_when=a note is written for the demo club, or the control (a real club)
		//   stores nothing;
		// no_claim=the demo answer is `{ ok: true }` without checking the window, the
		//   caps or the target, so a malformed-target refusal is not what a demo
		//   club answers.
		it("discards anonymous feedback on the demo club and stores it on a real club", async () => {
			const { leaveFeedbackLogic } = await import("./role-feedback-logic");
			const demo = await liveClub(true);
			const real = await liveClub(false);
			const note = (sd: SeededClub) => ({
				meetingId: sd.meetingId,
				target: { kind: "slot" as const, id: sd.slotId },
				wentWell: "Clear signals",
			});

			expect(await leaveFeedbackLogic(note(demo))).toEqual({ ok: true });
			expect(await notesFor(demo.meetingId)).toEqual([]);

			expect(await leaveFeedbackLogic(note(real))).toEqual({ ok: true });
			expect(await notesFor(real.meetingId)).toHaveLength(1);
		});

		// protects=what an officer writes on the demo club is stored as before: a guest
		//   they add, a time the Timer records, a vote cast on its ballot;
		// fails_when=the discard is applied beyond the two public writers, so a demo
		//   walkthrough shows an empty guest list, no timing or no tally;
		// no_claim=the officer's guest is written through `createGuestRecord`, the one
		//   writer every officer flow shares, rather than through each server fn.
		it("still stores an officer-entered guest, a timing and a vote", async () => {
			const demo = await liveClub(true);

			const { createGuestRecord } = await import("./guests-logic");
			await createGuestRecord(testDb, {
				clubId: demo.clubId,
				name: "Officer-entered Guest",
			});
			expect(await guestsOf(demo.clubId)).toHaveLength(1);

			const [timerDef] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: demo.clubId,
					name: "Timer",
					key: "timer",
					category: "functionary",
					sortOrder: 60,
				})
				.returning({ id: roleDefinitions.id });
			const [speakerDef] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: demo.clubId,
					name: "Speaker",
					key: "speaker",
					category: "speaker",
					isSpeakerRole: true,
					sortOrder: 30,
				})
				.returning({ id: roleDefinitions.id });
			const [timerSlot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: demo.meetingId,
					roleDefinitionId: timerDef.id,
					status: "claimed",
					assignedMemberId: demo.memberId,
				})
				.returning({ id: roleSlots.id });
			const [speakerSlot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: demo.meetingId,
					roleDefinitionId: speakerDef.id,
					slotIndex: 0,
					status: "claimed",
					assignedMemberId: demo.adminMemberId,
				})
				.returning({ id: roleSlots.id });
			if (!timerDef || !speakerDef || !timerSlot || !speakerSlot) {
				throw new Error("seed rows");
			}

			const { recordMeetingTiming } = await import("./timings-logic");
			await recordMeetingTiming({
				meetingId: demo.meetingId,
				slotId: speakerSlot.id,
				elapsedSeconds: 371,
				marks: { green: 5, yellow: 6, red: 7 },
				claimedActorMemberId: demo.memberId,
			});
			const timings = await testDb
				.select({ s: meetingTimings.elapsedSeconds })
				.from(meetingTimings)
				.where(eq(meetingTimings.slotId, speakerSlot.id));
			expect(timings).toEqual([{ s: 371 }]);

			const { openVote, castVote } = await import("./voting-logic");
			await openVote({
				meetingId: demo.meetingId,
				category: "best_speaker",
				actorMemberId: demo.adminMemberId,
				clubId: demo.clubId,
			});
			await castVote({
				meetingId: demo.meetingId,
				category: "best_speaker",
				voter: { kind: "anonymous" },
				candidate: { kind: "member", id: demo.adminMemberId },
				deviceToken: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
			});
			const votes = await testDb
				.select({ id: meetingVotes.id })
				.from(meetingVotes)
				.innerJoin(
					meetingVoteSessions,
					eq(meetingVoteSessions.id, meetingVotes.sessionId),
				)
				.where(eq(meetingVoteSessions.meetingId, demo.meetingId));
			expect(votes).toHaveLength(1);
		});
	},
);
