/**
 * The fixture helpers the dev seeder (`src/db/seed.ts`) and the Harbor City
 * fixture club (`./club-fixture.ts`, #1198) share.
 *
 * Three rules, each one a way the helpers used to be unusable from anywhere but
 * the seed script:
 *
 *  - **Every write takes its executor.** A helper that wrote through the global
 *    `db` could not join a caller's transaction, so a fixture built inside one
 *    could not be rolled back. `tx` is the first parameter of every function
 *    here that touches the database; pass `db` for a plain seed or a
 *    transaction handle for an atomic build.
 *  - **Time is an input.** `dayAt` and `joinedAgo` take `now`, and `dayAt` also
 *    takes the club's time zone: the old `dayAt` called `setHours` in the
 *    SERVER's zone, so "6 PM" on a UTC host was 1 PM at a Chicago club.
 *  - **Nothing here runs on import, and nothing imports `scripts/`.** The old
 *    seed ran `main()` and `process.exit` when imported.
 *
 * This module imports no runtime `db`: `DbOrTx` is a type, so importing it
 * connects to nothing.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import {
	defaultClubRoleForOffices,
	type OfficerPosition,
} from "#/lib/officers";
import {
	availableContactMethods,
	type ContactMethod,
} from "#/lib/preferred-contact";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import type { DbOrTx } from "#/server/meeting-templates-logic";
import {
	clubs,
	meetings,
	members,
	officerTerms,
	pathEnrollments,
	pathLevelProgress,
	pathwaysPaths,
	pathwaysProjects,
	people,
	projectCompletionMarks,
	roleDefinitions,
	roleSlots,
	speeches,
	user,
} from "../schema.ts";

/** A refusal the fixtures can name, so a caller can tell it from a bug. */
export type FixtureErrorCode = "CATALOG_MISSING";

export class FixtureError extends Error {
	readonly code: FixtureErrorCode;
	constructor(code: FixtureErrorCode, detail?: string) {
		super(detail ? `${code}: ${detail}` : code);
		this.name = "FixtureError";
		this.code = code;
	}
}

/**
 * The sign-in account for a fictional person: created when absent, and an
 * existing account is returned UNTOUCHED. Never renames: a fixture built in a
 * database that already holds a real account at that address must not rewrite
 * its owner's name (the seed's old `upsertUser` did).
 */
export async function ensureFixtureUser(
	tx: DbOrTx,
	name: string,
	email: string,
): Promise<string> {
	await tx
		.insert(user)
		.values({ id: randomUUID(), name, email, emailVerified: true })
		.onConflictDoNothing({ target: user.email });
	const [row] = await tx
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);
	if (!row) throw new Error(`Fixture: no account for ${email}`);
	return row.id;
}

/**
 * The instant it is `hour`:00 wall time in `timeZone`, `days` calendar days
 * from `now`'s date there (negative = past). The date is read in the CLUB's
 * zone, not the process's, so the same call gives the same instants on a UTC
 * server and on a laptop in Chicago.
 */
export function dayAt(
	now: Date,
	timeZone: string,
	days: number,
	hour: number,
): Date {
	const [y, m, d] = utcToZonedWallTime(now, timeZone)
		.slice(0, 10)
		.split("-")
		.map(Number) as [number, number, number];
	const date = new Date(Date.UTC(y, m - 1, d + days))
		.toISOString()
		.slice(0, 10);
	return zonedWallTimeToUtc(
		`${date}T${String(hour).padStart(2, "0")}:00`,
		timeZone,
	);
}

/** A join date `years`/`months` before `now` (for realistic tenure spread). */
export function joinedAgo(now: Date, years: number, months = 0): Date {
	const d = new Date(now);
	d.setUTCFullYear(d.getUTCFullYear() - years);
	d.setUTCMonth(d.getUTCMonth() - months);
	return d;
}

/** A join date `daysAgo` in the past (kept within the current program year for
 *  the DCP new-member count). */
export function joinedThisYear(
	now: Date,
	timeZone: string,
	daysAgo: number,
): Date {
	return dayAt(now, timeZone, -daysAgo, 12);
}

/**
 * A distinct, dial-safe fictional number per seeded person.
 *
 * Every seeded person needs one because `NudgeButtons` renders the WhatsApp
 * draft ONLY when a phone is present. Seeding none — as the seed did until
 * #576 — meant the tap-to-nudge affordance the meeting page is built around
 * could not be exercised locally at all: every row fell back to Email, and a
 * WhatsApp-specific regression (a malformed `wa.me` URL, platform detection,
 * the `data-slot="wa-phone"` link-colour exclusion) would reach production
 * without anyone having seen it. Found by /qa on v1.15.0.0.
 *
 * Uses the +1 202 555 0100-0199 block, which is reserved for fiction, so a
 * mis-sent draft during local testing cannot reach a real person. Deterministic
 * by index, so a re-seed does not reshuffle who has which number.
 */
export function seedPhone(index: number): string {
	return `+1202555${String(100 + index).padStart(4, "0")}`;
}

export interface RosterEntry {
	name: string;
	email: string;
	/** Omitted ⇒ a generated fictional number (see `seedPhone`). Set it only to
	 *  seed a SPECIFIC shape — a missing number, a local format needing the
	 *  club's dialing code — since the default already covers the common case. */
	phone?: string | null;
	officerPosition?: OfficerPosition;
	joinedAt?: Date;
	status?: "active" | "inactive";
	/** How officers should reach this person, and who chose it (#1093, #1110):
	 *  ONE field so the method and its provenance cannot be seeded apart. The
	 *  writers refuse a method whose data is missing, so every seeded phone and
	 *  email keeps the method it names available. Omitted ⇒ no preference. */
	contactPreference?: { method: ContactMethod; by: "member" | "officer" };
	/** Offered as a mentor (#939). Omitted ⇒ false, the column default. */
	willingToMentor?: boolean;
	/** The sign-in account, when the caller already has it. Present (even as
	 *  `null`) ⇒ `ensureFixtureUser` is NOT called for this entry; omitted ⇒ a
	 *  fictional account is created for it. */
	userId?: string | null;
}

export interface MeetingSpec {
	scheduledAt: Date;
	theme: string;
	location: string;
	// Optional so a meeting can be seeded with NO Word of the Day. The column is
	// nullable and the insert passes this straight through, so `undefined` lands
	// as NULL — which is the only way to reach the empty state on the poster,
	// print and present surfaces from seed data (#492).
	wordOfTheDay?: string;
	wodDefinition?: string;
	wodExample?: string;
	reminders?: string;
	status?: "scheduled" | "completed" | "cancelled";
}

export interface SeededClub {
	clubId: string;
	memberByName: Map<string, string>;
	personByName: Map<string, string>;
	defs: (typeof roleDefinitions)["$inferSelect"][];
	meetings: {
		meetingId: string;
		theme: string;
		slots: (typeof roleSlots)["$inferSelect"][];
	}[];
}

/**
 * A seeded meeting by its theme. A club's meetings are inserted in list order,
 * so an index points at whatever sits there today; a theme keeps pointing at
 * the meeting it names when one is added or moved, and a typo throws.
 */
export function meetingByTheme(club: SeededClub, theme: string) {
	const meeting = club.meetings.find((m) => m.theme === theme);
	if (!meeting) throw new Error(`Seed: no meeting themed "${theme}"`);
	return meeting;
}

/**
 * Insert one club end to end, INSIDE the caller's executor: the club row, its
 * roster (each member a Person linked to a sign-in account, ADR-0008 Phase B),
 * open officer terms, the standard role-definition template, and a set of
 * meetings each pre-populated with empty role slots. No reset and no delete: a
 * caller that wants a clean slate does that first.
 */
export async function insertFixtureClub(
	tx: DbOrTx,
	opts: {
		name: string;
		slug: string;
		now: Date;
		/** Omitted ⇒ the column default. */
		timeZone?: string;
		/** Omitted ⇒ NULL: the fixture club carries no Toastmasters club number. */
		clubNumber?: string;
		district?: string;
		mission?: string;
		meetingSchedule?: string;
		/** #367 — TRUE puts the General Evaluator, not the Toastmaster of the Day, on
		 *  the functionary-intro beat. Omitted ⇒ the column default (false), i.e. the
		 *  standard flow. Set it here so at least one seeded club exercises the MCF
		 *  variant locally and in CI. */
		geIntroducesFunctionaries?: boolean;
		roster: RosterEntry[];
		meetings: MeetingSpec[];
	},
): Promise<SeededClub> {
	const [club] = await tx
		.insert(clubs)
		.values({
			name: opts.name,
			slug: opts.slug,
			timezone: opts.timeZone,
			clubNumber: opts.clubNumber,
			district: opts.district,
			mission: opts.mission,
			meetingSchedule: opts.meetingSchedule,
			geIntroducesFunctionaries: opts.geIntroducesFunctionaries ?? false,
		})
		.returning({ id: clubs.id });
	if (!club) throw new Error("Fixture: club insert returned no row");

	// A sign-in account per roster email (idempotent across clubs).
	const userIdByEmail = new Map<string, string | null>();
	for (const r of opts.roster) {
		userIdByEmail.set(
			r.email,
			r.userId !== undefined
				? r.userId
				: await ensureFixtureUser(tx, r.name, r.email),
		);
	}

	// People carry the auth link (people.user_id); memberships carry the per-club
	// role, DEFAULTED from office (President / VP Education ⇒ admin).
	const insertedPeople = await tx
		.insert(people)
		.values(
			opts.roster.map((r, i) => {
				const phone = r.phone === undefined ? seedPhone(i) : r.phone;
				// The two real writers refuse a method whose data is missing
				// (`contactMethodAvailableSql`); this insert is neither of them, so it
				// holds itself to the same rule rather than seed a preference every
				// reader would show as "no preference".
				const method = r.contactPreference?.method;
				if (
					method &&
					!availableContactMethods({ email: r.email, phone }).includes(method)
				) {
					throw new Error(
						`Seed: ${r.name} prefers ${method} but has no ${method === "email" ? "email" : "phone number"} to use it with`,
					);
				}
				return {
					name: r.name,
					email: r.email,
					phone,
					preferredContact: method ?? null,
					contactPreferenceBy: r.contactPreference?.by ?? null,
					userId: userIdByEmail.get(r.email) ?? null,
				};
			}),
		)
		.returning({ id: people.id, name: people.name });
	const personByName = new Map(insertedPeople.map((p) => [p.name, p.id]));

	const insertedMembers = await tx
		.insert(members)
		.values(
			opts.roster.map((r) => ({
				clubId: club.id,
				personId: personByName.get(r.name)!,
				name: r.name,
				status: r.status ?? "active",
				willingToMentor: r.willingToMentor ?? false,
				joinedAt: r.joinedAt ?? joinedAgo(opts.now, 2),
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
			termStart: opts.now,
		}));
	if (officerTermRows.length > 0) {
		await tx.insert(officerTerms).values(officerTermRows);
	}

	const defs = await tx
		.insert(roleDefinitions)
		.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: club.id })))
		.returning();

	const meetingsOut: SeededClub["meetings"] = [];
	for (const ms of opts.meetings) {
		const [meeting] = await tx
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
				meetingId: meeting!.id,
				roleDefinitionId: def.id,
				slotIndex: i,
			})),
		);
		const slots = await tx.insert(roleSlots).values(slotRows).returning();
		meetingsOut.push({ meetingId: meeting!.id, theme: ms.theme, slots });
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
export async function claimSlot(
	tx: DbOrTx,
	slotId: string,
	memberId: string,
	when: Date,
) {
	await tx
		.update(roleSlots)
		.set({ assignedMemberId: memberId, status: "claimed", claimedAt: when })
		.where(eq(roleSlots.id, slotId));
}

/** Point an evaluator slot at the speaker slot it evaluates. */
export async function linkEvaluator(
	tx: DbOrTx,
	evalSlotId: string,
	speakerSlotId: string,
) {
	await tx
		.update(roleSlots)
		.set({ evaluatesSlotId: speakerSlotId })
		.where(eq(roleSlots.id, evalSlotId));
}

/** The meeting's slot for `roleName` (`slotIndex` 0 = "Speaker 1"). Throws, so
 *  a renamed role in `ROLE_TEMPLATE` fails the seed instead of seeding nothing. */
export function slotOf(
	m: SeededClub["meetings"][number],
	defs: SeededClub["defs"],
	roleName: string,
	slotIndex = 0,
) {
	const def = defs.find((d) => d.name === roleName);
	const slot = m.slots.find(
		(s) => s.roleDefinitionId === def?.id && s.slotIndex === slotIndex,
	);
	if (!slot)
		throw new Error(`Seed: no slot ${slotIndex} for role "${roleName}"`);
	return slot;
}

/** Claim a slot for a non-member guest (#151): `assigned_guest_id`, never both
 *  assignees (the table's check). */
export async function claimSlotForGuest(
	tx: DbOrTx,
	slotId: string,
	guestId: string,
	when: Date,
) {
	await tx
		.update(roleSlots)
		.set({ assignedGuestId: guestId, status: "claimed", claimedAt: when })
		.where(eq(roleSlots.id, slotId));
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
export const SPEECH_POOL: SpeechSpec[] = [
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
export async function fillMeeting(
	tx: DbOrTx,
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
		const assigneeName = assignees[ai % assignees.length]!;
		ai++;
		await claimSlot(tx, slot.id, memberByName.get(assigneeName)!, opts.when);

		if (slot.roleDefinitionId === speakerDefId) {
			const spec = SPEECH_POOL[opts.speechCursor.i % SPEECH_POOL.length]!;
			opts.speechCursor.i++;
			const [sp] = await tx
				.insert(speeches)
				.values({ personId: personByName.get(assigneeName)!, ...spec })
				.returning({ id: speeches.id });
			await tx
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
			await linkEvaluator(tx, evalSlots[i]!.id, speakerSlots[i]!.id);
	}
}

/**
 * The catalog path with `courseCode`, or `CATALOG_MISSING`. The fixtures READ
 * the catalog and never write it: in production it is seeded at container start
 * by `seed-catalog.mjs`, and a fixture that upserted a row would be rewriting
 * shared reference data.
 */
async function catalogPathId(tx: DbOrTx, courseCode: string): Promise<string> {
	const [path] = await tx
		.select({ id: pathwaysPaths.id })
		.from(pathwaysPaths)
		.where(eq(pathwaysPaths.courseCode, courseCode))
		.limit(1);
	if (!path) {
		throw new FixtureError(
			"CATALOG_MISSING",
			`the Pathways catalog has no path ${courseCode}`,
		);
	}
	return path.id;
}

/**
 * Throws `CATALOG_MISSING` unless every `courseCode` is in the catalog and the
 * named projects are at the named level. Called BEFORE a fixture writes
 * anything, so a missing catalog leaves nothing behind even for a caller that
 * is not in a transaction.
 */
export async function assertCatalog(
	tx: DbOrTx,
	needs: { courseCode: string; level?: number; projects?: string[] }[],
): Promise<void> {
	for (const need of needs) {
		const pathId = await catalogPathId(tx, need.courseCode);
		if (!need.projects || need.level === undefined) continue;
		const rows = await tx
			.select({ name: pathwaysProjects.name })
			.from(pathwaysProjects)
			.where(
				and(
					eq(pathwaysProjects.pathId, pathId),
					eq(pathwaysProjects.level, need.level),
				),
			);
		const have = new Set(rows.map((r) => r.name));
		for (const name of need.projects) {
			if (!have.has(name)) {
				throw new FixtureError(
					"CATALOG_MISSING",
					`${need.courseCode} has no Level ${need.level} project "${name}"`,
				);
			}
		}
	}
}

/** Enroll a person in a catalog path (by course code) with per-level progress rows. */
export async function enrollPath(
	tx: DbOrTx,
	clubId: string,
	personId: string,
	courseCode: string,
	levels: {
		level: number;
		completed: number;
		total: number;
		approved: boolean;
	}[],
	approvedAt: Date,
) {
	const pathId = await catalogPathId(tx, courseCode);
	const [enr] = await tx
		.insert(pathEnrollments)
		.values({ personId, pathId })
		.onConflictDoNothing({
			target: [pathEnrollments.personId, pathEnrollments.pathId],
		})
		.returning({ id: pathEnrollments.id });
	const enrollmentId =
		enr?.id ??
		(
			await tx
				.select({ id: pathEnrollments.id })
				.from(pathEnrollments)
				.where(
					and(
						eq(pathEnrollments.personId, personId),
						eq(pathEnrollments.pathId, pathId),
					),
				)
				.limit(1)
		)[0]!.id;
	await tx.insert(pathLevelProgress).values(
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

/**
 * Declare a path by hand (#417) and mark some of its catalog projects complete
 * (#419): an enrollment with NO `path_level_progress` rows, which is what puts
 * it on the catalog branch — levels counted from `pathways_projects` against
 * the marks, so "what is left" can be named. Needs the catalog seeded first.
 * The enrollment insert has no onConflict: it relies on the club insert having
 * just created the person fresh, so no enrollment for this path can exist yet.
 */
export async function declarePathWithMarks(
	tx: DbOrTx,
	personId: string,
	markedByMemberId: string,
	courseCode: string,
	level: number,
	markedProjectNames: string[],
) {
	const pathId = await catalogPathId(tx, courseCode);
	const [enr] = await tx
		.insert(pathEnrollments)
		.values({ personId, pathId })
		.returning({ id: pathEnrollments.id });
	const projects = await tx
		.select({ id: pathwaysProjects.id, name: pathwaysProjects.name })
		.from(pathwaysProjects)
		.where(
			and(
				eq(pathwaysProjects.pathId, pathId),
				eq(pathwaysProjects.level, level),
			),
		);
	const idByName = new Map(projects.map((p) => [p.name, p.id]));
	await tx.insert(projectCompletionMarks).values(
		markedProjectNames.map((name) => {
			const projectId = idByName.get(name);
			if (!projectId) {
				throw new FixtureError(
					"CATALOG_MISSING",
					`${courseCode} has no Level ${level} project "${name}"`,
				);
			}
			return { enrollmentId: enr!.id, projectId, markedByMemberId };
		}),
	);
}
