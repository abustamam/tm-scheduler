import { useCallback, useSyncExternalStore } from "react";

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
	emitChange();
}
export function clearStoredMember(clubId: string) {
	localStorage.removeItem(memberKey(clubId));
	emitChange();
}

// ---------------------------------------------------------------------------
// Shared external store: every `useCurrentMember` instance subscribes here, so
// a `setMember`/`clearMember` in one component (e.g. the home's "not you?")
// immediately re-renders the gate and any other consumer — and cross-tab
// `storage` events are picked up too.
// ---------------------------------------------------------------------------
const listeners = new Set<() => void>();
function emitChange() {
	for (const l of listeners) l();
}
function subscribe(cb: () => void) {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === null || e.key.startsWith("gavelup:member:")) cb();
	};
	if (typeof window !== "undefined") {
		window.addEventListener("storage", onStorage);
	}
	return () => {
		listeners.delete(cb);
		if (typeof window !== "undefined") {
			window.removeEventListener("storage", onStorage);
		}
	};
}

// `useSyncExternalStore` requires a stable snapshot reference when nothing
// changed, or it re-renders forever. Cache the parsed value per club and only
// re-parse when the raw localStorage string actually differs.
const snapshotCache = new Map<
	string,
	{ raw: string | null; value: StoredMember | null }
>();
function getSnapshot(clubId: string): StoredMember | null {
	if (typeof localStorage === "undefined") return null;
	const raw = localStorage.getItem(memberKey(clubId));
	const cached = snapshotCache.get(clubId);
	if (cached && cached.raw === raw) return cached.value;
	const value = readStoredMember(clubId);
	snapshotCache.set(clubId, { raw, value });
	return value;
}

/** SSR-safe hook backed by a shared store. `member` is null on the server and
 * during hydration, then reflects localStorage; all instances stay in sync. */
export function useCurrentMember(clubId: string) {
	const member = useSyncExternalStore(
		subscribe,
		() => getSnapshot(clubId),
		() => null,
	);
	const setMember = useCallback(
		(m: StoredMember) => storeMember(clubId, m),
		[clubId],
	);
	const clearMember = useCallback(() => clearStoredMember(clubId), [clubId]);
	return { member, setMember, clearMember };
}
