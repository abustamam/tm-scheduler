/**
 * The single identity/capabilities object the shared `<MeetingAgenda>` consumes.
 *
 * The agenda component never reads a Better-Auth session or the self-asserted
 * `useCurrentMember` store directly — it only asks this object "who is the
 * current member" and "which actions may they take". Each surface constructs one
 * via an adapter (`sessionViewer` / `selfAssertedViewer`), which is the seam that
 * lets one component serve both identity models (ADR-0008 session vs. ADR-0010
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
	/** Take over someone else's filled slot — public self-serve. */
	canTakeOver: boolean;
	/** Edit the speech on your own filled speaker slot — public self-serve. */
	canEditOwnSpeech: boolean;
}

/**
 * Adapter from the signed-in Better-Auth session (ADR-0008): the route context's
 * current member id plus the loader's admin `canManage` flag. Admins get the full
 * management set; the self-serve capabilities (availability/takeover/own-speech)
 * are the public surface's and stay off here.
 */
export function sessionViewer(input: {
	currentMemberId: string | null;
	canManage: boolean;
}): MeetingViewer {
	return {
		currentMemberId: input.currentMemberId,
		canManage: input.canManage,
		canAssign: input.canManage,
		canManageSpeakers: input.canManage,
		canToggleAvailability: false,
		canTakeOver: false,
		canEditOwnSpeech: false,
	};
}

/**
 * Adapter from the self-asserted public identity (ADR-0010): the picked member
 * plus the derived `isTmod` flag (they hold the meeting's Toastmaster slot). Any
 * picked member may toggle availability, take over a slot, and edit their own
 * speech; the TMOD additionally gets assign and speaker-slot management. A
 * visitor who hasn't picked a name (`memberId === null`) gets a read-only agenda.
 */
export function selfAssertedViewer(input: {
	memberId: string | null;
	isTmod: boolean;
}): MeetingViewer {
	const hasIdentity = input.memberId !== null;
	return {
		currentMemberId: input.memberId,
		canManage: false,
		canAssign: input.isTmod,
		canManageSpeakers: input.isTmod,
		canToggleAvailability: hasIdentity,
		canTakeOver: hasIdentity,
		canEditOwnSpeech: hasIdentity,
	};
}
