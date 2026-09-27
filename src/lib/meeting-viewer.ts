/**
 * The single identity/capabilities object the shared `<MeetingAgenda>` consumes.
 *
 * The agenda component never reads a Better-Auth session or the self-asserted
 * `useCurrentMember` store directly — it only asks this object "who is the
 * current member" and "which actions may they take". Each surface constructs one
 * via the shared `meetingViewer` adapter, which is the seam that lets one
 * component serve both identity models (ADR-0008 session vs. ADR-0010
 * self-serve). A capability the adapter doesn't grant renders nothing in the
 * component — there is no per-surface branching inside the agenda.
 */
export interface MeetingViewer {
	/**
	 * The current member's id, or `null` when no identity is established (a public
	 * visitor who hasn't picked a name yet). Drives "(you)" markers and which slot
	 * an action targets; when null, mutating controls simply don't render.
	 */
	currentMemberId: string | null;
	/**
	 * Full management (signed-in admin only): confirm/unconfirm assignments, move
	 * speakers, remove non-paired roles, release anyone's slot, edit any speech,
	 * plus the stats strip and the "not available this week" section.
	 */
	canManage: boolean;
	/** Open the assign/reassign picker (signed-in admin OR public TMOD). */
	canAssign: boolean;
	/** Add/remove speaker slots (signed-in admin OR public TMOD). */
	canManageSpeakers: boolean;
	/** Toggle own availability ("I can't make this one") — public self-serve. */
	canToggleAvailability: boolean;
	/** Take over someone else's filled slot — SIGNED-IN only (no honor-system booting). */
	canTakeOver: boolean;
	/**
	 * Edit the speech on your own filled speaker slot. Needs a SESSION as well as
	 * an identity (#1003): `updateSpeakerDetails` refuses a name-pick since #763,
	 * and ADR-0026 says a control the server refuses must not be shown. The
	 * agenda ORs this with `canManage`, which is how an impersonating superadmin
	 * (no member id) keeps the control.
	 */
	canEditOwnSpeech: boolean;
	/** Claim an open slot. Offered to any visitor incl. a no-identity one (who identifies at click); a lockedViewer denies it. */
	canClaim: boolean;
	/**
	 * Release your own filled slot. A SIGNED-IN identity holding the slot may
	 * (#1003): `releaseSlot` refuses a name-pick since #763. A `lockedViewer`
	 * denies it so a locked meeting stays read-only client-side. Like
	 * `canEditOwnSpeech`, the session term lives HERE and never in front of
	 * `canManage` at the call site.
	 */
	canReleaseOwn: boolean;
	/** Open the "Edit meeting" dialog (theme/location/WOD/notes; reschedule is
	 *  admin-only inside it). Manager surface: admin OR the meeting's TMOD. */
	canEditMeetingMeta: boolean;
	/** Open the focused Word-of-the-Day editor. The pure Grammarian's affordance
	 *  only — admins and the TMOD edit the WOD through "Edit meeting". */
	canEditWod: boolean;
	/** Edit the meeting's Table Topics notes (#880): anyone who may edit the meta,
	 *  plus the meeting's Table Topics Master. Unlike `canEditWod` this IS the
	 *  whole answer, because nothing else on the agenda page edits the notes for
	 *  the TTM, so there is no overlap to avoid. */
	canEditTableTopicsNotes: boolean;
}

/**
 * The single adapter both meeting surfaces construct (ADR-0008 session and
 * ADR-0010 self-serve converge here). The public route passes `canManage:false`;
 * the authed route passes it from the loader. `isTmod`/`isGrammarian` come from
 * `deriveMeetingRoleFlags`. `isEditableWindow` is false for a PAST meeting — it
 * disables the edit affordances while leaving claim/release available; a LOCKED
 * meeting is handled separately by `lockedViewer`.
 */
export function meetingViewer(input: {
	currentMemberId: string | null;
	canManage: boolean;
	isTmod: boolean;
	isGrammarian: boolean;
	isEditableWindow: boolean;
	/** The real-auth (Better-Auth) shell path (#317). Take-over ("boot" a held
	 *  role), releasing your own slot and editing your own speech are granted
	 *  ONLY here (#1003) — the honor-system name-pick path may claim open slots
	 *  and nothing the server gates on a session. Optional, defaults to false
	 *  (fail closed: none of the three unless a caller opts in). */
	isSignedIn?: boolean;
	/** Holds the meeting's Table Topics Master slot (#880). Optional, defaults
	 *  to false (fail closed), as `isSignedIn`. */
	isTableTopicsMaster?: boolean;
}): MeetingViewer {
	const hasIdentity = input.currentMemberId !== null;
	const isSignedIn = input.isSignedIn ?? false;
	const manages = input.canManage;
	const runsMeeting = manages || input.isTmod;
	return {
		currentMemberId: input.currentMemberId,
		canManage: manages,
		canAssign: runsMeeting,
		canManageSpeakers: runsMeeting,
		canEditMeetingMeta: runsMeeting && input.isEditableWindow,
		// lockedViewer denies these for a locked/past meeting.
		//
		// NOT offered to a no-identity visitor any more, whatever this flag says:
		// the control moved onto the personal strip, which renders nothing without
		// an effective member, and the strip's own handler returns early when
		// `myId` is null. The old "they identify at click" contract came from
		// `toggleAvailability` awaiting `requireIdentity()` — that call is gone,
		// so a click with no identity now does nothing at all rather than opening
		// the picker. Left `true` because the flag is still the LOCK gate for
		// everyone who does have an identity; the identity half is the strip's.
		canToggleAvailability: true,
		canClaim: true,
		// Boot a held role: real sign-in only (spec decision #6).
		canTakeOver: isSignedIn,
		// Need a session-backed identity that actually holds the slot (#1003):
		// the server writes behind both require `requireSessionActor` (#763).
		canEditOwnSpeech: hasIdentity && isSignedIn,
		canReleaseOwn: hasIdentity && isSignedIn,
		canEditWod:
			input.isGrammarian && !input.isTmod && !manages && input.isEditableWindow,
		canEditTableTopicsNotes:
			(runsMeeting || (input.isTableTopicsMaster ?? false)) &&
			input.isEditableWindow,
	};
}

/**
 * May this viewer edit the meeting's WORD OF THE DAY? The union of the two
 * capabilities above, and a named function rather than an inline `||` because
 * neither flag answers the question ALONE and the focused `/me/word` route
 * (#666) has to ask it.
 *
 * `canEditWod` is deliberately the PURE Grammarian's affordance — it is false
 * for the TMOD and for an admin, so that the agenda page shows them one "Edit
 * meeting" button instead of two overlapping controls. Reading it on its own as
 * "may edit the Word of the Day" therefore inverts the answer for exactly the
 * two callers who have the WIDER capability: `resolveWordOfTheDayAuthz` grants
 * admin, TMOD **and** Grammarian, so a route gated on `canEditWod` alone would
 * tell the Toastmaster they may not do something the server would happily let
 * them do.
 *
 * Composing the two flags rather than re-deriving from `isTmod`/`isGrammarian`
 * keeps the LOCK for free: `lockedViewer` zeroes both, so a completed meeting —
 * and, for a non-manager, a meeting whose day has passed — answers false here
 * without this function knowing anything about a meeting's lifecycle.
 */
export function canEditWordOfTheDay(viewer: MeetingViewer): boolean {
	return viewer.canEditMeetingMeta || viewer.canEditWod;
}
