/**
 * Connector parity table (#1564, child of #1560).
 *
 * One row per exported non-GET `createServerFn` under `src/server/`, saying
 * whether the connector (`/api/mcp`) can do what that function does. Without it
 * a gap is found the way #1560's was, by a user's agent hitting it mid-task.
 * `parity.guard.test.ts` fails when a write has no row (or its method cannot be
 * read), a row names a function that is gone or is listed twice, a `tool` row
 * names an unregistered tool or one whose audience disagrees with the row's, a
 * `tool` row has a `superadmin`, `public` or `areaDirector` audience, or a
 * registered tool is neither named by a row nor on the test's read-only /
 * gap-gate allowlist.
 *
 * ## The three outcomes (exactly one per row)
 *
 * - `tool`: the connector can do it, through the named tool(s). The tool and the
 *   function must reach the SAME underlying write (a shared `*Core` / `apply*`
 *   / logic function); a tool that does a different write is a `gap`.
 * - `gap`: it should be on the connector and is not yet. #1560 closes when none
 *   remain. When unsure, a row is `gap`, not `notOnConnector`: the maintainer
 *   decides exclusions in review.
 * - `notOnConnector`: deliberately excluded, with a `category` and a `reason`.
 *
 * ## Audience
 *
 * Read from the function's gate, as the WEAKEST caller it admits: `admin`
 * (`requireClubRole(["admin"])` or an admin-only editor guard), `member` (any
 * active member, or an admin-or-delegate gate such as the TMOD / ballot-counter
 * editors), `self` (the signed-in user's own account data, or a self-or-admin
 * gate such as path enrollment and progress marks), `areaDirector` (a current
 * Area Director term via `requireAreaDirector`, which is NOT club membership;
 * added beyond the issue's five audiences), `superadmin`, `public` (no
 * session). A `tool` row's audience must agree with a tool's: `admin` is exactly
 * an `"officer"` tool, `member` and `self` a `"member"` tool; `areaDirector`,
 * `superadmin` and `public` have no connector audience, so such a row cannot be
 * a `tool` row. A member-gated function whose only connector counterpart is an
 * officer tool (`reassignSlot` vs `assign_roles`) is a `gap`: the member-scoped
 * tool is what is missing.
 *
 * Mixed-audience note: a `gap` row's audience is the maintainer's to confirm when
 * the tool is built.
 */
import type { McpToolAudience } from "./tool";

export type ParityAudience =
	| "admin"
	| "member"
	| "self"
	| "areaDirector"
	| "superadmin"
	| "public";

/** Why a function is deliberately not on the connector. */
export type NotOnConnectorCategory =
	| "credential management"
	| "file upload"
	| "extension ingest"
	| "public path"
	| "confirm-link step"
	| "UI-only state"
	| "sign-in flow"
	| "connector management"
	| "superadmin only";

/**
 * One outcome per row. The other two keys are `never` on each arm, so a row
 * naming two outcomes does not type-check (the checker repeats the test at run
 * time for a cast). `gap` may carry its child issue number.
 */
export type ParityOutcome =
	| {
			tool: string | readonly string[];
			gap?: never;
			notOnConnector?: never;
	  }
	| { gap: true | number; tool?: never; notOnConnector?: never }
	| {
			notOnConnector: { category: NotOnConnectorCategory; reason: string };
			tool?: never;
			gap?: never;
	  };

export interface ParityRow {
	/** Path under `src/server/`, no extension: `members`, `mcp/tools/foo`. */
	module: string;
	/** The exported `createServerFn` name. */
	name: string;
	audience: ParityAudience;
	outcome: ParityOutcome;
}

/** The connector audience a row audience maps to, or null when it has none. */
export function toolAudienceFor(
	audience: ParityAudience,
): McpToolAudience | null {
	if (audience === "admin") return "officer";
	if (audience === "member" || audience === "self") return "member";
	return null;
}

/** The tool names a `tool` outcome names, as a list. */
export function toolNames(tool: string | readonly string[]): readonly string[] {
	return typeof tool === "string" ? [tool] : tool;
}

function row(
	module: string,
	name: string,
	audience: ParityAudience,
	outcome: ParityOutcome,
): ParityRow {
	return { module, name, audience, outcome };
}

export const PARITY_ROWS: ParityRow[] = [
	row("attendance-plan", "setPlannedAttendance", "member", {
		tool: ["set_my_attendance", "set_attendance"],
	}),
	row("attendance-plan", "clearPlannedAttendance", "member", { gap: true }),
	row("mentorship", "setMyWillingToMentor", "self", { gap: true }),
	row("mentorship", "setMyMentorBio", "self", { gap: true }),
	row("mentorship", "requestMentor", "self", { gap: true }),
	row("mentorship", "withdrawMentorRequest", "self", { gap: true }),
	row("mentorship", "decideMentorRequest", "self", { gap: true }),
	row("mentorship", "createMentorship", "admin", { gap: true }),
	row("mentorship", "endMentorship", "admin", { gap: true }),
	row("mentorship", "setMentorshipFocus", "admin", { gap: true }),
	row("api-tokens", "generateApiToken", "self", {
		notOnConnector: {
			category: "credential management",
			reason: "minting a token is a signed-in browser step",
		},
	}),
	row("api-tokens", "revokeApiTokenFn", "self", {
		notOnConnector: {
			category: "credential management",
			reason: "revoking a token is a signed-in browser step",
		},
	}),
	row("club-logo", "uploadClubLogo", "admin", {
		notOnConnector: {
			category: "file upload",
			reason: "an image upload is a browser step",
		},
	}),
	row("club-logo", "removeClubLogoFn", "admin", {
		notOnConnector: {
			category: "file upload",
			reason: "removing the logo pairs with the browser upload",
		},
	}),
	row("availability", "setAvailability", "member", { gap: true }),
	row("availability", "clearAvailability", "member", { gap: true }),
	row("availability", "markUnavailableReleasing", "member", {
		tool: "set_my_attendance",
	}),
	row("upload-members", "previewMemberUpload", "admin", { gap: true }),
	row("upload-members", "commitMemberUpload", "admin", { gap: true }),
	row("sync-tokens", "generateSyncToken", "admin", {
		notOnConnector: {
			category: "credential management",
			reason: "the extension's sync token is minted in the browser",
		},
	}),
	row("sync-tokens", "revokeSyncTokenFn", "admin", {
		notOnConnector: {
			category: "credential management",
			reason: "the extension's sync token is revoked in the browser",
		},
	}),
	row("pathways-sync", "ingestPathwaysProgress", "admin", {
		notOnConnector: {
			category: "extension ingest",
			reason: "the browser extension posts Pathways progress",
		},
	}),
	row("clubs", "resetDemoClubFromClub", "admin", { gap: true }),
	row("clubs", "updateClubProfile", "admin", { gap: true }),
	row("clubs", "updateClubAgendaSettings", "admin", { gap: true }),
	row("clubs", "updateClubTimezone", "admin", { gap: true }),
	row("clubs", "markChartered", "admin", { gap: true }),
	row("clubs", "updateCharterDate", "admin", { gap: true }),
	row("clubs", "applyDefaultJoinUrl", "admin", { gap: true }),
	row("voting", "submitVote", "public", {
		notOnConnector: {
			category: "public path",
			reason: "a voter may be anonymous and acts as their device",
		},
	}),
	row("voting", "openVoteFn", "member", { gap: true }),
	row("voting", "closeVoteFn", "member", { gap: true }),
	row("voting", "disqualifyCandidateFn", "member", { gap: true }),
	row("voting", "undoDisqualificationFn", "member", { gap: true }),
	row("path-enrollment", "addMyPath", "self", { gap: true }),
	row("path-enrollment", "removeMyPath", "self", { gap: true }),
	row("path-enrollment", "addMemberPath", "self", { gap: true }),
	row("path-enrollment", "removeMemberPath", "self", { gap: true }),
	row("role-definitions", "createClubRole", "admin", { gap: true }),
	row("role-definitions", "updateClubRole", "admin", { gap: true }),
	row("role-definitions", "setClubRoleEnabled", "admin", { gap: true }),
	row("role-definitions", "reorderClubRoles", "admin", { gap: true }),
	row("role-definitions", "deleteClubRole", "admin", { gap: true }),
	row("role-definitions", "syncTemplateToUpcomingMeetings", "admin", {
		gap: true,
	}),
	row("dues", "createDuesPeriod", "admin", { gap: true }),
	row("dues", "updateDuesPeriod", "admin", { gap: true }),
	row("dues", "deleteDuesPeriod", "admin", { gap: true }),
	row("dues", "recordDuesPayment", "admin", { gap: true }),
	row("dues", "waiveDues", "admin", { gap: true }),
	row("dues", "undoDues", "admin", { gap: true }),
	row("guest-book-pending", "patchGuestBookPendingPlan", "admin", {
		notOnConnector: {
			category: "confirm-link step",
			reason:
				"record_guest_book only stages the plan and hands back a link; correcting it is the signed-in human's step, by design",
		},
	}),
	row("guest-book-pending", "applyGuestBookPendingPlan", "admin", {
		notOnConnector: {
			category: "confirm-link step",
			reason:
				"record_guest_book does not call this: it stages the plan, and the signed-in human applies it from the link, by design",
		},
	}),
	row("area-visits", "recordClubVisit", "areaDirector", { gap: true }),
	row("area-visits", "clearClubVisit", "areaDirector", { gap: true }),
	row("meeting-templates", "applyTemplateToMeeting", "admin", { gap: true }),
	row("meeting-templates", "saveAgendaAsClubTemplate", "admin", { gap: true }),
	row("auth-context", "setActiveClub", "self", {
		notOnConnector: {
			category: "UI-only state",
			reason: "which club the browser session is viewing",
		},
	}),
	row("auth-context", "setViewAs", "self", {
		notOnConnector: {
			category: "UI-only state",
			reason: "the superadmin-style view-as switch for the browser session",
		},
	}),
	row("guest-invite-template", "updateGuestInviteTemplates", "admin", {
		gap: true,
	}),
	row("guest-invite-template", "resetGuestInviteTemplate", "admin", {
		gap: true,
	}),
	row("people", "mergePeopleFn", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "merging Person records across clubs",
		},
	}),
	row("officer-training", "setTrainingWindow", "admin", { gap: true }),
	row("officer-training", "resetTrainingWindow", "admin", { gap: true }),
	row("officer-training", "addTrainingRecord", "admin", { gap: true }),
	row("officer-training", "removeTrainingRecord", "admin", { gap: true }),
	row("club-agendas", "renameClubTemplate", "admin", { gap: true }),
	row("club-agendas", "duplicateClubTemplateFn", "admin", { gap: true }),
	row("club-agendas", "setClubTemplateEnabled", "admin", { gap: true }),
	row("club-agendas", "deleteClubTemplateFn", "admin", { gap: true }),
	row("club-agendas", "setClubDefaultTemplate", "admin", { gap: true }),
	row("club-agendas", "adoptStandardAgendaFn", "admin", { gap: true }),
	row("speech-requests", "submitSpeechRequest", "self", { gap: true }),
	row("speech-requests", "editSpeechRequest", "self", { gap: true }),
	row("speech-requests", "withdrawMySpeechRequest", "self", { gap: true }),
	row("speech-requests", "scheduleRequestedSpeech", "admin", { gap: true }),
	row("guest-rsvp", "submitGuestRsvp", "public", {
		notOnConnector: {
			category: "public path",
			reason: "session-less RSVP from the guest's own link",
		},
	}),
	row("timings", "recordTiming", "public", {
		notOnConnector: {
			category: "UI-only state",
			reason: "the live timer page records durations as a device",
		},
	}),
	row("progress-marks", "markMyProject", "self", { gap: true }),
	row("progress-marks", "unmarkMyProject", "self", { gap: true }),
	row("progress-marks", "markMemberProject", "self", { gap: true }),
	row("progress-marks", "unmarkMemberProject", "self", { gap: true }),
	row("impersonation", "startImpersonation", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "impersonation is a console feature",
		},
	}),
	row("impersonation", "endImpersonation", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "impersonation is a console feature",
		},
	}),
	row("action-items", "addActionItem", "admin", { gap: true }),
	row("action-items", "editActionItem", "admin", { gap: true }),
	row("action-items", "closeActionItem", "admin", { gap: true }),
	row("action-items", "restoreActionItem", "admin", { gap: true }),
	row("action-items", "removeActionItem", "admin", { gap: true }),
	row("batch-meetings", "batchCreateMeetings", "admin", { gap: true }),
	row("guest-pipeline", "submitGuestBook", "public", {
		notOnConnector: {
			category: "public path",
			reason: "a visitor registers themselves at the meeting",
		},
	}),
	row("guest-pipeline", "recordGuestInvite", "admin", { gap: true }),
	row("guest-pipeline", "setGuestStage", "admin", { gap: true }),
	row("guest-pipeline", "updateGuest", "admin", { gap: true }),
	row("guest-pipeline", "deleteGuest", "admin", { gap: true }),
	row("guest-pipeline", "convertGuestToMember", "admin", { gap: true }),
	row("guest-pipeline", "linkGuestToMember", "admin", { gap: true }),
	row("guest-pipeline", "unlinkGuestFromMember", "admin", { gap: true }),
	row("guest-pipeline", "undoGuestConversion", "admin", { gap: true }),
	row("guest-pipeline", "addGuestToClub", "admin", { gap: true }),
	row("guest-pipeline", "separateGuest", "admin", { gap: true }),
	row("guest-pipeline", "linkGuestAcrossClubs", "admin", { gap: true }),
	row("outreach", "setContacted", "admin", { gap: true }),
	row("outreach", "clearContacted", "admin", { gap: true }),
	row("areas", "createDistrict", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("areas", "createDivision", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("areas", "createArea", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("areas", "renameDivision", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("areas", "renameArea", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("areas", "addAreaClub", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("areas", "linkAreaClub", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("areas", "removeAreaClub", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("areas", "findUserForDirector", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("areas", "assignAreaDirector", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("areas", "endAreaDirectorTerm", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("access-requests", "submitAccessRequest", "public", {
		notOnConnector: {
			category: "public path",
			reason: "a signed-out person asks a club for access",
		},
	}),
	row("agenda-plan-pending", "applyAgendaPendingPlan", "admin", {
		notOnConnector: {
			category: "confirm-link step",
			reason:
				"upsert_agendas does not call this: it stages the plan, and the signed-in human applies it from the link, by design",
		},
	}),
	row("onboarding", "provisionClub", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("onboarding", "updateConsoleAdminEmail", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("onboarding", "archiveConsoleClub", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("onboarding", "unarchiveConsoleClub", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("onboarding", "deleteConsoleClub", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("onboarding", "revertConsoleClubToChartering", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("onboarding", "resetDemoClubFromConsole", "superadmin", {
		notOnConnector: {
			category: "superadmin only",
			reason: "a console feature for the platform operator, not a club officer",
		},
	}),
	row("meetings", "createMeeting", "admin", { gap: true }),
	row("meetings", "updateMeeting", "member", { gap: true }),
	row("meetings", "updateWordOfTheDay", "member", { gap: true }),
	row("meetings", "updateTableTopicsNotes", "member", { gap: true }),
	row("meetings", "completeMeeting", "admin", { gap: true }),
	row("meetings", "setMeetingDigitalVoting", "admin", { gap: true }),
	row("meetings", "reopenMeeting", "admin", { gap: true }),
	row("meetings", "cancelMeeting", "admin", { tool: "cancel_meeting" }),
	row("meetings", "restoreMeeting", "admin", { tool: "restore_meeting" }),
	row("role-feedback", "leaveFeedback", "public", { gap: true }),
	row("role-feedback", "deleteMyFeedback", "self", { gap: true }),
	row("role-feedback", "markMyFeedbackSeen", "self", {
		notOnConnector: {
			category: "UI-only state",
			reason: "marks feedback as read in the app",
		},
	}),
	row("whats-new", "markWhatsNewSeen", "self", {
		notOnConnector: {
			category: "UI-only state",
			reason: "a dismissed what's-new banner",
		},
	}),
	row("whats-new", "markFeatureSeen", "self", {
		notOnConnector: {
			category: "UI-only state",
			reason: "a dismissed feature tip",
		},
	}),
	row("members", "editMember", "admin", { tool: "edit_member" }),
	row("members", "mergeMembers", "admin", { gap: true }),
	row("members", "removeMember", "admin", { gap: true }),
	row("members", "setMemberStatus", "admin", { gap: true }),
	row("members", "setMemberRole", "admin", { gap: true }),
	row("members", "bulkImportMembers", "admin", { tool: "add_members" }),
	row("account-invite", "inviteMember", "admin", { gap: true }),
	row("account-invite", "inviteAllMembers", "admin", { gap: true }),
	row("account-invite", "finishAccountClaim", "self", {
		notOnConnector: {
			category: "sign-in flow",
			reason: "claiming an account after a magic link",
		},
	}),
	row("slots", "claimSlot", "member", { tool: "claim_open_role" }),
	row("slots", "releaseSlot", "member", { gap: true }),
	row("slots", "confirmSlot", "member", { gap: true }),
	row("slots", "unconfirmSlot", "admin", { gap: true }),
	row("slots", "reassignSlot", "member", { gap: true }),
	// Own-slot-only: the tool writes a speaker slot the caller holds. Editing
	// another member's or a guest's speech stays in the app (#1571).
	row("slots", "updateSpeakerDetails", "member", {
		tool: "set_my_speech_details",
	}),
	row("slots", "addSpeakerSlot", "member", { tool: "edit_speaker_slots" }),
	row("slots", "removeSpeakerSlot", "member", { tool: "edit_speaker_slots" }),
	row("slots", "moveSpeakerSlot", "member", { tool: "edit_speaker_slots" }),
	row("slots", "moveEvaluatorSlot", "member", { tool: "edit_speaker_slots" }),
	row("slots", "addRoleSlot", "admin", { tool: "edit_role_slots" }),
	row("slots", "removeRoleSlot", "admin", { tool: "edit_role_slots" }),
	row("speeches", "archiveSpeech", "member", { gap: true }),
	row("speeches", "rescheduleSpeech", "member", { gap: true }),
	row("speeches", "editSpeechFromLog", "self", { gap: true }),
	row("oauth-grants", "disconnectConnectedApp", "self", {
		notOnConnector: {
			category: "connector management",
			reason:
				"revoking an app's access is done in the app, not by the app itself",
		},
	}),
	row("orientation", "setMyBasecampSetup", "self", {
		notOnConnector: {
			category: "UI-only state",
			reason: "the member's own Basecamp setup checklist",
		},
	}),
	row("orientation", "dismissMyOrientation", "self", {
		notOnConnector: {
			category: "UI-only state",
			reason: "a dismissed orientation card",
		},
	}),
	row("orientation", "startOrientation", "admin", { gap: true }),
	row("dcp", "startScoreboard", "admin", { gap: true }),
	row("dcp", "updateGoal", "admin", { gap: true }),
	row("dcp", "applyEducationSuggestions", "admin", { gap: true }),
	row("dcp", "applyTrainingSuggestion", "admin", { gap: true }),
	row("dcp", "updateBaseMemberCount", "admin", { gap: true }),
	row("recurrence-rule", "saveClubRecurrenceRule", "admin", {
		tool: "update_meeting_schedule",
	}),
	row("recurrence-rule", "deleteClubRecurrenceRule", "admin", { gap: true }),
	row("cover", "releaseOwnSlotForCover", "member", { gap: true }),
	row("cover", "undoReleaseForCover", "member", { gap: true }),
	row("cover", "askForCover", "member", { gap: true }),
	row("history-import", "uploadEasySpeakBundle", "admin", { gap: true }),
	row("history-import", "previewEasySpeakImport", "admin", { gap: true }),
	row("history-import", "applyEasySpeakImport", "admin", { gap: true }),
	row("history-import", "importEasySpeakSpeechRequests", "admin", {
		gap: true,
	}),
	row("history-import", "importEasySpeakMentors", "admin", { gap: true }),
	row("contact-preference", "setMyPreferredContact", "self", { gap: true }),
	row("meeting-agenda-edit", "addAgendaRowFn", "admin", {
		tool: "edit_agenda",
	}),
	row("meeting-agenda-edit", "updateAgendaRowFn", "admin", {
		tool: "edit_agenda",
	}),
	row("meeting-agenda-edit", "removeAgendaRowFn", "admin", {
		tool: "edit_agenda",
	}),
	row("meeting-agenda-edit", "moveAgendaRowFn", "admin", {
		tool: "edit_agenda",
	}),
	row("meeting-agenda-edit", "addAgendaRoleFn", "admin", { gap: true }),
	row("meeting-agenda-edit", "removeAgendaRoleFn", "admin", { gap: true }),
	row("minutes", "setAttendance", "admin", { tool: "record_attendance" }),
	row("minutes", "addMinutesGuest", "admin", { tool: "record_attendance" }),
	row("minutes", "removeMinutesGuest", "admin", { tool: "record_attendance" }),
	row("minutes", "addTableTopics", "member", { tool: "record_table_topics" }),
	row("minutes", "removeTableTopics", "member", {
		tool: "record_table_topics",
	}),
	row("minutes", "moveTableTopics", "member", { tool: "record_table_topics" }),
	row("minutes", "setMinutesAward", "member", { tool: "set_awards" }),
	row("minutes", "clearMinutesAward", "member", { tool: "set_awards" }),
	row("charter", "updateCharterTarget", "admin", { gap: true }),
	row("charter", "startCharterChecklist", "admin", { gap: true }),
	row("charter", "addCharterStep", "admin", { gap: true }),
	row("charter", "renameCharterStep", "admin", { gap: true }),
	row("charter", "setCharterStepDone", "admin", { gap: true }),
	row("charter", "removeCharterStep", "admin", { gap: true }),
	row("charter", "reorderCharterSteps", "admin", { gap: true }),
	row("charter", "addCharterHelper", "admin", { gap: true }),
	row("charter", "removeCharterHelper", "admin", { gap: true }),
	row("promo", "updatePromoTemplate", "admin", { gap: true }),
	row("promo", "resetPromoTemplate", "admin", { gap: true }),
	row("guests", "assignGuestSlot", "admin", { tool: "assign_roles" }),
	row("guests", "updateGuestProfile", "admin", { gap: true }),
];
