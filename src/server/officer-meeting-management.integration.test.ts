/**
 * DB-backed tests that an elected officer (an active `member` holding an open
 * `officer_terms` row — effective admin, #202) can use every control the meeting
 * page shows once `canManageClub` admits them (#1383): edit meeting details and
 * the Word of the Day, reschedule, add / remove / move a speaker slot, and edit
 * minutes (`getMinutes` `canEdit`).
 *
 * Each case goes through the REAL server fn and its guard, with
 * `createServerFn` and the session mocked, so it is `resolveAdminGrant` that
 * decides, not a hand-built grant. An officer whose term has ended, and a plain
 * member, are refused on the same paths.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetings,
	officerTerms,
	roleDefinitions,
	roleSlots,
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
		handler:
			(handle: (input: { data: unknown }) => unknown) =>
			({ data }: { data: unknown }) =>
				handle({ data }),
	}),
}));

let sessionUserId: string | null = null;
const request = { headers: new Headers() };
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

const { updateMeeting, updateWordOfTheDay } = await import("#/server/meetings");
const { addSpeakerSlot, removeSpeakerSlot, moveSpeakerSlot } = await import(
	"#/server/slots"
);
const { getMinutes } = await import("#/server/minutes");

async function seedSpeakerRoles(clubId: string) {
	const [spk] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: "Speaker",
			category: "speaker",
			defaultCount: 3,
			sortOrder: 10,
			isSpeakerRole: true,
		})
		.returning({ id: roleDefinitions.id });
	const [ev] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: "Evaluator",
			category: "evaluator",
			defaultCount: 3,
			sortOrder: 11,
			isSpeakerRole: false,
		})
		.returning({ id: roleDefinitions.id });
	return { speakerRoleId: spk.id, evaluatorRoleId: ev.id };
}

describe.skipIf(!hasTestDb)(
	"an elected officer manages the meeting page's controls (#1383)",
	() => {
		let club: SeededClub;
		let speakerRoleId: string;

		beforeEach(async () => {
			club = await seedClub();
			({ speakerRoleId } = await seedSpeakerRoles(club.clubId));
			// The seeded `member` row holds an open term and stays `club_role = member`.
			await testDb
				.insert(officerTerms)
				.values({ membershipId: club.memberId, position: "secretary" });
		});
		afterEach(async () => {
			sessionUserId = null;
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		const asOfficer = () => {
			sessionUserId = club.memberUserId;
		};
		const endTerm = () =>
			testDb
				.update(officerTerms)
				.set({ termEnd: new Date() })
				.where(eq(officerTerms.membershipId, club.memberId));
		const speakerSlots = () =>
			testDb
				.select({ id: roleSlots.id, slotIndex: roleSlots.slotIndex })
				.from(roleSlots)
				.where(
					and(
						eq(roleSlots.meetingId, club.meetingId),
						eq(roleSlots.roleDefinitionId, speakerRoleId),
					),
				)
				.orderBy(roleSlots.slotIndex);

		it("edits meeting details and the Word of the Day", async () => {
			asOfficer();
			await updateMeeting({
				data: { meetingId: club.meetingId, theme: "Officer theme" },
			});
			await updateWordOfTheDay({
				data: { meetingId: club.meetingId, wordOfTheDay: "verve" },
			});
			const [row] = await testDb
				.select({ theme: meetings.theme, word: meetings.wordOfTheDay })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			expect(row).toEqual({ theme: "Officer theme", word: "verve" });
		});

		it("reschedules the meeting (the admin arm, not a TMOD self-assert)", async () => {
			asOfficer();
			await updateMeeting({
				data: { meetingId: club.meetingId, scheduledAt: "2027-03-01T18:30" },
			});
			const [row] = await testDb
				.select({ at: meetings.scheduledAt })
				.from(meetings)
				.where(eq(meetings.id, club.meetingId));
			expect(row.at.getUTCFullYear()).toBe(2027);
		});

		it("adds, moves and removes a speaker slot", async () => {
			asOfficer();
			await addSpeakerSlot({ data: { meetingId: club.meetingId } });
			await addSpeakerSlot({ data: { meetingId: club.meetingId } });
			const added = await speakerSlots();
			expect(added).toHaveLength(2);
			await moveSpeakerSlot({
				data: { slotId: added[1].id, direction: "up" },
			});
			const moved = await speakerSlots();
			expect(moved[0].id).toBe(added[1].id);
			await removeSpeakerSlot({ data: { meetingId: club.meetingId } });
			expect(await speakerSlots()).toHaveLength(1);
		});

		it("getMinutes reports canEdit for the officer, even before the meeting completes", async () => {
			asOfficer();
			const result = await getMinutes({ data: club.meetingId });
			expect(result.visible).toBe(true);
			expect(result.canEdit).toBe(true);
		});

		describe("refused", () => {
			const refusals = async () => {
				const calls = [
					() =>
						updateMeeting({
							data: { meetingId: club.meetingId, theme: "nope" },
						}),
					() =>
						updateMeeting({
							data: {
								meetingId: club.meetingId,
								scheduledAt: "2027-04-01T18:30",
							},
						}),
					() =>
						updateWordOfTheDay({
							data: { meetingId: club.meetingId, wordOfTheDay: "nope" },
						}),
					() => addSpeakerSlot({ data: { meetingId: club.meetingId } }),
					() => removeSpeakerSlot({ data: { meetingId: club.meetingId } }),
				];
				for (const call of calls) {
					await expect(call()).rejects.toThrow();
				}
				expect(await speakerSlots()).toHaveLength(0);
				const [row] = await testDb
					.select({ theme: meetings.theme, word: meetings.wordOfTheDay })
					.from(meetings)
					.where(eq(meetings.id, club.meetingId));
				expect(row.theme).not.toBe("nope");
				expect(row.word).not.toBe("nope");
				const minutes = await getMinutes({ data: club.meetingId });
				expect(minutes.canEdit).toBe(false);
			};

			it("an officer whose term has ended", async () => {
				// protects=an ended officer term grants no agenda write; fails_when=resolveAdminGrant treats any officer_terms row as open; no_claim=none
				await endTerm();
				asOfficer();
				await refusals();
			});

			it("a plain member with no officer term", async () => {
				await testDb
					.delete(officerTerms)
					.where(eq(officerTerms.membershipId, club.memberId));
				asOfficer();
				await refusals();
			});
		});
	},
);
