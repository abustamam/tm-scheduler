/**
 * `get_import_report` — what an Easy-Speak history import did (#1051).
 *
 * Read-only: applying an import stays in the superadmin console. It returns the
 * reconciliation report the apply stored with the `club_imports` row: for each
 * count the bundle's number, GavelUp's number and the source ids of any
 * difference, plus what was intentionally not imported. So "did the Easy-Speak
 * import lose anything?" can be answered from Claude.
 *
 * Authorized against the club id in the input (`authorizeToken`), which refuses
 * a club the token's owner is not an admin or officer of as FORBIDDEN and an
 * archived one as ARCHIVED. The lookup then carries the same club id, so an
 * `importId` that belongs to another club is NOT_FOUND, never its report.
 *
 * The report names people (guests and members who appear in the history, and
 * anyone skipped), like the agenda tools do. No contact details are in it.
 */
import { z } from "zod";
import { loadImportReport } from "#/server/history-import-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const inputSchema = {
	clubId: z.string().uuid(),
	importId: z
		.string()
		.uuid()
		.optional()
		.describe("A specific import; omit for the club's latest applied import."),
};

export const getImportReportTool: McpToolDefinition = {
	name: "get_import_report",
	audience: "officer",
	config: {
		title: "Get import report",
		description:
			"The reconciliation report of a club's Easy-Speak history import: for " +
			"each count the bundle's number, GavelUp's number and the source ids of " +
			"any difference, the meetings that failed, and what was intentionally " +
			"not imported. Returns the latest applied import unless an importId is " +
			"given. Read-only; applying an import is done by a superadmin in the " +
			"console.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club } = await authorizeToken(ctx, args.clubId);
		const found = await loadImportReport({
			clubId: club.clubId,
			importId: args.importId,
		});
		if (!found) {
			throw new McpError(
				"NOT_FOUND",
				"This club has no applied Easy-Speak import" +
					(args.importId ? " with that id." : "."),
			);
		}
		return {
			clubId: club.clubId,
			importId: found.importId,
			appliedAt: found.appliedAt.toISOString(),
			report: found.report,
		};
	},
};
