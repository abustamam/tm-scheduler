/**
 * Officer-only writes on a cancelled meeting (#1085).
 *
 * #1084 refused every member-facing write on a cancelled meeting and every
 * write that changes who holds a role, and HID the officer-only editors. The
 * server still accepted those, so a stale tab, an offline-queue replay or a
 * direct call could give a cancelled meeting a new date, a roll, guests, Table
 * Topics speakers or awards while it was hidden from every member.
 *
 * Executes the REAL `createServerFn` handlers through the minimal adapter
 * `speaker-details-cancelled.integration.test.ts` uses, with the cookie →
 * session lookup faked and nothing else. Several refusals live in a handler
 * (`unconfirmSlot`, the minutes writers) and the rest in a resolver or a logic
 * function the handler calls, so only the handler is the seam that covers all
 * of them.
 *
 * Every case runs twice against the same preparation: refused on the cancelled
 * meeting with the exact sentence and NOTHING written, and accepted on the
 * scheduled one with the write visible. The control is what makes the refusal
 * mean anything: without it a case passes on a harness that never reaches the
 * write, or on a fixture the write would have refused anyway.
 */
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "#/db/auth-schema";
import {
	guests,
	meetingAttendance,
	meetingAwards,
	meetings,
	roleDefinitions,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// `meetings.ts` also declares validator-less fns (`.handler` straight off
// `createServerFn`), so the adapter answers both shapes.
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

let sessionUserId: string | null = null;
/** Fresh per test: the impersonation marker is keyed on this object. */
let request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
vi.mock("#/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				sessionUserId ? { user: { id: sessionUserId } } : null,
		},
	},
}));

const {
	setMeetingDigitalVoting,
	updateMeeting,
	updateTableTopicsNotes,
	updateWordOfTheDay,
} = await import("./meetings");
const { confirmSlot, unconfirmSlot } = await import("./slots");
const { NO_PERMISSION_MESSAGE, NOT_A_MEMBER_MESSAGE } = await import(
	"./guards"
);
const {
	addMinutesGuest,
	addTableTopics,
	clearMinutesAward,
	moveTableTopics,
	removeMinutesGuest,
	removeTableTopics,
	setAttendance,
	setMinutesAward,
} = await import("./minutes");

/** Exact-string matcher, so a case cannot pass on an unrelated throw. */
const exact = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/** The adapter runs the validator synchronously, so a validation refusal is a
 *  THROW rather than a rejection; this folds both into one promise. */
const attempt = (fn: () => unknown) => (async () => fn())();

interface Case {
	name: string;
	/** Who is signed in: the seeded admin, or nobody (a self-asserted holder). */
	as: "admin" | "anonymous";
	/** Fixture rows the write needs, laid down while the meeting is scheduled. */
	prepare?: (seed: SeededClub) => Promise<void>;
	act: (seed: SeededClub) => unknown;
	/** What the write would change, read back. Compared with `toEqual`. */
	read: (seed: SeededClub) => Promise<unknown>;
}

async function meetingRow(seed: SeededClub) {
	const [row] = await testDb
		.select()
		.from(meetings)
		.where(eq(meetings.id, seed.meetingId));
	return row;
}

async function slotRow(seed: SeededClub) {
	const [row] = await testDb
		.select({ status: roleSlots.status })
		.from(roleSlots)
		.where(eq(roleSlots.id, seed.slotId));
	return row;
}

async function setSlot(
	seed: SeededClub,
	status: "claimed" | "confirmed",
): Promise<void> {
	await testDb
		.update(roleSlots)
		.set({ status, assignedMemberId: seed.memberId })
		.where(eq(roleSlots.id, seed.slotId));
}

async function attendanceRows(seed: SeededClub) {
	return testDb
		.select({
			memberId: meetingAttendance.memberId,
			guestId: meetingAttendance.guestId,
			status: meetingAttendance.status,
		})
		.from(meetingAttendance)
		.where(eq(meetingAttendance.meetingId, seed.meetingId))
		.orderBy(asc(meetingAttendance.id));
}

async function topicsRows(seed: SeededClub) {
	return testDb
		.select({
			id: tableTopicsSpeakers.id,
			sortOrder: tableTopicsSpeakers.sortOrder,
		})
		.from(tableTopicsSpeakers)
		.where(eq(tableTopicsSpeakers.meetingId, seed.meetingId))
		.orderBy(asc(tableTopicsSpeakers.sortOrder), asc(tableTopicsSpeakers.id));
}

async function awardRows(seed: SeededClub) {
	return testDb
		.select({
			category: meetingAwards.category,
			memberId: meetingAwards.memberId,
		})
		.from(meetingAwards)
		.where(eq(meetingAwards.meetingId, seed.meetingId));
}

/** A guest of this club, present at the meeting. Returns the guest id. */
async function seedPresentGuest(seed: SeededClub): Promise<string> {
	const [g] = await testDb
		.insert(guests)
		.values({ clubId: seed.clubId, name: "Cancelled Case Guest" })
		.returning({ id: guests.id });
	if (!g) throw new Error("Failed to seed the guest");
	await testDb.insert(meetingAttendance).values({
		meetingId: seed.meetingId,
		guestId: g.id,
		status: "present",
	});
	return g.id;
}

/** Ids of the Table Topics rows `seedTopics` laid down, in order. */
let topicIds: string[] = [];
async function seedTopics(seed: SeededClub, count: number): Promise<void> {
	const rows = await testDb
		.insert(tableTopicsSpeakers)
		.values(
			Array.from({ length: count }, (_, i) => ({
				meetingId: seed.meetingId,
				memberId: i % 2 === 0 ? seed.memberId : seed.adminMemberId,
				sortOrder: i,
			})),
		)
		.returning({ id: tableTopicsSpeakers.id });
	topicIds = rows.map((r) => r.id);
}

let guestId = "";

const CASES: Case[] = [
	// Meeting details.
	{
		name: "updateMeeting (admin): theme",
		as: "admin",
		act: (s) =>
			updateMeeting({ data: { meetingId: s.meetingId, theme: "Renamed" } }),
		read: async (s) => (await meetingRow(s))?.theme ?? null,
	},
	{
		name: "updateMeeting (admin): reschedule",
		as: "admin",
		act: (s) =>
			updateMeeting({
				data: { meetingId: s.meetingId, scheduledAt: "2031-03-04T19:00" },
			}),
		read: async (s) => (await meetingRow(s))?.scheduledAt.getTime(),
	},
	{
		// The self-asserted Toastmaster arm needs no session at all, which is why
		// the issue names it: the resolver checked only the completed lock.
		name: "updateMeeting (self-asserted Toastmaster): location",
		as: "anonymous",
		prepare: async (s) => {
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: s.clubId,
					name: "Toastmaster of the Day",
					key: "toastmaster_of_the_day",
					category: "leadership",
					isSpeakerRole: false,
				})
				.returning({ id: roleDefinitions.id });
			if (!def) throw new Error("Failed to seed the TMOD role");
			await testDb.insert(roleSlots).values({
				meetingId: s.meetingId,
				roleDefinitionId: def.id,
				status: "claimed",
				assignedMemberId: s.memberId,
			});
		},
		act: (s) =>
			updateMeeting({
				data: {
					meetingId: s.meetingId,
					selfMemberId: s.memberId,
					location: "Room 12",
				},
			}),
		read: async (s) => (await meetingRow(s))?.location ?? null,
	},
	{
		name: "updateWordOfTheDay (admin)",
		as: "admin",
		act: (s) =>
			updateWordOfTheDay({
				data: { meetingId: s.meetingId, wordOfTheDay: "Ephemeral" },
			}),
		read: async (s) => (await meetingRow(s))?.wordOfTheDay ?? null,
	},
	{
		name: "updateTableTopicsNotes (admin)",
		as: "admin",
		act: (s) =>
			updateTableTopicsNotes({
				data: { meetingId: s.meetingId, tableTopicsNotes: "Travel" },
			}),
		read: async (s) => (await meetingRow(s))?.tableTopicsNotes ?? null,
	},
	// Digital voting switch.
	{
		name: "setMeetingDigitalVoting (admin)",
		as: "admin",
		act: (s) =>
			setMeetingDigitalVoting({
				data: { meetingId: s.meetingId, disabled: true },
			}),
		read: async (s) => (await meetingRow(s))?.digitalVotingDisabled,
	},
	// Slot confirmation.
	{
		name: "confirmSlot (officer arm)",
		as: "admin",
		prepare: (s) => setSlot(s, "claimed"),
		act: (s) => confirmSlot({ data: { slotId: s.slotId } }),
		read: slotRow,
	},
	{
		// Already refused before #1085, one step later (`setPlanStatus`'s gate);
		// kept so the move ahead of the grant cannot lose it.
		name: "confirmSlot (holder arm)",
		as: "anonymous",
		prepare: (s) => setSlot(s, "claimed"),
		act: (s) =>
			confirmSlot({ data: { slotId: s.slotId, memberId: s.memberId } }),
		read: slotRow,
	},
	{
		name: "unconfirmSlot (admin)",
		as: "admin",
		prepare: (s) => setSlot(s, "confirmed"),
		act: (s) => unconfirmSlot({ data: { slotId: s.slotId } }),
		read: slotRow,
	},
	// Minutes and roll.
	{
		name: "setAttendance (admin)",
		as: "admin",
		act: (s) =>
			setAttendance({
				data: {
					meetingId: s.meetingId,
					memberId: s.memberId,
					status: "present",
				},
			}),
		read: attendanceRows,
	},
	{
		name: "addMinutesGuest (admin)",
		as: "admin",
		act: (s) =>
			addMinutesGuest({
				data: { meetingId: s.meetingId, newGuest: { name: "Walk-in" } },
			}),
		read: attendanceRows,
	},
	{
		name: "removeMinutesGuest (admin)",
		as: "admin",
		prepare: async (s) => {
			guestId = await seedPresentGuest(s);
		},
		act: (s) =>
			removeMinutesGuest({ data: { meetingId: s.meetingId, guestId } }),
		read: attendanceRows,
	},
	{
		name: "addTableTopics (admin)",
		as: "admin",
		act: (s) =>
			addTableTopics({
				data: { meetingId: s.meetingId, memberId: s.memberId },
			}),
		read: async (s) => (await topicsRows(s)).length,
	},
	{
		name: "removeTableTopics (admin)",
		as: "admin",
		prepare: (s) => seedTopics(s, 1),
		act: (s) =>
			removeTableTopics({
				data: { meetingId: s.meetingId, id: topicIds[0] as string },
			}),
		read: topicsRows,
	},
	{
		name: "moveTableTopics (admin)",
		as: "admin",
		prepare: (s) => seedTopics(s, 2),
		act: (s) =>
			moveTableTopics({
				data: {
					meetingId: s.meetingId,
					id: topicIds[1] as string,
					direction: "up",
				},
			}),
		read: async (s) => (await topicsRows(s)).map((r) => r.id),
	},
	{
		name: "setMinutesAward (admin)",
		as: "admin",
		act: (s) =>
			setMinutesAward({
				data: {
					meetingId: s.meetingId,
					category: "best_speaker",
					memberId: s.memberId,
				},
			}),
		read: awardRows,
	},
	{
		name: "clearMinutesAward (admin)",
		as: "admin",
		prepare: async (s) => {
			await testDb.insert(meetingAwards).values({
				meetingId: s.meetingId,
				category: "best_speaker",
				memberId: s.memberId,
			});
		},
		act: (s) =>
			clearMinutesAward({
				data: { meetingId: s.meetingId, category: "best_speaker" },
			}),
		read: awardRows,
	},
];

describe.skipIf(!hasTestDb)(
	"officer-only writes on a cancelled meeting (#1085)",
	() => {
		let seed: SeededClub;

		beforeEach(async () => {
			request = { headers: new Headers() };
			sessionUserId = null;
			topicIds = [];
			guestId = "";
			seed = await seedClub();
			// An hour ago: the day has arrived, so the roll's date rule passes and
			// the control half reaches every write. The status alone decides.
			await testDb
				.update(meetings)
				.set({ scheduledAt: new Date(Date.now() - 60 * 60 * 1000) })
				.where(eq(meetings.id, seed.meetingId));
		});

		afterEach(async () => {
			sessionUserId = null;
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		async function setStatus(status: "scheduled" | "cancelled") {
			await testDb
				.update(meetings)
				.set({ status })
				.where(eq(meetings.id, seed.meetingId));
		}

		function signIn(as: Case["as"]) {
			sessionUserId = as === "admin" ? seed.adminUserId : null;
		}

		describe.each(CASES)("$name", (c) => {
			it("is refused on the cancelled meeting, and writes nothing", async () => {
				await c.prepare?.(seed);
				await setStatus("cancelled");
				const before = await c.read(seed);
				signIn(c.as);
				await expect(attempt(() => c.act(seed))).rejects.toThrow(
					exact(MEETING_CANCELLED_MESSAGE),
				);
				expect(await c.read(seed)).toEqual(before);
			});

			it("the control: on the scheduled meeting the same write lands", async () => {
				await c.prepare?.(seed);
				const before = await c.read(seed);
				signIn(c.as);
				await attempt(() => c.act(seed));
				expect(await c.read(seed)).not.toEqual(before);
			});
		});

		describe("unconfirmSlot refuses a non-admin for who they are, not for the cancel", () => {
			// A cancelled meeting is hidden from members, so the cancellation must
			// not be what tells a caller outside the club (or a plain member) that
			// it exists and was cancelled. The role gate answers first.
			let outsiderId: string | null = null;

			afterEach(async () => {
				if (outsiderId)
					await testDb.delete(user).where(eq(user.id, outsiderId));
				outsiderId = null;
			});

			it("a signed-in user outside the club hears they are not a member", async () => {
				outsiderId = `outsider-${crypto.randomUUID()}`;
				await testDb.insert(user).values({
					id: outsiderId,
					name: "Outsider",
					email: `${outsiderId}@test.example`,
				});
				await setSlot(seed, "confirmed");
				await setStatus("cancelled");
				sessionUserId = outsiderId;
				await expect(
					attempt(() => unconfirmSlot({ data: { slotId: seed.slotId } })),
				).rejects.toThrow(exact(NOT_A_MEMBER_MESSAGE));
				expect(await slotRow(seed)).toEqual({ status: "confirmed" });
			});

			it("a plain member hears they lack permission", async () => {
				await setSlot(seed, "confirmed");
				await setStatus("cancelled");
				sessionUserId = seed.memberUserId;
				await expect(
					attempt(() => unconfirmSlot({ data: { slotId: seed.slotId } })),
				).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
				expect(await slotRow(seed)).toEqual({ status: "confirmed" });
			});
		});

		it("a completed meeting's roll is still writable (the lock is not the cancel)", async () => {
			// AC2: minutes are written up after the meeting, so the cancellation
			// refusal must not have been folded into the completed lock.
			await testDb
				.update(meetings)
				.set({ status: "completed" })
				.where(eq(meetings.id, seed.meetingId));
			signIn("admin");
			await setAttendance({
				data: {
					meetingId: seed.meetingId,
					memberId: seed.memberId,
					status: "present",
				},
			});
			const rows = await testDb
				.select({ status: meetingAttendance.status })
				.from(meetingAttendance)
				.where(
					and(
						eq(meetingAttendance.meetingId, seed.meetingId),
						eq(meetingAttendance.memberId, seed.memberId),
					),
				);
			expect(rows).toEqual([{ status: "present" }]);
		});
	},
);
