/**
 * Server-fns for the club-logo upload/remove/meta (#495). Admin-gated
 * (`requireClubRole(["admin"])` for the two mutations), mirroring
 * `upload-members.ts`. Per the client-bundle rule, this module exports ONLY
 * createServerFns + types — the db logic lives in the sibling
 * `club-logo-logic.ts` (`server-modules.guard.test.ts` enforces this).
 *
 * Transport is base64-in-JSON via `createServerFn`, exactly like
 * `upload-members.ts`'s CSV text — no multipart path exists in this repo.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	applyClubLogoUpload,
	type ClubLogoMeta,
	loadClubLogoMeta,
	removeClubLogo,
} from "./club-logo-logic";
import { requireClubRole, requireUser } from "./guards";

export type { ClubLogoMeta };

const clubIdSchema = z.object({
	clubId: z.string().uuid(),
});

const uploadSchema = z.object({
	clubId: z.string().uuid(),
	// Base64-encoded image bytes (the client reads the File via
	// `file.arrayBuffer()` → base64, matching the CSV-text transport in
	// upload-members.ts). Capped on the ENCODED string; the server separately
	// enforces a 256 KB cap on the DECODED bytes (club-logo-logic.ts), since
	// base64 inflates size ~33% — the two numbers are deliberately different.
	base64: z.string().min(1).max(350_000),
	// Client-declared MIME — validated (allow-list + magic-byte sniff) server
	// side in club-logo-logic.ts, never trusted here.
	mime: z.string(),
	// The required "I confirm my club is authorized to use this image"
	// checkbox. Re-validated server-side in the logic layer — the disabled
	// submit button on the client is not the gate (ADR-0024 constraint 3).
	attested: z.boolean(),
});

/** Upload (insert or replace) the club's logo. */
export const uploadClubLogo = createServerFn({ method: "POST" })
	.validator((i: unknown) => uploadSchema.parse(i))
	.handler(async ({ data }) => {
		const sessionUser = await requireUser();
		await requireClubRole(sessionUser.id, data.clubId, ["admin"]);
		await applyClubLogoUpload({
			clubId: data.clubId,
			base64: data.base64,
			mime: data.mime,
			attested: data.attested,
			userId: sessionUser.id,
		});
	});

/** Remove the club's logo. No-op when none is set. */
export const removeClubLogoFn = createServerFn({ method: "POST" })
	.validator((i: unknown) => clubIdSchema.parse(i))
	.handler(async ({ data }) => {
		const sessionUser = await requireUser();
		await requireClubRole(sessionUser.id, data.clubId, ["admin"]);
		await removeClubLogo(data.clubId);
	});

/**
 * Existence + version for a club's logo. Public (no auth): a club logo isn't
 * PII, and the same information (whether a logo exists, and its version) is
 * already exposed by the public `<img>` URL the printed agenda embeds. Used
 * by the club-settings admin UI to render the current preview / "remove"
 * affordance.
 */
export const getClubLogoMeta = createServerFn({ method: "POST" })
	.validator((i: unknown) => clubIdSchema.parse(i))
	.handler(async ({ data }) => {
		const meta = await loadClubLogoMeta(data.clubId);
		return meta ? { updatedAt: meta.updatedAt.toISOString() } : null;
	});
