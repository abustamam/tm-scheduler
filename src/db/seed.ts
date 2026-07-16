import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { currentProgramYear } from "#/lib/dcp";
import {
	defaultClubRoleForOffices,
	type OfficerPosition,
} from "#/lib/officers";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { db } from "./index.ts";
import {
	clubs,
	dcpGoalProgress,
	dcpScoreboards,
	duesPeriods,
	guests,
	meetings,
	memberDues,
	members,
	officerTerms,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	people,
	roleDefinitions,
	roleSlots,
	speeches,
	user,
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

async function upsertUser(name: string, email: string) {
	const [row] = await db
		.insert(user)
		.values({ id: randomUUID(), name, email, emailVerified: true })
		.onConflictDoUpdate({ target: user.email, set: { name } })
		.returning({ id: user.id });
	return row.id;
}

/** A meeting time `days` from now (negative = past) at `hour` local. */
function dayAt(days: number, hour: number) {
	const d = new Date();
	d.setDate(d.getDate() + days);
	d.setHours(hour, 0, 0, 0);
	return d;
}

/** A join date `years`/`months` before today (for realistic tenure spread). */
function joinedAgo(years: number, months = 0) {
	const d = new Date();
	d.setFullYear(d.getFullYear() - years);
	d.setMonth(d.getMonth() - months);
	return d;
}

/** A join date `daysAgo` in the past (kept within the current program year for
 *  the DCP new-member count). */
function joinedThisYear(daysAgo: number) {
	return dayAt(-daysAgo, 12);
}

interface RosterEntry {
	name: string;
	email: string;
	officerPosition?: OfficerPosition;
	joinedAt?: Date;
	status?: "active" | "inactive";
}

interface MeetingSpec {
	scheduledAt: Date;
	theme: string;
	location: string;
	wordOfTheDay: string;
	wodDefinition?: string;
	wodExample?: string;
	reminders?: string;
	status?: "scheduled" | "completed" | "cancelled";
}

interface SeededClub {
	clubId: string;
	memberByName: Map<string, string>;
	personByName: Map<string, string>;
	defs: (typeof roleDefinitions)["$inferSelect"][];
	meetings: {
		meetingId: string;
		slots: (typeof roleSlots)["$inferSelect"][];
	}[];
}

/** Delete any existing club(s) with this name (cascades to meetings/slots/role
 *  defs/memberships) so re-running the seed is deterministic. */
async function resetClubByName(name: string) {
	const existing = await db
		.select({ id: clubs.id })
		.from(clubs)
		.where(eq(clubs.name, name));
	for (const c of existing) {
		await db.delete(clubs).where(eq(clubs.id, c.id));
	}
}

/**
 * Seed one club end to end: the club row + profile, its roster (each member is a
 * Person linked to a sign-in account — ADR-0008 Phase B), open officer terms, the
 * standard role-definition template, and a set of meetings each pre-populated
 * with empty role slots. Returns handles the caller can use to wire up claims.
 */
async function seedClub(opts: {
	name: string;
	slug: string;
	clubNumber: string;
	district?: string;
	mission?: string;
	meetingSchedule?: string;
	roster: RosterEntry[];
	meetings: MeetingSpec[];
}): Promise<SeededClub> {
	await resetClubByName(opts.name);

	const [club] = await db
		.insert(clubs)
		.values({
			name: opts.name,
			slug: opts.slug,
			clubNumber: opts.clubNumber,
			district: opts.district,
			mission: opts.mission,
			meetingSchedule: opts.meetingSchedule,
		})
		.returning({ id: clubs.id });

	// Upsert a sign-in account per roster email (idempotent across clubs).
	const userIdByEmail = new Map<string, string>();
	for (const r of opts.roster) {
		userIdByEmail.set(r.email, await upsertUser(r.name, r.email));
	}

	// People carry the auth link (people.user_id); memberships carry the per-club
	// role, DEFAULTED from office (President / VP Education ⇒ admin).
	const insertedPeople = await db
		.insert(people)
		.values(
			opts.roster.map((r) => ({
				name: r.name,
				email: r.email,
				userId: userIdByEmail.get(r.email)!,
			})),
		)
		.returning({ id: people.id, name: people.name });
	const personByName = new Map(insertedPeople.map((p) => [p.name, p.id]));

	const insertedMembers = await db
		.insert(members)
		.values(
			opts.roster.map((r) => ({
				clubId: club.id,
				personId: personByName.get(r.name)!,
				name: r.name,
				email: r.email,
				status: r.status ?? "active",
				joinedAt: r.joinedAt ?? joinedAgo(2),
				clubRole: defaultClubRoleForOffices(
					r.officerPosition ? [r.officerPosition] : [],
				),
			})),
		)
		.returning({ id: members.id, name: members.name });
	const memberByName = new Map(insertedMembers.map((m) => [m.name, m.id]));

	// Office(s) live in officer_terms (#100): open a current term per seeded office.
	const officerTermRows = opts.roster
		.filter((r) => r.officerPosition)
		.map((r) => ({
			membershipId: memberByName.get(r.name)!,
			position: r.officerPosition!,
			termStart: new Date(),
		}));
	if (officerTermRows.length > 0) {
		await db.insert(officerTerms).values(officerTermRows);
	}

	const defs = await db
		.insert(roleDefinitions)
		.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: club.id })))
		.returning();

	const meetingsOut: SeededClub["meetings"] = [];
	for (const ms of opts.meetings) {
		const [meeting] = await db
			.insert(meetings)
			.values({
				clubId: club.id,
				scheduledAt: ms.scheduledAt,
				theme: ms.theme,
				location: ms.location,
				wordOfTheDay: ms.wordOfTheDay,
				wodDefinition: ms.wodDefinition,
				wodExample: ms.wodExample,
				reminders: ms.reminders,
				status: ms.status ?? "scheduled",
			})
			.returning({ id: meetings.id });
		const slotRows = defs.flatMap((def) =>
			Array.from({ length: def.defaultCount }, (_, i) => ({
				meetingId: meeting.id,
				roleDefinitionId: def.id,
				slotIndex: i,
			})),
		);
		const slots = await db.insert(roleSlots).values(slotRows).returning();
		meetingsOut.push({ meetingId: meeting.id, slots });
	}

	return {
		clubId: club.id,
		memberByName,
		personByName,
		defs,
		meetings: meetingsOut,
	};
}

/** Claim a slot for a member (assigned + status=claimed). */
async function claimSlot(slotId: string, memberId: string, when: Date) {
	await db
		.update(roleSlots)
		.set({ assignedMemberId: memberId, status: "claimed", claimedAt: when })
		.where(eq(roleSlots.id, slotId));
}

/** Point an evaluator slot at the speaker slot it evaluates. */
async function linkEvaluator(evalSlotId: string, speakerSlotId: string) {
	await db
		.update(roleSlots)
		.set({ evaluatesSlotId: speakerSlotId })
		.where(eq(roleSlots.id, evalSlotId));
}

interface SpeechSpec {
	title: string;
	pathwayPath: string;
	projectName: string;
	projectLevel: string;
	minMinutes: number;
	maxMinutes: number;
}

/** A rotating pool of realistic speeches drawn on for speaker slots. */
const SPEECH_POOL: SpeechSpec[] = [
	{
		title: "Finding My Voice",
		pathwayPath: "Dynamic Leadership",
		projectName: "Ice Breaker",
		projectLevel: "Level 1",
		minMinutes: 4,
		maxMinutes: 6,
	},
	{
		title: "Lessons From the Trail",
		pathwayPath: "Presentation Mastery",
		projectName: "Researching and Presenting",
		projectLevel: "Level 2",
		minMinutes: 5,
		maxMinutes: 7,
	},
	{
		title: "The Case for Curiosity",
		pathwayPath: "Motivational Strategies",
		projectName: "Understanding Your Communication Style",
		projectLevel: "Level 1",
		minMinutes: 4,
		maxMinutes: 6,
	},
	{
		title: "Why We Tell Stories",
		pathwayPath: "Engaging Humor",
		projectName: "Know Your Sense of Humor",
		projectLevel: "Level 1",
		minMinutes: 5,
		maxMinutes: 7,
	},
	{
		title: "Leading Without a Title",
		pathwayPath: "Strategic Relationships",
		projectName: "Understanding Emotional Intelligence",
		projectLevel: "Level 3",
		minMinutes: 5,
		maxMinutes: 7,
	},
	{
		title: "Data That Persuades",
		pathwayPath: "Presentation Mastery",
		projectName: "Persuasive Speaking",
		projectLevel: "Level 3",
		minMinutes: 5,
		maxMinutes: 7,
	},
	{
		title: "From Nervous to Natural",
		pathwayPath: "Dynamic Leadership",
		projectName: "Introduction to Toastmasters Mentoring",
		projectLevel: "Level 2",
		minMinutes: 5,
		maxMinutes: 7,
	},
	{
		title: "The Two-Minute Pitch",
		pathwayPath: "Motivational Strategies",
		projectName: "Connect with Your Audience",
		projectLevel: "Level 2",
		minMinutes: 4,
		maxMinutes: 6,
	},
	{
		title: "A Toast to Beginnings",
		pathwayPath: "Leadership Development",
		projectName: "Ice Breaker",
		projectLevel: "Level 1",
		minMinutes: 4,
		maxMinutes: 6,
	},
	{
		title: "Managing the Room",
		pathwayPath: "Strategic Relationships",
		projectName: "Leading in Difficult Situations",
		projectLevel: "Level 4",
		minMinutes: 5,
		maxMinutes: 7,
	},
];

/**
 * Fill a meeting's roles by rotating through `assignees` in template order.
 * Claims the first `count` slots; attaches a pooled speech to each claimed
 * speaker slot; links each evaluator slot to the matching speaker slot. Members
 * cycle so nobody is double-booked while there are enough distinct assignees.
 */
async function fillMeeting(
	m: SeededClub["meetings"][number],
	defs: SeededClub["defs"],
	assignees: string[],
	memberByName: Map<string, string>,
	personByName: Map<string, string>,
	opts: { count: number; when: Date; speechCursor: { i: number } },
) {
	const templateOrder = new Map(ROLE_TEMPLATE.map((r, i) => [r.name, i]));
	const defById = new Map(defs.map((d) => [d.id, d]));
	// Slots in canonical agenda order: role-template order, then slot index.
	const ordered = [...m.slots].sort((a, b) => {
		const da = templateOrder.get(defById.get(a.roleDefinitionId)!.name) ?? 99;
		const dbi = templateOrder.get(defById.get(b.roleDefinitionId)!.name) ?? 99;
		return da - dbi || a.slotIndex - b.slotIndex;
	});

	const speakerDefId = defs.find((d) => d.name === "Speaker")!.id;
	const evaluatorDefId = defs.find((d) => d.name === "Evaluator")!.id;

	let ai = 0;
	for (const slot of ordered.slice(0, opts.count)) {
		const assigneeName = assignees[ai % assignees.length];
		ai++;
		await claimSlot(slot.id, memberByName.get(assigneeName)!, opts.when);

		if (slot.roleDefinitionId === speakerDefId) {
			const spec = SPEECH_POOL[opts.speechCursor.i % SPEECH_POOL.length];
			opts.speechCursor.i++;
			const [sp] = await db
				.insert(speeches)
				.values({ personId: personByName.get(assigneeName)!, ...spec })
				.returning({ id: speeches.id });
			await db
				.update(roleSlots)
				.set({ speechId: sp!.id })
				.where(eq(roleSlots.id, slot.id));
		}
	}

	// Pair evaluator slots (in order) to speaker slots, whether or not claimed.
	const evalSlots = ordered
		.filter((s) => s.roleDefinitionId === evaluatorDefId)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	const speakerSlots = ordered
		.filter((s) => s.roleDefinitionId === speakerDefId)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	for (let i = 0; i < evalSlots.length; i++) {
		if (speakerSlots[i])
			await linkEvaluator(evalSlots[i].id, speakerSlots[i].id);
	}
}

/** Enroll a person in a path (by course code) with per-level progress rows. */
async function enrollPath(
	clubId: string,
	personId: string,
	courseCode: string,
	name: string,
	levels: {
		level: number;
		completed: number;
		total: number;
		approved: boolean;
	}[],
	approvedAt: Date,
) {
	const [path] = await db
		.insert(pathwaysPaths)
		.values({ courseCode, name, status: "current", sortOrder: 0 })
		.onConflictDoUpdate({ target: pathwaysPaths.courseCode, set: { name } })
		.returning({ id: pathwaysPaths.id });
	const [enr] = await db
		.insert(pathEnrollments)
		.values({ personId, pathId: path!.id })
		.onConflictDoNothing({
			target: [pathEnrollments.personId, pathEnrollments.pathId],
		})
		.returning({ id: pathEnrollments.id });
	const enrollmentId =
		enr?.id ??
		(
			await db
				.select({ id: pathEnrollments.id })
				.from(pathEnrollments)
				.where(
					and(
						eq(pathEnrollments.personId, personId),
						eq(pathEnrollments.pathId, path!.id),
					),
				)
				.limit(1)
		)[0]!.id;
	await db.insert(pathLevelProgress).values(
		levels.map((lv) => ({
			enrollmentId,
			level: lv.level,
			completed: lv.completed,
			total: lv.total,
			approved: lv.approved,
			// First-observed completion facts (ADR-0022) — stamped on approved
			// levels so DCP education-goal derivation (#245) has data to work with.
			completedAt: lv.approved ? approvedAt : null,
			creditedClubId: lv.approved ? clubId : null,
		})),
	);
}

async function main() {
	console.log("Seeding…");

	// A platform superadmin who belongs to no club (for console + impersonation).
	await upsertUser("Platform Superadmin", SUPERADMIN_EMAIL);

	const py = currentProgramYear();

	// ---------------------------------------------------------------------------
	// Club 1 — MCF: a full, lively club. ~16 active members + a complete officer
	// team, past meetings with speeches, upcoming meetings at varying fill, plus
	// Pathways progress, a started DCP scoreboard, guests, and dues — so every
	// screen has realistic data.
	// ---------------------------------------------------------------------------
	const mcf = await seedClub({
		name: "MCF",
		slug: "mcf-toastmasters",
		clubNumber: "28677176",
		district: "District 39",
		mission:
			"We provide a supportive and positive learning experience in which members are empowered to develop communication and leadership skills, resulting in greater self-confidence and personal growth.",
		meetingSchedule: "2nd & 4th Wednesday, 7:00–8:30 PM",
		roster: [
			// Officers
			{
				name: "Rasheed Bustamam",
				email: ADMIN_EMAIL,
				officerPosition: "vp_education",
				joinedAt: joinedAgo(3),
			},
			{
				name: "Jordan Patel",
				email: "jordan@example.com",
				officerPosition: "president",
				joinedAt: joinedAgo(4),
			},
			{
				name: "Maya Thompson",
				email: "maya@example.com",
				officerPosition: "vp_membership",
				joinedAt: joinedAgo(2, 6),
			},
			{
				name: "Diego Fuentes",
				email: "diego@example.com",
				officerPosition: "vp_public_relations",
				joinedAt: joinedAgo(2),
			},
			{
				name: "Schinthia Islam",
				email: "schinthia@example.com",
				officerPosition: "secretary",
				joinedAt: joinedAgo(1, 8),
			},
			{
				name: "Grace Kim",
				email: "grace@example.com",
				officerPosition: "treasurer",
				joinedAt: joinedAgo(5),
			},
			{
				name: "Tomás Vega",
				email: "tomas@example.com",
				officerPosition: "sergeant_at_arms",
				joinedAt: joinedAgo(1),
			},
			{
				name: "Bill Nakamura",
				email: "bill@example.com",
				officerPosition: "immediate_past_president",
				joinedAt: joinedAgo(6),
			},
			// Members
			{
				name: "Alex Rivera",
				email: "alex@example.com",
				joinedAt: joinedThisYear(11),
			},
			{
				name: "Sam Chen",
				email: "sam@example.com",
				joinedAt: joinedThisYear(9),
			},
			{
				name: "Aisha Bello",
				email: "aisha@example.com",
				joinedAt: joinedAgo(0, 10),
			},
			{
				name: "Leo Martins",
				email: "leo@example.com",
				joinedAt: joinedAgo(2, 2),
			},
			{
				name: "Hannah Cohen",
				email: "hannah@example.com",
				joinedAt: joinedAgo(1, 3),
			},
			{
				name: "Noah Weber",
				email: "noah@example.com",
				joinedAt: joinedThisYear(6),
			},
			{
				name: "Chloe Dubois",
				email: "chloe@example.com",
				joinedAt: joinedAgo(0, 7),
			},
			{
				name: "Ravi Anand",
				email: "ravi@example.com",
				joinedAt: joinedThisYear(4),
			},
			// Inactive (didn't renew) — hidden from the active roster, still on record
			{
				name: "Frank Osei",
				email: "frank@example.com",
				status: "inactive",
				joinedAt: joinedAgo(3, 4),
			},
			{
				name: "Linda Park",
				email: "linda@example.com",
				status: "inactive",
				joinedAt: joinedAgo(4),
			},
		],
		meetings: [
			// Past (completed) — fully run, drive speech history + role recency
			{
				scheduledAt: dayAt(-21, 19),
				theme: "Momentum",
				location: "Community Hall, Room B",
				wordOfTheDay: "Galvanize",
				wodDefinition: "to shock or excite someone into taking action",
				wodExample: "The keynote galvanized the club to recruit new members.",
				status: "completed",
			},
			{
				scheduledAt: dayAt(-14, 19),
				theme: "Breaking Barriers",
				location: "Community Hall, Room B",
				wordOfTheDay: "Tenacious",
				wodDefinition: "tending to keep a firm hold; persistent",
				wodExample: "Her tenacious preparation showed in every speech.",
				status: "completed",
			},
			{
				scheduledAt: dayAt(-7, 19),
				theme: "The Power of Story",
				location: "Community Hall, Room B",
				wordOfTheDay: "Evocative",
				wodDefinition: "bringing strong images or feelings to mind",
				wodExample: "An evocative opening line pulls the audience in.",
				status: "completed",
			},
			// Upcoming (scheduled) — varying fill drives the sign-up sheet
			{
				scheduledAt: dayAt(4, 19),
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
				scheduledAt: dayAt(11, 19),
				theme: "Stories That Stick",
				location: "Community Hall, Room B",
				wordOfTheDay: "Vivid",
				wodDefinition: "producing powerful, clear images in the mind",
				wodExample: "Vivid detail makes an ordinary story memorable.",
			},
			{
				scheduledAt: dayAt(18, 19),
				theme: "Finding Your Voice",
				location: "Community Hall, Room B",
				wordOfTheDay: "Authentic",
				wodDefinition: "genuine; true to one's own personality",
				wodExample: "An authentic delivery beats a polished but hollow one.",
			},
			{
				scheduledAt: dayAt(25, 19),
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
		mcf.meetings[0],
		mcf.defs,
		rotate(pool, 0),
		mcf.memberByName,
		mcf.personByName,
		{ count: 12, when: dayAt(-24, 12), speechCursor },
	);
	await fillMeeting(
		mcf.meetings[1],
		mcf.defs,
		rotate(pool, 4),
		mcf.memberByName,
		mcf.personByName,
		{ count: 12, when: dayAt(-17, 12), speechCursor },
	);
	await fillMeeting(
		mcf.meetings[2],
		mcf.defs,
		rotate(pool, 8),
		mcf.memberByName,
		mcf.personByName,
		{ count: 12, when: dayAt(-10, 12), speechCursor },
	);
	// Upcoming meetings: decreasing fill (10, 7, 4, 1 of 12) → open slots on the sheet.
	await fillMeeting(
		mcf.meetings[3],
		mcf.defs,
		rotate(pool, 2),
		mcf.memberByName,
		mcf.personByName,
		{ count: 10, when: dayAt(-2, 12), speechCursor },
	);
	await fillMeeting(
		mcf.meetings[4],
		mcf.defs,
		rotate(pool, 6),
		mcf.memberByName,
		mcf.personByName,
		{ count: 7, when: dayAt(-1, 12), speechCursor },
	);
	await fillMeeting(
		mcf.meetings[5],
		mcf.defs,
		rotate(pool, 10),
		mcf.memberByName,
		mcf.personByName,
		{ count: 4, when: dayAt(-1, 12), speechCursor },
	);
	await fillMeeting(
		mcf.meetings[6],
		mcf.defs,
		rotate(pool, 3),
		mcf.memberByName,
		mcf.personByName,
		{ count: 1, when: dayAt(0, 12), speechCursor },
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
		mcf.clubId,
		person("Rasheed Bustamam"),
		"8706",
		"Dynamic Leadership",
		[
			L(1, 5, 5, true),
			L(2, 4, 4, true),
			L(3, 4, 4, true),
			L(4, 3, 3, true),
			L(5, 1, 4, false),
		],
		joinedAgo(0, 2),
	);
	await enrollPath(
		mcf.clubId,
		person("Jordan Patel"),
		"8701",
		"Presentation Mastery",
		[L(1, 5, 5, true), L(2, 4, 4, true), L(3, 2, 4, false)],
		joinedAgo(0, 3),
	);
	await enrollPath(
		mcf.clubId,
		person("Grace Kim"),
		"8700",
		"Motivational Strategies",
		[L(1, 5, 5, true), L(2, 4, 4, true), L(3, 4, 4, true), L(4, 1, 3, false)],
		joinedAgo(0, 4),
	);
	await enrollPath(
		mcf.clubId,
		person("Leo Martins"),
		"8711",
		"Engaging Humor",
		[L(1, 5, 5, true), L(2, 3, 4, false)],
		joinedAgo(0, 1),
	);
	await enrollPath(
		mcf.clubId,
		person("Hannah Cohen"),
		"8705",
		"Strategic Relationships",
		[L(1, 5, 5, true), L(2, 2, 4, false)],
		joinedAgo(0, 2),
	);
	await enrollPath(
		mcf.clubId,
		person("Aisha Bello"),
		"8701",
		"Presentation Mastery",
		[L(1, 5, 5, true), L(2, 1, 4, false)],
		joinedAgo(0, 1),
	);
	await enrollPath(
		mcf.clubId,
		person("Alex Rivera"),
		"8706",
		"Dynamic Leadership",
		[L(1, 3, 5, false)],
		joinedAgo(0, 0),
	);
	await enrollPath(
		mcf.clubId,
		person("Sam Chen"),
		"8700",
		"Motivational Strategies",
		[L(1, 2, 5, false)],
		joinedAgo(0, 0),
	);
	await enrollPath(
		mcf.clubId,
		person("Diego Fuentes"),
		"8702",
		"Leadership Development",
		[L(1, 5, 5, true), L(2, 4, 4, true), L(3, 3, 4, false)],
		joinedAgo(0, 5),
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

	// Guests across the pipeline (VP Membership).
	await db.insert(guests).values([
		{
			clubId: mcf.clubId,
			name: "Priyanka Rao",
			email: "priyanka.rao@example.com",
			phone: "+1 916 555 0181",
			stage: "prospect",
		},
		{
			clubId: mcf.clubId,
			name: "Marcus Bailey",
			email: "marcus.bailey@example.com",
			stage: "following_up",
		},
		{
			clubId: mcf.clubId,
			name: "Elena Sokolova",
			phone: "+1 916 555 0142",
			stage: "following_up",
		},
		{
			clubId: mcf.clubId,
			name: "Ravi Anand",
			email: "ravi@example.com",
			stage: "joined",
			convertedMembershipId: mcf.memberByName.get("Ravi Anand")!,
		},
		{ clubId: mcf.clubId, name: "Ben Carter", stage: "lost" },
	]);

	// Dues — the Apr 1 renewal, most paid, a few outstanding (Treasurer view).
	const [mcfDues] = await db
		.insert(duesPeriods)
		.values({
			clubId: mcf.clubId,
			label: "2026 Apr 1 renewal",
			dueDate: dayAt(-30, 0),
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
			paidAt: dayAt(-33, 10),
		})),
	);

	// ---------------------------------------------------------------------------
	// Club 2 — Harbor City Speakers: a distinct roster + officers + meetings, so
	// multi-club flows (club switcher, superadmin console, impersonation across a
	// club you don't belong to) are realistic. Lightly filled.
	// ---------------------------------------------------------------------------
	const harbor = await seedClub({
		name: "Harbor City Speakers",
		slug: "harbor-city-speakers",
		clubNumber: "01234567",
		district: "District 4",
		meetingSchedule: "Every Tuesday, 6:30–7:45 PM",
		roster: [
			{
				name: "Dana Okafor",
				email: "dana@example.com",
				officerPosition: "president",
				joinedAt: joinedAgo(3),
			},
			{
				name: "Priya Nair",
				email: "priya@example.com",
				officerPosition: "vp_education",
				joinedAt: joinedAgo(2),
			},
			{
				name: "Marcus Lee",
				email: "marcus@example.com",
				joinedAt: joinedAgo(1),
			},
			{
				name: "Nina Petrov",
				email: "nina@example.com",
				joinedAt: joinedAgo(0, 8),
			},
			{
				name: "Omar Haddad",
				email: "omar@example.com",
				joinedAt: joinedThisYear(10),
			},
		],
		meetings: [
			{
				scheduledAt: dayAt(3, 18),
				theme: "Coastal Voices",
				location: "Harbor Library, Meeting Room 2",
				wordOfTheDay: "Buoyant",
			},
			{
				scheduledAt: dayAt(10, 18),
				theme: "Tides of Change",
				location: "Harbor Library, Meeting Room 2",
				wordOfTheDay: "Momentum",
			},
		],
	});

	const harborPool = [
		"Dana Okafor",
		"Priya Nair",
		"Marcus Lee",
		"Nina Petrov",
		"Omar Haddad",
	];
	await fillMeeting(
		harbor.meetings[0],
		harbor.defs,
		harborPool,
		harbor.memberByName,
		harbor.personByName,
		{ count: 5, when: dayAt(-1, 12), speechCursor: { i: 3 } },
	);

	console.log("Seeded 2 clubs:");
	console.log(
		"  • MCF (mcf-toastmasters) — 16 active members, full officer team, 7 meetings, Pathways/DCP/guests/dues",
	);
	console.log(
		"  • Harbor City Speakers (harbor-city-speakers) — Dana (President), Priya (VP Education)",
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
