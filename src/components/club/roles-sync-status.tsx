// #1651: the Roles tab's offline-queue indicator. A role change queued offline
// (#1638) reports here, from the route's one `useOfflineMinutes` instance.
//
// Member-only: every other `<SyncStatus>` is limited to signed-in members or
// editors, and this one must be too. An anonymous visitor can queue nothing, and
// would otherwise see the held-role-changes line with Discard (`discardHeld` has
// no identity check) and could throw away another member's queued changes.
import {
	SyncStatus,
	type SyncStatusProps,
} from "#/components/club/sync-status";

export function RolesSyncStatus({
	shell,
	sync,
}: {
	shell: boolean;
	sync: SyncStatusProps;
}) {
	if (!shell) return null;
	return <SyncStatus {...sync} />;
}
