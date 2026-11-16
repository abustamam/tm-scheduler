// The key a role op compares holders by (#1638), in ONE place for the server's
// comparison and the client's projection: `"m:<memberId>"` for a member,
// `"g:<guestId>"` for a guest, null for an open slot. A guest wins when both
// ids are somehow set, as in the server's comparison. Client-safe.
export type HolderKey = string | null;

export function holderKey(
	memberId: string | null | undefined,
	guestId: string | null | undefined,
): HolderKey {
	if (guestId) return `g:${guestId}`;
	if (memberId) return `m:${memberId}`;
	return null;
}
