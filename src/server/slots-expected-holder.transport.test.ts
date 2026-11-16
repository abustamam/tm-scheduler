/**
 * Handler routing of the three role writes' `expectedHolder` (#1638), run
 * through the same minimal Start adapter as `slots.transport.test.ts`, with the
 * logic layer mocked.
 *
 * protects=the handler-level branches of claimSlot / releaseSlot / reassignSlot:
 *   `expectedHolder` present (null INCLUDED) goes to `applyRoleOpExpectingHolder`
 *   and never to the plain core; absent goes to the plain core unchanged; a
 *   missing slot answers `slot-gone` only when `expectedHolder` is present and
 *   throws "Role not found." when it is absent; the session actor is resolved
 *   before the comparison runs;
 * fails_when=routing tests truthiness instead of `!== undefined` (a queued
 *   claim's `expectedHolder: null` then takes the plain core), the missing-slot
 *   arm answers for an absent `expectedHolder`, or the comparison runs before
 *   the actor is resolved;
 * no_claim=the comparison itself (the integration suite), and the handler's
 *   behaviour with a real transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const SLOT_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const RESOLVED_ACTOR = "55555555-5555-4555-8555-555555555555";
const HOLDER = `m:${"66666666-6666-4666-8666-666666666666"}`;
const TX = { __tx: true };

const { preRead } = vi.hoisted(() => ({
	preRead: { rows: [] as unknown[] },
}));

vi.mock("#/db", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["select", "from", "innerJoin", "where"]) {
		chain[m] = () => chain;
	}
	chain.limit = async () => preRead.rows;
	return {
		db: {
			select: () => chain,
			transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(TX)),
		},
	};
});
vi.mock("./activity", () => ({ logActivity: vi.fn() }));
vi.mock("./guards", () => ({
	assertClubNotArchived: vi.fn(),
	getSessionUser: vi.fn(),
	requireClubRole: vi.fn(),
	requireMeetingAgendaEditor: vi.fn(),
	requireMemberInClub: vi.fn(async () => undefined),
	requireUser: vi.fn(),
}));
vi.mock("./meeting-authz-logic", () => ({ assertMeetingNotLocked: vi.fn() }));
vi.mock("./write-actor-logic", () => ({
	requestWriteActorWithProof: vi.fn(async () => ({
		memberId: RESOLVED_ACTOR,
		proof: "asserted",
	})),
	requireSessionActor: vi.fn(async () => ({ memberId: RESOLVED_ACTOR })),
}));
vi.mock("./slots-logic", () => ({
	applyAddRoleSlot: vi.fn(),
	applyAddSpeakerSlot: vi.fn(),
	applyMoveEvaluatorSlot: vi.fn(),
	applyMoveSpeakerSlot: vi.fn(),
	applyRemoveRoleSlot: vi.fn(),
	applyRemoveSpeakerSlot: vi.fn(),
	applyRoleOpExpectingHolder: vi.fn(async () => ({ ok: true })),
	claimSlotCore: vi.fn(async () => ({ clubId: CLUB_ID })),
	confirmSlotCore: vi.fn(),
	editSlotSpeech: vi.fn(),
	reassignSlotCore: vi.fn(async () => ({ clubId: CLUB_ID })),
	releaseSlotCore: vi.fn(async () => ({ clubId: CLUB_ID })),
}));

import { claimSlot, reassignSlot, releaseSlot } from "./slots";
import * as logic from "./slots-logic";
import { requireSessionActor } from "./write-actor-logic";

beforeEach(() => {
	vi.clearAllMocks();
	preRead.rows = [{ clubId: CLUB_ID }];
});

type Call = (expectedHolder?: string | null) => Promise<unknown>;

const CASES: {
	name: string;
	kind: "claim" | "release" | "reassign";
	call: Call;
	plainCore: () => unknown;
	extra: Record<string, unknown>;
}[] = [
	{
		name: "claimSlot",
		kind: "claim",
		call: (e) =>
			claimSlot({
				data: {
					slotId: SLOT_ID,
					memberId: MEMBER_ID,
					actorMemberId: ACTOR,
					...(e === undefined ? {} : { expectedHolder: e }),
				},
			}),
		plainCore: () => vi.mocked(logic.claimSlotCore),
		extra: { memberId: MEMBER_ID, proof: "asserted" },
	},
	{
		name: "reassignSlot",
		kind: "reassign",
		call: (e) =>
			reassignSlot({
				data: {
					slotId: SLOT_ID,
					memberId: MEMBER_ID,
					...(e === undefined ? {} : { expectedHolder: e }),
				},
			}),
		plainCore: () => vi.mocked(logic.reassignSlotCore),
		extra: { memberId: MEMBER_ID, proof: "session" },
	},
	{
		name: "releaseSlot",
		kind: "release",
		call: (e) =>
			releaseSlot({
				data: {
					slotId: SLOT_ID,
					...(e === undefined ? {} : { expectedHolder: e }),
				},
			}),
		plainCore: () => vi.mocked(logic.releaseSlotCore),
		extra: { proof: "session" },
	},
];

describe.each(CASES)("$name expectedHolder routing (#1638)", (c) => {
	it.each([
		["null (expected open)", null],
		["a holder key", HOLDER],
	])("expectedHolder %s goes to the comparison, never the plain core", async (_label, expected) => {
		await c.call(expected);
		expect(logic.applyRoleOpExpectingHolder).toHaveBeenCalledTimes(1);
		expect(logic.applyRoleOpExpectingHolder).toHaveBeenCalledWith(TX, {
			kind: c.kind,
			slotId: SLOT_ID,
			actorMemberId: RESOLVED_ACTOR,
			expectedHolder: expected,
			...c.extra,
		});
		expect(c.plainCore()).not.toHaveBeenCalled();
	});

	it("an absent expectedHolder takes the plain core, unchanged", async () => {
		await c.call(undefined);
		expect(c.plainCore()).toHaveBeenCalledTimes(1);
		expect(logic.applyRoleOpExpectingHolder).not.toHaveBeenCalled();
	});

	it("a missing slot answers slot-gone when expectedHolder is present, without resolving anyone", async () => {
		preRead.rows = [];
		for (const expected of [null, HOLDER]) {
			await expect(c.call(expected)).resolves.toEqual({
				ok: false,
				reason: "slot-gone",
				currentHolderName: null,
			});
		}
		expect(logic.applyRoleOpExpectingHolder).not.toHaveBeenCalled();
		expect(requireSessionActor).not.toHaveBeenCalled();
	});

	it("a missing slot still throws when expectedHolder is absent", async () => {
		preRead.rows = [];
		await expect(c.call(undefined)).rejects.toThrow("Role not found.");
	});

	it("a skip from the comparison is returned to the caller as is", async () => {
		vi.mocked(logic.applyRoleOpExpectingHolder).mockResolvedValueOnce({
			ok: false,
			reason: "holder-changed",
			currentHolderName: "Ana",
		});
		await expect(c.call(HOLDER)).resolves.toMatchObject({
			ok: false,
			reason: "holder-changed",
			currentHolderName: "Ana",
		});
	});
});

describe("the session is resolved before the comparison (#1638)", () => {
	it.each([
		[
			"releaseSlot",
			() => releaseSlot({ data: { slotId: SLOT_ID, expectedHolder: null } }),
		],
		[
			"reassignSlot",
			() =>
				reassignSlot({
					data: { slotId: SLOT_ID, memberId: MEMBER_ID, expectedHolder: null },
				}),
		],
	])("%s: no session, no comparison", async (_name, call) => {
		vi.mocked(requireSessionActor).mockRejectedValueOnce(
			new Error("Sign in required"),
		);
		await expect(call()).rejects.toThrow("Sign in required");
		expect(logic.applyRoleOpExpectingHolder).not.toHaveBeenCalled();
	});
});

describe("claimSlot's answer on the compare path (#1638)", () => {
	it("an applied claim carries the proof the actor was resolved on", async () => {
		await expect(
			claimSlot({
				data: {
					slotId: SLOT_ID,
					memberId: MEMBER_ID,
					actorMemberId: ACTOR,
					expectedHolder: null,
				},
			}),
		).resolves.toEqual({ ok: true, proof: "asserted" });
	});
});
