/**
 * Client-side cache of the last-known-good signed-in context (issue #176,
 * slice 1). The `_authed` layout's `beforeLoad` calls `getAuthContext()` — a
 * network round-trip — and redirects to `/signin` when there is no user. That
 * hard-fails offline: a cached meeting page can't render because the guard
 * can't reach the server to confirm the identity.
 *
 * So on every successful ONLINE guard we persist the resolved context here, and
 * when the guard call FAILS because the network is down we fall back to it — the
 * cached meeting view then renders with the user's identity. A genuine
 * "not signed in" response (the call reached the server and returned no user)
 * still redirects; only a thrown/rejected call (offline) triggers the fallback.
 *
 * Browser-only: on the server (SSR) there is no `localStorage`, so reads return
 * null and writes are no-ops — the offline fallback is purely a client concern.
 *
 * This module must NOT import `#/db` (it is bundled to the client). The
 * `import type` below is fully erased at build time.
 */
import type { getAuthContext } from "#/server/auth-context";

/** The resolved value of the auth-context server fn (`{ user, clubs, … }`). */
export type AuthContextValue = Awaited<ReturnType<typeof getAuthContext>>;

/**
 * The signed-in route context the `_authed` layout hands to the app shell
 * (mirrors the `beforeLoad` return shape). `authUser` is the non-null user.
 */
export type AuthRouteContext = {
	authUser: NonNullable<AuthContextValue["user"]>;
	clubs: AuthContextValue["clubs"];
	currentMemberId: AuthContextValue["currentMemberId"];
	activeClubId: AuthContextValue["activeClubId"];
	isSuperadmin: AuthContextValue["isSuperadmin"];
};

/** The outcome of invoking `getAuthContext()` in the guard. */
export type AuthContextOutcome =
	| { ok: true; value: AuthContextValue }
	| { ok: false; error: unknown };

/** What the guard should do next. Pure decision — no side effects. */
export type AuthDecision =
	| { kind: "authed"; context: AuthRouteContext; fresh: boolean }
	| { kind: "redirect" };

const STORAGE_KEY = "gavelup.auth-context.v1";

/** Safe `localStorage` handle, or null when unavailable (SSR / privacy mode). */
function storage(): Storage | null {
	try {
		if (typeof localStorage === "undefined") return null;
		return localStorage;
	} catch {
		// Access itself can throw in sandboxed / storage-disabled contexts.
		return null;
	}
}

/** True once a parsed value looks like a usable cached context. */
function isValidContext(value: unknown): value is AuthRouteContext {
	if (!value || typeof value !== "object") return false;
	const authUser = (value as { authUser?: unknown }).authUser;
	return (
		!!authUser &&
		typeof authUser === "object" &&
		typeof (authUser as { id?: unknown }).id === "string"
	);
}

/**
 * Persist the last-known-good signed-in context. Browser-only; a no-op on the
 * server or when storage is unavailable.
 */
export function persistAuthContext(ctx: AuthRouteContext): void {
	const s = storage();
	if (!s) return;
	try {
		s.setItem(STORAGE_KEY, JSON.stringify(ctx));
	} catch {
		// Quota exceeded / disabled — the offline fallback simply won't be primed.
	}
}

/** Read the cached context, or null if none / invalid / unavailable. */
export function readCachedAuthContext(): AuthRouteContext | null {
	const s = storage();
	if (!s) return null;
	try {
		const raw = s.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		return isValidContext(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** Drop the cached context (on a genuine signed-out response). */
export function clearCachedAuthContext(): void {
	const s = storage();
	if (!s) return;
	try {
		s.removeItem(STORAGE_KEY);
	} catch {
		// Ignore — nothing else to do.
	}
}

/** Build the layout's route-context shape from a resolved auth-context value. */
function toRouteContext(value: AuthContextValue): AuthRouteContext {
	return {
		// `user` is non-null on this path (checked by the caller / decideAuth).
		authUser: value.user as NonNullable<AuthContextValue["user"]>,
		clubs: value.clubs,
		currentMemberId: value.currentMemberId,
		activeClubId: value.activeClubId,
		isSuperadmin: value.isSuperadmin,
	};
}

/**
 * Decide what the `_authed` guard should do, given the outcome of calling
 * `getAuthContext()` and the last cached context. PURE — the caller performs
 * the persist / clear / redirect side effects.
 *
 *   - Resolved with a user  → authed (fresh); the caller persists it.
 *   - Resolved without a user → the call reached the server and it says
 *       "signed out" → redirect (the caller clears any stale cache).
 *   - Threw / rejected (offline / network error) → fall back to the cached
 *       context if we have one, else redirect (nothing to show offline).
 */
export function decideAuth(
	outcome: AuthContextOutcome,
	cached: AuthRouteContext | null,
): AuthDecision {
	if (outcome.ok) {
		if (outcome.value.user) {
			return {
				kind: "authed",
				fresh: true,
				context: toRouteContext(outcome.value),
			};
		}
		// Reached the server and it returned no user — a real sign-out.
		return { kind: "redirect" };
	}
	// The call itself failed (offline). Use the cached identity if we have one.
	if (cached) return { kind: "authed", fresh: false, context: cached };
	return { kind: "redirect" };
}
