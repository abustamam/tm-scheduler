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
