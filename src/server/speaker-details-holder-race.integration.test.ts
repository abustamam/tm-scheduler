/**
 * `updateSpeakerDetails` against a change of slot holder between its unlocked
 * read and its write (#1529).
 *
 * Runs the REAL handler with the fakes of `speaker-details-guest.integration.test.ts`.
 * The seam is `assertClubNotArchived`, wrapped here: it is the first call after
 * the handler's unlocked slot read and before its transaction opens, so a hook
 * run on its first call changes the holder in exactly that window.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
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

// Runs once, on the first archive check after the unlocked read.
let betweenReadAndWrite: (() => Promise<void>) | null = null;
vi.mock("./guards", async (importOriginal) => {
	const real = await importOriginal<typeof import("./guards")>();
	return {
		...real,
		assertClubNotArchived: async (
			...args: Parameters<typeof real.assertClubNotArchived>
		) => {
			const hook = betweenReadAndWrite;
			betweenReadAndWrite = null;
			await real.assertClubNotArchived(...args);
			if (hook) await hook();
		},
	};
});

const { updateSpeakerDetails } = await import("./slots");

describe.skipIf(!hasTestDb)("updateSpeakerDetails holder race (#1529)", () => {
	let seed: SeededClub;
	let slotId: string;
	let guestId: string;

	beforeEach(async () => {
		request = { headers: new Headers() };
		betweenReadAndWrite = null;
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
		expect(
			await testDb.select().from(speeches).where(eq(speeches.title, "Orphan")),
		).toHaveLength(0);
		expect(
			await testDb.select().from(guests).where(eq(guests.id, guestId)),
		).toHaveLength(1);
	});
});
