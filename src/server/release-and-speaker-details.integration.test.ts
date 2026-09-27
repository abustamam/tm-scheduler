/**
 * The three slot writes that take something away from a member — releasing,
 * reassigning and editing speech details — need a session bound to a member of
 * the club (#763, ADR-0026). An unverified "Who are you?" pick may fill a
 * blank; these are not blanks.
 *
 * Unlike most suites here, this one executes the REAL `createServerFn`
 * handlers: the session gate lives in the handler (it is request-scoped, and
 * `assign_roles` reaches the same cores from a bearer token), so a test of the
 * cores alone could delete the gate and stay green. Two boundaries are faked
 * and nothing else:
 *
 *  - `createServerFn`, with the minimal adapter `slots.transport.test.ts`
 *    introduced, so `releaseSlot({ data })` runs validator + handler;
 *  - the cookie → session lookup (`getRequest` + `auth.api.getSession`), the
 *    same library-boundary mock `availability.integration.test.ts` uses, so
 *    `getSessionUser`, `requireSessionActor` and the membership lookups all
 *    run for real against the seeded rows.
 *
 * Every case reads back its own club's rows only (vitest runs files in
 * parallel against one database).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubs,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
	user,
} from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";
import {
	NOT_ON_ROSTER_MESSAGE,
	SIGN_IN_REQUIRED_MESSAGE,
} from "#/lib/write-proof";
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
/** One stable object, because the impersonation marker is keyed on identity. */
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

const { claimSlot, reassignSlot, releaseSlot, updateSpeakerDetails } =
	await import("./slots");

/** Exact-string matcher, so a case cannot pass on an unrelated throw. */
const exact = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

describe.skipIf(!hasTestDb)(
	"release / reassign / speech details need a session (#763)",
	() => {
		let seed: SeededClub;
		/** A signed-in user with NO membership in this club. */
		let outsiderUserId: string;
		/** The speaker slot, held by the ADMIN member with a speech attached. */
		let speakerSlotId: string;
		let speechId: string;

		beforeEach(async () => {
			sessionUserId = null;
			seed = await seedClub();
			outsiderUserId = randomUUID();
			await testDb.insert(user).values({
				id: outsiderUserId,
				name: "Outsider",
				email: `outsider-${outsiderUserId}@test.example`,
				emailVerified: true,
			});

			// The Timer slot, held by the admin — so the SIGNED-IN member below
			// acts on a slot held by somebody else, the case the sheet rule is for.
			await testDb
				.update(roleSlots)
				.set({
					assignedMemberId: seed.adminMemberId,
					status: "confirmed",
					claimedAt: new Date(),
				})
				.where(eq(roleSlots.id, seed.slotId));

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
		});

		afterEach(async () => {
			sessionUserId = null;
			// Speeches are Person-owned and not in the club cascade.
			await testDb.delete(speeches).where(eq(speeches.id, speechId));
			await cleanup(seed.clubId, [
				seed.adminUserId,
				seed.memberUserId,
				outsiderUserId,
			]);
		});

		async function slotRow(slotId: string) {
			const [row] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
					speechId: roleSlots.speechId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, slotId));
			return row;
		}

		async function speechTitle() {
			const [row] = await testDb
				.select({ title: speeches.title })
				.from(speeches)
				.where(eq(speeches.id, speechId));
			return row?.title;
		}

		async function logRows(
			action: "release" | "reassign" | "claim" | "meeting_edit",
		) {
			return testDb
				.select({
					actorMemberId: activityLog.actorMemberId,
					detail: activityLog.detail,
				})
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, action),
					),
				);
		}

		const editInput = () => ({
			slotId: speakerSlotId,
			speakerDetails: { speechTitle: "Rewritten" },
		});

		// -----------------------------------------------------------------------
		// No session: refused, whatever member id is asserted, nothing written.
		// -----------------------------------------------------------------------

		describe("with no session", () => {
			// The holder's own id and a bystander's: neither is a credential.
			const asserted = () => [seed.adminMemberId, seed.memberId];

			it("releaseSlot refuses and leaves the slot held", async () => {
				for (const actorMemberId of asserted()) {
					await expect(
						releaseSlot({ data: { slotId: seed.slotId, actorMemberId } }),
					).rejects.toThrow(exact(SIGN_IN_REQUIRED_MESSAGE));
				}
				expect(await slotRow(seed.slotId)).toMatchObject({
					status: "confirmed",
					assignedMemberId: seed.adminMemberId,
				});
				expect(await logRows("release")).toHaveLength(0);
			});

			it("reassignSlot refuses and leaves the slot with its holder", async () => {
				for (const actorMemberId of asserted()) {
					await expect(
						reassignSlot({
							data: {
								slotId: seed.slotId,
								memberId: seed.memberId,
								actorMemberId,
							},
						}),
					).rejects.toThrow(exact(SIGN_IN_REQUIRED_MESSAGE));
				}
				expect(await slotRow(seed.slotId)).toMatchObject({
					status: "confirmed",
					assignedMemberId: seed.adminMemberId,
				});
				expect(await logRows("reassign")).toHaveLength(0);
			});

			it("updateSpeakerDetails refuses and leaves the speech as it was", async () => {
				for (const actorMemberId of asserted()) {
					await expect(
						updateSpeakerDetails({ data: { ...editInput(), actorMemberId } }),
					).rejects.toThrow(exact(SIGN_IN_REQUIRED_MESSAGE));
				}
				expect(await speechTitle()).toBe("Original Title");
				expect((await slotRow(speakerSlotId))?.speechId).toBe(speechId);
				expect(await logRows("meeting_edit")).toHaveLength(0);
			});
		});

		// -----------------------------------------------------------------------
		// A signed-in member of the club: the sheet rule, on SOMEONE ELSE's slot.
		// -----------------------------------------------------------------------

		describe("signed in as a member of the club", () => {
			beforeEach(() => {
				sessionUserId = seed.memberUserId;
			});

			it("releases a slot another member holds, logged once as the session", async () => {
				await releaseSlot({ data: { slotId: seed.slotId } });

				expect(await slotRow(seed.slotId)).toMatchObject({
					status: "open",
					assignedMemberId: null,
				});
				const rows = await logRows("release");
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({
					actorMemberId: seed.memberId,
					detail: { fromMemberId: seed.adminMemberId, proof: "session" },
				});
			});

			it("credits the session, not an asserted actor an old client still sends", async () => {
				await releaseSlot({
					data: { slotId: seed.slotId, actorMemberId: seed.adminMemberId },
				});
				const [row] = await logRows("release");
				expect(row?.actorMemberId).toBe(seed.memberId);
			});

			it("reassigns a slot another member holds, logged once as the session", async () => {
				await reassignSlot({
					data: { slotId: seed.slotId, memberId: seed.memberId },
				});

				expect(await slotRow(seed.slotId)).toMatchObject({
					status: "claimed",
					assignedMemberId: seed.memberId,
				});
				const rows = await logRows("reassign");
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({
					actorMemberId: seed.memberId,
					detail: {
						fromMemberId: seed.adminMemberId,
						memberId: seed.memberId,
						proof: "session",
					},
				});
			});

			it("edits another member's speech details, logged with before and after", async () => {
				await updateSpeakerDetails({ data: editInput() });

				expect(await speechTitle()).toBe("Rewritten");
				const rows = await logRows("meeting_edit");
				expect(rows).toHaveLength(1);
				expect(rows[0]).toEqual({
					actorMemberId: seed.memberId,
					detail: {
						change: "speaker_details",
						slotId: speakerSlotId,
						speechId,
						before: { title: "Original Title", projectId: null },
						after: { title: "Rewritten", projectId: null },
						proof: "session",
					},
				});
			});

			it("logs an unlink as a change to no speech at all", async () => {
				// Blank input unlinks the speech (it persists, Person-owned), so the
				// after-state is the SLOT's, not the speech we started with.
				await updateSpeakerDetails({
					data: { slotId: speakerSlotId, speakerDetails: {} },
				});

				expect((await slotRow(speakerSlotId))?.speechId).toBeNull();
				const [row] = await logRows("meeting_edit");
				expect(row?.detail).toMatchObject({
					before: { title: "Original Title", projectId: null },
					after: { title: null, projectId: null },
				});
			});

			it("reassignSlot still refuses a target who is not on this roster", async () => {
				await expect(
					reassignSlot({
						data: { slotId: seed.slotId, memberId: randomUUID() },
					}),
				).rejects.toThrow();
				expect((await slotRow(seed.slotId))?.assignedMemberId).toBe(
					seed.adminMemberId,
				);
			});

			it("an archived club refuses all three, before any write", async () => {
				await testDb
					.update(clubs)
					.set({ archivedAt: new Date() })
					.where(eq(clubs.id, seed.clubId));

				await expect(
					releaseSlot({ data: { slotId: seed.slotId } }),
				).rejects.toThrow(exact(CLUB_ARCHIVED_MESSAGE));
				await expect(
					reassignSlot({
						data: { slotId: seed.slotId, memberId: seed.memberId },
					}),
				).rejects.toThrow(exact(CLUB_ARCHIVED_MESSAGE));
				await expect(
					updateSpeakerDetails({ data: editInput() }),
				).rejects.toThrow(exact(CLUB_ARCHIVED_MESSAGE));
				expect((await slotRow(seed.slotId))?.assignedMemberId).toBe(
					seed.adminMemberId,
				);
				expect(await speechTitle()).toBe("Original Title");
			});
		});

		// -----------------------------------------------------------------------
		// A session that is not on this roster: signing in again cannot help.
		// -----------------------------------------------------------------------

		describe("signed in with no membership in the club", () => {
			beforeEach(() => {
				sessionUserId = outsiderUserId;
			});

			it("releaseSlot refuses with the roster message", async () => {
				await expect(
					releaseSlot({
						data: { slotId: seed.slotId, actorMemberId: seed.memberId },
					}),
				).rejects.toThrow(exact(NOT_ON_ROSTER_MESSAGE));
				expect((await slotRow(seed.slotId))?.status).toBe("confirmed");
			});

			it("reassignSlot refuses with the roster message", async () => {
				await expect(
					reassignSlot({
						data: {
							slotId: seed.slotId,
							memberId: seed.memberId,
							actorMemberId: seed.memberId,
						},
					}),
				).rejects.toThrow(exact(NOT_ON_ROSTER_MESSAGE));
				expect((await slotRow(seed.slotId))?.assignedMemberId).toBe(
					seed.adminMemberId,
				);
			});

			it("updateSpeakerDetails refuses with the roster message", async () => {
				await expect(
					updateSpeakerDetails({
						data: { ...editInput(), actorMemberId: seed.memberId },
					}),
				).rejects.toThrow(exact(NOT_ON_ROSTER_MESSAGE));
				expect(await speechTitle()).toBe("Original Title");
			});
		});

		// -----------------------------------------------------------------------
		// The claim reports its proof, which is what the season grid reads.
		// -----------------------------------------------------------------------

		describe("claimSlot reports how the claimer was established", () => {
			beforeEach(async () => {
				await testDb
					.update(roleSlots)
					.set({ assignedMemberId: null, status: "open", claimedAt: null })
					.where(eq(roleSlots.id, seed.slotId));
			});

			it("asserted, for a name-pick with no session", async () => {
				const result = await claimSlot({
					data: {
						slotId: seed.slotId,
						memberId: seed.memberId,
						actorMemberId: seed.memberId,
					},
				});
				expect(result).toEqual({ ok: true, proof: "asserted" });
				const [row] = await logRows("claim");
				expect(row?.detail).toMatchObject({ proof: "asserted" });
			});

			it("session, for the member's own session", async () => {
				sessionUserId = seed.memberUserId;
				const result = await claimSlot({
					data: {
						slotId: seed.slotId,
						memberId: seed.memberId,
						actorMemberId: seed.memberId,
					},
				});
				expect(result).toEqual({ ok: true, proof: "session" });
			});
		});
	},
);
