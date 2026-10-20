import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { requireSuperadmin, requireUser } from "./guards";
import {
	applyEasySpeakImport as applyEasySpeakImportLogic,
	importApplySchema,
	importClubSchema,
	importRunSchema,
	importSpeechRequests as importSpeechRequestsLogic,
	listClubImports as listClubImportsLogic,
	previewEasySpeakImport as previewEasySpeakImportLogic,
	storedImportSchema,
	storeEasySpeakBundle as storeEasySpeakBundleLogic,
	uploadImportSchema,
} from "./history-import-logic";
import { getActiveImpersonationForUser } from "./impersonation-logic";
import { importMentorPairs as importMentorPairsLogic } from "./mentor-import-logic";

// The Easy-Speak history import (#1051): superadmin only. EVERY fn here runs
// `requireUser()` then `requireSuperadmin()` before it touches the logic
// (`history-import-authz.guard.test.ts` pins that order), because
// `history-import-logic.ts` has no session of its own and writes club data.
//
// This module is imported by client route files, so it exports ONLY
// createServerFns (server-modules.guard.test.ts).

const READ_ONLY_IMPERSONATION_MESSAGE =
	"A read-only impersonation session cannot upload or apply an import. End it, or start an Act as admin session.";

/** Upload and apply both write club data; a read-only impersonation session writes none. */
async function assertNotReadOnlyImpersonation(userId: string): Promise<void> {
	const impersonation = await getActiveImpersonationForUser(userId);
	if (impersonation?.mode === "read_only") {
		throw new Error(READ_ONLY_IMPERSONATION_MESSAGE);
	}
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
	const result = schema.safeParse(input);
	if (!result.success) {
		throw new Error(result.error.issues[0]?.message ?? "Invalid input");
	}
	return result.data;
}

/** The club's stored imports, newest first. */
export const listEasySpeakImports = createServerFn({ method: "GET" })
	.validator((input: unknown) => parse(importClubSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return listClubImportsLogic(data.clubId);
	});

/** Store an uploaded bundle (validated, size-capped, deduplicated by hash). Refused under read-only impersonation. */
export const uploadEasySpeakBundle = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(uploadImportSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		await assertNotReadOnlyImpersonation(currentUser.id);
		return storeEasySpeakBundleLogic({
			clubId: data.clubId,
			uploadedByUserId: currentUser.id,
			text: data.text,
		});
	});

/**
 * The plan for a stored bundle with the given person decisions; writes nothing.
 * POST only because the decisions ride in the body: a GET would put them in the URL.
 */
export const previewEasySpeakImport = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(importRunSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return previewEasySpeakImportLogic({
			clubId: data.clubId,
			importId: data.importId,
			resolutions: data.resolutions,
			contacts: data.contacts,
		});
	});

/** Apply a stored bundle. Refused while anyone is unresolved and under read-only impersonation. */
export const applyEasySpeakImport = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(importApplySchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		await assertNotReadOnlyImpersonation(currentUser.id);
		return applyEasySpeakImportLogic({
			clubId: data.clubId,
			importId: data.importId,
			superadminUserId: currentUser.id,
			resolutions: data.resolutions,
			planHash: data.planHash,
			contacts: data.contacts,
		});
	});

/**
 * Import the stored bundle's open speech requests into the club's queue (#1052).
 * A step of its own, after Apply: it matches requesters to the people Apply
 * resolved. Idempotent. Refused under read-only impersonation.
 */
export const importEasySpeakSpeechRequests = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(storedImportSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		await assertNotReadOnlyImpersonation(currentUser.id);
		return importSpeechRequestsLogic({
			clubId: data.clubId,
			importId: data.importId,
			superadminUserId: currentUser.id,
		});
	});

/**
 * Import the stored bundle's mentor pairs as pairings (#1053). A step of its
 * own, after Apply: it matches both people to those Apply resolved. Idempotent.
 * Refused under read-only impersonation.
 */
export const importEasySpeakMentors = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(storedImportSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		await assertNotReadOnlyImpersonation(currentUser.id);
		return importMentorPairsLogic({
			clubId: data.clubId,
			importId: data.importId,
			superadminUserId: currentUser.id,
		});
	});
