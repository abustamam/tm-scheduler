import { eq, inArray } from "drizzle-orm";
import { currentProgramYear } from "#/lib/dcp";
import { createGuestRecord } from "#/server/guests-logic";
import { seedPathwaysCatalog } from "../../scripts/pathways-catalog-seed.ts";
import { seedGlobalTemplates } from "../../scripts/seed-global-templates.ts";
import {
	buildFixtureClub,
	fixtureRosterEmails,
} from "./fixtures/club-fixture.ts";
import {
	dayAt,
	enrollPath,
	ensureFixtureUser,
	fillMeeting,
	insertFixtureClub,
	joinedAgo,
	joinedThisYear,
} from "./fixtures/helpers.ts";
import { db } from "./index.ts";
import {
	clubs,
	dcpGoalProgress,
	dcpScoreboards,
	duesPeriods,
	guests,
	memberDues,
	members,
	people,
} from "./schema.ts";

// Env (DATABASE_URL) is loaded via `tsx --env-file=.env.local` (see db:seed).
// The club admin who can sign in to manage everything. Defaults to the project
// owner's email so a magic-link sign-in lands as an admin out of the box.
const ADMIN_EMAIL =
	process.env.SEED_ADMIN_EMAIL ?? "rasheed.bustamam@gmail.com";
// A platform superadmin who belongs to NO club — so signing in as them exercises
// the superadmin console + impersonation ("View as"/"Act as") against clubs they
// aren't a member of. To actually grant the flag, add this email to
// SUPERADMIN_EMAILS (reconciled onto user.is_superadmin on sign-in — ADR-0016).
const SUPERADMIN_EMAIL =
	process.env.SEED_SUPERADMIN_EMAIL ?? "superadmin@example.com";

// The fixture helpers and the Harbor City club live in `./fixtures/`, where a
// transaction can reach them (#1198). This file keeps the reset, MCF and the
// script wrapper, and calls them.

/**
 * Delete any existing club(s) with this name (cascades to meetings/slots/role
 * defs/memberships) so re-running the seed is deterministic.
 *
 * People are club-less, so that cascade leaves the club's Persons behind, and
 * every re-seed used to add another copy of each, with its path enrollments
 * and speeches. So the Persons this seed made are removed too, and only those:
 * a Person at one of THIS roster's addresses that no membership in any club
 * holds any more. A Person a membership still holds (another club's) or at any
 * other address is left alone. Done as a select and a filter in JS rather than
 * a correlated subquery, which Drizzle can emit unqualified.
 */
async function resetClubByName(name: string, rosterEmails: string[]) {
	const existing = await db
		.select({ id: clubs.id })
		.from(clubs)
		.where(eq(clubs.name, name));
	// The Persons this club's guest rows point at (#1124), read BEFORE the
	// cascade deletes the rows: nothing else names a guest-only Person afterwards.
	const guestPersonIds =
		existing.length === 0
			? []
			: (
					await db
						.select({ id: guests.personId })
						.from(guests)
						.where(
							inArray(
								guests.clubId,
								existing.map((c) => c.id),
							),
						)
				).flatMap((g) => (g.id ? [g.id] : []));
	for (const c of existing) {
		await db.delete(clubs).where(eq(clubs.id, c.id));
	}

	const atRosterAddress = await db
		.select({ id: people.id })
		.from(people)
		.where(inArray(people.email, rosterEmails));
	const candidateIds = [
		...new Set([...atRosterAddress.map((p) => p.id), ...guestPersonIds]),
	];
	if (candidateIds.length === 0) return;
	const stillHeld = await db
		.selectDistinct({ id: members.personId })
		.from(members)
		.where(inArray(members.personId, candidateIds));
	// A guest row in ANOTHER club holds a Person too: deleting it would hit the
	// RESTRICT key, and would take that club's visitor with it.
	const stillGuest = await db
		.selectDistinct({ id: guests.personId })
		.from(guests)
		.where(inArray(guests.personId, candidateIds));
	const heldIds = new Set([
		...stillHeld.map((m) => m.id),
		...stillGuest.flatMap((g) => (g.id ? [g.id] : [])),
	]);
	const orphanIds = candidateIds.filter((id) => !heldIds.has(id));
	if (orphanIds.length > 0) {
		await db.delete(people).where(inArray(people.id, orphanIds));
	}
}

/**
 * Seed one club end to end: reset any club of the same name, then insert it with
 * its roster, open officer terms, the standard role-definition template and a
 * set of meetings each pre-populated with empty role slots.
 */
async function seedClub(
	opts: Parameters<typeof insertFixtureClub>[1],
): ReturnType<typeof insertFixtureClub> {
	await resetClubByName(
		opts.name,
		opts.roster.map((r) => r.email),
	);
	return insertFixtureClub(db, opts);
}

async function main() {
	console.log("Seeding…");

	// The Pathways catalog first: Harbor City's hand-declared paths below read
	// it, and `enrollPath` throws `CATALOG_MISSING` when a path is absent rather
	// than writing one. Idempotent — the production container runs it on every
	// boot.
	await seedPathwaysCatalog();

	// A platform superadmin who belongs to no club (for console + impersonation).
	await ensureFixtureUser(db, "Platform Superadmin", SUPERADMIN_EMAIL);

	// "Now" and the club's zone, fixed once so every date below agrees. MCF and
	// Harbor City both pass this zone explicitly; MCF's meetings are 7 PM there.
	const now = new Date();
	const TZ = "America/Chicago";
	const at = (days: number, hour: number) => dayAt(now, TZ, days, hour);

	const py = currentProgramYear(now);

	// ---------------------------------------------------------------------------
	// Club 1 — MCF: a full, lively club. ~16 active members + a complete officer
	// team, past meetings with speeches, upcoming meetings at varying fill, plus
	// Pathways progress, a started DCP scoreboard, guests, and dues — so every
	// screen has realistic data.
	// ---------------------------------------------------------------------------
	const mcf = await seedClub({
		now,
		timeZone: TZ,
		name: "MCF",
		slug: "mcf-toastmasters",
		clubNumber: "28677176",
		district: "District 39",
		mission:
			"We provide a supportive and positive learning experience in which members are empowered to develop communication and leadership skills, resulting in greater self-confidence and personal growth.",
		meetingSchedule: "2nd & 4th Wednesday, 7:00–8:30 PM",
		// The real MCF runs the General Evaluator variant of the functionary intro
		// (#367) — the data migration flips it by slug in every deployed
		// environment, and this keeps a freshly seeded dev/CI database matching.
		geIntroducesFunctionaries: true,
		roster: [
			// Officers
			{
				name: "Rasheed Bustamam",
				email: ADMIN_EMAIL,
				officerPosition: "vp_education",
				joinedAt: joinedAgo(now, 3),
			},
			{
				name: "Jordan Patel",
				email: "jordan@example.com",
				officerPosition: "president",
				joinedAt: joinedAgo(now, 4),
			},
			{
				name: "Maya Thompson",
				email: "maya@example.com",
				officerPosition: "vp_membership",
				joinedAt: joinedAgo(now, 2, 6),
			},
			{
				name: "Diego Fuentes",
				email: "diego@example.com",
				officerPosition: "vp_public_relations",
				joinedAt: joinedAgo(now, 2),
			},
			{
				name: "Schinthia Islam",
				email: "schinthia@example.com",
				officerPosition: "secretary",
				joinedAt: joinedAgo(now, 1, 8),
			},
			{
				name: "Grace Kim",
				email: "grace@example.com",
				officerPosition: "treasurer",
				joinedAt: joinedAgo(now, 5),
			},
			{
				name: "Tomás Vega",
				email: "tomas@example.com",
				officerPosition: "sergeant_at_arms",
				joinedAt: joinedAgo(now, 1),
			},
			{
				name: "Bill Nakamura",
				email: "bill@example.com",
				officerPosition: "immediate_past_president",
				joinedAt: joinedAgo(now, 6),
			},
			// Members
			{
				name: "Alex Rivera",
				email: "alex@example.com",
				joinedAt: joinedThisYear(now, TZ, 11),
			},
			{
				name: "Sam Chen",
				email: "sam@example.com",
				joinedAt: joinedThisYear(now, TZ, 9),
			},
			{
				name: "Aisha Bello",
				email: "aisha@example.com",
				joinedAt: joinedAgo(now, 0, 10),
			},
			{
				name: "Leo Martins",
				email: "leo@example.com",
				joinedAt: joinedAgo(now, 2, 2),
			},
			{
				name: "Hannah Cohen",
				email: "hannah@example.com",
				joinedAt: joinedAgo(now, 1, 3),
			},
			{
				name: "Noah Weber",
				email: "noah@example.com",
				joinedAt: joinedThisYear(now, TZ, 6),
			},
			{
				name: "Chloe Dubois",
				email: "chloe@example.com",
				joinedAt: joinedAgo(now, 0, 7),
			},
			{
				name: "Ravi Anand",
				email: "ravi@example.com",
				joinedAt: joinedThisYear(now, TZ, 4),
			},
			// Inactive (didn't renew) — hidden from the active roster, still on record
			{
				name: "Frank Osei",
				email: "frank@example.com",
				status: "inactive",
				joinedAt: joinedAgo(now, 3, 4),
			},
			{
				name: "Linda Park",
				email: "linda@example.com",
				status: "inactive",
				joinedAt: joinedAgo(now, 4),
			},
		],
		meetings: [
			// Past (completed) — fully run, drive speech history + role recency
			{
				scheduledAt: at(-21, 19),
				theme: "Momentum",
				location: "Community Hall, Room B",
				wordOfTheDay: "Galvanize",
				wodDefinition: "to shock or excite someone into taking action",
				wodExample: "The keynote galvanized the club to recruit new members.",
				status: "completed",
			},
			{
				scheduledAt: at(-14, 19),
				theme: "Breaking Barriers",
				location: "Community Hall, Room B",
				wordOfTheDay: "Tenacious",
				wodDefinition: "tending to keep a firm hold; persistent",
				wodExample: "Her tenacious preparation showed in every speech.",
				status: "completed",
			},
			{
				scheduledAt: at(-7, 19),
				theme: "The Power of Story",
				location: "Community Hall, Room B",
				wordOfTheDay: "Evocative",
				wodDefinition: "bringing strong images or feelings to mind",
				wodExample: "An evocative opening line pulls the audience in.",
				status: "completed",
			},
			// Upcoming (scheduled) — varying fill drives the sign-up sheet
			{
				scheduledAt: at(4, 19),
				theme: "New Beginnings",
				location: "Community Hall, Room B",
				wordOfTheDay: "Resilient",
				wodDefinition: "able to recover quickly from difficulty",
				wodExample:
					"A resilient speaker recovers from a lost train of thought.",
				reminders:
					"Bring a guest.\nConfirm your Pathways project before you speak.",
			},
			{
				scheduledAt: at(11, 19),
				theme: "Stories That Stick",
				location: "Community Hall, Room B",
				wordOfTheDay: "Vivid",
				wodDefinition: "producing powerful, clear images in the mind",
				wodExample: "Vivid detail makes an ordinary story memorable.",
			},
			{
				scheduledAt: at(18, 19),
				theme: "Finding Your Voice",
				location: "Community Hall, Room B",
				wordOfTheDay: "Authentic",
				wodDefinition: "genuine; true to one's own personality",
				wodExample: "An authentic delivery beats a polished but hollow one.",
			},
			{
				scheduledAt: at(25, 19),
				theme: "Leadership in Action",
				location: "Community Hall, Room B",
				wordOfTheDay: "Decisive",
				wodDefinition: "settling an issue; producing a clear result",
				wodExample:
					"A decisive Table Topics answer commits to a point of view.",
			},
		],
	});

	const speechCursor = { i: 0 };
	// Everyone eligible to take a role (officers included), minus the inactive two.
	const pool = [
		"Jordan Patel",
		"Rasheed Bustamam",
		"Maya Thompson",
		"Diego Fuentes",
		"Schinthia Islam",
		"Grace Kim",
		"Tomás Vega",
		"Bill Nakamura",
		"Alex Rivera",
		"Sam Chen",
		"Aisha Bello",
		"Leo Martins",
		"Hannah Cohen",
		"Noah Weber",
		"Chloe Dubois",
		"Ravi Anand",
	];
	// Rotate the starting assignee per meeting so roles spread across the club.
	const rotate = (arr: string[], by: number) => [
		...arr.slice(by),
		...arr.slice(0, by),
	];

	// Past meetings: fully claimed (all 12 slots), with speeches.
	await fillMeeting(
		db,
		mcf.meetings[0],
		mcf.defs,
		rotate(pool, 0),
		mcf.memberByName,
		mcf.personByName,
		{ count: 12, when: at(-24, 12), speechCursor },
	);
	await fillMeeting(
		db,
		mcf.meetings[1],
		mcf.defs,
		rotate(pool, 4),
		mcf.memberByName,
		mcf.personByName,
		{ count: 12, when: at(-17, 12), speechCursor },
	);
	await fillMeeting(
		db,
		mcf.meetings[2],
		mcf.defs,
		rotate(pool, 8),
		mcf.memberByName,
		mcf.personByName,
		{ count: 12, when: at(-10, 12), speechCursor },
	);
	// Upcoming meetings: decreasing fill (10, 7, 4, 1 of 12) → open slots on the sheet.
	await fillMeeting(
		db,
		mcf.meetings[3],
		mcf.defs,
		rotate(pool, 2),
		mcf.memberByName,
		mcf.personByName,
		{ count: 10, when: at(-2, 12), speechCursor },
	);
	await fillMeeting(
		db,
		mcf.meetings[4],
		mcf.defs,
		rotate(pool, 6),
		mcf.memberByName,
		mcf.personByName,
		{ count: 7, when: at(-1, 12), speechCursor },
	);
	await fillMeeting(
		db,
		mcf.meetings[5],
		mcf.defs,
		rotate(pool, 10),
		mcf.memberByName,
		mcf.personByName,
		{ count: 4, when: at(-1, 12), speechCursor },
	);
	await fillMeeting(
		db,
		mcf.meetings[6],
		mcf.defs,
		rotate(pool, 3),
		mcf.memberByName,
		mcf.personByName,
		{ count: 1, when: at(0, 12), speechCursor },
	);

	// Pathways — enroll members with a spread of progress (drives the roster
	// Pathway column + VP Education dashboard). Approved levels get dated,
	// club-credited completion facts (ADR-0022).
	const person = (n: string) => mcf.personByName.get(n)!;
	const L = (
		level: number,
		completed: number,
		total: number,
		approved: boolean,
	) => ({ level, completed, total, approved });
	await enrollPath(
		db,
		mcf.clubId,
		person("Rasheed Bustamam"),
		"8706",
		[
			L(1, 5, 5, true),
			L(2, 4, 4, true),
			L(3, 4, 4, true),
			L(4, 3, 3, true),
			L(5, 1, 4, false),
		],
		joinedAgo(now, 0, 2),
	);
	await enrollPath(
		db,
		mcf.clubId,
		person("Jordan Patel"),
		"8701",
		[L(1, 5, 5, true), L(2, 4, 4, true), L(3, 2, 4, false)],
		joinedAgo(now, 0, 3),
	);
	await enrollPath(
		db,
		mcf.clubId,
		person("Grace Kim"),
		"8700",
		[L(1, 5, 5, true), L(2, 4, 4, true), L(3, 4, 4, true), L(4, 1, 3, false)],
		joinedAgo(now, 0, 4),
	);
	await enrollPath(
		db,
		mcf.clubId,
		person("Leo Martins"),
		"8711",
		[L(1, 5, 5, true), L(2, 3, 4, false)],
		joinedAgo(now, 0, 1),
	);
	await enrollPath(
		db,
		mcf.clubId,
		person("Hannah Cohen"),
		"8705",
		[L(1, 5, 5, true), L(2, 2, 4, false)],
		joinedAgo(now, 0, 2),
	);
	await enrollPath(
		db,
		mcf.clubId,
		person("Aisha Bello"),
		"8701",
		[L(1, 5, 5, true), L(2, 1, 4, false)],
		joinedAgo(now, 0, 1),
	);
	await enrollPath(
		db,
		mcf.clubId,
		person("Alex Rivera"),
		"8706",
		[L(1, 3, 5, false)],
		joinedAgo(now, 0, 0),
	);
	await enrollPath(
		db,
		mcf.clubId,
		person("Sam Chen"),
		"8700",
		[L(1, 2, 5, false)],
		joinedAgo(now, 0, 0),
	);
	await enrollPath(
		db,
		mcf.clubId,
		person("Diego Fuentes"),
		"8702",
		[L(1, 5, 5, true), L(2, 4, 4, true), L(3, 3, 4, false)],
		joinedAgo(now, 0, 5),
	);

	// DCP scoreboard for the current program year — a started, partly-met board.
	const [mcfSb] = await db
		.insert(dcpScoreboards)
		.values({ clubId: mcf.clubId, programYear: py, baseMemberCount: 14 })
		.returning({ id: dcpScoreboards.id });
	const mcfGoals: Record<string, number> = {
		g1: 4,
		g2: 2,
		g3: 1,
		g4: 2,
		g5: 1,
		g6: 0,
		g7: 4,
		g8: 2,
		g9: 1,
		g10: 0,
	};
	await db.insert(dcpGoalProgress).values(
		Object.entries(mcfGoals).map(([goalKey, achieved]) => ({
			scoreboardId: mcfSb!.id,
			goalKey,
			achieved,
		})),
	);

	// Guests across the pipeline (VP Membership). Every guest row points at a
	// Person (#1124), so each goes through `createGuestRecord`, which writes the
	// contact onto the Person it mints (#1125). Ravi, who joined, IS the member's
	// Person, as the migration's backfill leaves a converted guest, so he carries
	// no contact of his own here: a guest row never writes a member's.
	const raviPersonId = mcf.personByName.get("Ravi Anand");
	if (!raviPersonId) throw new Error('Seed: no Person for "Ravi Anand"');
	for (const g of [
		{
			name: "Priyanka Rao",
			email: "priyanka.rao@example.com",
			phone: "+1 916 555 0181",
			stage: "prospect" as const,
		},
		{
			name: "Marcus Bailey",
			email: "marcus.bailey@example.com",
			stage: "following_up" as const,
		},
		{
			name: "Elena Sokolova",
			phone: "+1 916 555 0142",
			stage: "following_up" as const,
		},
		{
			name: "Ravi Anand",
			stage: "joined" as const,
			convertedMembershipId: mcf.memberByName.get("Ravi Anand")!,
			personId: raviPersonId,
		},
		{ name: "Ben Carter", stage: "lost" as const },
	]) {
		await createGuestRecord(db, { clubId: mcf.clubId, ...g });
	}

	// Dues — the Apr 1 renewal, most paid, a few outstanding (Treasurer view).
	const [mcfDues] = await db
		.insert(duesPeriods)
		.values({
			clubId: mcf.clubId,
			label: "2026 Apr 1 renewal",
			dueDate: at(-30, 0),
			defaultAmountCents: 4500,
		})
		.returning({ id: duesPeriods.id });
	const paidNames = [
		"Rasheed Bustamam",
		"Jordan Patel",
		"Maya Thompson",
		"Diego Fuentes",
		"Grace Kim",
		"Bill Nakamura",
		"Alex Rivera",
		"Sam Chen",
		"Aisha Bello",
		"Leo Martins",
		"Hannah Cohen",
		"Chloe Dubois",
	];
	await db.insert(memberDues).values(
		paidNames.map((n) => ({
			membershipId: mcf.memberByName.get(n)!,
			duesPeriodId: mcfDues!.id,
			status: "paid" as const,
			amountCents: 4500,
			paidAt: at(-33, 10),
		})),
	);

	// ---------------------------------------------------------------------------
	// Club 2 — Harbor City Speakers: a distinct roster + officers + meetings, so
	// multi-club flows (club switcher, superadmin console, impersonation across a
	// club you don't belong to) are realistic. Built by the fixture module, the
	// same code the demo club uses (#1198); only the reset and the profile fields
	// that are the dev seed's own stay here. Dana is its admin: a fictional member
	// with a sign-in account, so a dev can sign in as her.
	//
	// `/tour`'s officers stop (#901) is captured from Harbor's VPE and VPM
	// dashboards, and its agenda shot from Harbor's next meeting, by
	// `bun run marketing:screenshots`, which checks each of the shapes the fixture
	// builds is on the page before it shoots (`marketing-screenshot-features.ts`).
	// ---------------------------------------------------------------------------
	const harborAdmin = { name: "Dana Okafor", email: "dana@example.com" };
	await resetClubByName(
		"Harbor City Speakers",
		fixtureRosterEmails(harborAdmin.email),
	);
	const harbor = await buildFixtureClub(db, {
		name: "Harbor City Speakers",
		slug: "harbor-city-speakers",
		timeZone: TZ,
		now,
		admin: {
			...harborAdmin,
			userId: await ensureFixtureUser(db, harborAdmin.name, harborAdmin.email),
		},
	});
	// The fixture club carries no Toastmasters number; the dev club keeps its own.
	await db
		.update(clubs)
		.set({
			clubNumber: "01234567",
			district: "District 4",
			meetingSchedule: "Every Tuesday, 6:30–7:45 PM",
		})
		.where(eq(clubs.id, harbor.clubId));

	// Global agenda templates (#agenda-templates). Club-less, so they are seeded
	// once for the whole install rather than per club, and the script is
	// idempotent — it replaces the template's roles and beats in place.
	await seedGlobalTemplates();

	console.log("Seeded 2 clubs:");
	console.log(
		"  • MCF (mcf-toastmasters) — 16 active members, full officer team, 7 meetings, Pathways/DCP/guests/dues",
	);
	console.log(
		"  • Harbor City Speakers (harbor-city-speakers) — Dana (President), Priya (VP Education), Sofia (VP Membership), 10 meetings (6 held, 4 upcoming), Pathways, 4 guests of 3 kinds, mentorship, feedback notes, minutes, dues, DCP",
	);
	console.log(`Admin sign-in email (MCF): ${ADMIN_EMAIL}`);
	console.log(
		`Superadmin (no club): ${SUPERADMIN_EMAIL} — set SUPERADMIN_EMAILS=${SUPERADMIN_EMAIL} to grant on sign-in`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
