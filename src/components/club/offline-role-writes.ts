// The meeting page's role writes through the offline queue (#1638).
//
// Both functions go through `offlineMinutes.mutate` and so follow its one rule,
// unchanged: call the server directly when online with an empty queue, otherwise
// enqueue, so an op never overtakes one already waiting. The direct call is
// whatever the caller passes (today's exact `claimSlot` / `reassignSlot` /
// `releaseSlot`). A queued op carries the names the page and the deck show while
// it waits, the asserting actor, and the holder the officer SAW: the slot they
// pass is the PROJECTED one, so a second offline edit chains off the first.
import type { useOfflineMinutes } from "#/hooks/use-offline-minutes";
import { holderKeyOf } from "#/lib/project-slots";
import { isRealSpeechTitle } from "#/lib/speech-title";

export type OfflineMinutesHandle = ReturnType<typeof useOfflineMinutes>;

/** The slice of a slot a queued role op is built from. */
export type RoleOpSlot = {
	id: string;
	roleName: string;
	assigneeName: string | null;
	assigneeId?: string | null;
	assigneeGuestId?: string | null;
};

/** Shown instead of dropping a tap: `mutate` refuses one while a write or a
 *  drain is in flight, and says nothing. */
export const STILL_SYNCING_MESSAGE =
	"Still syncing your last change. Try again in a moment.";

/** Speech details cannot ride a queued assignment: editing them offline stays
 *  online-only. */
export const SPEECH_DETAILS_OFFLINE_MESSAGE =
	"Speech details can't be saved offline. Claim the role without them, or try again when you're back online.";

/** Thrown when the caller has no display name to show for the person being
 *  given the role: a queued op carries the name the deck prints, and a
 *  placeholder there would be wrong in front of the room. */
export const NAME_UNAVAILABLE_MESSAGE =
	"Can't save this offline: that person's name isn't loaded. Try again when you're back online.";

/** Thrown for an assignment that would replay as a claim with nobody to credit
 *  as the actor. */
export const ACTOR_UNAVAILABLE_MESSAGE =
	"Can't save this offline. Try again when you're back online.";

/** Whether a claim's speech details carry anything to save. The `TBA`
 *  placeholder the assign sheet sends for a speaker slot is not something. */
export function hasSpeakerDetails(
	d:
		| {
				speechTitle?: string;
				pathwayPath?: string;
				projectName?: string;
				projectLevel?: string;
				projectId?: string | null;
				minMinutes?: number;
				maxMinutes?: number;
		  }
		| undefined,
): boolean {
	if (!d) return false;
	return Boolean(
		isRealSpeechTitle(d.speechTitle) ||
			d.pathwayPath ||
			d.projectName ||
			d.projectLevel ||
			d.projectId ||
			d.minMinutes != null ||
			d.maxMinutes != null,
	);
}

function guardBusy(offline: OfflineMinutesHandle) {
	if (offline.busy || offline.draining) throw new Error(STILL_SYNCING_MESSAGE);
}

/** Give `slot` to a member. `direct` is the online call, made exactly as it
 *  was before the queue existed. A refusal on that path rethrows, so the
 *  caller's own error handling (the sign-in link) still sees it. */
export async function assignRoleViaQueue(
	offline: OfflineMinutesHandle,
	args: {
		slot: RoleOpSlot;
		member: { id: string; name: string | null };
		/** What today's call passes as the actor: the claimer for a claim, null for
		 *  a reassign (which carries none on the wire). Never filled in here. */
		actorMemberId: string | null;
		/** Speech details the claim passes. Only the `TBA` placeholder can be
		 *  queued; real details are online-only. */
		speakerDetails?: Parameters<typeof hasSpeakerDetails>[0];
		direct: () => Promise<unknown>;
	},
): Promise<void> {
	guardBusy(offline);
	await offline.mutate(
		args.direct,
		() => {
			if (hasSpeakerDetails(args.speakerDetails)) {
				throw new Error(SPEECH_DETAILS_OFFLINE_MESSAGE);
			}
			const name = args.member.name?.trim();
			if (!name) throw new Error(NAME_UNAVAILABLE_MESSAGE);
			const expectedHolder = holderKeyOf(args.slot);
			// An open slot replays as a claim, which needs its actor.
			if (expectedHolder === null && !args.actorMemberId) {
				throw new Error(ACTOR_UNAVAILABLE_MESSAGE);
			}
			return {
				type: "assignSlot",
				...offline.opMeta(),
				slotId: args.slot.id,
				roleName: args.slot.roleName,
				memberId: args.member.id,
				memberDisplayName: name,
				actorMemberId: args.actorMemberId,
				// The sheet's speaker "TBA": the online claim sends it, so the queued
				// one does too and the page ends in the same state.
				...(args.speakerDetails
					? { speakerDetails: { speechTitle: args.speakerDetails.speechTitle } }
					: {}),
				expectedHolder,
				expectedHolderName: args.slot.assigneeName,
			};
		},
		{ throwOnError: true, slotId: args.slot.id },
	);
}

/** Clear `slot`. A guest-held slot may be cleared offline. */
export async function releaseRoleViaQueue(
	offline: OfflineMinutesHandle,
	args: { slot: RoleOpSlot; direct: () => Promise<unknown> },
): Promise<void> {
	guardBusy(offline);
	await offline.mutate(
		args.direct,
		() => ({
			type: "releaseSlot",
			...offline.opMeta(),
			slotId: args.slot.id,
			roleName: args.slot.roleName,
			expectedHolder: holderKeyOf(args.slot),
			expectedHolderName: args.slot.assigneeName,
		}),
		{ throwOnError: true, slotId: args.slot.id },
	);
}
