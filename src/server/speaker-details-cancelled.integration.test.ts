/**
 * `updateSpeakerDetails` on a cancelled meeting (#1057, review of #1084 D).
 *
 * Any signed-in member of the club may edit a speaker slot's speech (the sheet
 * rule), and a blank input UNLINKS the speech (`editSlotSpeech`). On a
 * cancelled meeting that is the one change a restore cannot bring back, on a
 * page that is read-only, so the holder could not put it right either.
 *
 * Executes the REAL `createServerFn` handler, with the two boundaries
 * `release-and-speaker-details.integration.test.ts` fakes and nothing else:
 * `createServerFn` (the minimal adapter, so `updateSpeakerDetails({ data })`
 * runs validator + handler) and the cookie → session lookup. The refusal lives
 * in the handler, beside the lock check, so a test of `editSlotSpeech` alone
 * could delete it and stay green.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
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

const { updateSpeakerDetails } = await import("./slots");

/** Exact-string matcher, so a case cannot pass on an unrelated throw. */
const exact = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

describe.skipIf(!hasTestDb)(
	"updateSpeakerDetails on a cancelled meeting (#1057)",
	() => {
		let seed: SeededClub;
		let speakerSlotId: string;
		let speechId: string;

		beforeEach(async () => {
			request = { headers: new Headers() };
			seed = await seedClub();
			// A speaker slot held by the ADMIN with a speech attached; the
			// signed-in MEMBER edits it, which the sheet rule allows.
			const [def] = await testDb
				.insert(roleDefinitions)
				.values({
					clubId: seed.clubId,
					name: "Speaker",
					category: "speaker",
					isSpeakerRole: true,
				})
				.returning({ id: roleDefinitions.id });
			const [admin] = await testDb
				.select({ personId: members.personId })
				.from(members)
				.where(eq(members.id, seed.adminMemberId));
			if (!def || !admin) throw new Error("Failed to seed the speaker role");
			const [speech] = await testDb
				.insert(speeches)
				.values({ personId: admin.personId, title: "Original Title" })
				.returning({ id: speeches.id });
			if (!speech) throw new Error("Failed to seed the speech");
			speechId = speech.id;
			const [slot] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: seed.meetingId,
					roleDefinitionId: def.id,
					status: "claimed",
					assignedMemberId: seed.adminMemberId,
					speechId,
				})
				.returning({ id: roleSlots.id });
			if (!slot) throw new Error("Failed to seed the speaker slot");
			speakerSlotId = slot.id;
			sessionUserId = seed.memberUserId;
		});

		afterEach(async () => {
			sessionUserId = null;
			// Speeches are Person-owned and not in the club cascade.
			await testDb.delete(speeches).where(eq(speeches.id, speechId));
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		});

		async function cancel() {
			await testDb
				.update(meetings)
				.set({ status: "cancelled" })
				.where(eq(meetings.id, seed.meetingId));
		}

		async function slotSpeechId() {
			const [row] = await testDb
				.select({ speechId: roleSlots.speechId })
				.from(roleSlots)
				.where(eq(roleSlots.id, speakerSlotId));
			return row?.speechId;
		}

		async function speechTitle() {
			const [row] = await testDb
				.select({ title: speeches.title })
				.from(speeches)
				.where(eq(speeches.id, speechId));
			return row?.title;
		}

		async function speakerDetailRows() {
			return testDb
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "meeting_edit"),
					),
				);
		}

		it("a blank input is refused, and the speech stays linked", async () => {
			await cancel();
			await expect(
				updateSpeakerDetails({
					data: { slotId: speakerSlotId, speakerDetails: {} },
				}),
			).rejects.toThrow(exact(MEETING_CANCELLED_MESSAGE));
			expect(await slotSpeechId()).toBe(speechId);
			expect(await speakerDetailRows()).toHaveLength(0);
		});

		it("a rewrite is refused, and the speech is unchanged", async () => {
			await cancel();
			await expect(
				updateSpeakerDetails({
					data: {
						slotId: speakerSlotId,
						speakerDetails: { speechTitle: "Rewritten" },
					},
				}),
			).rejects.toThrow(exact(MEETING_CANCELLED_MESSAGE));
			expect(await speechTitle()).toBe("Original Title");
			expect(await slotSpeechId()).toBe(speechId);
		});

		it("the control: on the scheduled meeting the same blank input unlinks it", async () => {
			// Without this, the two cases above pass on a harness that never
			// reaches the write at all.
			await updateSpeakerDetails({
				data: { slotId: speakerSlotId, speakerDetails: {} },
			});
			expect(await slotSpeechId()).toBeNull();
			expect(await speakerDetailRows()).toHaveLength(1);
		});
	},
);
