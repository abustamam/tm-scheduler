import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AuthContextValue,
	type AuthRouteContext,
	clearCachedAuthContext,
	decideAuth,
	persistAuthContext,
	readCachedAuthContext,
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
		localStorage.setItem("gavelup.auth-context.v1", "{not json");
		expect(readCachedAuthContext()).toBeNull();
		localStorage.setItem("gavelup.auth-context.v1", JSON.stringify({ foo: 1 }));
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
