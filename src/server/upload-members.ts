/**
 * Server-fns for the VPE membership-CSV upload (#62). Admin-gated
 * (`requireClubRole(["admin"])`). Per the client-bundle rule, this module
 * exports ONLY createServerFns + types — the db logic lives in the sibling
 * `upload-members-logic.ts` (see `members.ts` / the server-modules guard test).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole, requireUser } from "./guards";
import {
	commitMemberImport,
	type ImportCommitResult,
	type ImportPreviewResult,
	previewMemberImport,
} from "./upload-members-logic";

export type { ImportCommitResult, ImportPreviewResult };

const uploadSchema = z.object({
	clubId: z.string().uuid(),
	// Raw CSV text (the client reads the File via `file.text()`). A TM export is a
	// few KB even for a large club, so JSON text is fine — no multipart needed.
	// Bounded to 2 MB so an authenticated admin can't force unbounded parse/memory
	// or a long DB-connection hold via a huge payload (matches the batch-size caps
	// on other endpoints, e.g. pathways-ingest).
	csv: z.string().min(1).max(2_000_000),
});

/** Dry-run: parse + classify the upload into an insert/update/skip diff. */
export const previewMemberUpload = createServerFn({ method: "POST" })
	.validator((i: unknown) => uploadSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return previewMemberImport(data.clubId, data.csv);
	});

/** Commit the upload after the admin confirms the preview. */
export const commitMemberUpload = createServerFn({ method: "POST" })
	.validator((i: unknown) => uploadSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return commitMemberImport(data.clubId, data.csv);
	});
