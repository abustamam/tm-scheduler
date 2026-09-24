/**
 * Transport tests for the three public slot writes whose archive gate lives in
 * a core (#825): `claimSlot`, `reassignSlot`, `releaseSlot`.
 *
 * The integration suites prove each CORE refuses an archived club. Nothing
 * there can prove the HANDLER still reaches its core, because a
 * `createServerFn` handler needs the Start runtime. A source grep for the
 * core's name was the first attempt and it was blind twice over — a string
 * literal or an `if (false)` call satisfied it while the handler wrote inline.
 *
 * So this executes the real handlers through a minimal Start adapter (the
 * shape `upload-members.transport.test.ts` introduced) with the core mocked,
 * and asserts behaviour rather than text:
 *
 *   · the handler CALLS the core, inside the transaction it opened;
 *   · it passes the RESOLVED actor, never the one the client asserted (#396);
 *   · a refusal the core raises — the archive refusal above all — reaches the
 *     caller unchanged rather than being swallowed into a success;
 *   · a trust guard that refuses stops the request BEFORE any transaction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_ARCHIVED_MESSAGE } from "#/lib/club-archive";

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
const ASSERTED_ACTOR = "44444444-4444-4444-8444-444444444444";
const RESOLVED_ACTOR = "55555555-5555-4555-8555-555555555555";

// The transaction handle the fake `db.transaction` passes its callback, so a
// test can tell a core called INSIDE the handler's transaction from one called
// on the pooled client.
const TX = { __tx: true };

const { preRead } = vi.hoisted(() => ({
	preRead: { rows: [] as unknown[] },
}));

vi.mock("#/db", () => {
	// The handlers' pre-read is `select().from().innerJoin().where().limit()`.
	// Every link returns the chain; `limit` ends it with the seeded rows.
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
	requestWriteActor: vi.fn(async () => RESOLVED_ACTOR),
}));
vi.mock("./slots-logic", () => ({
	applyAddRoleSlot: vi.fn(),
	applyAddSpeakerSlot: vi.fn(),
	applyMoveEvaluatorSlot: vi.fn(),
	applyMoveSpeakerSlot: vi.fn(),
	applyRemoveRoleSlot: vi.fn(),
	applyRemoveSpeakerSlot: vi.fn(),
	claimSlotCore: vi.fn(async () => ({ clubId: CLUB_ID })),
	confirmSlotCore: vi.fn(),
	editSlotSpeech: vi.fn(),
	reassignSlotCore: vi.fn(async () => ({ clubId: CLUB_ID })),
	releaseSlotCore: vi.fn(async () => ({ clubId: CLUB_ID })),
}));

import { db } from "#/db";
import { requireMemberInClub } from "./guards";
import { claimSlot, reassignSlot, releaseSlot } from "./slots";
import * as logic from "./slots-logic";
import { requestWriteActor } from "./write-actor-logic";

beforeEach(() => {
	vi.clearAllMocks();
	preRead.rows = [{ clubId: CLUB_ID }];
});

/** Each handler, the core it must reach, and what it must hand that core. */
const CASES = [
	{
		name: "claimSlot",
		call: () =>
			claimSlot({
				data: {
					slotId: SLOT_ID,
					memberId: MEMBER_ID,
					actorMemberId: ASSERTED_ACTOR,
					speakerDetails: { speechTitle: "Ice Breaker" },
				},
			}),
		core: () => vi.mocked(logic.claimSlotCore),
		expectedArgs: {
			slotId: SLOT_ID,
			memberId: MEMBER_ID,
			actorMemberId: RESOLVED_ACTOR,
			speakerDetails: { speechTitle: "Ice Breaker" },
		},
		guardsTarget: true,
	},
	{
		name: "reassignSlot",
		call: () =>
			reassignSlot({
				data: {
					slotId: SLOT_ID,
					memberId: MEMBER_ID,
					actorMemberId: ASSERTED_ACTOR,
				},
			}),
		core: () => vi.mocked(logic.reassignSlotCore),
		expectedArgs: {
			slotId: SLOT_ID,
			memberId: MEMBER_ID,
			actorMemberId: RESOLVED_ACTOR,
		},
		guardsTarget: true,
	},
	{
		name: "releaseSlot",
		call: () =>
			releaseSlot({
				data: { slotId: SLOT_ID, actorMemberId: ASSERTED_ACTOR },
			}),
		core: () => vi.mocked(logic.releaseSlotCore),
		expectedArgs: { slotId: SLOT_ID, actorMemberId: RESOLVED_ACTOR },
		guardsTarget: false,
	},
] as const;

describe.each(CASES)("$name transport (#825)", (c) => {
	it("delegates to its core inside the handler's transaction, with the resolved actor", async () => {
		await expect(c.call()).resolves.toEqual({ ok: true });

		expect(c.core()).toHaveBeenCalledTimes(1);
		expect(c.core()).toHaveBeenCalledWith(TX, c.expectedArgs);
		expect(requestWriteActor).toHaveBeenCalledWith({
			clubId: CLUB_ID,
			claimedActorMemberId: ASSERTED_ACTOR,
		});
	});

	it("surfaces the core's archive refusal to the caller", async () => {
		c.core().mockRejectedValueOnce(new Error(CLUB_ARCHIVED_MESSAGE));
		await expect(c.call()).rejects.toThrow(CLUB_ARCHIVED_MESSAGE);
	});

	it("refuses before any transaction when the actor cannot be resolved", async () => {
		vi.mocked(requestWriteActor).mockRejectedValueOnce(
			new Error("not on this roster"),
		);
		await expect(c.call()).rejects.toThrow("not on this roster");
		expect(db.transaction).not.toHaveBeenCalled();
		expect(c.core()).not.toHaveBeenCalled();
	});

	it("refuses an unknown slot before any transaction", async () => {
		preRead.rows = [];
		await expect(c.call()).rejects.toThrow("Role not found.");
		expect(db.transaction).not.toHaveBeenCalled();
		expect(c.core()).not.toHaveBeenCalled();
	});

	if (c.guardsTarget) {
		it("refuses a target who is not on the club's roster before any transaction", async () => {
			vi.mocked(requireMemberInClub).mockRejectedValueOnce(
				new Error("Member not found in this club."),
			);
			await expect(c.call()).rejects.toThrow("Member not found in this club.");
			expect(requireMemberInClub).toHaveBeenCalledWith(MEMBER_ID, CLUB_ID);
			expect(db.transaction).not.toHaveBeenCalled();
			expect(c.core()).not.toHaveBeenCalled();
		});
	}
});
