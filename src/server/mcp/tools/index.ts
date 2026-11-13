/**
 * THE tool registry (#773).
 *
 * An explicit list, deliberately — the route must not walk a directory at
 * runtime, and a static list is what lets `tsc` see every tool. The risk an
 * explicit list carries is that a new tool file is simply forgotten, so
 * `mcp-authz.guard.test.ts` DERIVES the tool set from the directory and fails
 * when this list and the directory disagree in either direction: a file not
 * listed here, or a name listed here with no file.
 *
 * That pairing is the point. A hand-written list cannot fail for the case it
 * exists to catch — the tool that forgot its authorization check is missing from
 * the list too — which is how #544's nine hand-enrolled readers sat beside an
 * ungated `getMeeting` with the guard green.
 */
import type { McpToolDefinition } from "../tool";
import { addMembersTool } from "./add-members";
import { adoptStandardAgendaTool } from "./adopt-standard-agenda";
import { applyAgendaTemplateTool } from "./apply-agenda-template";
import { assignRolesTool } from "./assign-roles";
import { cancelMeetingTool } from "./cancel-meeting";
import { claimOpenRoleTool } from "./claim-open-role";
import { completeMeetingTool } from "./complete-meeting";
import { createMeetingsTool } from "./create-meetings";
import { deleteAgendaTemplateTool } from "./delete-agenda-template";
import { duplicateAgendaTemplateTool } from "./duplicate-agenda-template";
import { editAgendaTool } from "./edit-agenda";
import { editAgendaTemplateTool } from "./edit-agenda-template";
import { editMeetingTool } from "./edit-meeting";
import { editMemberTool } from "./edit-member";
import { editRoleSlotsTool } from "./edit-role-slots";
import { editSpeakerSlotsTool } from "./edit-speaker-slots";
import { findPeopleTool } from "./find-people";
import { getAgendaTool } from "./get-agenda";
import { getImportReportTool } from "./get-import-report";
import { getLineupBlastTool } from "./get-lineup-blast";
import { getMyFeedbackTool } from "./get-my-feedback";
import { getMyScheduleTool } from "./get-my-schedule";
import { listAgendaTemplatesTool } from "./list-agenda-templates";
import { listMeetingsTool } from "./list-meetings";
import { recordAttendanceTool } from "./record-attendance";
import { recordGuestBookTool } from "./record-guest-book";
import { recordTableTopicsTool } from "./record-table-topics";
import { releaseMyRoleTool } from "./release-my-role";
import { reopenMeetingTool } from "./reopen-meeting";
import { requestCoverTool } from "./request-cover";
import { rescheduleMeetingTool } from "./reschedule-meeting";
import { restoreMeetingTool } from "./restore-meeting";
import { saveAgendaAsTemplateTool } from "./save-agenda-as-template";
import { setAttendanceTool } from "./set-attendance";
import { setAwardsTool } from "./set-awards";
import { setContactPreferenceTool } from "./set-contact-preference";
import { setDefaultAgendaTemplateTool } from "./set-default-agenda-template";
import { setMemberStandingTool } from "./set-member-standing";
import { setMyAttendanceTool } from "./set-my-attendance";
import { setMyContactPreferenceTool } from "./set-my-contact-preference";
import { setMySpeechDetailsTool } from "./set-my-speech-details";
import { updateMeetingScheduleTool } from "./update-meeting-schedule";
import { upsertAgendasTool } from "./upsert-agendas";
import { whoamiTool } from "./whoami";

export const MCP_TOOLS: McpToolDefinition[] = [
	whoamiTool,
	listMeetingsTool,
	getAgendaTool,
	getLineupBlastTool,
	getImportReportTool,
	getMyFeedbackTool,
	getMyScheduleTool,
	setMyAttendanceTool,
	setMyContactPreferenceTool,
	setAttendanceTool,
	recordAttendanceTool,
	claimOpenRoleTool,
	requestCoverTool,
	releaseMyRoleTool,
	findPeopleTool,
	recordGuestBookTool,
	assignRolesTool,
	setAwardsTool,
	recordTableTopicsTool,
	upsertAgendasTool,
	editAgendaTool,
	listAgendaTemplatesTool,
	saveAgendaAsTemplateTool,
	applyAgendaTemplateTool,
	editAgendaTemplateTool,
	duplicateAgendaTemplateTool,
	deleteAgendaTemplateTool,
	setDefaultAgendaTemplateTool,
	adoptStandardAgendaTool,
	editMeetingTool,
	editRoleSlotsTool,
	editSpeakerSlotsTool,
	cancelMeetingTool,
	restoreMeetingTool,
	createMeetingsTool,
	completeMeetingTool,
	reopenMeetingTool,
	rescheduleMeetingTool,
	updateMeetingScheduleTool,
	setContactPreferenceTool,
	addMembersTool,
	editMemberTool,
	setMemberStandingTool,
	setMySpeechDetailsTool,
];
