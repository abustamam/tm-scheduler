import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./index.ts";
import {
	clubMemberships,
	clubs,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speakerDetails,
	user,
} from "./schema.ts";

// Env (DATABASE_URL) is loaded via `tsx --env-file=.env.local` (see db:seed).
// The club admin who can sign in to manage everything. Defaults to the project
// owner's email so a magic-link sign-in lands as an admin out of the box.
const ADMIN_EMAIL =
	process.env.SEED_ADMIN_EMAIL ?? "rasheed.bustamam@gmail.com";

type RoleSeed = {
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	sortOrder: number;
	isSpeakerRole: boolean;
	description: string;
};

const ROLE_TEMPLATE: RoleSeed[] = [
	{
		name: "Toastmaster of the Day",
		category: "leadership",
		defaultCount: 1,
		sortOrder: 10,
		isSpeakerRole: false,
		description:
			"Hosts the meeting: sets the theme, introduces each speaker and segment, and keeps energy and timing on track. Prep: review the agenda beforehand.",
	},
	{
		name: "Table Topics Master",
		category: "leadership",
		defaultCount: 1,
		sortOrder: 20,
		isSpeakerRole: false,
		description:
			"Leads the impromptu speaking segment by preparing 8–10 questions or scenarios and calling on members or guests to respond on the spot.",
	},
	{
		name: "Speaker",
		category: "speaker",
		defaultCount: 3,
		sortOrder: 30,
		isSpeakerRole: true,
		description:
			"Delivers a prepared speech from your Pathways project; coordinate with your evaluator on the project objectives and time target before the meeting.",
	},
	{
		name: "Evaluator",
		category: "evaluator",
		defaultCount: 3,
		sortOrder: 40,
		isSpeakerRole: false,
		description:
			"Provides structured written and verbal feedback on your assigned speaker's delivery, language, and achievement of their project goals.",
	},
	{
		name: "General Evaluator",
		category: "evaluator",
		defaultCount: 1,
		sortOrder: 50,
		isSpeakerRole: false,
		description:
			"Oversees meeting quality by evaluating all roles (except speakers) and summarizing feedback from the Timer, Ah-Counter, and Grammarian.",
	},
	{
		name: "Timer",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 60,
		isSpeakerRole: false,
		description:
			"Tracks and displays time signals for every speaker and evaluator, then reports any overtime violations to the General Evaluator at the end of the meeting.",
	},
	{
		name: "Ah-Counter",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 70,
		isSpeakerRole: false,
		description:
			"Tallies filler words (um, ah, so, you know, like) for each speaker during the meeting and reports the counts in the evaluation segment.",
	},
	{
		name: "Grammarian",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 80,
		isSpeakerRole: false,
		description:
			"Introduces a Word of the Day, monitors language use throughout the meeting, and commends creative phrasing while noting grammatical slips in the evaluation segment.",
	},
];

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

async function main() {
	console.log("Seeding…");

	// Users (admin + a few members). Upserted so re-running is safe.
	const adminId = await upsertUser("Rasheed Bustamam", ADMIN_EMAIL);
	const alexId = await upsertUser("Alex Rivera", "alex@example.com");
	const samId = await upsertUser("Sam Chen", "sam@example.com");
	const jordanId = await upsertUser("Jordan Patel", "jordan@example.com");

	// Reset any prior MCF club (cascades to meetings/slots/role defs/memberships).
	const existing = await db
		.select({ id: clubs.id })
		.from(clubs)
		.where(eq(clubs.name, "MCF"));
	for (const c of existing) {
		await db.delete(clubs).where(eq(clubs.id, c.id));
	}

	const [club] = await db
		.insert(clubs)
		.values({ name: "MCF", slug: "mcf-toastmasters", clubNumber: "28677176" })
		.returning({ id: clubs.id });

	await db.insert(clubMemberships).values([
		{ userId: adminId, clubId: club.id, clubRole: "admin" },
		{ userId: jordanId, clubId: club.id, clubRole: "vpe" },
		{ userId: alexId, clubId: club.id, clubRole: "member" },
		{ userId: samId, clubId: club.id, clubRole: "member" },
	]);

	// Seed a roster of members (idempotent — guard with count check).
	const existingMembers = await db
		.select({ id: members.id })
		.from(members)
		.where(eq(members.clubId, club.id));

	// Build a name→memberId map. Insert fresh if this is the first run.
	let memberByName: Map<string, string>;
	if (existingMembers.length === 0) {
		const inserted = await db
			.insert(members)
			.values([
				{
					clubId: club.id,
					name: "Rasheed Bustamam",
					email: ADMIN_EMAIL,
					office: "VP Education",
					userId: adminId,
				},
				{ clubId: club.id, name: "Alex Rivera", email: "alex@example.com" },
				{ clubId: club.id, name: "Sam Chen", email: "sam@example.com" },
				{ clubId: club.id, name: "Jordan Patel", email: "jordan@example.com" },
			])
			.returning({ id: members.id, name: members.name });
		memberByName = new Map(inserted.map((m) => [m.name, m.id]));
	} else {
		const all = await db
			.select({ id: members.id, name: members.name })
			.from(members)
			.where(eq(members.clubId, club.id));
		memberByName = new Map(all.map((m) => [m.name, m.id]));
	}

	const alexMemberId = memberByName.get("Alex Rivera")!;
	const samMemberId = memberByName.get("Sam Chen")!;
	const jordanMemberId = memberByName.get("Jordan Patel")!;

	const defs = await db
		.insert(roleDefinitions)
		.values(ROLE_TEMPLATE.map((r) => ({ ...r, clubId: club.id })))
		.returning();

	// Helper to generate a meeting's slots from the template.
	async function createMeetingWithSlots(opts: {
		scheduledAt: Date;
		theme: string;
		location: string;
		wordOfTheDay: string;
	}) {
		const [meeting] = await db
			.insert(meetings)
			.values({
				clubId: club.id,
				scheduledAt: opts.scheduledAt,
				theme: opts.theme,
				location: opts.location,
				wordOfTheDay: opts.wordOfTheDay,
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
		return { meetingId: meeting.id, slots, defs };
	}

	const byRole = (name: string) => defs.find((d) => d.name === name)!;

	// Meeting 1 — partially filled so the schedule + evaluator links are lively.
	const m1 = await createMeetingWithSlots({
		scheduledAt: nextWeekAt(7, 19),
		theme: "New Beginnings",
		location: "Community Hall, Room B",
		wordOfTheDay: "Resilient",
	});

	const speakerDefId = byRole("Speaker").id;
	const evaluatorDefId = byRole("Evaluator").id;
	const tmodDefId = byRole("Toastmaster of the Day").id;
	const timerDefId = byRole("Timer").id;

	const speakerSlots = m1.slots
		.filter((s) => s.roleDefinitionId === speakerDefId)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	const evaluatorSlots = m1.slots
		.filter((s) => s.roleDefinitionId === evaluatorDefId)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	const tmodSlot = m1.slots.find((s) => s.roleDefinitionId === tmodDefId)!;
	const timerSlot = m1.slots.find((s) => s.roleDefinitionId === timerDefId)!;

	// Claim TMOD + Timer.
	await db
		.update(roleSlots)
		.set({
			assignedMemberId: jordanMemberId,
			status: "claimed",
			claimedAt: new Date(),
		})
		.where(eq(roleSlots.id, tmodSlot.id));
	await db
		.update(roleSlots)
		.set({
			assignedMemberId: alexMemberId,
			status: "claimed",
			claimedAt: new Date(),
		})
		.where(eq(roleSlots.id, timerSlot.id));

	// Claim two speaker slots with details.
	await db
		.update(roleSlots)
		.set({
			assignedMemberId: alexMemberId,
			status: "claimed",
			claimedAt: new Date(),
		})
		.where(eq(roleSlots.id, speakerSlots[0].id));
	await db.insert(speakerDetails).values({
		slotId: speakerSlots[0].id,
		speechTitle: "Finding My Voice",
		pathwayPath: "Dynamic Leadership",
		projectName: "Ice Breaker",
		projectLevel: "Level 1",
		minMinutes: 4,
		maxMinutes: 6,
	});

	await db
		.update(roleSlots)
		.set({
			assignedMemberId: samMemberId,
			status: "claimed",
			claimedAt: new Date(),
		})
		.where(eq(roleSlots.id, speakerSlots[1].id));
	await db.insert(speakerDetails).values({
		slotId: speakerSlots[1].id,
		speechTitle: "Lessons From the Trail",
		pathwayPath: "Presentation Mastery",
		projectName: "Researching and Presenting",
		projectLevel: "Level 2",
		minMinutes: 5,
		maxMinutes: 7,
	});

	// Link evaluator slots to the speakers they evaluate.
	await db
		.update(roleSlots)
		.set({ evaluatesSlotId: speakerSlots[0].id })
		.where(eq(roleSlots.id, evaluatorSlots[0].id));
	await db
		.update(roleSlots)
		.set({ evaluatesSlotId: speakerSlots[1].id })
		.where(eq(roleSlots.id, evaluatorSlots[1].id));
	await db
		.update(roleSlots)
		.set({ evaluatesSlotId: speakerSlots[2].id })
		.where(eq(roleSlots.id, evaluatorSlots[2].id));
	// Also claim the first evaluator so the speaker→evaluator pairing is visible.
	await db
		.update(roleSlots)
		.set({
			assignedMemberId: jordanMemberId,
			status: "claimed",
			claimedAt: new Date(),
		})
		.where(eq(roleSlots.id, evaluatorSlots[0].id));

	// Meeting 2 — wide open, two weeks out.
	const m2 = await createMeetingWithSlots({
		scheduledAt: nextWeekAt(14, 19),
		theme: "Stories That Stick",
		location: "Community Hall, Room B",
		wordOfTheDay: "Vivid",
	});

	// Pair its evaluator slots to its speaker slots too (still open).
	const m2Speakers = m2.slots
		.filter((s) => s.roleDefinitionId === speakerDefId)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	const m2Evaluators = m2.slots
		.filter((s) => s.roleDefinitionId === evaluatorDefId)
		.sort((a, b) => a.slotIndex - b.slotIndex);
	for (let i = 0; i < m2Evaluators.length; i++) {
		if (m2Speakers[i]) {
			await db
				.update(roleSlots)
				.set({ evaluatesSlotId: m2Speakers[i].id })
				.where(eq(roleSlots.id, m2Evaluators[i].id));
		}
	}

	console.log(`Seeded club MCF with 2 meetings.`);
	console.log(`Admin sign-in email: ${ADMIN_EMAIL}`);
	console.log(
		"Members: alex@example.com, sam@example.com, jordan@example.com (VPE)",
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
