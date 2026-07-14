// Offline minutes write-queue (issue #176 slice 3). CLIENT-ONLY.
//
// When the minutes screen is OFFLINE, each edit is captured here as a durable
// `MinutesOp` in IndexedDB (keyed by meetingId) and the last online `getMinutes`
// result is stashed as a snapshot. `deriveMinutes(snapshot, ops)` then rebuilds
// the displayed state optimistically. Slice 4 drains this queue back to the
// server on reconnect; this module only persists — it never touches the network.
//
// This file must NOT import `#/db` (that would drag `pg` into the client
// bundle). `MinutesData` / `AttendanceStatus` / `AwardCategory` are imported
// TYPE-ONLY from the server logic module, so they are erased at build time.
import type {
	AttendanceStatus,
	AwardCategory,
	MinutesData,
} from "#/server/minutes-logic";

/** Contact fields for a brand-new club guest (name required, contact optional). */
export type NewGuestPayload = {
	name: string;
	email?: string;
	phone?: string;
};

/**
 * A single queued minutes edit. Mirrors one server mutation each. Every op
 * carries a generated `opId` (queue-entry identity) and `queuedAt`. Creates also
 * carry a client-generated ENTITY id (`guestId` for a new guest, `id` for a new
 * Table Topics speaker row) — the same id slice 2's server-fns accept, so a
 * later replay is idempotent. `name`/`isGuest` are the resolved values needed to
 * render the optimistic row without a round-trip.
 */
export type MinutesOp =
	| {
			type: "setAttendance";
			opId: string;
			queuedAt: number;
			memberId: string;
			status: AttendanceStatus;
	  }
	| {
			type: "addGuest";
			opId: string;
			queuedAt: number;
			/** Client-generated id for a new guest, or the existing club guest's id. */
			guestId: string;
			/** Resolved display name (for the optimistic render). */
			name: string;
			/** Present ⇒ new-guest create path; absent ⇒ existing `guestId`. */
			newGuest?: NewGuestPayload;
	  }
	| {
			type: "removeGuest";
			opId: string;
			queuedAt: number;
			guestId: string;
	  }
	| {
			type: "addTableTopics";
			opId: string;
			queuedAt: number;
			/** Client-generated Table Topics speaker-row id (the stable move/remove target). */
			id: string;
			name: string;
			isGuest: boolean;
			memberId?: string;
			guestId?: string;
			newGuest?: NewGuestPayload;
			topic?: string;
	  }
	| {
			type: "removeTableTopics";
			opId: string;
			queuedAt: number;
			id: string;
	  }
	| {
			type: "moveTableTopics";
			opId: string;
			queuedAt: number;
			id: string;
			direction: "up" | "down";
	  }
	| {
			type: "setAward";
			opId: string;
			queuedAt: number;
			category: AwardCategory;
			name: string;
			isGuest: boolean;
			memberId?: string;
			guestId?: string;
			newGuest?: NewGuestPayload;
	  }
	| {
			type: "clearAward";
			opId: string;
			queuedAt: number;
			category: AwardCategory;
	  };

/**
 * Minimal async key/value storage the queue is built on. IndexedDB in the
 * browser; an in-memory fake in unit tests (no real IndexedDB required).
 */
export interface KeyValueStore {
	get<T>(key: string): Promise<T | undefined>;
	set<T>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<void>;
}

const queueKey = (meetingId: string) => `queue:${meetingId}`;
const snapshotKey = (meetingId: string) => `snapshot:${meetingId}`;

/**
 * Build the queue API over a storage adapter. Injectable so tests can drive it
 * with an in-memory store; the browser default (below) uses IndexedDB.
 */
export function createOfflineMinutesQueue(store: KeyValueStore) {
	return {
		/** Append an op to a meeting's queue (order preserved). */
		async enqueue(meetingId: string, op: MinutesOp): Promise<void> {
			const existing =
				(await store.get<MinutesOp[]>(queueKey(meetingId))) ?? [];
			await store.set(queueKey(meetingId), [...existing, op]);
		},
		/** Read a meeting's queued ops in insertion order (empty when none). */
		async readQueue(meetingId: string): Promise<MinutesOp[]> {
			return (await store.get<MinutesOp[]>(queueKey(meetingId))) ?? [];
		},
		/** Drop every queued op for a meeting (slice 4 calls this after a drain). */
		async clearQueue(meetingId: string): Promise<void> {
			await store.delete(queueKey(meetingId));
		},
		/** Remove a single op by its `opId` (leaves the rest in order). */
		async removeOp(meetingId: string, opId: string): Promise<void> {
			const existing =
				(await store.get<MinutesOp[]>(queueKey(meetingId))) ?? [];
			await store.set(
				queueKey(meetingId),
				existing.filter((o) => o.opId !== opId),
			);
		},
		/** Persist the last online `getMinutes` result as the offline base. */
		async saveSnapshot(meetingId: string, minutes: MinutesData): Promise<void> {
			await store.set(snapshotKey(meetingId), minutes);
		},
		/** Read the persisted snapshot (null when none has been saved yet). */
		async readSnapshot(meetingId: string): Promise<MinutesData | null> {
			return (await store.get<MinutesData>(snapshotKey(meetingId))) ?? null;
		},
	};
}

export type OfflineMinutesQueue = ReturnType<typeof createOfflineMinutesQueue>;

// ---------------------------------------------------------------------------
// Storage adapters
// ---------------------------------------------------------------------------

const DB_NAME = "gavelup-offline";
const STORE_NAME = "minutes-kv";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const database = req.result;
			if (!database.objectStoreNames.contains(STORE_NAME)) {
				database.createObjectStore(STORE_NAME);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/** IndexedDB-backed store (browser only; a single string-keyed object store). */
export function indexedDbStore(): KeyValueStore {
	return {
		async get<T>(key: string): Promise<T | undefined> {
			const db = await openDb();
			try {
				return await new Promise<T | undefined>((resolve, reject) => {
					const tx = db.transaction(STORE_NAME, "readonly");
					const req = tx.objectStore(STORE_NAME).get(key);
					req.onsuccess = () =>
						resolve((req.result as T | undefined) ?? undefined);
					req.onerror = () => reject(req.error);
				});
			} finally {
				db.close();
			}
		},
		async set<T>(key: string, value: T): Promise<void> {
			const db = await openDb();
			try {
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction(STORE_NAME, "readwrite");
					tx.objectStore(STORE_NAME).put(value, key);
					tx.oncomplete = () => resolve();
					tx.onerror = () => reject(tx.error);
					tx.onabort = () => reject(tx.error);
				});
			} finally {
				db.close();
			}
		},
		async delete(key: string): Promise<void> {
			const db = await openDb();
			try {
				await new Promise<void>((resolve, reject) => {
					const tx = db.transaction(STORE_NAME, "readwrite");
					tx.objectStore(STORE_NAME).delete(key);
					tx.oncomplete = () => resolve();
					tx.onerror = () => reject(tx.error);
					tx.onabort = () => reject(tx.error);
				});
			} finally {
				db.close();
			}
		},
	};
}

/** In-memory store (structured-clone semantics) for tests and SSR fallback. */
export function memoryStore(): KeyValueStore {
	const map = new Map<string, unknown>();
	return {
		async get<T>(key: string): Promise<T | undefined> {
			return map.has(key) ? (structuredClone(map.get(key)) as T) : undefined;
		},
		async set<T>(key: string, value: T): Promise<void> {
			map.set(key, structuredClone(value));
		},
		async delete(key: string): Promise<void> {
			map.delete(key);
		},
	};
}

// ---------------------------------------------------------------------------
// Default browser singleton + convenience wrappers used by the component.
// ---------------------------------------------------------------------------

let defaultQueue: OfflineMinutesQueue | null = null;

function getDefaultQueue(): OfflineMinutesQueue {
	if (!defaultQueue) {
		const store =
			typeof indexedDB !== "undefined" ? indexedDbStore() : memoryStore();
		defaultQueue = createOfflineMinutesQueue(store);
	}
	return defaultQueue;
}

export const enqueue = (meetingId: string, op: MinutesOp) =>
	getDefaultQueue().enqueue(meetingId, op);
export const readQueue = (meetingId: string) =>
	getDefaultQueue().readQueue(meetingId);
export const clearQueue = (meetingId: string) =>
	getDefaultQueue().clearQueue(meetingId);
export const removeOp = (meetingId: string, opId: string) =>
	getDefaultQueue().removeOp(meetingId, opId);
export const saveSnapshot = (meetingId: string, minutes: MinutesData) =>
	getDefaultQueue().saveSnapshot(meetingId, minutes);
export const readSnapshot = (meetingId: string) =>
	getDefaultQueue().readSnapshot(meetingId);
