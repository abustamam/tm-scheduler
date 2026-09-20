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
import { assignRolesTool } from "./assign-roles";
import { findPeopleTool } from "./find-people";
import { getAgendaTool } from "./get-agenda";
import { listMeetingsTool } from "./list-meetings";
import { recordGuestBookTool } from "./record-guest-book";
import { upsertAgendasTool } from "./upsert-agendas";
import { whoamiTool } from "./whoami";

export const MCP_TOOLS: McpToolDefinition[] = [
	whoamiTool,
	listMeetingsTool,
	getAgendaTool,
	findPeopleTool,
	recordGuestBookTool,
	assignRolesTool,
	upsertAgendasTool,
];
