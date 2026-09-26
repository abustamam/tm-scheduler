/**
 * The club data export's URL (#915). Pure — no `#/db` import — so the two
 * links to it (Club settings' "Download export" and the roster's "Export club
 * data") and the route test build the same string.
 *
 * `/export/zip`, not `/export.zip`: TanStack's file router reads every `.` in
 * `clubs.$clubId.export.zip.ts` as a path separator, the same way
 * `meetings.$id.minutes.pdf.ts` serves `/minutes/pdf`. The downloaded file's
 * NAME comes from the route's `content-disposition`, not from this path.
 */
export function clubExportUrl(clubId: string): string {
	return `/api/clubs/${encodeURIComponent(clubId)}/export/zip`;
}

/** The `impersonating` field of `getAuthContext`, as route context carries it. */
export interface ExportImpersonation {
	clubId: string;
	mode: "read_only" | "read_write";
}

/**
 * Whether the export link may be shown for `clubId`, given the viewer is
 * otherwise an admin there. False under "View as this club" (a `read_only`
 * impersonation of that club): `getAuthContext` surfaces the impersonated club
 * with `clubRole: "admin"`, so every admin check on the client passes, while
 * the route's `requireClubRole` refuses a read-only session by construction. A
 * link there is a guaranteed 403. `read_write` ("Act as admin") is served, so
 * it keeps the link.
 */
export function exportLinkAllowed(
	impersonating: ExportImpersonation | null | undefined,
	clubId: string,
): boolean {
	return !(
		impersonating?.mode === "read_only" && impersonating.clubId === clubId
	);
}
