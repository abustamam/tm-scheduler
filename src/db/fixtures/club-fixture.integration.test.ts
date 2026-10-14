/**
 * DB-backed tests for the Harbor City fixture club (#1198).
 *
 * Every test carries its card: what it protects, the wrong result it rejects,
 * and what green does not prove.
 *
 * The roster addresses are fixed (`priya@example.com`, ...), so the suite
 * deletes the accounts and Persons at them before and after each test, and
 * builds each club under a per-run slug and admin address. Test files run in
 * parallel against one database; nothing else here uses those addresses.
 *
 * Run with:
 *   bunx vitest run src/db/fixtures/club-fixture.integration.test.ts
 */
import { readFileSync } from "node:fs";
import { and, count, eq, inArray, sql } from "drizzle-orm";
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
import {
	clubs,
	dcpGoalProgress,
	dcpScoreboards,
	duesPeriods,
	guests,
	meetingAttendance,
	meetingAwards,
	meetings,
	memberDues,
	members,
	pathEnrollments,
	pathwaysPaths,
	pathwaysProjects,
	people,
	roleDefinitions,
	roleSlots,
	tableTopicsSpeakers,
	user,
} from "#/db/schema";
import { utcToZonedWallTime } from "#/lib/datetime";
import { PATHWAYS_CATALOG } from "#/lib/pathways-catalog";
import type { DbOrTx } from "#/server/meeting-templates-logic";
import { listMentors } from "#/server/mentorship-logic";
import { loadFeedbackForUser } from "#/server/role-feedback-logic";
import { cleanup, hasTestDb, openBlockingTx, testDb } from "#/test/db";
import {
	buildFixtureClub,
	FixtureError,
	fixtureRosterEmails,
} from "./club-fixture.ts";
import { ensureFixtureUser } from "./helpers.ts";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const RUN = Math.random().toString(36).slice(2, 8);
const ZONE = "America/Chicago";
const ADMIN_EMAIL = `admin-${RUN}@example.com`;
const ADMIN_NAME = "Test Presenter";
const FIXTURE_EMAILS = fixtureRosterEmails(ADMIN_EMAIL);
/** Guests the fixture creates; their Persons carry these addresses. */
const GUEST_EMAILS = [
	"lucia.moreno@example.com",
	"ethan.brooks@example.com",
	"imani.clarke@example.com",
	"theo.marchetti@example.com",
];

class Rollback extends Error {}

const CATALOG_CODES = ["8706", "8700", "8705", "8701"];
/** Catalog paths this file inserted, so it can take them out again. */
const addedPathIds: string[] = [];

/**
 * The fixture only READS the catalog. A test DB that lacks a path it needs gets
 * that path with its projects and no level rows (a level row for a real path
 * would change what the progress suites see). The insert is
 * `onConflictDoNothing().returning(id)`, so `addedPathIds` holds exactly the
 * rows THIS file created and `removeAddedCatalog` deletes only those: the
 * Pathways suites run in parallel against the same database and may have
 * inserted the same course code first, and that row is theirs.
 */
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

describe.skipIf(!hasTestDb)("Harbor City fixture club", () => {
	const clubIds: string[] = [];
	let slugCounter = 0;
	const opts = (now: Date, userId: string | null = null) => ({
		name: `Harbor Fixture ${RUN}`,
		slug: `harbor-fixture-${RUN}-${++slugCounter}`,
		timeZone: ZONE,
		now,
		admin: { name: ADMIN_NAME, email: ADMIN_EMAIL, userId },
	});

	async function removeFixtureRows() {
		const emails = [...FIXTURE_EMAILS, ...GUEST_EMAILS];
		const userIds = (
			await testDb
				.select({ id: user.id })
				.from(user)
				.where(inArray(user.email, emails))
		).map((u) => u.id);
		for (const id of clubIds.splice(0)) await cleanup(id, []);
		// A rolled-back or refused build leaves no club to cascade from; and a
		// pre-existing account is not the fixture's to keep.
		await testDb.delete(people).where(inArray(people.email, emails));
		if (userIds.length > 0) {
			await testDb.delete(user).where(inArray(user.id, userIds));
		}
	}

	// Both this suite and `demo-reset-logic.integration.test.ts` (#1199) build the
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
	// After-hooks unwind last-defined first: the club rows go before the paths.
	afterAll(removeAddedCatalog);
	beforeEach(removeFixtureRows);
	afterEach(removeFixtureRows);
	afterAll(removeFixtureRows);

	/** A committed build with a real admin account, as `db:seed` makes one. */
	async function build(now = new Date()) {
		const userId = await ensureFixtureUser(testDb, ADMIN_NAME, ADMIN_EMAIL);
		const o = opts(now, userId);
		const { clubId } = await buildFixtureClub(testDb, o);
		clubIds.push(clubId);
		return { clubId, userId, now };
	}

	/** Every base table of the public schema, with each row as JSON text. */
	async function snapshotEveryTable(conn: DbOrTx) {
		const names = (
			await conn.execute<{ table_name: string }>(
				sql`select table_name from information_schema.tables
					where table_schema = 'public' and table_type = 'BASE TABLE'`,
			)
		).rows.map((r) => r.table_name);
		const rows = new Map<string, Set<string>>();
		for (const name of names) {
			const res = await conn.execute<{ r: string }>(
				sql`select to_jsonb(t)::text as r from ${sql.identifier(name)} t`,
			);
			rows.set(name, new Set(res.rows.map((x) => x.r)));
		}
		return rows;
	}

	// protects=a transaction that throws after the build leaves nothing behind in
	//   ANY table of the public schema, including the mentorship, which used to
	//   open its own transaction and so could not even see the club;
	// fails_when=any fixture write goes through a connection other than the one
	//   it was given (it would commit, or be refused for naming a club that does
	//   not exist yet), or any table keeps a row the build created;
	// no_claim=NOT a before/after count of every table: test files run in
	//   parallel against one database, so a global count moves for reasons of its
	//   own. The rows the build created are identified instead, inside a
	//   REPEATABLE READ transaction (other suites' commits are invisible there),
	//   as the rows every public table holds with the build minus the rows it
	//   holds once the build's savepoint is rolled back; after the outer
	//   rollback each of those exact rows is looked for in the committed table.
	//   It does not see a row a fixture write committed on another connection
	//   that this snapshot cannot read, other than by finding it in the committed
	//   tables afterwards, which it does by exact content.
	it("leaves no row behind when the transaction rolls back", async () => {
		const o = opts(new Date());
		const created = new Map<string, string[]>();
		let clubId = "";
		await expect(
			testDb.transaction(
				async (tx) => {
					let withBuild = new Map<string, Set<string>>();
					await expect(
						tx.transaction(async (sp) => {
							({ clubId } = await buildFixtureClub(sp, o));
							withBuild = await snapshotEveryTable(sp);
							throw new Rollback();
						}),
					).rejects.toBeInstanceOf(Rollback);
					// The savepoint is gone: this is the state before the build.
					const before = await snapshotEveryTable(tx);
					for (const [name, rows] of withBuild) {
						const own = [...rows].filter((r) => !before.get(name)?.has(r));
						if (own.length > 0) created.set(name, own);
					}
					throw new Rollback();
				},
				{ isolationLevel: "repeatable read" },
			),
		).rejects.toBeInstanceOf(Rollback);

		// Not vacuous: the build wrote to the tables this test is about, and to
		// the many that carry no club_id of their own.
		for (const t of [
			"clubs",
			"mentorships",
			"meetings",
			"role_slots",
			"user",
			"people",
			"meeting_attendance",
			"member_dues",
			"dcp_goal_progress",
		]) {
			expect(created.has(t), `${t} gained no row inside the build`).toBe(true);
		}
		expect(clubId).not.toBe("");

		const after = await snapshotEveryTable(testDb);
		for (const [name, rows] of created) {
			const kept = rows.filter((r) => after.get(name)?.has(r));
			expect(kept, `${name} kept rows the build created`).toEqual([]);
		}
	});

	// protects=what an officer opens between meetings (dues, minutes on every held
	//   meeting, an evaluator on every held speech, the DCP board) and what the
	//   presenter opens ("my" notes, next role, Pathways, attendance) are all
	//   non-empty, and the notes come back through the signed-in user's own
	//   memberships, the way the app reads them;
	// fails_when=any of those rows is not written, a note is addressed to a
	//   member other than the admin, or the admin's Person is not linked to
	//   `admin.userId`;
	// no_claim=says nothing about how the screens render these rows, and the
	//   catalog is the real one for the four paths it needs, without level rows.
	it("builds the officers' views and the presenter's history", async () => {
		const { clubId, userId, now } = await build();

		const held = await testDb
			.select({ id: meetings.id, status: meetings.status })
			.from(meetings)
			.where(
				and(eq(meetings.clubId, clubId), sql`${meetings.scheduledAt} < ${now}`),
			);
		expect(held).toHaveLength(6);
		expect(held.every((m) => m.status === "completed")).toBe(true);

		// Dues: one period, five paid; the other two members are open.
		const periods = await testDb
			.select({ id: duesPeriods.id })
			.from(duesPeriods)
			.where(eq(duesPeriods.clubId, clubId));
		expect(periods).toHaveLength(1);
		const [paid] = await testDb
			.select({ n: count() })
			.from(memberDues)
			.where(
				and(
					eq(memberDues.duesPeriodId, periods[0]!.id),
					eq(memberDues.status, "paid"),
				),
			);
		const [roster] = await testDb
			.select({ n: count() })
			.from(members)
			.where(eq(members.clubId, clubId));
		expect(paid?.n).toBe(5);
		expect(roster?.n).toBe(7);

		// DCP: this program year's board with all ten goals.
		const [board] = await testDb
			.select({ id: dcpScoreboards.id, year: dcpScoreboards.programYear })
			.from(dcpScoreboards)
			.where(eq(dcpScoreboards.clubId, clubId));
		expect(board?.year).toBeTypeOf("number");
		const goals = await testDb
			.select({ key: dcpGoalProgress.goalKey })
			.from(dcpGoalProgress)
			.where(eq(dcpGoalProgress.scoreboardId, board!.id));
		expect(goals).toHaveLength(10);

		// Minutes and evaluators, on each of the six held meetings.
		const defs = await testDb
			.select({ id: roleDefinitions.id, name: roleDefinitions.name })
			.from(roleDefinitions)
			.where(eq(roleDefinitions.clubId, clubId));
		const defName = new Map(defs.map((d) => [d.id, d.name]));
		for (const m of held) {
			const awards = await testDb
				.select({ category: meetingAwards.category })
				.from(meetingAwards)
				.where(eq(meetingAwards.meetingId, m.id));
			expect(awards.map((a) => a.category).sort()).toEqual([
				"best_evaluator",
				"best_speaker",
				"best_table_topics",
			]);
			const [topics] = await testDb
				.select({ n: count() })
				.from(tableTopicsSpeakers)
				.where(eq(tableTopicsSpeakers.meetingId, m.id));
			expect(topics?.n).toBeGreaterThanOrEqual(3);
			const [attendance] = await testDb
				.select({ n: count() })
				.from(meetingAttendance)
				.where(eq(meetingAttendance.meetingId, m.id));
			expect(attendance?.n).toBeGreaterThanOrEqual(5);

			const slots = await testDb
				.select()
				.from(roleSlots)
				.where(eq(roleSlots.meetingId, m.id));
			const speakers = slots.filter(
				(s) => defName.get(s.roleDefinitionId) === "Speaker" && s.speechId,
			);
			expect(speakers.length).toBeGreaterThanOrEqual(3);
			for (const sp of speakers) {
				const evaluator = slots.find((s) => s.evaluatesSlotId === sp.id);
				expect(
					evaluator?.assignedMemberId,
					`a held speech has no claimed evaluator`,
				).toBeTruthy();
			}
		}

		// The presenter: their Person is linked to the account, and the account's
		// own memberships return the notes addressed to them.
		const [adminMember] = await testDb
			.select({ id: members.id, personId: members.personId })
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(and(eq(members.clubId, clubId), eq(people.userId, userId)));
		expect(adminMember).toBeDefined();
		const feedback = await loadFeedbackForUser(userId, {}, now);
		expect(feedback.meetings).toHaveLength(2);
		const labels = feedback.meetings
			.flatMap((g) => g.roles)
			.map((r) => `${r.roleLabel} x${r.notes.length}`)
			.sort();
		expect(labels).toEqual(["Speaker 2 x2", "Toastmaster of the Day x2"]);

		const upcoming = await testDb
			.select({ id: roleSlots.id })
			.from(roleSlots)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(
				and(
					eq(roleSlots.assignedMemberId, adminMember!.id),
					eq(meetings.clubId, clubId),
					sql`${meetings.scheduledAt} > ${now}`,
				),
			);
		expect(upcoming).toHaveLength(1);
		const paths = await testDb
			.select({ id: pathEnrollments.id })
			.from(pathEnrollments)
			.where(eq(pathEnrollments.personId, adminMember!.personId));
		expect(paths).toHaveLength(1);
		const attended = await testDb
			.select({ id: meetingAttendance.meetingId })
			.from(meetingAttendance)
			.where(eq(meetingAttendance.memberId, adminMember!.id));
		expect(new Set(attended.map((a) => a.id))).toEqual(
			new Set(held.map((m) => m.id)),
		);
		// Visitors were counted at the first three meetings (1 + 2 + 1 rows).
		const [guestRows] = await testDb
			.select({ n: count() })
			.from(meetingAttendance)
			.where(
				and(
					inArray(
						meetingAttendance.meetingId,
						held.map((m) => m.id),
					),
					sql`${meetingAttendance.guestId} is not null`,
				),
			);
		expect(guestRows?.n).toBe(4);
		// Camille joined four days ago: she was at none of the held meetings, and
		// held no role at any of them.
		const [camille] = await testDb
			.select({ id: members.id })
			.from(members)
			.where(and(eq(members.clubId, clubId), eq(members.name, "Camille Roy")));
		const camilleAtHeld = await testDb
			.select({ id: meetingAttendance.id })
			.from(meetingAttendance)
			.where(
				and(
					eq(meetingAttendance.memberId, camille!.id),
					inArray(
						meetingAttendance.meetingId,
						held.map((m) => m.id),
					),
				),
			);
		expect(camilleAtHeld).toHaveLength(0);
	});

	// protects=the demo club and `db:seed` show Find a mentor with mentors on it
	//   (#945): a fixture member who is willing carries `mentor_listed_at`, so
	//   `listMentors` returns them to another member;
	// fails_when=the fixture inserts `willing_to_mentor` without the listing (the
	//   page is empty, a demo walk-through of "Find a mentor" shows nobody), or
	//   lists a member who is not willing (the members CHECK refuses that row);
	// no_claim=NOT which members are willing; only that every willing one is
	//   listed and no unwilling one is, and that the page returns them.
	it("lists every willing fixture member on Find a mentor", async () => {
		const { clubId } = await build();
		const rows = await testDb
			.select({
				id: members.id,
				name: members.name,
				willing: members.willingToMentor,
				listedAt: members.mentorListedAt,
			})
			.from(members)
			.where(eq(members.clubId, clubId));
		const willing = rows.filter((r) => r.willing);
		expect(willing.length).toBeGreaterThan(0);
		expect(willing.every((r) => r.listedAt !== null)).toBe(true);
		expect(
			rows.filter((r) => !r.willing).every((r) => r.listedAt === null),
		).toBe(true);

		// A member who is not themselves a mentor sees every willing member.
		const viewer = rows.find((r) => !r.willing);
		expect(viewer).toBeDefined();
		const listed = await listMentors(clubId, viewer!.id);
		expect(listed.map((m) => m.memberId).sort()).toEqual(
			willing.map((r) => r.id).sort(),
		);
	});

	// protects=every meeting is 18:00 on the club's wall clock, on the date the
	//   CLUB is on, when the process runs in UTC; and the fixture holds only
	//   reserved fiction: @example.com addresses and +1 202 555 01xx numbers;
	// fails_when=a meeting is placed with the process's own zone (18:00 UTC is
	//   13:00 in Chicago), the date is taken in UTC (the fixed `now` is 22:30 on
	//   the 14th in Chicago and already the 15th in UTC), or any address or
	//   number is not the reserved kind;
	// no_claim=one zone and one winter-free date; DST changeovers are
	//   `datetime.test.ts`'s, and the real server's zone is only emulated by
	//   setting TZ here.
	it("places meetings at 18:00 club time under TZ=UTC and uses only reserved contacts", async () => {
		const priorTz = process.env.TZ;
		process.env.TZ = "UTC";
		try {
			expect(new Date(2026, 6, 15, 12).getTimezoneOffset()).toBe(0);
			const now = new Date("2026-07-15T03:30:00.000Z");
			const { clubId } = await build(now);

			const rows = await testDb
				.select({ at: meetings.scheduledAt })
				.from(meetings)
				.where(eq(meetings.clubId, clubId))
				.orderBy(meetings.scheduledAt);
			const wall = rows.map((r) => utcToZonedWallTime(r.at, ZONE));
			expect(wall).toEqual([
				"2026-06-02T18:00",
				"2026-06-09T18:00",
				"2026-06-16T18:00",
				"2026-06-23T18:00",
				"2026-06-30T18:00",
				"2026-07-07T18:00",
				"2026-07-17T18:00",
				"2026-07-24T18:00",
				"2026-07-31T18:00",
				"2026-08-07T18:00",
			]);
			expect(rows.filter((r) => r.at < now)).toHaveLength(6);
			expect(rows.filter((r) => r.at > now)).toHaveLength(4);
			// CDT is UTC-5: 18:00 there is 23:00Z, which a zone mix-up cannot fake.
			expect(rows[5]?.at.toISOString()).toBe("2026-07-07T23:00:00.000Z");

			const contacts = [
				...(await testDb
					.select({ email: people.email, phone: people.phone })
					.from(people)
					.innerJoin(members, eq(members.personId, people.id))
					.where(eq(members.clubId, clubId))),
				...(await testDb
					.select({ email: people.email, phone: people.phone })
					.from(people)
					.innerJoin(guests, eq(guests.personId, people.id))
					.where(eq(guests.clubId, clubId))),
			];
			expect(contacts).toHaveLength(11);
			for (const c of contacts) {
				expect(c.email, "a Person without an address").toBeTruthy();
				expect(c.email).toMatch(/@example\.com$/);
				if (c.phone !== null) expect(c.phone).toMatch(/^\+120255501\d\d$/);
			}
			const accounts = await testDb
				.select({ email: user.email })
				.from(user)
				.innerJoin(people, eq(people.userId, user.id))
				.innerJoin(members, eq(members.personId, people.id))
				.where(eq(members.clubId, clubId));
			expect(accounts).toHaveLength(7);
			for (const a of accounts) expect(a.email).toMatch(/@example\.com$/);
		} finally {
			if (priorTz === undefined) delete process.env.TZ;
			else process.env.TZ = priorTz;
		}
	});

	// protects=the DCP scoreboard is for the program year the CLUB is in: a
	//   Chicago club on the evening of June 30 is still in the program year that
	//   ends that day, though the server's clock (UTC) already reads July 1;
	// fails_when=the year is computed from the process's own date: under TZ=UTC
	//   the first instant below is July 1 there and would give 2026, not 2025;
	// no_claim=two instants around one boundary in one zone; the rest of the
	//   year, and zones ahead of UTC, are not exercised, and `board.year` is
	//   compared with literals, not with `programYearForDate`.
	it("takes the DCP program year from the club's wall date under TZ=UTC", async () => {
		const priorTz = process.env.TZ;
		process.env.TZ = "UTC";
		try {
			expect(new Date(2026, 6, 1, 12).getTimezoneOffset()).toBe(0);
			const cases: [string, string, number][] = [
				// 21:30 on June 30 in Chicago (CDT), 02:30 on July 1 in UTC.
				["2026-07-01T02:30:00.000Z", "2026-06-30T21:30", 2025],
				// 00:30 on July 1 in Chicago, 05:30 in UTC.
				["2026-07-01T05:30:00.000Z", "2026-07-01T00:30", 2026],
			];
			for (const [instant, wall, year] of cases) {
				const now = new Date(instant);
				expect(utcToZonedWallTime(now, ZONE)).toBe(wall);
				const { clubId } = await build(now);
				const [board] = await testDb
					.select({ year: dcpScoreboards.programYear })
					.from(dcpScoreboards)
					.where(eq(dcpScoreboards.clubId, clubId));
				expect(board?.year, `program year at ${wall} in Chicago`).toBe(year);
			}
		} finally {
			if (priorTz === undefined) delete process.env.TZ;
			else process.env.TZ = priorTz;
		}
	});

	// protects=an account that already exists at a fictional member's address
	//   keeps its name, and the fixture links its new Person to that account;
	// fails_when=the build upserts the account's name (the old seeder did);
	// no_claim=says nothing about other columns of the account, which the build
	//   never names.
	it("does not rename an account that already exists", async () => {
		const [existing] = await testDb
			.insert(user)
			.values({
				id: crypto.randomUUID(),
				name: "Priya, Real Person",
				email: "priya@example.com",
				emailVerified: true,
			})
			.returning({ id: user.id });
		const { clubId } = await build();

		const [after] = await testDb
			.select({ name: user.name })
			.from(user)
			.where(eq(user.id, existing!.id));
		expect(after?.name).toBe("Priya, Real Person");
		const [linked] = await testDb
			.select({ userId: people.userId })
			.from(people)
			.innerJoin(members, eq(members.personId, people.id))
			.where(
				and(eq(members.clubId, clubId), eq(people.email, "priya@example.com")),
			);
		expect(linked?.userId).toBe(existing!.id);
	});

	// protects=an absent Pathways catalog stops the build with a named error and
	//   leaves no row of the club, the accounts or the catalog behind;
	// fails_when=the build throws a different error, leaves a club, an account or
	//   a Person behind, or upserts the catalog rows it needs instead of reading
	//   them;
	// no_claim=the empty catalog is a temporary table shadowing the real one for
	//   this transaction, not a database that never had one; it does not tell the
	//   up-front check from the later writers' own refusals (both throw the same
	//   code, and the build's savepoint rolls either back); a catalog with the
	//   path but not a named project is not exercised here.
	it("throws CATALOG_MISSING and writes nothing when the catalog is empty", async () => {
		const o = opts(new Date());
		await expect(
			testDb.transaction(async (tx) => {
				await tx.execute(
					sql`create temp table pathways_paths (like pathways_paths including all) on commit drop`,
				);
				await tx.execute(
					sql`create temp table pathways_projects (like pathways_projects including all) on commit drop`,
				);
				const attempt = buildFixtureClub(tx, o);
				await expect(attempt).rejects.toBeInstanceOf(FixtureError);
				await expect(attempt).rejects.toMatchObject({
					code: "CATALOG_MISSING",
				});
				// Nothing was left, even before the rollback below.
				const [clubsNamed] = await tx
					.select({ n: count() })
					.from(clubs)
					.where(eq(clubs.slug, o.slug));
				expect(clubsNamed?.n).toBe(0);
				const [accounts] = await tx
					.select({ n: count() })
					.from(user)
					.where(inArray(user.email, FIXTURE_EMAILS));
				expect(accounts?.n).toBe(0);
				const [persons] = await tx
					.select({ n: count() })
					.from(people)
					.where(inArray(people.email, [...FIXTURE_EMAILS, ...GUEST_EMAILS]));
				expect(persons?.n).toBe(0);
				const [catalog] = await tx.select({ n: count() }).from(pathwaysPaths);
				expect(catalog?.n).toBe(0);
				throw new Rollback();
			}),
		).rejects.toBeInstanceOf(Rollback);
	});

	// protects=importing the module runs nothing and exits nothing, and it takes
	//   nothing from `scripts/`, which in production is a separate step;
	// fails_when=a module-level statement calls `process.exit` or a script file is
	//   imported from either fixture file;
	// no_claim=`#/db` is mocked here, so this does NOT show that importing
	//   `club-fixture.ts` is safe without a database: it loads `#/db` through
	//   `guests-logic` and `mentorship-logic`, and the real `#/db` throws at
	//   import without DATABASE_URL (only `helpers.ts` itself imports no `db`).
	//   The source scan is not a proof either: it catches the import form used
	//   here and a literal `process.exit`, not an exit reached through a helper.
	it("is import-safe and imports nothing from scripts/", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit called");
		}) as never);
		try {
			vi.resetModules();
			const mod = await import("./club-fixture.ts");
			expect(typeof mod.buildFixtureClub).toBe("function");
			expect(exit).not.toHaveBeenCalled();
		} finally {
			exit.mockRestore();
		}
		for (const file of ["club-fixture.ts", "helpers.ts"]) {
			const source = readFileSync(
				new URL(`./${file}`, import.meta.url),
				"utf8",
			);
			expect(source, `${file} imports from scripts/`).not.toMatch(
				/from\s+["'][^"']*scripts\//,
			);
			expect(source, `${file} calls process.exit`).not.toMatch(
				/process\.exit\(/,
			);
		}
	});
});
