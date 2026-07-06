import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	type BcmProgressPage,
	normalizePages,
	type ParsedMemberPath,
	parseProgressPages,
} from "#/lib/basecamp-progress";
import { requireClubRole, requireUser } from "./guards";
import { type SyncResult, syncClubProgress } from "./pathways-sync-logic";

const ingestSchema = z.object({
	clubId: z.string().uuid(),
	// The raw JSON the VPE pastes: a single BCM page object or an array of them.
	json: z.string().min(1),
});

/** Ingest pasted Base Camp `/api/bcm/progress` JSON for a club. Admin/VPE only. */
export const ingestPathwaysProgress = createServerFn({ method: "POST" })
	.validator((i: unknown) => ingestSchema.parse(i))
	.handler(async ({ data }): Promise<SyncResult> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin", "vpe"]);

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(data.json);
		} catch {
			throw new Error("Pasted content is not valid JSON.");
		}
		let rows: ParsedMemberPath[];
		try {
			const pages = normalizePages(
				parsedJson as BcmProgressPage | BcmProgressPage[],
			);
			rows = parseProgressPages(pages);
		} catch {
			throw new Error(
				"Pasted content doesn't look like a Base Camp progress payload (expected the /api/bcm/progress JSON).",
			);
		}

		return syncClubProgress(data.clubId, rows);
	});
