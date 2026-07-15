import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
	defaultClubRoleForOffices,
	type OfficerPosition,
} from "#/lib/officers";
import { ROLE_TEMPLATE } from "#/lib/role-template";
import { db } from "./index.ts";
import {
	clubs,
	meetings,
	members,
	officerTerms,
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

function nextWeekAt(daysFromNow: number, hour: number) {
	const d = new Date();
	d.setDate(d.getDate() + daysFromNow);
	d.setHours(hour, 0, 0, 0);
	return d;
}

interface RosterEntry {
	name: string;
	email: string;
	officerPosition?: OfficerPosition;
}

interface MeetingSpec {
	scheduledAt: Date;
	theme: string;
	location: string;
	wordOfTheDay: string;
}

interface SeededClub {
	clubId: string;
	memberByName: Map<string, string>;
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
 * Seed one club end to end: the club row, its roster (each member is a Person
 * linked to a sign-in account — ADR-0008 Phase B), open officer terms, the
 * standard role-definition template, and a set of meetings each pre-populated
 * with empty role slots. Returns handles the caller can use to wire up claims.
 */
async function seedClub(opts: {
	name: string;
	slug: string;
	clubNumber: string;
	roster: RosterEntry[];
	meetings: MeetingSpec[];
}): Promise<SeededClub> {
	await resetClubByName(opts.name);

	const [club] = await db
		.insert(clubs)
		.values({ name: opts.name, slug: opts.slug, clubNumber: opts.clubNumber })
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

	return { clubId: club.id, memberByName, defs, meetings: meetingsOut };
}

/** Claim a slot for a member (assigned + status=claimed). */
async function claimSlot(slotId: string, memberId: string) {
	await db
		.update(roleSlots)
		.set({
			assignedMemberId: memberId,
			status: "claimed",
			claimedAt: new Date(),
		})
		.where(eq(roleSlots.id, slotId));
}

/** Point an evaluator slot at the speaker slot it evaluates. */
async function linkEvaluator(evalSlotId: string, speakerSlotId: string) {
	await db
		.update(roleSlots)
		.set({ evaluatesSlotId: speakerSlotId })
		.where(eq(roleSlots.id, evalSlotId));
}

async function personOfMember(memberId: string) {
	const [row] = await db
		.select({ personId: members.personId })
		.from(members)
		.where(eq(members.id, memberId))
		.limit(1);
	return row!.personId;
}

async function main() {
	console.log("Seeding…");

	// A platform superadmin who belongs to no club (for console + impersonation).
	await upsertUser("Platform Superadmin", SUPERADMIN_EMAIL);

	// ---------------------------------------------------------------------------
	// Club 1 — MCF: fully wired (claims, speeches, evaluator pairings) so the
	// schedule + evaluator links are lively.
	// ---------------------------------------------------------------------------
	const mcf = await seedClub({
		name: "MCF",
		slug: "mcf-toastmasters",
		clubNumber: "28677176",
		roster: [
			{
				name: "Rasheed Bustamam",
				email: ADMIN_EMAIL,
				officerPosition: "vp_education",
			},
			{ name: "Alex Rivera", email: "alex@example.com" },
			{ name: "Sam Chen", email: "sam@example.com" },
			{
				name: "Jordan Patel",
				email: "jordan@example.com",
				officerPosition: "president",
			},
		],
		meetings: [
			{
				scheduledAt: nextWeekAt(7, 19),
				theme: "New Beginnings",
				location: "Community Hall, Room B",
				wordOfTheDay: "Resilient",
			},
			{
				scheduledAt: nextWeekAt(14, 19),
				theme: "Stories That Stick",
				location: "Community Hall, Room B",
				wordOfTheDay: "Vivid",
			},
		],
	});

	const mcfDefs = mcf.defs;
	const mcfByRole = (name: string) => mcfDefs.find((d) => d.name === name)!;
	const alexMemberId = mcf.memberByName.get("Alex Rivera")!;
	const samMemberId = mcf.memberByName.get("Sam Chen")!;
	const jordanMemberId = mcf.memberByName.get("Jordan Patel")!;

	const speakerDefId = mcfByRole("Speaker").id;
	const evaluatorDefId = mcfByRole("Evaluator").id;
	const tmodDefId = mcfByRole("Toastmaster of the Day").id;
	const timerDefId = mcfByRole("Timer").id;

	const m1Slots = mcf.meetings[0].slots;
	const speakerSlots = m1Slots
		.filter((s) => s.roleDefinitionId === speakerDefId)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	const evaluatorSlots = m1Slots
		.filter((s) => s.roleDefinitionId === evaluatorDefId)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	const tmodSlot = m1Slots.find((s) => s.roleDefinitionId === tmodDefId)!;
	const timerSlot = m1Slots.find((s) => s.roleDefinitionId === timerDefId)!;

	await claimSlot(tmodSlot.id, jordanMemberId);
	await claimSlot(timerSlot.id, alexMemberId);

	// Two speaker slots, each with a Person-owned speech (ADR-0009).
	await claimSlot(speakerSlots[0].id, alexMemberId);
	const [alexSpeech] = await db
		.insert(speeches)
		.values({
			personId: await personOfMember(alexMemberId),
			title: "Finding My Voice",
			pathwayPath: "Dynamic Leadership",
			projectName: "Ice Breaker",
			projectLevel: "Level 1",
			minMinutes: 4,
			maxMinutes: 6,
		})
		.returning({ id: speeches.id });
	await db
		.update(roleSlots)
		.set({ speechId: alexSpeech!.id })
		.where(eq(roleSlots.id, speakerSlots[0].id));

	await claimSlot(speakerSlots[1].id, samMemberId);
	const [samSpeech] = await db
		.insert(speeches)
		.values({
			personId: await personOfMember(samMemberId),
			title: "Lessons From the Trail",
			pathwayPath: "Presentation Mastery",
			projectName: "Researching and Presenting",
			projectLevel: "Level 2",
			minMinutes: 5,
			maxMinutes: 7,
		})
		.returning({ id: speeches.id });
	await db
		.update(roleSlots)
		.set({ speechId: samSpeech!.id })
		.where(eq(roleSlots.id, speakerSlots[1].id));

	// Link evaluator slots to the speakers they evaluate; claim the first.
	await linkEvaluator(evaluatorSlots[0].id, speakerSlots[0].id);
	await linkEvaluator(evaluatorSlots[1].id, speakerSlots[1].id);
	if (speakerSlots[2])
		await linkEvaluator(evaluatorSlots[2].id, speakerSlots[2].id);
	await claimSlot(evaluatorSlots[0].id, jordanMemberId);

	// Meeting 2 — wide open; still pair its evaluator slots to its speaker slots.
	const m2Slots = mcf.meetings[1].slots;
	const m2Speakers = m2Slots
		.filter((s) => s.roleDefinitionId === speakerDefId)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	const m2Evaluators = m2Slots
		.filter((s) => s.roleDefinitionId === evaluatorDefId)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	for (let i = 0; i < m2Evaluators.length; i++) {
		if (m2Speakers[i])
			await linkEvaluator(m2Evaluators[i].id, m2Speakers[i].id);
	}

	// ---------------------------------------------------------------------------
	// Club 2 — Harbor City Speakers: a distinct roster + officers + meetings, so
	// multi-club flows (club switcher, superadmin console, impersonation across a
	// club you don't belong to) are realistic. Lightly filled.
	// ---------------------------------------------------------------------------
	const harbor = await seedClub({
		name: "Harbor City Speakers",
		slug: "harbor-city-speakers",
		clubNumber: "01234567",
		roster: [
			{
				name: "Dana Okafor",
				email: "dana@example.com",
				officerPosition: "president",
			},
			{
				name: "Priya Nair",
				email: "priya@example.com",
				officerPosition: "vp_education",
			},
			{ name: "Marcus Lee", email: "marcus@example.com" },
			{ name: "Nina Petrov", email: "nina@example.com" },
			{ name: "Omar Haddad", email: "omar@example.com" },
		],
		meetings: [
			{
				scheduledAt: nextWeekAt(5, 18),
				theme: "Coastal Voices",
				location: "Harbor Library, Meeting Room 2",
				wordOfTheDay: "Buoyant",
			},
			{
				scheduledAt: nextWeekAt(12, 18),
				theme: "Tides of Change",
				location: "Harbor Library, Meeting Room 2",
				wordOfTheDay: "Momentum",
			},
		],
	});

	const harborByRole = (name: string) =>
		harbor.defs.find((d) => d.name === name)!;
	const danaId = harbor.memberByName.get("Dana Okafor")!;
	const marcusId = harbor.memberByName.get("Marcus Lee")!;
	const ninaId = harbor.memberByName.get("Nina Petrov")!;

	const h1Slots = harbor.meetings[0].slots;
	const hTmod = h1Slots.find(
		(s) => s.roleDefinitionId === harborByRole("Toastmaster of the Day").id,
	)!;
	const hTimer = h1Slots.find(
		(s) => s.roleDefinitionId === harborByRole("Timer").id,
	)!;
	const hSpeaker = h1Slots
		.filter((s) => s.roleDefinitionId === harborByRole("Speaker").id)
		.sort((a, b) => a.slotIndex - b.slotIndex)[0];
	await claimSlot(hTmod.id, danaId);
	await claimSlot(hTimer.id, marcusId);
	if (hSpeaker) await claimSlot(hSpeaker.id, ninaId);

	console.log("Seeded 2 clubs:");
	console.log(
		"  • MCF (mcf-toastmasters) — admins: Rasheed (VP Education), Jordan (President)",
	);
	console.log(
		"  • Harbor City Speakers (harbor-city-speakers) — admins: Dana (President), Priya (VP Education)",
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
