/**
 * The slot writers refuse a frozen meeting by WRITE CLASS (#1135, part of #1129).
 *
 * Before, each slot writer named the status it knew: `assertMeetingNotLocked`
 * (completed) in one place, `meetingNotCancelled` (cancelled) in another, and
 * several writers had only the first, so a cancelled meeting's lineup could still
 * be edited through them. They now ask the policy (`MEETING_WRITE_POLICY`, class
 * `plan`), which refuses both, and this file holds four things:
 *
 * 1. The GAINS. Each writer that did not refuse a cancelled meeting under its
 *    own meeting lock now does, with the cancelled sentence, and writes nothing.
 *    The scheduled meeting is the control: same preparation, the write lands.
 * 2. The STATEMENT. The claim, reassign, release and guest-assignment writes carry
 *    the class in their own WHERE (`meetingAcceptsWrite`), so a status that
 *    committed after the early check is still refused. The early check is switched
 *    off through a seam (it is the only thing a serial test can reach first), and
 *    the statement alone must still refuse BOTH statuses with the right sentence.
 * 3. The OVERRIDES. Where a writer deliberately accepts a status its class
 *    refuses, the order of its refusals is observable, and each case here would
 *    change sentence if the `accept` option were dropped.
 * 4. The `record` writer: `attachSpeechToOpenSlot` accepts a completed meeting.
 *
 * ## The seams, and why they are the only fakes
 *
 * - `assertMeetingAccepts` can be told to skip its next call(s). A completed or
 *   cancelled meeting is refused by it before any statement runs, so without the
 *   seam the statement's own refusal is unreachable serially, and deleting it
 *   leaves every serial case green.
 * - `setPlanStatus` can be told to skip its cancelled gate. `releaseSlots…` frees
 *   the roles and then writes `not_coming`; on a cancelled meeting that second
 *   write refuses with the SAME sentence and rolls the release back, which would
 *   hide whether the release itself accepted the meeting.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	guests,
	meetingAttendancePlan,
	meetings,
	members,
	roleDefinitions,
	roleSlots,
	speeches,
} from "#/db/schema";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { MEETING_LOCKED_MESSAGE } from "#/lib/meeting-lifecycle";
import { SIGN_IN_REQUIRED_MESSAGE } from "#/lib/write-proof";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));
// The minimal adapter `speaker-details-cancelled.integration.test.ts` uses, so
// the availability handlers below run validator + handler for real.
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

const seam = vi.hoisted(() => ({
	/** Calls to `assertMeetingAccepts` to let through before the real one runs. */
	skipAccepts: 0,
	/** Make `setPlanStatus` a no-op, so its own cancelled gate cannot answer. */
	skipPlanWrite: false,
}));

vi.mock("#/lib/meeting-lifecycle", async (orig) => {
	const real = await orig<typeof import("#/lib/meeting-lifecycle")>();
	return {
		...real,
		assertMeetingAccepts: (
			...args: Parameters<typeof real.assertMeetingAccepts>
		) => {
			if (seam.skipAccepts > 0) {
				seam.skipAccepts -= 1;
				return;
			}
			real.assertMeetingAccepts(...args);
		},
	};
});

vi.mock("./attendance-plan-logic", async (orig) => {
	const real = await orig<typeof import("./attendance-plan-logic")>();
	return {
		...real,
		setPlanStatus: (...args: Parameters<typeof real.setPlanStatus>) =>
			seam.skipPlanWrite
				? Promise.resolve({ ok: true as const, changed: true })
				: real.setPlanStatus(...args),
	};
});

// `releaseSlotsAndMarkUnavailable` resolves its actor from the SESSION
// (`resolveActor`, ADR-0026), so the cookie → session lookup is faked at the
// library boundary, exactly as `decline-release-cancelled.integration.test.ts`
// does, and nothing else is.
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
	applyAddRoleSlot,
	applyAddSpeakerSlot,
	applyMoveEvaluatorSlot,
	applyMoveSpeakerSlot,
	applyRemoveRoleSlot,
	applyRemoveSpeakerSlot,
	applyTemplateSyncToUpcomingMeetings,
	claimSlotCore,
	confirmHeldClaimedSlots,
	reassignSlotCore,
	releaseSlotCore,
	syncSlotsForRoleEnabledChange,
} = await import("./slots-logic");
const { applyAssignGuestToSlot } = await import("./guests-logic");
const { attachSpeechToOpenSlot } = await import("./speeches-logic");
const { releaseSlotsAndMarkUnavailable } = await import("./availability-logic");
const { clearAvailability, markUnavailableReleasing, setAvailability } =
	await import("./availability");
const { unconfirmSlot } = await import("./slots");
const { NO_PERMISSION_MESSAGE } = await import("./guards");

type Frozen = "cancelled" | "completed";
const FROZEN: readonly Frozen[] = ["cancelled", "completed"];
const SENTENCE: Record<Frozen, string> = {
	cancelled: MEETING_CANCELLED_MESSAGE,
	completed: MEETING_LOCKED_MESSAGE,
};

/** Exact-string matcher, so a case cannot pass on an unrelated throw. */
const exact = (message: string) =>
	new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

async function setStatus(meetingId: string, status: Frozen | "scheduled") {
	await testDb
		.update(meetings)
		.set({ status })
		.where(eq(meetings.id, meetingId));
}

/** Every column a slot writer can change, for one meeting, in a stable order. */
async function lineup(meetingId: string) {
	const rows = await testDb
		.select({
			id: roleSlots.id,
			roleDefinitionId: roleSlots.roleDefinitionId,
			slotIndex: roleSlots.slotIndex,
			status: roleSlots.status,
			assignedMemberId: roleSlots.assignedMemberId,
			assignedGuestId: roleSlots.assignedGuestId,
			evaluatesSlotId: roleSlots.evaluatesSlotId,
			speechId: roleSlots.speechId,
		})
		.from(roleSlots)
		.where(eq(roleSlots.meetingId, meetingId));
	return rows.sort((a, b) => a.id.localeCompare(b.id));
}

async function addRole(
	clubId: string,
	o: {
		name: string;
		category?: "speaker" | "evaluator" | "functionary";
		sortOrder: number;
		isSpeakerRole?: boolean;
		defaultCount?: number;
	},
): Promise<string> {
	const [row] = await testDb
		.insert(roleDefinitions)
		.values({
			clubId,
			name: o.name,
			category: o.category ?? "functionary",
			defaultCount: o.defaultCount ?? 1,
			sortOrder: o.sortOrder,
			isSpeakerRole: o.isSpeakerRole ?? false,
		})
		.returning({ id: roleDefinitions.id });
	if (!row) throw new Error("Failed to insert a role definition");
	return row.id;
}

describe.skipIf(!hasTestDb)(
	"slot writers refuse by write class (#1135)",
	() => {
		let club: SeededClub;
		let speakerRoleId: string;
		let evaluatorRoleId: string;

		beforeEach(async () => {
			seam.skipAccepts = 0;
			seam.skipPlanWrite = false;
			sessionUserId = null;
			request = { headers: new Headers() };
			club = await seedClub();
			speakerRoleId = await addRole(club.clubId, {
				name: "Speaker",
				category: "speaker",
				sortOrder: 10,
				isSpeakerRole: true,
				defaultCount: 3,
			});
			evaluatorRoleId = await addRole(club.clubId, {
				name: "Evaluator",
				category: "evaluator",
				sortOrder: 11,
				defaultCount: 3,
			});
		});

		afterEach(async () => {
			seam.skipAccepts = 0;
			seam.skipPlanWrite = false;
			sessionUserId = null;
			await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
		});

		// ------------------------------------------------------------------------
		// 1. The gains: refused under the meeting lock, by class.
		// ------------------------------------------------------------------------
		//
		// `realignEvaluatorPairs` has no status of its own to read: it is refused by
		// its three callers (add speaker, remove speaker, move), each of which now
		// refuses by class under the meeting lock. The "lineup unchanged" assertion
		// below is what shows the realign did not run.
		describe("the plan writers that gained a refusal of a cancelled meeting", () => {
			let extraRoleId: string;
			beforeEach(async () => {
				extraRoleId = await addRole(club.clubId, {
					name: "Vote Counter",
					sortOrder: 20,
				});
				// Two speaker/evaluator pairs, made while the meeting is still live.
				for (let i = 0; i < 2; i += 1) {
					await applyAddSpeakerSlot({
						meetingId: club.meetingId,
						actorMemberId: club.adminMemberId,
					});
				}
			});

			async function slotAt(roleId: string, slotIndex: number) {
				const row = (await lineup(club.meetingId)).find(
					(s) => s.roleDefinitionId === roleId && s.slotIndex === slotIndex,
				);
				if (!row) throw new Error("slot not found");
				return row.id;
			}

			const writers: {
				name: string;
				act: (self: { slotOf: typeof slotAt }) => Promise<unknown>;
			}[] = [
				{
					name: "applyAddSpeakerSlot",
					act: () =>
						applyAddSpeakerSlot({
							meetingId: club.meetingId,
							actorMemberId: club.adminMemberId,
						}),
				},
				{
					name: "applyAddRoleSlot",
					act: () =>
						applyAddRoleSlot({
							meetingId: club.meetingId,
							roleDefinitionId: extraRoleId,
							actorMemberId: club.adminMemberId,
						}),
				},
				{
					name: "applyRemoveRoleSlot",
					act: () =>
						applyRemoveRoleSlot({
							slotId: club.slotId,
							actorMemberId: club.adminMemberId,
						}),
				},
				{
					name: "applyRemoveSpeakerSlot",
					act: () =>
						applyRemoveSpeakerSlot({
							meetingId: club.meetingId,
							actorMemberId: club.adminMemberId,
						}),
				},
				{
					name: "applyMoveSpeakerSlot",
					act: async ({ slotOf }) =>
						applyMoveSpeakerSlot({
							slotId: await slotOf(speakerRoleId, 0),
							direction: "down",
							actorMemberId: club.adminMemberId,
						}),
				},
				{
					name: "applyMoveEvaluatorSlot",
					act: async ({ slotOf }) =>
						applyMoveEvaluatorSlot({
							slotId: await slotOf(evaluatorRoleId, 0),
							direction: "down",
							actorMemberId: club.adminMemberId,
						}),
				},
			];

			describe.each(writers)("$name", ({ act }) => {
				it("the control: a scheduled meeting accepts it and the lineup changes", async () => {
					const before = await lineup(club.meetingId);
					await act({ slotOf: slotAt });
					expect(await lineup(club.meetingId)).not.toEqual(before);
				});

				it.each(
					FROZEN,
				)("a %s meeting refuses it with that status's sentence and writes nothing", async (status) => {
					await setStatus(club.meetingId, status);
					const before = await lineup(club.meetingId);
					await expect(act({ slotOf: slotAt })).rejects.toThrow(
						exact(SENTENCE[status]),
					);
					expect(await lineup(club.meetingId)).toEqual(before);
				});
			});
		});

		// ------------------------------------------------------------------------
		// 2. The statement refuses on its own, both statuses.
		// ------------------------------------------------------------------------
		describe("the write's own WHERE refuses a frozen meeting (early check skipped)", () => {
			// An OFFICER claiming FOR the member, not the member claiming for
			// themselves: a self-claim also writes the `coming` answer, and
			// `setPlanStatus` refuses a cancelled meeting with the same sentence and
			// rolls the claim back, which would make the statement's own refusal of a
			// cancelled meeting look redundant. Deleting it must turn this red.
			const claim = (slotId: string, memberId: string) =>
				testDb.transaction((tx) =>
					claimSlotCore(tx, {
						slotId,
						memberId,
						actorMemberId: club.adminMemberId,
					}),
				);

			it.each(FROZEN)("claimSlotCore on a %s meeting", async (status) => {
				await setStatus(club.meetingId, status);
				const before = await lineup(club.meetingId);
				seam.skipAccepts = 1; // the early check; the post-statement read stays real
				await expect(claim(club.slotId, club.memberId)).rejects.toThrow(
					exact(SENTENCE[status]),
				);
				expect(seam.skipAccepts).toBe(0); // the seam was consumed by the early check
				expect(await lineup(club.meetingId)).toEqual(before);
			});

			it.each(FROZEN)("reassignSlotCore on a %s meeting", async (status) => {
				await setStatus(club.meetingId, status);
				const before = await lineup(club.meetingId);
				seam.skipAccepts = 1;
				await expect(
					testDb.transaction((tx) =>
						reassignSlotCore(tx, {
							slotId: club.slotId,
							memberId: club.memberId,
							actorMemberId: club.adminMemberId,
						}),
					),
				).rejects.toThrow(exact(SENTENCE[status]));
				expect(seam.skipAccepts).toBe(0);
				expect(await lineup(club.meetingId)).toEqual(before);
			});

			it.each(FROZEN)("releaseSlotCore on a %s meeting", async (status) => {
				await testDb
					.update(roleSlots)
					.set({ status: "claimed", assignedMemberId: club.memberId })
					.where(eq(roleSlots.id, club.slotId));
				await setStatus(club.meetingId, status);
				const before = await lineup(club.meetingId);
				seam.skipAccepts = 1;
				await expect(
					testDb.transaction((tx) =>
						releaseSlotCore(tx, {
							slotId: club.slotId,
							actorMemberId: club.adminMemberId,
						}),
					),
				).rejects.toThrow(exact(SENTENCE[status]));
				expect(seam.skipAccepts).toBe(0);
				expect(await lineup(club.meetingId)).toEqual(before);
			});

			it.each(
				FROZEN,
			)("applyAssignGuestToSlot on a %s meeting", async (status) => {
				await setStatus(club.meetingId, status);
				const before = await lineup(club.meetingId);
				seam.skipAccepts = 1;
				await expect(
					applyAssignGuestToSlot({
						slotId: club.slotId,
						newGuest: { name: "Visitor" },
						actorMemberId: club.adminMemberId,
					}),
				).rejects.toThrow(exact(SENTENCE[status]));
				expect(seam.skipAccepts).toBe(0);
				expect(await lineup(club.meetingId)).toEqual(before);
				// The guest the assignment created rolled back with it.
				expect(
					await testDb
						.select({ id: guests.id })
						.from(guests)
						.where(eq(guests.clubId, club.clubId)),
				).toEqual([]);
			});

			// The throw after the re-read is reachable only when the meeting accepts
			// the class again by the time the statement's refusal is explained (a
			// restore or a reopen in between). It says what these two writes said
			// before they were written through the policy.
			it.each([
				["reassignSlotCore", "reassign"],
				["releaseSlotCore", "release"],
			] as const)("%s keeps its cancelled sentence when the re-read finds the meeting accepting again", async (_name, which) => {
				await testDb
					.update(roleSlots)
					.set({ status: "claimed", assignedMemberId: club.memberId })
					.where(eq(roleSlots.id, club.slotId));
				await setStatus(club.meetingId, "cancelled");
				seam.skipAccepts = 2; // the early check AND the post-statement read
				const run =
					which === "reassign"
						? testDb.transaction((tx) =>
								reassignSlotCore(tx, {
									slotId: club.slotId,
									memberId: club.adminMemberId,
									actorMemberId: club.adminMemberId,
								}),
							)
						: testDb.transaction((tx) =>
								releaseSlotCore(tx, {
									slotId: club.slotId,
									actorMemberId: club.adminMemberId,
								}),
							);
				await expect(run).rejects.toThrow(exact(MEETING_CANCELLED_MESSAGE));
			});

			it("a claim that simply lost the race to another claim still says so", async () => {
				await testDb
					.update(roleSlots)
					.set({ status: "claimed", assignedMemberId: club.adminMemberId })
					.where(eq(roleSlots.id, club.slotId));
				await expect(claim(club.slotId, club.memberId)).rejects.toThrow(
					"Sorry — this role was just claimed by someone else.",
				);
			});
		});

		// ------------------------------------------------------------------------
		// 3. The overrides: the order each refusal has always had.
		// ------------------------------------------------------------------------
		describe("the early check accepts cancelled where a later check owns that refusal", () => {
			it("claimSlotCore: an asserted caller who fails the TMOD gate hears that, not the cancellation", async () => {
				await setStatus(club.meetingId, "cancelled");
				await expect(
					testDb.transaction((tx) =>
						claimSlotCore(tx, {
							slotId: club.slotId,
							memberId: club.memberId,
							// Someone else, and not the meeting's Toastmaster.
							actorMemberId: club.adminMemberId,
							proof: "asserted",
						}),
					),
				).rejects.toThrow(exact(SIGN_IN_REQUIRED_MESSAGE));
			});

			it("claimSlotCore: the same caller on a completed meeting hears the lock, before that gate", async () => {
				await setStatus(club.meetingId, "completed");
				await expect(
					testDb.transaction((tx) =>
						claimSlotCore(tx, {
							slotId: club.slotId,
							memberId: club.memberId,
							actorMemberId: club.adminMemberId,
							proof: "asserted",
						}),
					),
				).rejects.toThrow(exact(MEETING_LOCKED_MESSAGE));
			});

			it("applyAssignGuestToSlot: a request that fails guest validation hears that on a cancelled meeting", async () => {
				await setStatus(club.meetingId, "cancelled");
				await expect(
					applyAssignGuestToSlot({
						slotId: club.slotId,
						newGuest: { name: "   " },
						actorMemberId: club.adminMemberId,
					}),
				).rejects.toThrow(exact("A guest name is required."));
			});

			it("applyAssignGuestToSlot: the same request on a completed meeting hears the lock first", async () => {
				await setStatus(club.meetingId, "completed");
				await expect(
					applyAssignGuestToSlot({
						slotId: club.slotId,
						newGuest: { name: "   " },
						actorMemberId: club.adminMemberId,
					}),
				).rejects.toThrow(exact(MEETING_LOCKED_MESSAGE));
			});
		});

		// ------------------------------------------------------------------------
		// confirmHeldClaimedSlots: refuses up front, by class.
		// ------------------------------------------------------------------------
		describe("confirmHeldClaimedSlots", () => {
			const confirmHeld = () =>
				confirmHeldClaimedSlots({
					memberId: club.memberId,
					meetingId: club.meetingId,
					proof: "session",
				});

			it("the control: a member holding nothing on a scheduled meeting confirms nothing", async () => {
				expect(await confirmHeld()).toEqual({ confirmedRoles: [] });
			});

			it.each(
				FROZEN,
			)("refuses a member holding nothing on a %s meeting, rather than succeeding vacuously", async (status) => {
				await setStatus(club.meetingId, status);
				await expect(confirmHeld()).rejects.toThrow(exact(SENTENCE[status]));
			});
		});

		// ------------------------------------------------------------------------
		// backfillMissingRoleSlots: its two callers, two policies.
		// ------------------------------------------------------------------------
		describe("backfillMissingRoleSlots", () => {
			let missingRoleId: string;
			beforeEach(async () => {
				// A standard role the meeting has none of, so a sync has something to add.
				missingRoleId = await addRole(club.clubId, {
					name: "Grammarian",
					sortOrder: 30,
				});
			});
			const slotsOfMissing = async () =>
				(await lineup(club.meetingId)).filter(
					(s) => s.roleDefinitionId === missingRoleId,
				);
			const sync = () =>
				applyTemplateSyncToUpcomingMeetings({
					clubId: club.clubId,
					actorMemberId: club.adminMemberId,
				});
			const enable = () =>
				syncSlotsForRoleEnabledChange({
					clubId: club.clubId,
					roleDefinitionId: missingRoleId,
					roleName: "Grammarian",
					defaultCount: 1,
					enabled: true,
					standing: true,
					actorMemberId: club.adminMemberId,
				});

			it("the control: both add the missing slot to a scheduled meeting", async () => {
				expect(await sync()).toMatchObject({ meetingsChanged: 1 });
				expect(await slotsOfMissing()).toHaveLength(1);
			});

			it("template_sync deliberately covers a cancelled meeting (its `plan` accepts cancelled)", async () => {
				await setStatus(club.meetingId, "cancelled");
				expect(await sync()).toMatchObject({ meetingsChanged: 1 });
				expect(await slotsOfMissing()).toHaveLength(1);
			});

			it("the role-enable path does not: a cancelled meeting is not a candidate", async () => {
				await setStatus(club.meetingId, "cancelled");
				expect(await enable()).toMatchObject({ meetingsChanged: 0 });
				expect(await slotsOfMissing()).toHaveLength(0);
			});

			it.each([
				["template_sync", sync],
				["role_enabled", enable],
			] as const)("%s refuses a completed meeting loudly and writes nothing", async (_label, run) => {
				await setStatus(club.meetingId, "completed");
				await expect(run()).rejects.toThrow(exact(MEETING_LOCKED_MESSAGE));
				expect(await slotsOfMissing()).toHaveLength(0);
			});
		});

		// ------------------------------------------------------------------------
		// 4. The record writer.
		// ------------------------------------------------------------------------
		describe("attachSpeechToOpenSlot (class record)", () => {
			let speechId: string;
			let speakerSlotId: string;

			beforeEach(async () => {
				const [member] = await testDb
					.select({ personId: members.personId })
					.from(members)
					.where(eq(members.id, club.memberId));
				if (!member) throw new Error("seeded member missing");
				const [speech] = await testDb
					.insert(speeches)
					.values({ personId: member.personId, title: "Ice Breaker" })
					.returning({ id: speeches.id });
				if (!speech) throw new Error("Failed to seed the speech");
				speechId = speech.id;
				const [slot] = await testDb
					.insert(roleSlots)
					.values({
						meetingId: club.meetingId,
						roleDefinitionId: speakerRoleId,
						slotIndex: 0,
					})
					.returning({ id: roleSlots.id });
				if (!slot) throw new Error("Failed to seed the speaker slot");
				speakerSlotId = slot.id;
			});

			afterEach(async () => {
				// Speeches are Person-owned, so the club's cleanup does not take them.
				await testDb
					.update(roleSlots)
					.set({ speechId: null })
					.where(eq(roleSlots.id, speakerSlotId));
				await testDb.delete(speeches).where(eq(speeches.id, speechId));
			});

			// The admin acts for the member, so no plan row is written for either.
			const attach = () =>
				attachSpeechToOpenSlot(testDb, {
					speechId,
					slotId: speakerSlotId,
					actorMemberId: club.adminMemberId,
				});
			const slotRow = async () =>
				(await lineup(club.meetingId)).find((s) => s.id === speakerSlotId);

			it.each([
				"scheduled",
				"completed",
			] as const)("accepts a %s meeting: the speech lands and the slot is the speaker's", async (status) => {
				await setStatus(club.meetingId, status);
				await expect(attach()).resolves.toMatchObject({
					assignedMemberId: club.memberId,
				});
				expect(await slotRow()).toMatchObject({
					status: "claimed",
					assignedMemberId: club.memberId,
					speechId,
				});
			});

			it("refuses a cancelled meeting with the sentence it has always said, and writes nothing", async () => {
				await setStatus(club.meetingId, "cancelled");
				const before = await lineup(club.meetingId);
				// `That`, not `MEETING_CANCELLED_MESSAGE`'s `This`.
				await expect(attach()).rejects.toThrow(
					exact("That meeting is cancelled."),
				);
				expect(await lineup(club.meetingId)).toEqual(before);
			});
		});

		// ------------------------------------------------------------------------
		// unconfirmSlot: the lock answers before the role gate, the cancel after it.
		// ------------------------------------------------------------------------
		//
		// Two class calls, because the two statuses have always been refused in
		// two places: a completed meeting says locked to ANY caller, a cancelled one
		// is hidden from members, so a caller who lacks the role hears that first
		// (`cancelled-meeting-officer-writes.integration.test.ts` holds that half).
		describe("unconfirmSlot, as a plain member", () => {
			beforeEach(async () => {
				await testDb
					.update(roleSlots)
					.set({ status: "confirmed", assignedMemberId: club.memberId })
					.where(eq(roleSlots.id, club.slotId));
				sessionUserId = club.memberUserId;
			});
			const unconfirm = () =>
				Promise.resolve().then(() =>
					unconfirmSlot({ data: { slotId: club.slotId } }),
				);

			it("a scheduled meeting reaches the role gate", async () => {
				await expect(unconfirm()).rejects.toThrow(exact(NO_PERMISSION_MESSAGE));
			});

			it("a completed meeting is refused first, with the lock sentence", async () => {
				await setStatus(club.meetingId, "completed");
				await expect(unconfirm()).rejects.toThrow(
					exact(MEETING_LOCKED_MESSAGE),
				);
			});
		});

		// ------------------------------------------------------------------------
		// The availability handlers: the order each status has always been refused in.
		// ------------------------------------------------------------------------
		//
		// Each opens with the lock check, BEFORE it looks at the subject, so a caller
		// naming a member who is not on the roster hears about a completed meeting
		// first. A cancelled meeting is refused LATER (the plan seam, or the release
		// seam), so the same caller still hears about the roster: the handler's
		// `plan` call accepts `cancelled` for exactly that order. A subject who is
		// not on the roster is the cheapest way to tell the two apart without a
		// session or an actor ladder in the way.
		describe.each([
			["setAvailability", setAvailability],
			["clearAvailability", clearAvailability],
			["markUnavailableReleasing", markUnavailableReleasing],
		] as const)("%s", (_name, handler) => {
			const call = () =>
				Promise.resolve().then(() =>
					handler({
						data: {
							memberId: crypto.randomUUID(), // on no roster
							meetingId: club.meetingId,
							clubId: club.clubId,
						},
					}),
				);

			it.each([
				"scheduled",
				"cancelled",
			] as const)("a %s meeting reaches the subject check", async (status) => {
				await setStatus(club.meetingId, status);
				await expect(call()).rejects.toThrow(
					exact("Member not found in this club."),
				);
			});

			it("a completed meeting is refused first, with the lock sentence", async () => {
				await setStatus(club.meetingId, "completed");
				await expect(call()).rejects.toThrow(exact(MEETING_LOCKED_MESSAGE));
			});
		});

		// ------------------------------------------------------------------------
		// releaseSlotsAndMarkUnavailable: class `plan`, refused by the writer itself.
		// ------------------------------------------------------------------------
		describe("releaseSlotsAndMarkUnavailable (class plan)", () => {
			let heldSlotId: string;

			beforeEach(async () => {
				const [slot] = await testDb
					.insert(roleSlots)
					.values({
						meetingId: club.meetingId,
						roleDefinitionId: speakerRoleId,
						slotIndex: 0,
						status: "claimed",
						assignedMemberId: club.memberId,
					})
					.returning({ id: roleSlots.id });
				if (!slot) throw new Error("Failed to seed the held slot");
				heldSlotId = slot.id;
				// The member declines for themselves, from their own session.
				sessionUserId = club.memberUserId;
			});

			const release = (meetingId = club.meetingId) =>
				releaseSlotsAndMarkUnavailable(testDb, {
					memberId: club.memberId,
					meetingId,
					clubId: club.clubId,
				});
			const heldSlot = async () =>
				(await lineup(club.meetingId)).find((s) => s.id === heldSlotId);
			const planRows = () =>
				testDb
					.select({ status: meetingAttendancePlan.status })
					.from(meetingAttendancePlan)
					.where(
						and(
							eq(meetingAttendancePlan.meetingId, club.meetingId),
							eq(meetingAttendancePlan.memberId, club.memberId),
						),
					);

			it("the control: a scheduled meeting's role is released and the answer recorded", async () => {
				expect(await release()).toEqual({ released: 1 });
				expect(await heldSlot()).toMatchObject({
					status: "open",
					assignedMemberId: null,
				});
				expect(await planRows()).toEqual([{ status: "not_coming" }]);
			});

			// The plan write is switched off in the next two cases, so that ONLY this
			// writer can answer. With it on, `setPlanStatus` refuses the same
			// statuses with the same sentences and rolls the release back, which would
			// leave these green with the writer's own check deleted. (A cancelled
			// meeting has always been refused that way end to end:
			// `decline-release-cancelled.integration.test.ts`.)
			it.each(
				FROZEN,
			)("refuses a %s meeting ITSELF, with that sentence, before anything is released", async (status) => {
				await setStatus(club.meetingId, status);
				seam.skipPlanWrite = true;
				await expect(release()).rejects.toThrow(exact(SENTENCE[status]));
				expect(await heldSlot()).toMatchObject({
					status: "claimed",
					assignedMemberId: club.memberId,
				});
				expect(await planRows()).toEqual([]);
			});

			it("refuses a meeting that does not exist", async () => {
				await expect(release(crypto.randomUUID())).rejects.toThrow(
					exact("Meeting not found."),
				);
			});
		});
	},
);
