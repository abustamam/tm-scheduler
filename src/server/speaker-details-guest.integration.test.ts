/**
 * `updateSpeakerDetails` on a speaker slot held by a guest (#1518).
 *
 * Runs the REAL `createServerFn` handler with the same two fakes as
 * `speaker-details-cancelled.integration.test.ts` (the minimal adapter and the
 * cookie -> session lookup). The owner choice lives in the handler, so a test
 * of `editSlotSpeech` alone could delete the guest arm and stay green.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meetings, roleDefinitions, roleSlots, speeches } from "#/db/schema";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
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

const { updateSpeakerDetails } = await import("./slots");

const exact = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

describe.skipIf(!hasTestDb)("updateSpeakerDetails for a guest (#1518)", () => {
	let seed: SeededClub;
	let slotId: string;
	let guestId: string;

	beforeEach(async () => {
		request = { headers: new Headers() };
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
		await testDb.delete(speeches).where(eq(speeches.guestId, guestId));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function slotRow() {
		const [row] = await testDb
			.select({
				speechId: roleSlots.speechId,
				memberId: roleSlots.assignedMemberId,
				guestId: roleSlots.assignedGuestId,
			})
			.from(roleSlots)
			.where(eq(roleSlots.id, slotId));
		return row;
	}

	it("saves, creating a speech owned by the guest", async () => {
		await updateSpeakerDetails({
			data: { slotId, speakerDetails: { speechTitle: "Guest talk" } },
		});
		const row = await slotRow();
		expect(row?.speechId).toBeTruthy();
		const [speech] = await testDb
			.select()
			.from(speeches)
			.where(eq(speeches.id, row?.speechId as string));
		expect(speech?.title).toBe("Guest talk");
		expect(speech?.guestId).toBe(guestId);
		expect(speech?.personId).toBeNull();
	});

	it("an empty slot is refused with the unchanged message", async () => {
		await testDb
			.update(roleSlots)
			.set({ assignedGuestId: null, status: "open" })
			.where(eq(roleSlots.id, slotId));
		await expect(
			updateSpeakerDetails({
				data: { slotId, speakerDetails: { speechTitle: "Nobody's" } },
			}),
		).rejects.toThrow(exact("Assign a member before adding speech details."));
		const row = await slotRow();
		expect(row?.speechId).toBeNull();
		expect(row?.memberId).toBeNull();
		expect(row?.guestId).toBeNull();
	});

	it("a guest-held slot in a cancelled meeting is still refused", async () => {
		await testDb
			.update(meetings)
			.set({ status: "cancelled" })
			.where(eq(meetings.id, seed.meetingId));
		await expect(
			updateSpeakerDetails({
				data: { slotId, speakerDetails: { speechTitle: "Late" } },
			}),
		).rejects.toThrow(exact(MEETING_CANCELLED_MESSAGE));
		expect((await slotRow())?.speechId).toBeNull();
	});
});
