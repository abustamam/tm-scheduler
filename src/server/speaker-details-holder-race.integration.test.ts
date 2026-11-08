/**
 * `updateSpeakerDetails` against a change of slot holder between its unlocked
 * read and its write (#1529).
 *
 * Runs the REAL handler with the fakes of `speaker-details-guest.integration.test.ts`.
 * The seam is `assertClubNotArchived`, wrapped here. It is reached from three
 * places: `write-actor-logic` (the session gate, which imports the real one and
 * never sees this mock), the handler's own pre-transaction call (one argument,
 * after its unlocked slot read) and its in-transaction call (two arguments,
 * after the locks). The hook runs on the one-argument call whose stack is in
 * `slots.ts`, i.e. the handler's own, so it changes state in exactly the window
 * between the unlocked read and the transaction. Each test asserts its hook
 * fired.
 */
import { and, eq, or } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	guests,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => ({
		validator: (parse: (input: unknown) => unknown) => ({
			handler:
				(handle: (input: { data: unknown }) => unknown) =>
				({ data }: { data: unknown }) =>
					handle({ data: parse(data) }),
		}),
	}),
}));

let sessionUserId: string | null = null;
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

// Runs once, on the handler's own pre-transaction archive check (see header).
let betweenReadAndWrite: (() => Promise<void>) | null = null;
let hookFired = false;
vi.mock("./guards", async (importOriginal) => {
	const real = await importOriginal<typeof import("./guards")>();
	return {
		...real,
		assertClubNotArchived: async (
			...args: Parameters<typeof real.assertClubNotArchived>
		) => {
			await real.assertClubNotArchived(...args);
			if (
				args.length === 1 &&
				betweenReadAndWrite &&
				new Error().stack?.includes("/src/server/slots.ts")
			) {
				const hook = betweenReadAndWrite;
				betweenReadAndWrite = null;
				hookFired = true;
				await hook();
			}
		},
	};
});

const { CLUB_ARCHIVED_MESSAGE } = await import("#/lib/club-archive");
const { updateSpeakerDetails } = await import("./slots");

describe.skipIf(!hasTestDb)("updateSpeakerDetails holder race (#1529)", () => {
	let seed: SeededClub;
	let slotId: string;
	let guestId: string;
	let defId: string;

	beforeEach(async () => {
		request = { headers: new Headers() };
		betweenReadAndWrite = null;
		hookFired = false;
		seed = await seedClub();
		const [def] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name: "Speaker",
				category: "speaker",
				isSpeakerRole: true,
			})
			.returning({ id: roleDefinitions.id });
		if (!def) throw new Error("Failed to seed the speaker role");
		defId = def.id;
		const { createGuestRecord } = await import("./guests-logic");
		guestId = (
			await createGuestRecord(testDb, { clubId: seed.clubId, name: "Guest A" })
		).id;
		const [slot] = await testDb
			.insert(roleSlots)
			.values({
				meetingId: seed.meetingId,
				roleDefinitionId: def.id,
				status: "claimed",
				assignedGuestId: guestId,
			})
			.returning({ id: roleSlots.id });
		if (!slot) throw new Error("Failed to seed the speaker slot");
		slotId = slot.id;
		sessionUserId = seed.memberUserId;
	});

	afterEach(async () => {
		sessionUserId = null;
		betweenReadAndWrite = null;
		await testDb.delete(speeches).where(eq(speeches.guestId, guestId));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	const slotRow = async () => {
		const [row] = await testDb
			.select({
				speechId: roleSlots.speechId,
				memberId: roleSlots.assignedMemberId,
				guestId: roleSlots.assignedGuestId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		return row;
	};

	it("a guest slot handed to a member mid-save: the speech belongs to the member", async () => {
		const [member] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, seed.memberId));
		betweenReadAndWrite = async () => {
			await testDb
				.update(roleSlots)
				.set({ assignedGuestId: null, assignedMemberId: seed.memberId })
				.where(eq(roleSlots.id, slotId));
		};
		await updateSpeakerDetails({
			data: { slotId, speakerDetails: { speechTitle: "Raced" } },
		});
		expect(hookFired).toBe(true);
		const row = await slotRow();
		expect(row?.memberId).toBe(seed.memberId);
		const [speech] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, row?.speechId as string));
		expect(speech?.personId).toBe(member?.personId);
		expect(speech?.guestId).toBeNull();
	});

	it("a slot released mid-save is refused and creates no speech", async () => {
		betweenReadAndWrite = async () => {
			await testDb
				.update(roleSlots)
				.set({ assignedGuestId: null, status: "open" })
				.where(eq(roleSlots.id, slotId));
		};
		await expect(
			updateSpeakerDetails({
				data: { slotId, speakerDetails: { speechTitle: "Orphan" } },
			}),
		).rejects.toThrow(/^Assign a member before adding speech details\.$/);
		expect((await slotRow())?.speechId).toBeNull();
		expect(hookFired).toBe(true);
		const [member] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, seed.memberId));
		expect(
			await testDb
				.select()
				.from(speeches)
				.where(
					and(
						eq(speeches.title, "Orphan"),
						or(
							eq(speeches.guestId, guestId),
							eq(speeches.personId, member?.personId as string),
						),
					),
				),
		).toHaveLength(0);
		expect(
			await testDb.select().from(guests).where(eq(guests.id, guestId)),
		).toHaveLength(1);
	});

	it("a reassign that also clears speech_id mid-save: the old holder's speech is untouched", async () => {
		const [member] = await testDb
			.select({ personId: members.personId })
			.from(members)
			.where(eq(members.id, seed.memberId));
		const [aSpeech] = await testDb
			.insert(speeches)
			.values({ guestId, title: "A's speech" })
			.returning({ id: speeches.id });
		if (!aSpeech) throw new Error("Failed to seed the speech");
		await testDb
			.update(roleSlots)
			.set({ speechId: aSpeech.id })
			.where(eq(roleSlots.id, slotId));
		betweenReadAndWrite = async () => {
			await testDb
				.update(roleSlots)
				.set({
					assignedGuestId: null,
					assignedMemberId: seed.memberId,
					speechId: null,
				})
				.where(eq(roleSlots.id, slotId));
		};
		await updateSpeakerDetails({
			data: { slotId, speakerDetails: { speechTitle: "For B" } },
		});
		expect(hookFired).toBe(true);
		const [untouched] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, aSpeech.id));
		expect(untouched?.title).toBe("A's speech");
		expect(untouched?.guestId).toBe(guestId);
		const row = await slotRow();
		expect(row?.speechId).not.toBe(aSpeech.id);
		const [saved] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, row?.speechId as string));
		expect(saved?.title).toBe("For B");
		expect(saved?.personId).toBe(member?.personId);
		expect(saved?.guestId).toBeNull();
		// The log's "before" is the slot as the transaction found it (no speech),
		// not the speech the unlocked read saw.
		const [entry] = await testDb
			.select({ detail: activityLog.detail })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.clubId, seed.clubId),
					eq(activityLog.targetId, seed.meetingId),
				),
			);
		expect(
			(entry?.detail as { before: { title: string | null } }).before.title,
		).toBeNull();
	});

	it("a club archived mid-save is refused inside the transaction and writes no speech", async () => {
		betweenReadAndWrite = async () => {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
		};
		await expect(
			updateSpeakerDetails({
				data: { slotId, speakerDetails: { speechTitle: "Archived" } },
			}),
		).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
		expect(hookFired).toBe(true);
		expect((await slotRow())?.speechId).toBeNull();
		expect(
			await testDb
				.select()
				.from(speeches)
				.where(
					and(eq(speeches.title, "Archived"), eq(speeches.guestId, guestId)),
				),
		).toHaveLength(0);
	});

	it("a meeting cancelled mid-save is refused with the lifecycle's message and writes no speech", async () => {
		let expected = "";
		try {
			assertMeetingAccepts("cancelled", "plan");
		} catch (e) {
			expected = (e as Error).message;
		}
		expect(expected).not.toBe("");
		betweenReadAndWrite = async () => {
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seed.meetingId));
		};
		await expect(
			updateSpeakerDetails({
				data: { slotId, speakerDetails: { speechTitle: "Cancelled" } },
			}),
		).rejects.toThrow(expected);
		expect(hookFired).toBe(true);
		expect((await slotRow())?.speechId).toBeNull();
		expect(
			await testDb
				.select()
				.from(speeches)
				.where(
					and(eq(speeches.title, "Cancelled"), eq(speeches.guestId, guestId)),
				),
		).toHaveLength(0);
	});

	it("a role turned non-speaker mid-save is refused and writes no speech", async () => {
		betweenReadAndWrite = async () => {
			await testDb
				.update(roleDefinitions)
				.set({ isSpeakerRole: false })
				.where(eq(roleDefinitions.id, defId));
		};
		await expect(
			updateSpeakerDetails({
				data: { slotId, speakerDetails: { speechTitle: "NotSpeaker" } },
			}),
		).rejects.toThrow(/^Only speaker roles have speech details\.$/);
		expect(hookFired).toBe(true);
		expect((await slotRow())?.speechId).toBeNull();
		expect(
			await testDb
				.select()
				.from(speeches)
				.where(
					and(eq(speeches.title, "NotSpeaker"), eq(speeches.guestId, guestId)),
				),
		).toHaveLength(0);
	});
});
