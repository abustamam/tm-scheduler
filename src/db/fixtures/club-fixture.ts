/**
 * The Harbor City Speakers fixture club (#1198, part of #1114): a small, made-up
 * Toastmasters club with enough history that every screen an officer or a member
 * opens has something on it. The dev seeder builds it, and the demo club (#1199)
 * builds it again in production, so everything here is fiction by construction:
 * `@example.com` addresses and the `seedPhone` block (+1 202 555 01xx), which
 * the numbering plan reserves for fiction.
 *
 * `buildFixtureClub` writes through the executor it is given and nothing else.
 * Given a transaction it joins it, so a caller that throws afterwards leaves no
 * row in any table; given the pooled client it runs in its own transaction, so
 * a failure part way leaves no half-built club either. It never resets, never
 * deletes, and importing this file runs nothing and exits nothing.
 *
 * What it builds, for each audience:
 *  - everyone: 6 held meetings (-7, -14 … -42 days) and 4 upcoming (+3, +10, +17,
 *    +24), each at 18:00 in the CLUB's time zone, with role slots, speeches,
 *    guests of three kinds, a mentorship, Pathways progress and anonymous notes;
 *  - the officers' "Between meetings" views: a dues period with some members paid
 *    and some open, minutes on every held meeting (attendance, Table Topics
 *    speakers, awards), an evaluator linked to every held speech, and a DCP
 *    scoreboard for the current program year;
 *  - the presenter, who signs in as `admin`: roles at two held meetings with
 *    notes addressed to them, a role at the next meeting, a Pathways path in
 *    progress and attendance at every held meeting. Feedback is read through
 *    the signed-in user's own memberships, so this is what makes "my" views
 *    non-empty.
 *
 * It reads the Pathways catalog from the database (in production the container
 * seeds it at start) and throws `FixtureError("CATALOG_MISSING")`, before any
 * write, when it is absent. It imports nothing from `scripts/`.
 */

import { eq } from "drizzle-orm";
import {
	clubs,
	dcpGoalProgress,
	dcpScoreboards,
	duesPeriods,
	guestInvites,
	meetingAttendance,
	meetingAwards,
	memberDues,
	roleDefinitions,
	roleFeedbackNotes,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { slotLabel } from "#/lib/agenda";
import type { AttendanceMode } from "#/lib/attendance-mode";
import { utcToZonedWallTime } from "#/lib/datetime";
import { programYearForDate } from "#/lib/dcp";
import { createGuestRecord } from "#/server/guests-logic";
import type { DbOrTx } from "#/server/meeting-templates-logic";
import { createMentorship } from "#/server/mentorship-logic";
import {
	assertCatalog,
	claimSlot,
	claimSlotForGuest,
	dayAt,
	declarePathWithMarks,
	enrollPath,
	fillMeeting,
	insertFixtureClub,
	joinedAgo,
	joinedThisYear,
	type MeetingSpec,
	meetingByTheme,
	type RosterEntry,
	type SeededClub,
	seedPhone,
	slotOf,
} from "./helpers.ts";

export { FixtureError } from "./helpers.ts";

export interface FixtureClubOptions {
	name: string;
	slug: string;
	/** IANA zone the club meets in, e.g. "America/Chicago". Every meeting is
	 *  18:00 wall time there, whatever zone the process runs in. */
	timeZone: string;
	/** The instant the fixture is "today" at: meetings are placed relative to it. */
	now: Date;
	/** The club's President and the presenter. `userId` is the sign-in account
	 *  they already have; `null` builds the Person with none. */
	admin: { name: string; email: string; userId: string | null };
	/** Marks the club `clubs.is_demo` (#1199). Omitted ⇒ false. At most one club
	 *  may carry it (`clubs_single_demo_unique`). */
	isDemo?: boolean;
}

const MEETING_LOCATION = "Harbor Library, Meeting Room 2";

/** Catalog rows the fixture reads. Checked before anything is written. */
const MARCUS_PROJECTS = [
	"Ice Breaker",
	"Writing a Speech with Purpose",
	"Introduction to Vocal Variety and Body Language",
];
const OMAR_PROJECTS = ["Ice Breaker", "Writing a Speech with Purpose"];
const CATALOG_NEEDS = [
	{ courseCode: "8706", level: 1, projects: MARCUS_PROJECTS },
	{ courseCode: "8700", level: 1, projects: OMAR_PROJECTS },
	{ courseCode: "8705" },
	{ courseCode: "8701" },
];

/** The roster, index-ordered because `seedPhone` is by index: appending keeps
 *  every earlier member's number. The admin takes the President's seat. */
function harborRoster(
	opts: Pick<FixtureClubOptions, "now" | "timeZone" | "admin">,
): RosterEntry[] {
	const { now, timeZone, admin } = opts;
	return [
		{
			name: admin.name,
			email: admin.email,
			userId: admin.userId,
			officerPosition: "president",
			joinedAt: joinedAgo(now, 3),
			// A member's own choice, and a method outside the default pair.
			contactPreference: { method: "call", by: "member" },
			willingToMentor: true,
		},
		{
			name: "Priya Nair",
			email: "priya@example.com",
			officerPosition: "vp_education",
			joinedAt: joinedAgo(now, 2),
			willingToMentor: true,
		},
		{
			// Marcus, Nina and Omar are on the VPE's "Close to a level" list, which
			// is what `/tour`'s VP Education shot shows. They carry three different
			// preferences, two of them set by an officer (#1110), so the nudge
			// draft leads with each person's own channel (#1105).
			name: "Marcus Lee",
			email: "marcus@example.com",
			joinedAt: joinedAgo(now, 1),
			contactPreference: { method: "whatsapp", by: "member" },
		},
		{
			name: "Nina Petrov",
			email: "nina@example.com",
			joinedAt: joinedAgo(now, 0, 8),
			contactPreference: { method: "email", by: "officer" },
		},
		{
			name: "Omar Haddad",
			email: "omar@example.com",
			joinedAt: joinedThisYear(now, timeZone, 10),
			contactPreference: { method: "sms", by: "officer" },
		},
		{
			// Harbor's VP Membership (#901): `/tour`'s officers stop signs in as
			// this person for the guest-pipeline shot.
			name: "Sofia Reyes",
			email: "sofia@example.com",
			officerPosition: "vp_membership",
			joinedAt: joinedAgo(now, 1, 6),
		},
		{
			// The second new member, with no mentor yet (Omar is the paired one),
			// so the mentorship screens have both shapes. Last in the roster:
			// `seedPhone` is by roster index, so nobody above is renumbered.
			name: "Camille Roy",
			email: "camille@example.com",
			joinedAt: joinedThisYear(now, timeZone, 4),
		},
	];
}

/**
 * Every address the fixture's roster uses, so a caller resetting a club can
 * find the Persons a previous build left (the dev seeder does). Guests are not
 * here: their Persons are found through the club's guest rows.
 */
export function fixtureRosterEmails(adminEmail: string): string[] {
	return harborRoster({
		now: new Date(0),
		timeZone: "UTC",
		admin: { name: "", email: adminEmail, userId: null },
	}).map((r) => r.email);
}

/**
 * The held meetings, newest first. Each carries the word of the day a QA path
 * needs: a long word, an all-caps word (which routes to the second poster size
 * table) and so on live on the upcoming and held meetings below as they did in
 * the dev seed. Do not "tidy" them into ordinary meetings; each is the only
 * seed route to a branch.
 */
const HELD: {
	days: number;
	theme: string;
	word: string;
	definition: string;
	example: string;
	/** Where to start in the eligible members, so roles spread over the club. */
	rotate: number;
}[] = [
	{
		days: -7,
		theme: "Safe Harbor",
		word: "Anchor",
		definition: "to hold something firmly in place",
		example: "A good opening line anchors the whole speech.",
		rotate: 0,
	},
	{
		days: -14,
		theme: "Rising Tide",
		word: "Swell",
		definition: "to grow larger or stronger",
		example: "Applause began to swell as she finished.",
		rotate: 2,
	},
	{
		days: -21,
		theme: "Storm Warning",
		word: "Gale",
		definition: "a very strong wind, or a sudden burst of feeling",
		example: "A gale of laughter followed the last line.",
		rotate: 4,
	},
	{
		// All caps routes to the second size table, which is ~20-30% smaller
		// because capitals run wider. Members really do type words this way.
		days: -28,
		theme: "Fleeting Moments",
		word: "EPHEMERAL",
		definition: "lasting for a very short time",
		example: "The applause was ephemeral; the lesson was not.",
		rotate: 1,
	},
	{
		days: -35,
		theme: "Lighthouse Nights",
		word: "Beacon",
		definition: "a light or signal that guides",
		example: "Her story was a beacon for the newest members.",
		rotate: 3,
	},
	{
		days: -42,
		theme: "First Light",
		word: "Dawn",
		definition: "the first appearance of something",
		example: "Every Ice Breaker is the dawn of a speaker.",
		rotate: 0,
	},
];

const TABLE_TOPICS = [
	"A place you would go back to",
	"A small thing that changed your week",
	"The best advice you ignored",
	"What you would teach a class",
	"An object you cannot throw away",
	"A time you were wrong, happily",
];

/** The slots of one meeting by who holds them, read back from the database. */
async function heldSlots(tx: DbOrTx, meetingId: string) {
	return tx
		.select({
			id: roleSlots.id,
			memberId: roleSlots.assignedMemberId,
			roleName: roleDefinitions.name,
			slotIndex: roleSlots.slotIndex,
			slotsUnordered: roleDefinitions.slotsUnordered,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(eq(roleSlots.meetingId, meetingId));
}
type HeldSlot = Awaited<ReturnType<typeof heldSlots>>[number];

function holder(slots: HeldSlot[], roleName: string, slotIndex = 0) {
	const slot = slots.find(
		(x) => x.roleName === roleName && x.slotIndex === slotIndex,
	);
	if (!slot?.memberId) {
		throw new Error(`Fixture: nobody holds ${roleName} ${slotIndex + 1}`);
	}
	return { slot, memberId: slot.memberId };
}

/**
 * The DCP program year (July to June) the club is in on `now`: read off the
 * club's own wall date, not the process's. `programYearForDate` reads the
 * month and year in the process zone, so on a UTC server the evening of
 * June 30 in Chicago (already July 1 in UTC) would land in the next year. The
 * date is rebuilt from the club-local year and month at noon, a local date in
 * any process zone, so only its month and year are read.
 */
export function clubProgramYear(now: Date, timeZone: string): number {
	const [year, month] = utcToZonedWallTime(now, timeZone)
		.split("T")[0]!
		.split("-")
		.map(Number) as [number, number];
	return programYearForDate(new Date(year, month - 1, 15, 12));
}

/**
 * Build the Harbor City Speakers fixture club in `tx` and return its id.
 *
 * Fictional members get accounts through `ensureFixtureUser`, which never
 * renames one that already exists; the admin Person is linked to
 * `admin.userId` directly.
 */
export async function buildFixtureClub(
	tx: DbOrTx,
	opts: FixtureClubOptions,
): Promise<{ clubId: string }> {
	const { now, timeZone, admin } = opts;
	const roster = harborRoster(opts);
	if (roster.slice(1).some((r) => r.name === admin.name)) {
		throw new Error(
			`Fixture: the admin's name "${admin.name}" is also a fictional member's`,
		);
	}
	const at = (days: number, hour = 18) => dayAt(now, timeZone, days, hour);
	const joinedAtOf = new Map(roster.map((r) => [r.name, r.joinedAt!]));
	const [adminName, priya, marcus, nina, omar, sofia, camille] = roster.map(
		(r) => r.name,
	) as [string, string, string, string, string, string, string];

	// A savepoint under a caller's transaction, a transaction of its own under
	// the pooled client: either way a failure part way leaves nothing.
	return tx.transaction(async (conn) => {
		// Before the first write, so a missing catalog leaves nothing behind.
		await assertCatalog(conn, CATALOG_NEEDS);

		const meetingSpecs: MeetingSpec[] = [
			// Upcoming. The first two already carry a word with no definition or
			// example, which is why the awkward shapes live here rather than in
			// MCF, whose data should stay realistic for demos.
			{
				scheduledAt: at(3),
				theme: "Coastal Voices",
				location: MEETING_LOCATION,
				wordOfTheDay: "Buoyant",
			},
			{
				scheduledAt: at(10),
				theme: "Tides of Change",
				location: MEETING_LOCATION,
				wordOfTheDay: "Momentum",
			},
			// QA fixtures (#492): the Word of the Day poster, the print layouts and
			// the projected deck can be checked in a browser without hand-editing
			// the database.
			{
				// No Word of the Day at all → the poster's empty state, and the
				// meeting page's "Word poster" button must NOT render.
				scheduledAt: at(17),
				theme: "Open Floor",
				location: MEETING_LOCATION,
			},
			{
				// 14 characters, and the widest real word measured at that length —
				// exercises the third size bucket near its limit.
				scheduledAt: at(24),
				theme: "Saying Less",
				location: MEETING_LOCATION,
				wordOfTheDay: "Cumbersomeness",
				wodDefinition: "the quality of being awkward to carry, use, or say",
				wodExample: "He trimmed the cumbersomeness out of his opening line.",
			},
			...HELD.map((h) => ({
				scheduledAt: at(h.days),
				theme: h.theme,
				location: MEETING_LOCATION,
				wordOfTheDay: h.word,
				wodDefinition: h.definition,
				wodExample: h.example,
				status: "completed" as const,
			})),
		];

		const harbor: SeededClub = await insertFixtureClub(conn, {
			name: opts.name,
			slug: opts.slug,
			now,
			timeZone,
			roster,
			meetings: meetingSpecs,
		});
		// `insertFixtureClub` (helpers.ts, shared with the dev seeder) does not take
		// the flag, so it is set on the row it just wrote, in the same transaction.
		if (opts.isDemo) {
			await conn
				.update(clubs)
				.set({ isDemo: true })
				.where(eq(clubs.id, harbor.clubId));
		}
		const person = (n: string) => harbor.personByName.get(n)!;
		const member = (n: string) => harbor.memberByName.get(n)!;

		// Guests, one of each kind (#1046), two of them brought by a member (#1050).
		// The visiting Toastmasters take roles on the next meeting below, which
		// puts the "· Guest" marker on the printed agenda (#151, #1208). A guest
		// speaker is a guest holding a speech, so they are one of these.
		const guestIds = new Map<string, string>();
		for (const g of [
			{
				name: "Lucia Moreno",
				email: "lucia.moreno@example.com",
				phone: seedPhone(50),
				stage: "prospect" as const,
				introducedByMemberId: member(marcus),
			},
			{
				name: "Ethan Brooks",
				email: "ethan.brooks@example.com",
				phone: null,
				stage: "following_up" as const,
				introducedByMemberId: member(priya),
			},
			{
				name: "Imani Clarke",
				email: "imani.clarke@example.com",
				phone: seedPhone(51),
				kind: "visiting_toastmaster" as const,
				homeClub: "Bayview",
			},
			{
				name: "Theo Marchetti",
				email: "theo.marchetti@example.com",
				phone: seedPhone(52),
				kind: "visiting_toastmaster" as const,
				homeClub: "Seaport Speakers",
				introducedByMemberId: member(adminName),
			},
		]) {
			const { id } = await createGuestRecord(conn, {
				clubId: harbor.clubId,
				...g,
			});
			guestIds.set(g.name, id);
		}
		const guest = (n: string) => guestIds.get(n)!;

		// The next meeting (+3 days): the one the print and present shots capture.
		// Marcus and Omar are NOT on it, and nobody on "Close to a level" speaks: a
		// row shows the nudge only while its member has no speaker slot ahead
		// (`showsLevelNudge`), and Nina's row keeps its "Speaking" badge for
		// contrast. Speaker 3 goes to the guest speaker, the Grammarian to the
		// visiting Toastmaster, the Timer to the newest member. The admin is the
		// Toastmaster: the presenter's upcoming role.
		const next = meetingByTheme(harbor, "Coastal Voices");
		const nextClaimedAt = at(-1, 12);
		await fillMeeting(
			conn,
			next,
			harbor.defs,
			[adminName, priya, sofia, nina],
			harbor.memberByName,
			harbor.personByName,
			{ count: 4, when: nextClaimedAt, speechCursor: { i: 3 } },
		);
		await claimSlotForGuest(
			conn,
			slotOf(next, harbor.defs, "Speaker", 2).id,
			guest("Theo Marchetti"),
			nextClaimedAt,
		);
		await claimSlotForGuest(
			conn,
			slotOf(next, harbor.defs, "Grammarian").id,
			guest("Imani Clarke"),
			nextClaimedAt,
		);
		await claimSlot(
			conn,
			slotOf(next, harbor.defs, "Timer").id,
			member(camille),
			nextClaimedAt,
		);

		// The held meetings. Roles go to the members who had joined by then, in
		// agenda order, so a meeting from before Omar or Camille joined does not
		// have them in it. Eight roles: the Toastmaster, Table Topics, three
		// speakers and their three evaluators, which `fillMeeting` links.
		const speechCursor = { i: 0 };
		const everyone = [adminName, priya, marcus, nina, sofia, omar, camille];
		const heldRows: {
			meetingId: string;
			slots: HeldSlot[];
		}[] = [];
		for (const [i, h] of HELD.entries()) {
			const m = meetingByTheme(harbor, h.theme);
			const heldAt = at(h.days);
			const eligible = everyone.filter((n) => joinedAtOf.get(n)! <= heldAt);
			const r = h.rotate % eligible.length;
			await fillMeeting(
				conn,
				m,
				harbor.defs,
				[...eligible.slice(r), ...eligible.slice(0, r)],
				harbor.memberByName,
				harbor.personByName,
				{ count: 8, when: at(h.days - 3, 12), speechCursor },
			);
			const slots = await heldSlots(conn, m.meetingId);

			// Minutes (ADR-0014): who attended and how, who spoke at Table Topics,
			// and the three awards, read from what `fillMeeting` actually claimed so
			// reordering a pool cannot give an award to someone who held no such role.
			const topicsMaster = holder(slots, "Table Topics Master").memberId;
			const askable = eligible.filter((n) => member(n) !== topicsMaster);
			const topicSpeakers = [0, 1, 2].map(
				(k) => askable[(i + k) % askable.length]!,
			);
			await conn.insert(tableTopicsSpeakers).values(
				topicSpeakers.map((n, k) => ({
					meetingId: m.meetingId,
					memberId: member(n),
					topic: TABLE_TOPICS[(i + k) % TABLE_TOPICS.length],
					sortOrder: k,
				})),
			);
			await conn.insert(meetingAwards).values([
				{
					meetingId: m.meetingId,
					category: "best_speaker" as const,
					memberId: holder(slots, "Speaker", 0).memberId,
				},
				{
					meetingId: m.meetingId,
					category: "best_evaluator" as const,
					memberId: holder(slots, "Evaluator", 0).memberId,
				},
				{
					meetingId: m.meetingId,
					category: "best_table_topics" as const,
					memberId: member(topicSpeakers[0]!),
				},
			]);
			// In the room or on the call (#1046); NULL means not recorded, so a few
			// rows leave it out the way roll mode does today.
			const modeOf = (k: number): AttendanceMode | null => {
				const v = (k + i) % 5;
				return v === 4 ? null : v === 2 ? "online" : "in_person";
			};
			const guestsAttending: [string, AttendanceMode][] =
				i === 0
					? [["Lucia Moreno", "in_person"]]
					: i === 1
						? [
								["Imani Clarke", "in_person"],
								["Ethan Brooks", "online"],
							]
						: i === 2
							? [["Lucia Moreno", "in_person"]]
							: [];
			await conn.insert(meetingAttendance).values([
				...eligible.map((n, k) => ({
					meetingId: m.meetingId,
					memberId: member(n),
					status: "present" as const,
					mode: modeOf(k),
				})),
				...guestsAttending.map(([n, mode]) => ({
					meetingId: m.meetingId,
					guestId: guest(n),
					status: "present" as const,
					mode,
				})),
			]);
			heldRows.push({ meetingId: m.meetingId, slots });
		}

		// Anonymous notes (#981) for the people who served at the two most recent
		// held meetings. The recipient and the slot are read back from what
		// `fillMeeting` actually claimed, not matched by hand to its round-robin,
		// so reordering the pool cannot put a note on a role its recipient never
		// held. The admin has notes at both: a Toastmaster at the first, a speaker
		// at the second. No writer column exists, and `created_at` is the table's
		// own day-granular default: neither is set here.
		const roleCounts = Object.fromEntries(
			harbor.defs.map((d) => [d.name, d.defaultCount]),
		);
		const noteFor = (
			row: (typeof heldRows)[number],
			roleName: string,
			slotIndex = 0,
		) => {
			const { slot, memberId } = holder(row.slots, roleName, slotIndex);
			return {
				clubId: harbor.clubId,
				meetingId: row.meetingId,
				recipientMemberId: memberId,
				roleSlotId: slot.id,
				roleLabel: slotLabel(
					{
						roleName,
						slotIndex,
						slotsUnordered: slot.slotsUnordered,
					},
					roleCounts,
				),
			};
		};
		const [recent, older] = heldRows as [
			(typeof heldRows)[number],
			(typeof heldRows)[number],
		];
		await conn.insert(roleFeedbackNotes).values([
			{
				...noteFor(recent, "Speaker", 0),
				wentWell:
					"The story about your first night on the ferry pulled everyone in.",
				tryNext: "A longer pause before the ending would let it land.",
			},
			{
				...noteFor(recent, "Speaker", 0),
				wentWell: "Great energy from the first sentence.",
			},
			{
				...noteFor(recent, "Speaker", 1),
				wentWell: "Clear structure. I could follow every point.",
			},
			{
				...noteFor(recent, "Table Topics Master"),
				wentWell: "Your questions made everyone want to answer.",
				tryNext:
					"Keep the introduction short so there is time for one more speaker.",
			},
			{
				...noteFor(recent, "Toastmaster of the Day"),
				wentWell:
					"You set the tone in the first minute and kept every segment on time.",
				tryNext: "Add one personal detail when you introduce each speaker.",
			},
			{
				...noteFor(recent, "Toastmaster of the Day"),
				wentWell: "A warm welcome. The guests looked at ease straight away.",
			},
			{
				...noteFor(older, "Speaker", 1),
				wentWell: "A clear opening, and the middle built the way you promised.",
				tryNext: "Slow down on the line you want people to remember.",
			},
			{
				...noteFor(older, "Speaker", 1),
				wentWell: "I want to hear the next chapter.",
			},
		]);

		// Mentorship (#939): Omar, a new member, is paired with the admin; Camille,
		// the other new member, has no mentor yet. Through the pairing's own write
		// path, the one a club admin's "Pair a mentor" uses, so a seeded pairing
		// has passed the checks a real one does: both members active in this
		// club, mentor and mentee different. On `conn`, so it sees this club.
		await createMentorship(
			{
				clubId: harbor.clubId,
				mentorMemberId: member(adminName),
				menteeMemberId: member(omar),
				focus: "new_member",
				actorMemberId: member(priya),
			},
			conn,
		);

		// "Close to a level", catalog branch: a hand-declared path, 3 of Level 1's 4
		// projects marked, so the row NAMES what is left ("1 left: …").
		await declarePathWithMarks(
			conn,
			person(marcus),
			member(marcus),
			"8706",
			1,
			MARCUS_PROJECTS,
		);
		// A second "close" row, two projects short.
		await declarePathWithMarks(
			conn,
			person(omar),
			member(omar),
			"8700",
			1,
			OMAR_PROJECTS,
		);
		// Base Camp branch: Level 2 finished and not yet approved → an awaiting row.
		const L = (
			level: number,
			completed: number,
			total: number,
			approved: boolean,
		) => ({ level, completed, total, approved });
		await enrollPath(
			conn,
			harbor.clubId,
			person(nina),
			"8705",
			[L(1, 4, 4, true), L(2, 3, 3, false)],
			joinedAgo(now, 0, 3),
		);
		// The presenter's own path, in progress and three projects short of Level
		// 2, so the admin is not on the "Close to a level" list above.
		await enrollPath(
			conn,
			harbor.clubId,
			person(adminName),
			"8701",
			[L(1, 5, 5, true), L(2, 1, 4, false)],
			joinedAgo(now, 0, 2),
		);

		// Invites, by Harbor's VPM. Lucia is invited to the NEXT meeting, so her row
		// reads "Resend invite" (#1041) with an "Invited to …" badge; Ethan is
		// invited to the +10-day one, so his row still offers "Invite to …" for the
		// next meeting. That one is what keeps the capture's DOM check and its
		// upcoming-meeting check good for a week: once the next meeting has started,
		// Lucia's line reads "Last invited to …".
		await conn.insert(guestInvites).values([
			{
				clubId: harbor.clubId,
				guestId: guest("Lucia Moreno"),
				meetingId: next.meetingId,
				invitedByMemberId: member(sofia),
				invitedAt: at(-2, 10),
			},
			{
				clubId: harbor.clubId,
				guestId: guest("Ethan Brooks"),
				meetingId: meetingByTheme(harbor, "Tides of Change").meetingId,
				invitedByMemberId: member(sofia),
				invitedAt: at(-1, 10),
			},
		]);

		// Dues (the Treasurer's view): one period, due ten days ago, most paid and
		// two open. "Unpaid" is the absence of a row, so the open ones are the two
		// newest members', who are therefore overdue.
		const dueDate = at(-10, 0);
		const [period] = await conn
			.insert(duesPeriods)
			.values({
				clubId: harbor.clubId,
				label: `Renewal due ${utcToZonedWallTime(dueDate, timeZone).slice(0, 10)}`,
				dueDate,
				defaultAmountCents: 4500,
			})
			.returning({ id: duesPeriods.id });
		await conn.insert(memberDues).values(
			[adminName, priya, marcus, nina, sofia].map((n) => ({
				membershipId: member(n),
				duesPeriodId: period!.id,
				status: "paid" as const,
				amountCents: 4500,
				paidAt: at(-14, 10),
			})),
		);

		// The DCP scoreboard for the current program year: started, partly met.
		const [scoreboard] = await conn
			.insert(dcpScoreboards)
			.values({
				clubId: harbor.clubId,
				programYear: clubProgramYear(now, timeZone),
				baseMemberCount: 6,
			})
			.returning({ id: dcpScoreboards.id });
		const goals: Record<string, number> = {
			g1: 2,
			g2: 1,
			g3: 1,
			g4: 1,
			g5: 0,
			g6: 0,
			g7: 3,
			g8: 1,
			g9: 1,
			g10: 0,
		};
		await conn.insert(dcpGoalProgress).values(
			Object.entries(goals).map(([goalKey, achieved]) => ({
				scoreboardId: scoreboard!.id,
				goalKey,
				achieved,
			})),
		);

		return { clubId: harbor.clubId };
	});
}
