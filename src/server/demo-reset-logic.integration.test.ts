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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
	activityLog,
	apiTokens,
	areaClubs,
	areaDirectors,
	areas,
	clubs,
	clubVisits,
	districts,
	divisions,
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
import { currentProgramYear } from "#/lib/dcp";
import { PATHWAYS_CATALOG } from "#/lib/pathways-catalog";
import {
	cleanup,
	hasTestDb,
	openBlockingTx,
	type SeededClub,
	seedClub,
	testDb,
	waitForLockWait,
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

const {
	DEMO_DISTRICT_NUMBER,
	DEMO_LOCK_KEY,
	DEMO_LOCK_NAMESPACE,
	DemoError,
	resetDemoClub,
} = await import("./demo-reset-logic");
const { CLUB_BUSY_MESSAGE, lockClubForWrite } = await import(
	"./club-write-lock"
);
const { deleteClubCore } = await import("./onboarding-logic");
const { loadCurrentAreasForUser } = await import("./area-terms-logic");

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

/** The demo hierarchy rows that existed before the test (another suite's, or a
 *  leftover): `removeDemoHierarchy` removes only rows created after this. */
const preexisting = {
	districts: new Set<string>(),
	divisions: new Set<string>(),
	areas: new Set<string>(),
};

async function demoHierarchyRows() {
	const ds = (
		await testDb
			.select({ id: districts.id })
			.from(districts)
			.where(eq(districts.isDemo, true))
	).map((d) => d.id);
	const divs = ds.length
		? (
				await testDb
					.select({ id: divisions.id, districtId: divisions.districtId })
					.from(divisions)
					.where(inArray(divisions.districtId, ds))
			).map((d) => d.id)
		: [];
	const ars = divs.length
		? (
				await testDb
					.select({ id: areas.id })
					.from(areas)
					.where(inArray(areas.divisionId, divs))
			).map((a) => a.id)
		: [];
	return { ds, divs, ars };
}

async function snapshotDemoHierarchy() {
	const { ds, divs, ars } = await demoHierarchyRows();
	preexisting.districts = new Set(ds);
	preexisting.divisions = new Set(divs);
	preexisting.areas = new Set(ars);
}

/** The demo hierarchy rows THIS suite created (#1278), after each test so the
 *  single `is_demo` district slot is free for the next suite. A rebuild never
 *  deletes them, so the suite does, before it deletes the users the terms point
 *  at. Rows that existed at the snapshot are left alone. */
async function removeDemoHierarchy() {
	const { ds, divs, ars } = await demoHierarchyRows();
	const newAreas = ars.filter((id) => !preexisting.areas.has(id));
	const newDivs = divs.filter((id) => !preexisting.divisions.has(id));
	const newDistricts = ds.filter((id) => !preexisting.districts.has(id));
	if (tracked.users.length) {
		await testDb
			.delete(areaDirectors)
			.where(inArray(areaDirectors.userId, tracked.users));
	}
	if (newAreas.length) {
		await testDb
			.delete(clubVisits)
			.where(
				inArray(
					clubVisits.areaClubId,
					testDb
						.select({ id: areaClubs.id })
						.from(areaClubs)
						.where(inArray(areaClubs.areaId, newAreas)),
				),
			);
		await testDb.delete(areaClubs).where(inArray(areaClubs.areaId, newAreas));
		await testDb
			.delete(areaDirectors)
			.where(inArray(areaDirectors.areaId, newAreas));
		await testDb.delete(areas).where(inArray(areas.id, newAreas));
	}
	if (newDivs.length)
		await testDb.delete(divisions).where(inArray(divisions.id, newDivs));
	if (newDistricts.length)
		await testDb.delete(districts).where(inArray(districts.id, newDistricts));
}

async function teardown() {
	vi.unstubAllEnvs();
	builder.mode = "stub";
	await testDb.delete(clubs).where(eq(clubs.isDemo, true));
	await removeDemoHierarchy();
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
		await snapshotDemoHierarchy();
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
		// The fixture has more than one admin, so ask for the demo account's own
		// membership instead of "an admin": no row order to depend on.
		const demoMemberships = await testDb
			.select({
				name: people.name,
				userId: people.userId,
				clubRole: members.clubRole,
			})
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(and(eq(members.clubId, clubId), eq(people.userId, demoUser)));
		expect(demoMemberships).toEqual([
			{ name: "Demo Presenter", userId: demoUser, clubRole: "admin" },
		]);
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
		// Not "an admin" (the fixture has more than one): the demo account's own
		// membership.
		const demoMemberships = await testDb
			.select({ userId: people.userId, clubRole: members.clubRole })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(
				and(eq(members.clubId, second.clubId), eq(people.userId, demoUser)),
			);
		expect(demoMemberships).toEqual([{ userId: demoUser, clubRole: "admin" }]);
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

	// protects=the keep rule is decided on the users the delete has LOCKED, not on
	//   a list read before: a real person added by hand to the demo club who signs
	//   in while the rebuild waits (their Person is bound to their account only
	//   after the rebuild started) keeps the account;
	// fails_when=the keep decision is made before the Persons are locked, so the
	//   account bound in between is not in it and is deleted with the club;
	// no_claim=the bind is an UPDATE of `people.user_id` committed while the rebuild
	//   waits on the Person's lock, standing in for `linkPersonToUser`; the sign-in
	//   path itself is the auth suites' claim.
	it("keeps a real account whose Person is bound to it mid-rebuild", async () => {
		const first = await reset();
		const lateUser = await makeUser({ email: realEmail("late") });
		const latePerson = await makePerson(null, realEmail("late"));
		await join(first.clubId, latePerson);
		const held: {
			tx?: Parameters<Parameters<typeof testDb.transaction>[0]>[0];
		} = {};
		const holder = await openBlockingTx(async (tx) => {
			held.tx = tx;
			await tx
				.select({ id: people.id })
				.from(people)
				.where(eq(people.id, latePerson))
				.for("update");
		});
		let released = false;
		try {
			const rebuilding = reset();
			// Surface a failure of the rebuild at the await below, not as unhandled.
			rebuilding.catch(() => {});
			await waitForLockWait("for no key update", holder.pid);
			// The sign-in's bind, committed while the rebuild is waiting.
			if (!held.tx) throw new Error("holder transaction not open");
			await held.tx
				.update(people)
				.set({ userId: lateUser })
				.where(eq(people.id, latePerson));
			await holder.commit();
			released = true;
			await rebuilding;
		} finally {
			if (!released) await holder.commit();
		}

		expect(await exists("user", lateUser)).toBe(true);
		expect(await exists("people", latePerson)).toBe(false);
	});

	// protects=the keep rule covers every Person the delete removes, not only
	//   current members and guests: a former member (removed, so no membership row)
	//   whose Person is bound to a real account keeps the account;
	// fails_when=the accounts kept are those of the club's members and guests, so a
	//   removed member's real account is deleted with the club;
	// no_claim=the former member is found through the `member_remove` activity row,
	//   one of the paths `personsOfClub` reads; the other paths share the code that
	//   decides on the locked users.
	it("keeps the real account of a former member the club removed", async () => {
		const first = await reset();
		const formerUser = await makeUser({ email: realEmail("former") });
		const formerPerson = await makePerson(formerUser, realEmail("former"));
		await testDb.insert(activityLog).values({
			clubId: first.clubId,
			action: "member_remove",
			targetType: "member",
			detail: { personId: formerPerson },
		});

		await reset();

		expect(await exists("user", formerUser)).toBe(true);
	});

	// protects=a reserved-address account is still the demo club's to remove, whoever
	//   it is bound to: the rule is "not reserved", not "everything";
	// fails_when=the predicate keeps every account, so the fictional accounts pile
	//   up across rebuilds;
	// no_claim=the stand-in builder's one fictional account stands for the fixture's.
	it("still deletes the fictional account of the previous build", async () => {
		await demoAccount();
		await reset();
		const fake = await userByEmail(`stub-${RUN}@example.com`);
		expect(fake).not.toBeNull();

		await reset();

		expect(fake && (await exists("user", fake))).toBe(false);
	});

	// protects=a Person at the demo address that has no account yet, already in a
	//   real club as a member, is refused (the fixture would add a second Person at
	//   the address and the real member's first sign-in would bind neither);
	// fails_when=the reset proceeds and builds the demo club, or the real club is
	//   touched, or the refusal is a different code;
	// no_claim=the member case is the one run; the guest case is the next test.
	it("refuses ADDRESS_IN_REAL_CLUB for an unbound member Person at the demo address", async () => {
		const realClub = await makeRealClub();
		const person = await makePerson(null, DEMO_EMAIL);
		await join(realClub, person);

		await expect(reset()).rejects.toMatchObject({
			code: "ADDRESS_IN_REAL_CLUB",
		});

		expect(await demoClubs()).toEqual([]);
		expect(await exists("people", person)).toBe(true);
	});

	// protects=the refusal compares addresses the way sign-in's binder does
	//   (`normalizedEmail`: trimmed of ALL whitespace, lowercased), so an unbound
	//   real member stored as "demo@...\t" (a pasted roster cell) is still refused;
	//   with `lower()` alone the rebuild would add a second Person and the real
	//   member's first sign-in would bind neither;
	// fails_when=the member query goes back to `lower(people.email)`, and the
	//   padded address no longer counts as the demo address;
	// no_claim=the guest query shares the expression but is not separately pinned
	//   here; the demo account's own `user.email` is better-auth's, stored
	//   normalised, and is not padded.
	it("refuses ADDRESS_IN_REAL_CLUB for an unbound member whose stored address is whitespace-padded", async () => {
		const realClub = await makeRealClub();
		const person = await makePerson(null, `${DEMO_EMAIL}\t`);
		await join(realClub, person);

		await expect(reset()).rejects.toMatchObject({
			code: "ADDRESS_IN_REAL_CLUB",
		});

		expect(await demoClubs()).toEqual([]);
		expect(await exists("people", person)).toBe(true);
	});

	// protects=the same refusal when the unbound Person at the demo address is a
	//   real club's guest, and none when the Person sits in no real club;
	// fails_when=a guest row is not counted, or a Person in no club blocks the
	//   build;
	// no_claim=a Person the demo club itself holds at that address is not a real
	//   club's and is not covered here.
	it("refuses ADDRESS_IN_REAL_CLUB for an unbound guest Person, and not for one in no club", async () => {
		const realClub = await makeRealClub();
		const person = await makePerson(null, DEMO_EMAIL);
		await testDb.insert(guests).values({
			clubId: realClub,
			name: "G",
			personId: person,
		});

		await expect(reset()).rejects.toMatchObject({
			code: "ADDRESS_IN_REAL_CLUB",
		});

		await testDb.delete(guests).where(eq(guests.personId, person));
		await expect(reset()).resolves.toMatchObject({});
	});

	// protects=the rebuild takes the demo club's write lock before its row lock, the
	//   order every other club writer uses, so a guest conversion (write lock, then
	//   row) and a rebuild cannot deadlock;
	// fails_when=the rebuild goes straight to the club row and does not queue
	//   behind a holder of the club write lock;
	// no_claim=the holder takes the row lock after the write lock, as a conversion
	//   does; the real conversion path is the guest suites' claim.
	it("queues behind the demo club's write lock and finishes without a deadlock", async () => {
		const first = await reset();
		const holder = await openBlockingTx(async (tx) => {
			await lockClubForWrite(tx, first.clubId);
		});
		let released = false;
		try {
			const rebuilding = reset();
			rebuilding.catch(() => {});
			await waitForLockWait("pg_advisory_xact_lock", holder.pid);
			released = true;
			await holder.commit();
			const second = await rebuilding;
			expect(second.clubId).not.toBe(first.clubId);
		} finally {
			if (!released) await holder.commit();
		}
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

	// ---- the demo hierarchy (#1278) ----
	const hierarchy = async () => {
		const ds = await testDb
			.select()
			.from(districts)
			.where(eq(districts.isDemo, true));
		const ids = ds.map((d) => d.id);
		const divs = ids.length
			? await testDb
					.select()
					.from(divisions)
					.where(inArray(divisions.districtId, ids))
			: [];
		const ars = divs.length
			? await testDb
					.select()
					.from(areas)
					.where(
						inArray(
							areas.divisionId,
							divs.map((d) => d.id),
						),
					)
			: [];
		return { districts: ds, divisions: divs, areas: ars };
	};
	const rowsOf = (areaId: string) =>
		testDb.select().from(areaClubs).where(eq(areaClubs.areaId, areaId));
	const visitsOf = (areaId: string) =>
		testDb
			.select({
				id: clubVisits.id,
				round: clubVisits.round,
				visitedOn: clubVisits.visitedOn,
				name: areaClubs.name,
			})
			.from(clubVisits)
			.innerJoin(areaClubs, eq(areaClubs.id, clubVisits.areaClubId))
			.where(eq(areaClubs.areaId, areaId));
	const openTerms = (areaId: string) =>
		testDb
			.select()
			.from(areaDirectors)
			.where(
				and(eq(areaDirectors.areaId, areaId), isNull(areaDirectors.endedAt)),
			);

	// protects=the first build on a database with no demo district makes one
	//   district (number DEMO, flagged), one division (this program year, A), one
	//   area (1), four area clubs with no club number (the demo club + three
	//   name-only) and two round-1 visits (demo club, Bayfront Speakers);
	// fails_when=any of the rows is missing or doubled, a club number is written,
	//   or a visit lands on another club or round;
	// no_claim=stub builder stands in for the fixture; no demo account, so the
	//   visits' recorded_by is null.
	it("builds the demo district, division, area, four clubs and two visits on a first rebuild", async () => {
		const now = new Date();
		const { clubId } = await reset({ now });

		const h = await hierarchy();
		expect(h.districts).toHaveLength(1);
		expect(h.districts[0]).toMatchObject({
			number: DEMO_DISTRICT_NUMBER,
			isDemo: true,
		});
		expect(h.divisions).toHaveLength(1);
		expect(h.divisions[0]).toMatchObject({
			programYear: currentProgramYear(now),
			letter: "A",
		});
		expect(h.areas).toHaveLength(1);
		const area = h.areas[0];
		expect(area?.number).toBe("1");
		const rows = await rowsOf(area?.id as string);
		expect(rows.map((r) => r.name).sort()).toEqual(
			[
				"GavelUp Demo Club",
				"Bayfront Speakers",
				"Lighthouse Orators",
				"Pier Nine Toastmasters",
			].sort(),
		);
		expect(rows.every((r) => r.clubNumber === null)).toBe(true);
		expect(rows.find((r) => r.name === "GavelUp Demo Club")?.clubId).toBe(
			clubId,
		);
		expect(rows.filter((r) => r.clubId === null)).toHaveLength(3);
		const visits = await visitsOf(area?.id as string);
		expect(visits.map((v) => [v.name, v.round]).sort()).toEqual([
			["Bayfront Speakers", 1],
			["GavelUp Demo Club", 1],
		]);
	});

	// protects=a second rebuild keeps the one district/division/area, leaves
	//   exactly four area clubs (the previous demo row is cleared, not orphaned by
	//   the club delete's SET NULL), points the demo row at the NEW club and keeps
	//   exactly two visits;
	// fails_when=a second area or division appears, a name-only row is doubled or
	//   an orphan demo row with a null club survives, the demo row keeps the old
	//   club id, or the visits double;
	// no_claim=stub builder; same program year both times.
	it("a second rebuild keeps one area, four clubs, the demo row on the new club and two visits", async () => {
		await reset();
		const first = await hierarchy();
		const { clubId } = await reset();

		const h = await hierarchy();
		expect([h.districts.length, h.divisions.length, h.areas.length]).toEqual([
			1, 1, 1,
		]);
		expect(h.areas[0]?.id).toBe(first.areas[0]?.id);
		const rows = await rowsOf(h.areas[0]?.id as string);
		expect(rows).toHaveLength(4);
		expect(rows.filter((r) => r.name === "GavelUp Demo Club")).toEqual([
			expect.objectContaining({ clubId }),
		]);
		expect(await visitsOf(h.areas[0]?.id as string)).toHaveLength(2);
	});

	// protects=the in-club reset (actor clubAdmin) leaves the same hierarchy
	//   state as the superadmin rebuild, with the demo account as the visits'
	//   recorded_by;
	// fails_when=the club-admin path skips the hierarchy step or doubles rows, or
	//   the visits carry no recorder;
	// no_claim=stub builder; authorization is the #1199 cases above.
	it("the in-club reset produces the same state as a second superadmin rebuild", async () => {
		const demoUser = await demoAccount();
		const first = await reset();
		const { clubId } = await reset({
			actor: { kind: "clubAdmin", userId: demoUser },
			expectClubId: first.clubId,
		});

		const h = await hierarchy();
		expect([h.districts.length, h.divisions.length, h.areas.length]).toEqual([
			1, 1, 1,
		]);
		const rows = await rowsOf(h.areas[0]?.id as string);
		expect(rows).toHaveLength(4);
		expect(rows.find((r) => r.name === "GavelUp Demo Club")?.clubId).toBe(
			clubId,
		);
		expect(await visitsOf(h.areas[0]?.id as string)).toHaveLength(2);
		const recorders = await testDb
			.select({ recordedBy: clubVisits.recordedBy })
			.from(clubVisits)
			.innerJoin(areaClubs, eq(areaClubs.id, clubVisits.areaClubId))
			.where(eq(areaClubs.areaId, h.areas[0]?.id as string));
		expect(recorders.map((r) => r.recordedBy)).toEqual([demoUser, demoUser]);
	});

	// protects=with the demo account signed in once, it is the area's one open
	//   director term (display name Demo Presenter), the area shows as A1 on its
	//   current-areas list, and a rebuild keeps that same term row;
	// fails_when=no term, a second open term, a different display name, or a new
	//   term row (id changed) on the second rebuild;
	// no_claim=stub builder; the term's current-ness is read at the real clock.
	it("opens the demo account's director term once and keeps it across rebuilds", async () => {
		const demoUser = await demoAccount();
		const now = new Date();
		await reset({ now });
		const areaId = (await hierarchy()).areas[0]?.id as string;

		const terms = await openTerms(areaId);
		expect(terms).toEqual([
			expect.objectContaining({
				userId: demoUser,
				displayName: "Demo Presenter",
				assignedBy: superId,
			}),
		]);
		expect(await loadCurrentAreasForUser(demoUser, now)).toEqual([
			{ id: areaId, label: "A1" },
		]);

		await reset({ now });
		const after = await openTerms(areaId);
		expect(after.map((t) => t.id)).toEqual([terms[0]?.id]);
	});

	// protects=with no demo account the rebuild succeeds and opens no term, and an
	//   open term already on the area (an earlier demo account) is left as it is;
	// fails_when=the rebuild throws without an account, opens a term for nobody,
	//   or ends the old term it cannot replace;
	// no_claim=stub builder.
	it("opens no term without a demo account and leaves an existing open term", async () => {
		await reset();
		const areaId = (await hierarchy()).areas[0]?.id as string;
		expect(await openTerms(areaId)).toHaveLength(0);

		const other = await makeUser({ email: realEmail("old-director") });
		await testDb.insert(areaDirectors).values({
			areaId,
			userId: other,
			displayName: "Old Director",
			assignedBy: superId,
		});
		await reset();
		const open = await openTerms(areaId);
		expect(open.map((t) => [t.userId, t.endedAt])).toEqual([[other, null]]);
	});

	// protects=when the demo address now names another account, the old account's
	//   term is ended by the actor and the new account holds the one open term;
	// fails_when=the old term stays open (two directors, or the insert collides on
	//   the one-open-term index), ended_by is not the actor, or the new account
	//   gets no term;
	// no_claim=stub builder.
	it("ends the previous account's term and opens one for the new demo account", async () => {
		const accountX = await demoAccount();
		await reset();
		const areaId = (await hierarchy()).areas[0]?.id as string;
		// The address moves to a new account: X keeps its row but under another email.
		await testDb
			.update(user)
			.set({ email: realEmail("former-demo") })
			.where(eq(user.id, accountX));
		const accountY = await makeUser({ email: DEMO_EMAIL });

		await reset();

		const terms = await testDb
			.select()
			.from(areaDirectors)
			.where(eq(areaDirectors.areaId, areaId));
		const x = terms.find((t) => t.userId === accountX);
		expect(x?.endedAt).not.toBeNull();
		expect(x?.endedBy).toBe(superId);
		const open = await openTerms(areaId);
		expect(open.map((t) => t.userId)).toEqual([accountY]);
	});

	// protects=the round-1 visit is dated 14 calendar days back in America/Chicago,
	//   and never before the program year's first day: on July 5 it is July 1;
	// fails_when=the date is UTC-based, is before July 1, or is not clamped;
	// no_claim=stub builder; the arithmetic itself is the unit cases.
	it("dates the round-1 visit 14 days back, clamped to July 1", async () => {
		const july = new Date("2026-07-05T17:00:00Z");
		await reset({ now: july });
		const areaId = (await hierarchy()).areas[0]?.id as string;
		expect((await visitsOf(areaId)).map((v) => v.visitedOn)).toEqual([
			"2026-07-01",
			"2026-07-01",
		]);

		await reset({ now: new Date("2026-11-15T18:00:00Z") });
		expect((await visitsOf(areaId)).map((v) => v.visitedOn)).toEqual([
			"2026-11-01",
			"2026-11-01",
		]);
	});

	// protects=a rebuild in the next program year builds that year's division and
	//   area and leaves last year's rows alone, except that last year's demo row
	//   loses its club (the club was deleted);
	// fails_when=last year's division/area is reused or deleted, its name-only
	//   rows or visits are cleared, or its demo row still points at a club;
	// no_claim=stub builder; last year's term is not asserted.
	it("a rebuild in the next program year builds a new division and area, leaving last year's", async () => {
		await reset({ now: new Date("2026-11-15T18:00:00Z") });
		const lastArea = (await hierarchy()).areas[0]?.id as string;
		const lastRowsBefore = (await rowsOf(lastArea))
			.map((r) => [r.id, r.name])
			.sort();
		const lastVisitsBefore = (await visitsOf(lastArea))
			.map((v) => [v.id, v.name, v.visitedOn])
			.sort();
		await reset({ now: new Date("2027-08-10T18:00:00Z") });

		const h = await hierarchy();
		expect(h.districts).toHaveLength(1);
		expect(h.divisions.map((d) => d.programYear).sort()).toEqual([2026, 2027]);
		expect(h.areas).toHaveLength(2);
		const rows = await rowsOf(lastArea);
		expect(rows).toHaveLength(4);
		expect(rows.every((r) => r.clubId === null)).toBe(true);
		expect(rows.map((r) => [r.id, r.name]).sort()).toEqual(lastRowsBefore);
		expect(
			(await visitsOf(lastArea)).map((v) => [v.id, v.name, v.visitedOn]).sort(),
		).toEqual(lastVisitsBefore);
		const newArea = h.areas.find((a) => a.id !== lastArea);
		expect(
			(await rowsOf(newArea?.id as string)).filter((r) => r.clubId !== null),
		).toHaveLength(1);
	});

	// protects=just after UTC midnight on July 1 (still June 30 in Chicago) the
	//   division is the previous program year's and the visit is not dated later
	//   than the day the demo runs;
	// fails_when=the server clock's zone picks the program year, so the division
	//   is next year's while the visit day is in June;
	// no_claim=stub builder; the arithmetic itself is the unit cases.
	it("takes the program year from the Chicago day at the July 1 boundary", async () => {
		await reset({ now: new Date("2027-07-01T01:00:00Z") });

		const h = await hierarchy();
		expect(h.divisions.map((d) => d.programYear)).toEqual([2026]);
		expect(
			(await visitsOf(h.areas[0]?.id as string)).map((v) => v.visitedOn),
		).toEqual(["2027-06-16", "2027-06-16"]);
	});

	// protects=a demo account holding an open term in a REAL area is refused with
	//   a named error and the whole rebuild rolls back: the previous demo club and
	//   its area rows (same ids) are intact;
	// fails_when=the rebuild proceeds (the account would direct a real area and
	//   the demo area), throws a raw error, or leaves a half-rebuilt state;
	// no_claim=stub builder; the console-side refusal is #1294's.
	it("refuses a demo account that holds a term in a real area, and rolls back", async () => {
		const demoUser = await demoAccount();
		const first = await reset();
		const demoAreaId = (await hierarchy()).areas[0]?.id as string;
		const before = (await rowsOf(demoAreaId)).map((r) => r.id).sort();
		const [realDistrict] = await testDb
			.insert(districts)
			.values({ number: `R${RUN}`.slice(0, 8) })
			.returning({ id: districts.id });
		const [realDivision] = await testDb
			.insert(divisions)
			.values({
				districtId: realDistrict?.id as string,
				programYear: currentProgramYear(new Date()),
				letter: "Q",
			})
			.returning({ id: divisions.id });
		const [realArea] = await testDb
			.insert(areas)
			.values({ divisionId: realDivision?.id as string, number: "9" })
			.returning({ id: areas.id });
		await testDb.insert(areaDirectors).values({
			areaId: realArea?.id as string,
			userId: demoUser,
			displayName: "Demo Presenter",
			assignedBy: superId,
		});
		try {
			await expect(reset()).rejects.toMatchObject({
				name: "DemoError",
				code: "ACCOUNT_DIRECTS_REAL_AREA",
			});
			expect((await demoClubs()).map((c) => c.id)).toEqual([first.clubId]);
			expect((await rowsOf(demoAreaId)).map((r) => r.id).sort()).toEqual(
				before,
			);
		} finally {
			await testDb
				.delete(areaDirectors)
				.where(eq(areaDirectors.areaId, realArea?.id as string));
			await testDb.delete(areas).where(eq(areas.id, realArea?.id as string));
			await testDb
				.delete(divisions)
				.where(eq(divisions.id, realDivision?.id as string));
			await testDb
				.delete(districts)
				.where(eq(districts.id, realDistrict?.id as string));
		}
	});

	// protects=a district numbered DEMO that is not flagged is refused with a named
	//   error instead of a raw unique violation, and nothing is rebuilt;
	// fails_when=the insert raises 23505, or the unflagged district is adopted;
	// no_claim=stub builder.
	it("refuses with a named error when a non-demo district already has the number", async () => {
		const [taken] = await testDb
			.insert(districts)
			.values({ number: DEMO_DISTRICT_NUMBER })
			.returning({ id: districts.id });
		try {
			await expect(reset()).rejects.toMatchObject({
				name: "DemoError",
				code: "DEMO_DISTRICT_NUMBER_TAKEN",
			});
			expect(await demoClubs()).toHaveLength(0);
		} finally {
			await testDb
				.delete(districts)
				.where(eq(districts.id, taken?.id as string));
		}
	});

	// protects=a throw after the hierarchy step's first insert rolls the whole
	//   rebuild back: the previous demo club and its four area rows (same ids) are
	//   intact;
	// fails_when=the area rows are rebuilt while the club is not (or the reverse);
	// no_claim=the throw is a trigger that refuses the demo club's visit insert,
	//   scoped to the demo club's area row so no other suite is affected.
	it("rolls back the whole rebuild when the area step throws", async () => {
		const first = await reset();
		const areaId = (await hierarchy()).areas[0]?.id as string;
		const before = (await rowsOf(areaId)).map((r) => r.id).sort();
		const fn = `demo_1278_boom_${RUN}`;
		await testDb.execute(
			sql.raw(`create function ${fn}() returns trigger language plpgsql as $$
begin
  if exists (select 1 from area_clubs where id = new.area_club_id and name = 'GavelUp Demo Club' and club_id is not null and club_id <> '${first.clubId}') then
    raise exception 'injected failure';
  end if;
  return new;
end $$`),
		);
		await testDb.execute(
			sql.raw(
				`create trigger ${fn} before insert on club_visits for each row execute function ${fn}()`,
			),
		);
		try {
			await expect(reset()).rejects.toThrow();
		} finally {
			await testDb.execute(
				sql.raw(`drop trigger if exists ${fn} on club_visits`),
			);
			await testDb.execute(sql.raw(`drop function if exists ${fn}()`));
		}

		expect((await demoClubs()).map((c) => c.id)).toEqual([first.clubId]);
		expect((await rowsOf(areaId)).map((r) => r.id).sort()).toEqual(before);
		expect(await visitsOf(areaId)).toHaveLength(2);
	});
});

describe.skipIf(!hasTestDb)("deleteClubCore keepUser (#1199)", () => {
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

	// protects=an account the keepUser predicate accepts survives the club delete
	//   with its session while its Person (held only by this club) is deleted, and
	//   the club's other accounts are deleted as before;
	// fails_when=the kept account is deleted, its Person is kept, or the predicate
	//   keeps accounts it does not accept;
	// no_claim=the existing delete rules are the #914 suite's, run unmodified.
	it("keeps an account the predicate accepts and its session, still deleting its Person", async () => {
		const f = await twoPersonClub();

		await testDb.transaction((tx) =>
			deleteClubCore(tx, f.clubId, {
				keepUser: (account) => account.id === f.keepUser,
			}),
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

	// protects=the control for the case above: with no predicate both accounts
	//   go, so the predicate is what held the account;
	// fails_when=the first case would pass with no predicate;
	// no_claim=none beyond protects.
	it("deletes both accounts when no predicate is given", async () => {
		const f = await twoPersonClub();

		await testDb.transaction((tx) => deleteClubCore(tx, f.clubId));

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

		// protects=an archived demo club refuses the public guest book as every
		//   archived club does, instead of answering success;
		// fails_when=the demo early return runs before the archive refusal;
		// no_claim=the refusal's wording; officer flows are not touched.
		it("refuses a guest-book submission on an archived demo club", async () => {
			const demo = await liveClub(true);
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, demo.clubId));

			await expect(
				book(demo.clubId, `vera-arch-${RUN}@club.org`),
			).rejects.toThrow(/archived/i);
			expect(await guestsOf(demo.clubId)).toEqual([]);
		});

		// protects=an archived demo club refuses anonymous feedback instead of
		//   answering success;
		// fails_when=the demo early return runs before the archive refusal;
		// no_claim=the refusal's wording.
		it("refuses anonymous feedback on an archived demo club", async () => {
			const { leaveFeedbackLogic } = await import("./role-feedback-logic");
			const demo = await liveClub(true);
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, demo.clubId));

			await expect(
				leaveFeedbackLogic({
					meetingId: demo.meetingId,
					target: { kind: "slot" as const, id: demo.slotId },
					wentWell: "Clear signals",
				}),
			).rejects.toThrow(/archived/i);
			expect(await notesFor(demo.meetingId)).toEqual([]);
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
