import { useCallback, useEffect, useState } from "react";

export interface StoredMember {
	id: string;
	name: string;
}
export const memberKey = (clubId: string) => `gavelup:member:${clubId}`;

export function readStoredMember(clubId: string): StoredMember | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(memberKey(clubId));
		if (!raw) return null;
		const v = JSON.parse(raw);
		return typeof v?.id === "string" && typeof v?.name === "string" ? v : null;
	} catch {
		return null;
	}
}
export function storeMember(clubId: string, m: StoredMember) {
	localStorage.setItem(memberKey(clubId), JSON.stringify(m));
}
export function clearStoredMember(clubId: string) {
	localStorage.removeItem(memberKey(clubId));
}

/** SSR-safe hook. `member` is null until mounted (server render) and when unset. */
export function useCurrentMember(clubId: string) {
	const [member, setMember] = useState<StoredMember | null>(null);
	useEffect(() => {
		setMember(readStoredMember(clubId));
	}, [clubId]);
	const set = useCallback(
		(m: StoredMember) => {
			storeMember(clubId, m);
			setMember(m);
		},
		[clubId],
	);
	const clear = useCallback(() => {
		clearStoredMember(clubId);
		setMember(null);
	}, [clubId]);
	return { member, setMember: set, clearMember: clear };
}
