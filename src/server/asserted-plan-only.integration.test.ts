/**
 * DB-backed tests of the contract that the SESSIONLESS (asserted-proof) claim and
 * confirm read the member's PLAN only.
 *
 * The attendance roll is members-only. The plan answer (`not_coming`) is public:
 * the meeting payload's `answeredRungs` carries it. An asserted caller holds no
 * session, so what refuses them is the plan alone: the result of an asserted
 * claim or confirm is a function of the plan answer, for an open slot and for a
 * slot another member holds.
 *
 * Session and connector callers keep the roll-aware check (`isMemberUnavailable`):
 * a connector claim for an Absent member is refused, and a session claim is not
 * gated on the roll at all. The `claimSlot` server fn is driven with
 * `createServerFn` and the session mocked, signed out.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	meetingAttendance,
	meetingAttendancePlan,
	roleSlots,
} from "#/db/schema";
import { SIGN_IN_REQUIRED_MESSAGE, type WriteProof } from "#/lib/write-proof";
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

const request = { headers: new Headers() };
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => request,
}));
// Signed out: the asserted path is what is under test.
vi.mock("#/lib/auth", () => ({
	auth: { api: { getSession: async () => null } },
}));

const { claimSlot } = await import("#/server/slots");
const { claimSlotCore, confirmHeldClaimedSlots, confirmSlotCore } =
	await import("#/server/slots-logic");
const { isMemberNotComing, isMemberUnavailable } = await import(
	"#/server/attendance-plan-logic"
);

const CLAIMED_ELSEWHERE_MESSAGE =
	"Sorry — this role was just claimed by someone else.";
const CONNECTOR_NOT_COMING_MESSAGE =
	"You're marked as not coming to that meeting.";

type Roll = "none" | "absent" | "present";
const ROLLS: Roll[] = ["none", "absent", "present"];

describe.skipIf(!hasTestDb)(
	"asserted claim and confirm read the plan only",
	() => {
		let seed: SeededClub;
		const clubs: SeededClub[] = [];

		beforeEach(async () => {
			seed = await seedClub();
			clubs.push(seed);
		});

		afterEach(async () => {
			for (const s of clubs.splice(0)) {
				await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
			}
		});

		async function setPlan(
			memberId: string,
			status: "coming" | "not_coming" | "reached_out" | null,
		) {
			await testDb
				.delete(meetingAttendancePlan)
				.where(
					and(
						eq(meetingAttendancePlan.memberId, memberId),
						eq(meetingAttendancePlan.meetingId, seed.meetingId),
					),
				);
			if (status) {
				await testDb
					.insert(meetingAttendancePlan)
					.values({ memberId, meetingId: seed.meetingId, status });
			}
		}

		async function setRoll(memberId: string, roll: Roll) {
			await testDb
				.delete(meetingAttendance)
				.where(
					and(
						eq(meetingAttendance.memberId, memberId),
						eq(meetingAttendance.meetingId, seed.meetingId),
					),
				);
			if (roll !== "none") {
				await testDb
					.insert(meetingAttendance)
					.values({ memberId, meetingId: seed.meetingId, status: roll });
			}
		}

		async function plan(memberId: string) {
			const [row] = await testDb
				.select({ status: meetingAttendancePlan.status })
				.from(meetingAttendancePlan)
				.where(
					and(
						eq(meetingAttendancePlan.memberId, memberId),
						eq(meetingAttendancePlan.meetingId, seed.meetingId),
					),
				);
			return row?.status ?? null;
		}

		async function slot() {
			const [row] = await testDb
				.select({
					status: roleSlots.status,
					assignedMemberId: roleSlots.assignedMemberId,
				})
				.from(roleSlots)
				.where(eq(roleSlots.id, seed.slotId));
			return row;
		}

		async function giveSlotTo(memberId: string, status: "claimed" | "open") {
			await testDb
				.update(roleSlots)
				.set(
					status === "open"
						? { assignedMemberId: null, status: "open", claimedAt: null }
						: { assignedMemberId: memberId, status, claimedAt: new Date() },
				)
				.where(eq(roleSlots.id, seed.slotId));
		}

		/** What a signed-out caller is told when claiming the slot as `memberId`. */
		async function publicClaimAnswer(memberId: string): Promise<string> {
			try {
				await claimSlot({
					data: {
						slotId: seed.slotId,
						memberId,
						actorMemberId: memberId,
					},
				});
				return "claimed";
			} catch (e) {
				return (e as Error).message;
			}
		}

		function claim(memberId: string, actorMemberId: string, proof: WriteProof) {
			return testDb.transaction((tx) =>
				claimSlotCore(tx, {
					slotId: seed.slotId,
					memberId,
					actorMemberId,
					proof,
				}),
			);
		}

		function confirm(proof?: WriteProof) {
			return confirmSlotCore({
				slotId: seed.slotId,
				sessionUserId: null,
				selfMemberId: seed.memberId,
				proof,
			});
		}

		describe("a signed-out claim on a slot another member holds", () => {
			it("is answered from the plan alone, for every roll state (plan: coming)", async () => {
				// protects=an asserted claim on a held slot is a function of the plan answer; fails_when=the asserted path calls the roll-aware check; no_claim=a not_coming plan answer refuses by design, and is the third case
				await giveSlotTo(seed.adminMemberId, "claimed");
				await setPlan(seed.memberId, "coming");
				const answers: Record<Roll, string> = {
					none: "",
					absent: "",
					present: "",
				};
				for (const roll of ROLLS) {
					await setRoll(seed.memberId, roll);
					answers[roll] = await publicClaimAnswer(seed.memberId);
				}
				expect(answers).toEqual({
					none: CLAIMED_ELSEWHERE_MESSAGE,
					absent: CLAIMED_ELSEWHERE_MESSAGE,
					present: CLAIMED_ELSEWHERE_MESSAGE,
				});
				expect(await slot()).toMatchObject({
					assignedMemberId: seed.adminMemberId,
				});
			});

			it("is answered from the plan alone, for every roll state (no plan answer)", async () => {
				await giveSlotTo(seed.adminMemberId, "claimed");
				const answers: string[] = [];
				for (const roll of ROLLS) {
					await setRoll(seed.memberId, roll);
					answers.push(await publicClaimAnswer(seed.memberId));
				}
				expect(answers).toEqual(ROLLS.map(() => CLAIMED_ELSEWHERE_MESSAGE));
			});

			it("is answered from the plan alone, for every roll state (plan: not_coming)", async () => {
				// The plan is public (`answeredRungs`): a not_coming answer refuses, for every roll state.
				await giveSlotTo(seed.adminMemberId, "claimed");
				await setPlan(seed.memberId, "not_coming");
				const answers: string[] = [];
				for (const roll of ROLLS) {
					await setRoll(seed.memberId, roll);
					answers.push(await publicClaimAnswer(seed.memberId));
				}
				expect(answers).toEqual(ROLLS.map(() => SIGN_IN_REQUIRED_MESSAGE));
				expect(await slot()).toMatchObject({
					assignedMemberId: seed.adminMemberId,
				});
			});
		});

		describe("claiming an open slot", () => {
			it.each([
				"absent",
				"present",
			] as const)("an asserted self-claim by a member recorded %s, with no plan answer, is not refused by the roll", async (roll) => {
				// protects=an unverified claim is gated on the plan only; fails_when=the asserted path calls the roll-aware check; no_claim=who may claim for someone else is the TMOD rule, not under test here
				await setRoll(seed.memberId, roll);
				await claim(seed.memberId, seed.memberId, "asserted");
				expect(await slot()).toEqual({
					status: "claimed",
					assignedMemberId: seed.memberId,
				});
				expect(await plan(seed.memberId)).toBe("coming");
			});

			it("an asserted self-claim by a member recorded Absent, whose plan answer is coming, is not refused", async () => {
				await setPlan(seed.memberId, "coming");
				await setRoll(seed.memberId, "absent");
				await claim(seed.memberId, seed.memberId, "asserted");
				expect((await slot())?.assignedMemberId).toBe(seed.memberId);
			});

			it.each(
				ROLLS,
			)("an asserted claim over a not_coming plan answer is still refused, writing nothing (roll: %s)", async (roll) => {
				// protects=not_coming refuses an unverified claim for every roll state; fails_when=the plan check is dropped, or the roll can lift it; no_claim=none
				await setPlan(seed.memberId, "not_coming");
				await setRoll(seed.memberId, roll);
				await expect(
					claim(seed.memberId, seed.memberId, "asserted"),
				).rejects.toThrow(
					new RegExp(`^${SIGN_IN_REQUIRED_MESSAGE.replace(/\./g, "\\.")}$`),
				);
				expect(await slot()).toEqual({
					status: "open",
					assignedMemberId: null,
				});
				expect(await plan(seed.memberId)).toBe("not_coming");
			});

			it("a SESSION claim for a member recorded Absent still succeeds, as before", async () => {
				await setRoll(seed.memberId, "absent");
				await claim(seed.memberId, seed.adminMemberId, "session");
				expect((await slot())?.assignedMemberId).toBe(seed.memberId);
			});

			it("a CONNECTOR claim for a member recorded Absent is still refused: roll wins", async () => {
				// protects=session and connector callers keep the roll-aware check; fails_when=the connector arm moves to the plan-only check; no_claim=the MCP tools call isMemberUnavailable directly and have their own tests
				await setRoll(seed.memberId, "absent");
				await expect(
					claim(seed.memberId, seed.memberId, "connector"),
				).rejects.toThrow(CONNECTOR_NOT_COMING_MESSAGE);
				expect(await slot()).toEqual({
					status: "open",
					assignedMemberId: null,
				});
			});

			it("a CONNECTOR claim for a not_coming member recorded Present still succeeds: roll wins", async () => {
				await setPlan(seed.memberId, "not_coming");
				await setRoll(seed.memberId, "present");
				await claim(seed.memberId, seed.memberId, "connector");
				expect((await slot())?.assignedMemberId).toBe(seed.memberId);
			});
		});

		describe("confirming a held slot", () => {
			beforeEach(async () => {
				await giveSlotTo(seed.memberId, "claimed");
			});

			it.each(
				ROLLS,
			)("an asserted confirm with no plan answer is not refused by the roll (roll: %s)", async (roll) => {
				// protects=an unverified confirm is gated on the plan only; fails_when=the confirm path calls the roll-aware check; no_claim=who may confirm over a not_coming answer is the next case
				await setRoll(seed.memberId, roll);
				const result = await confirm("asserted");
				expect(result).toMatchObject({ ok: true, grantedVia: "self" });
				expect((await slot())?.status).toBe("confirmed");
				expect(await plan(seed.memberId)).toBe("coming");
			});

			it.each(
				ROLLS,
			)("an asserted confirm over a not_coming plan answer is refused with the one message (roll: %s)", async (roll) => {
				// protects=not_coming refuses an unverified confirm with one message for every roll state; fails_when=the plan check is dropped, or the roll can lift it; no_claim=none
				await setPlan(seed.memberId, "not_coming");
				await setRoll(seed.memberId, roll);
				await expect(confirm("asserted")).rejects.toThrow(
					new RegExp(`^${SIGN_IN_REQUIRED_MESSAGE.replace(/\./g, "\\.")}$`),
				);
				expect((await slot())?.status).toBe("claimed");
				expect(await plan(seed.memberId)).toBe("not_coming");
			});

			it("a confirm with no proof and no session is the asserted one, and reads the plan only", async () => {
				await setRoll(seed.memberId, "absent");
				await confirm();
				expect((await slot())?.status).toBe("confirmed");
			});

			it("a SESSION-proven holder confirming over their own not_coming still wins, as before", async () => {
				await setPlan(seed.memberId, "not_coming");
				await setRoll(seed.memberId, "absent");
				await confirm("session");
				expect((await slot())?.status).toBe("confirmed");
				expect(await plan(seed.memberId)).toBe("coming");
			});

			describe("confirmHeldClaimedSlots with the asserted proof", () => {
				function confirmHeld() {
					return confirmHeldClaimedSlots({
						memberId: seed.memberId,
						meetingId: seed.meetingId,
						proof: "asserted",
					});
				}

				it("returns one result for every roll state: it reads the plan only", async () => {
					// protects=the signed-out confirm-held path is a function of the plan answer; fails_when=it calls the roll-aware check; no_claim=the nudge page's wiring is pinned by attendance-plan-confirm-wiring.guard.test.ts
					const results: { confirmedRoles: string[] }[] = [];
					for (const roll of ROLLS) {
						await giveSlotTo(seed.memberId, "claimed");
						await setPlan(seed.memberId, null);
						await setRoll(seed.memberId, roll);
						results.push(await confirmHeld());
						expect((await slot())?.status).toBe("confirmed");
					}
					expect(results[0]?.confirmedRoles).toHaveLength(1);
					expect(results).toEqual(ROLLS.map(() => results[0]));
				});

				it.each(
					ROLLS,
				)("a not_coming plan answer refuses it with the one message, writing nothing (roll: %s)", async (roll) => {
					await setPlan(seed.memberId, "not_coming");
					await setRoll(seed.memberId, roll);
					await expect(confirmHeld()).rejects.toThrow(
						new RegExp(`^${SIGN_IN_REQUIRED_MESSAGE.replace(/\./g, "\\.")}$`),
					);
					expect((await slot())?.status).toBe("claimed");
					expect(await plan(seed.memberId)).toBe("not_coming");
				});
			});
		});

		describe("isMemberNotComing", () => {
			it("is true only for a not_coming plan answer, for every roll state", async () => {
				const answers: Record<string, boolean> = {};
				for (const planStatus of [
					null,
					"coming",
					"not_coming",
					"reached_out",
				] as const) {
					await setPlan(seed.memberId, planStatus);
					for (const roll of ROLLS) {
						await setRoll(seed.memberId, roll);
						answers[`${planStatus}/${roll}`] = await isMemberNotComing(testDb, {
							memberId: seed.memberId,
							meetingId: seed.meetingId,
						});
					}
				}
				expect(answers).toEqual({
					"null/none": false,
					"null/absent": false,
					"null/present": false,
					"coming/none": false,
					"coming/absent": false,
					"coming/present": false,
					"reached_out/none": false,
					"reached_out/absent": false,
					"reached_out/present": false,
					"not_coming/none": true,
					"not_coming/absent": true,
					"not_coming/present": true,
				});
			});

			it("is plan-only, where isMemberUnavailable is the roll-aware check", async () => {
				await setPlan(seed.memberId, "not_coming");
				await setRoll(seed.memberId, "present");
				const args = { memberId: seed.memberId, meetingId: seed.meetingId };
				expect(await isMemberNotComing(testDb, args)).toBe(true);
				expect(await isMemberUnavailable(testDb, args)).toBe(false);
				await setPlan(seed.memberId, "coming");
				await setRoll(seed.memberId, "absent");
				expect(await isMemberNotComing(testDb, args)).toBe(false);
				expect(await isMemberUnavailable(testDb, args)).toBe(true);
			});

			it("is scoped to the meeting's club: another club's member is never not_coming here", async () => {
				const other = await seedClub();
				clubs.push(other);
				await testDb.insert(meetingAttendancePlan).values({
					memberId: other.memberId,
					meetingId: seed.meetingId,
					status: "not_coming",
				});
				expect(
					await isMemberNotComing(testDb, {
						memberId: other.memberId,
						meetingId: seed.meetingId,
					}),
				).toBe(false);
			});
		});
	},
);
