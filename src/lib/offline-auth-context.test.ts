import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AuthContextValue,
	type AuthRouteContext,
	clearCachedAuthContext,
	decideAuth,
	persistAuthContext,
	readCachedAuthContext,
	STORAGE_KEY,
} from "./offline-auth-context";

// Vitest runs in the `node` environment (no DOM), so stub a minimal, in-memory
// `localStorage` for the persistence round-trip.
class MemoryStorage {
	private store = new Map<string, string>();
	get length() {
		return this.store.size;
	}
	clear() {
		this.store.clear();
	}
	getItem(key: string) {
		return this.store.has(key) ? (this.store.get(key) as string) : null;
	}
	setItem(key: string, value: string) {
		this.store.set(key, String(value));
	}
	removeItem(key: string) {
		this.store.delete(key);
	}
	key(index: number) {
		return [...this.store.keys()][index] ?? null;
	}
}

const authed: AuthRouteContext = {
	authUser: { id: "user-1", name: "Ada", email: "ada@example.com" },
	clubs: [
		{ clubId: "club-1", name: "Acme TM", clubNumber: "42", clubRole: "admin" },
	],
	currentMemberId: "member-1",
	activeClubId: "club-1",
	isSuperadmin: false,
};

// The resolved auth-context server-fn value when signed in / signed out. Cast to
// the server-fn value type — the signed-out branch is a distinct literal union
// member (`clubs: []`) that a plain object literal won't infer to.
const signedInValue = {
	user: authed.authUser,
	clubs: authed.clubs,
	currentMemberId: authed.currentMemberId,
	activeClubId: authed.activeClubId,
	isSuperadmin: authed.isSuperadmin,
} as AuthContextValue;
const signedOutValue = {
	user: null,
	clubs: [],
	currentMemberId: null,
	activeClubId: null,
	isSuperadmin: false,
} as AuthContextValue;

describe("offline-auth-context persistence", () => {
	beforeEach(() => {
		(globalThis as { localStorage?: unknown }).localStorage =
			new MemoryStorage();
	});
	afterEach(() => {
		(globalThis as { localStorage?: unknown }).localStorage = undefined;
	});

	it("persists then reads back the cached context", () => {
		expect(readCachedAuthContext()).toBeNull();
		persistAuthContext(authed);
		expect(readCachedAuthContext()).toEqual(authed);
	});

	it("clears the cached context", () => {
		persistAuthContext(authed);
		clearCachedAuthContext();
		expect(readCachedAuthContext()).toBeNull();
	});

	it("returns null for a corrupt / non-context payload", () => {
		// The key must match STORAGE_KEY. When it drifted (v1 here, v2 in the module)
		// both assertions still passed — but only because an unknown key reads as
		// empty, which the test above already covers. The `JSON.parse` catch and the
		// `isValidContext` rejection were executed by nothing and could both have been
		// deleted with the suite green.
		localStorage.setItem(STORAGE_KEY, "{not json");
		expect(readCachedAuthContext()).toBeNull();
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ foo: 1 }));
		expect(readCachedAuthContext()).toBeNull();
	});

	it("ignores a payload left under a superseded key (#560)", () => {
		// Bumping STORAGE_KEY is the sweep that stops a device serving an archived
		// club's name and number from before the takedown. Pins the bump itself: point
		// the module back at v1 and this fails.
		const v1Payload = JSON.stringify({
			// `authUser`, not `user` — this must be a VALID context, or the test would
			// pass on the shape check alone and prove nothing about the key.
			authUser: { id: "u1", name: "Old", email: "old@test.example" },
			clubs: [{ clubId: "c1", name: "Taken Down TM", clubRole: "member" }],
			currentMemberId: null,
			activeClubId: "c1",
			isSuperadmin: false,
		});
		// Control: written under the CURRENT key it reads back, so the assertion below
		// is about the key and nothing else.
		localStorage.setItem(STORAGE_KEY, v1Payload);
		expect(readCachedAuthContext()).not.toBeNull();

		localStorage.clear();
		localStorage.setItem("gavelup.auth-context.v1", v1Payload);
		expect(readCachedAuthContext()).toBeNull();
	});

	it("is a safe no-op when localStorage is unavailable (SSR)", () => {
		(globalThis as { localStorage?: unknown }).localStorage = undefined;
		expect(() => persistAuthContext(authed)).not.toThrow();
		expect(readCachedAuthContext()).toBeNull();
	});
});

describe("decideAuth — offline fallback vs. genuine sign-out", () => {
	it("returns fresh authed context when the call resolves with a user", () => {
		const decision = decideAuth({ ok: true, value: signedInValue }, null);
		expect(decision).toEqual({ kind: "authed", fresh: true, context: authed });
	});

	it("redirects when the call resolves with NO user (genuine sign-out), even with a cache", () => {
		// Reached the server: a real signed-out response must NOT fall back.
		const decision = decideAuth({ ok: true, value: signedOutValue }, authed);
		expect(decision).toEqual({ kind: "redirect" });
	});

	it("falls back to the cached context when the call THROWS (offline)", () => {
		const decision = decideAuth(
			{ ok: false, error: new TypeError("Failed to fetch") },
			authed,
		);
		expect(decision).toEqual({ kind: "authed", fresh: false, context: authed });
	});

	it("redirects when the call throws (offline) and there is NO cache", () => {
		const decision = decideAuth(
			{ ok: false, error: new TypeError("Failed to fetch") },
			null,
		);
		expect(decision).toEqual({ kind: "redirect" });
	});
});
