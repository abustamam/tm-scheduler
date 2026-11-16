/**
 * protects=the queued role op the meeting page builds (#1638): names, actor,
 * the holder the officer saw (guest key included), the speech-details refusal,
 * and the busy refusal; online with an empty queue calls the plain fn;
 * fails_when=expectedHolder or actor is dropped, a guest holder keys as a
 * member, speech details ride a queued claim, or a tap is silently dropped;
 * no_claim=the replay (drain-role-ops.test.ts) and the server decision.
 */
import { describe, expect, it, vi } from "vitest";
import {
	assignRoleViaQueue,
	hasSpeakerDetails,
	type OfflineMinutesHandle,
	releaseRoleViaQueue,
	SPEECH_DETAILS_OFFLINE_MESSAGE,
	STILL_SYNCING_MESSAGE,
} from "./offline-role-writes";

type Queued = Record<string, unknown>;

function handle(
	over: { busy?: boolean; draining?: boolean; online?: boolean } = {},
) {
	const queued: Queued[] = [];
	const h = {
		busy: over.busy ?? false,
		draining: over.draining ?? false,
		opMeta: () => ({ opId: "op-1", queuedAt: 42 }),
		mutate: vi.fn(
			async (online: () => Promise<unknown>, make: () => Queued) => {
				if (over.online === false) queued.push(make());
				else await online();
			},
		),
	};
	return { h: h as unknown as OfflineMinutesHandle, queued, mutate: h.mutate };
}

const slot = {
	id: "s1",
	roleName: "Timer",
	assigneeName: "Ann",
	assigneeId: "ann",
	assigneeGuestId: null,
};

describe("assignRoleViaQueue / releaseRoleViaQueue (#1638)", () => {
	it("online with an empty queue calls the plain fn and queues nothing", async () => {
		const { h, queued } = handle();
		const direct = vi.fn().mockResolvedValue(undefined);
		await assignRoleViaQueue(h, {
			slot,
			member: { id: "bob", name: "Bob" },
			actorMemberId: "adm",
			direct,
		});
		expect(direct).toHaveBeenCalledTimes(1);
		expect(queued).toEqual([]);
	});

	it("offline, the op carries names, actor and the holder the officer saw", async () => {
		const { h, queued } = handle({ online: false });
		await assignRoleViaQueue(h, {
			slot,
			member: { id: "bob", name: "Bob" },
			actorMemberId: "adm",
			direct: vi.fn(),
		});
		expect(queued[0]).toMatchObject({
			type: "assignSlot",
			slotId: "s1",
			roleName: "Timer",
			memberId: "bob",
			memberDisplayName: "Bob",
			actorMemberId: "adm",
			expectedHolder: "m:ann",
			expectedHolderName: "Ann",
		});
	});

	it("an open slot queues expectedHolder null", async () => {
		const { h, queued } = handle({ online: false });
		await assignRoleViaQueue(h, {
			slot: { ...slot, assigneeId: null, assigneeName: null },
			member: { id: "bob", name: "Bob" },
			actorMemberId: "adm",
			direct: vi.fn(),
		});
		expect(queued[0]?.expectedHolder).toBeNull();
	});

	it("a guest-held slot releases offline with a g: key", async () => {
		const { h, queued } = handle({ online: false });
		await releaseRoleViaQueue(h, {
			slot: {
				...slot,
				assigneeId: null,
				assigneeGuestId: "g1",
				assigneeName: "Gus",
			},
			direct: vi.fn(),
		});
		expect(queued[0]).toMatchObject({
			type: "releaseSlot",
			expectedHolder: "g:g1",
			expectedHolderName: "Gus",
		});
	});

	it("a queued claim with real speech details is refused; TBA is not a detail", async () => {
		const { h } = handle({ online: false });
		await expect(
			assignRoleViaQueue(h, {
				slot,
				member: { id: "bob", name: "Bob" },
				actorMemberId: "adm",
				speakerDetails: { speechTitle: "Ice Breaker" },
				direct: vi.fn(),
			}),
		).rejects.toThrow(SPEECH_DETAILS_OFFLINE_MESSAGE);
		expect(hasSpeakerDetails({ speechTitle: "TBA" })).toBe(false);
		expect(hasSpeakerDetails(undefined)).toBe(false);
		expect(hasSpeakerDetails({ pathwayPath: "Dynamic Leadership" })).toBe(true);
	});

	it("refuses visibly, not silently, while a write or drain is in flight", async () => {
		for (const over of [{ busy: true }, { draining: true }]) {
			const { h, mutate } = handle(over);
			await expect(
				releaseRoleViaQueue(h, { slot, direct: vi.fn() }),
			).rejects.toThrow(STILL_SYNCING_MESSAGE);
			expect(mutate).not.toHaveBeenCalled();
		}
	});
});
