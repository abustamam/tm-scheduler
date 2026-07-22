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
	/** Edit the speech on your own filled speaker slot — public self-serve. */
	canEditOwnSpeech: boolean;
	/** Claim an open slot. Offered to any visitor incl. a no-identity one (who identifies at click); a lockedViewer denies it. */
	canClaim: boolean;
	/**
	 * Release your own filled slot. Any identity holding the slot may; a
	 * `lockedViewer` denies it so a locked meeting stays read-only client-side.
	 */
	canReleaseOwn: boolean;
	/** Open the "Edit meeting" dialog (theme/location/WOD/notes; reschedule is
	 *  admin-only inside it). Manager surface: admin OR the meeting's TMOD. */
	canEditMeetingMeta: boolean;
	/** Open the focused Word-of-the-Day editor. The pure Grammarian's affordance
	 *  only — admins and the TMOD edit the WOD through "Edit meeting". */
	canEditWod: boolean;
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
	 *  role) is granted ONLY here — the honor-system name-pick path may claim
	 *  open slots but not reassign someone else's. Optional, defaults to false
	 *  (fail closed: no take-over unless a caller opts in). */
	isSignedIn?: boolean;
}): MeetingViewer {
	const hasIdentity = input.currentMemberId !== null;
	const manages = input.canManage;
	const runsMeeting = manages || input.isTmod;
	return {
		currentMemberId: input.currentMemberId,
		canManage: manages,
		canAssign: runsMeeting,
		canManageSpeakers: runsMeeting,
		canEditMeetingMeta: runsMeeting && input.isEditableWindow,
		// Offered to everyone incl. a no-identity visitor (they identify at click);
		// lockedViewer denies these for a locked/past meeting.
		canToggleAvailability: true,
		canClaim: true,
		// Boot a held role: real sign-in only (spec decision #6).
		canTakeOver: input.isSignedIn ?? false,
		// Need an established identity that actually holds the slot.
		canEditOwnSpeech: hasIdentity,
		canReleaseOwn: hasIdentity,
		canEditWod:
			input.isGrammarian && !input.isTmod && !manages && input.isEditableWindow,
	};
}
