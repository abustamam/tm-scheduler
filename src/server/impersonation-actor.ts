// Request-scoped "who is acting" marker for read-write impersonation (#246).
//
// When a mutating guard grants access via an active `read_write` impersonation
// session, it marks the current request with the real superadmin's user id. Any
// `logActivity` call later in the SAME request then auto-stamps `impersonated_by`
// (and forces `actor_member_id` to null), so every impersonated write is
// attributed to the real person — without threading an actor argument through the
// ~60 mutation callsites.
//
// Why keyed on the request object (not AsyncLocalStorage.enterWith): TanStack
// Start wraps each request in `eventStorage.run({ h3Event }, handler)`, so
// `getRequest()` returns the same `req` object in every frame of the request —
// including deep inside a guard AND later inside a transaction's `logActivity`.
// Keying a WeakMap on that shared object propagates the mark across async
// boundaries reliably, whereas `enterWith` set inside the guard would not reach
// the handler's continuation after the guard resolves.
//
// Deliberately dependency-light: imports ONLY `getRequest` (no db, no auth), so
// pulling it into the widely-imported `logActivity` keeps that path cheap.
import { getRequest } from "@tanstack/react-start/server";

const writeActorByRequest = new WeakMap<object, string>();

/** The current request object, or null outside a request (system callers, tests). */
function currentRequest(): object | null {
	try {
		return getRequest();
	} catch {
		return null;
	}
}

/**
 * Mark the current request as a read-write impersonated write by `superadminUserId`.
 * Called by the mutating guards when an active `read_write` session grants access.
 * No-ops outside a request context.
 */
export function markImpersonatedWrite(superadminUserId: string): void {
	const req = currentRequest();
	if (req) writeActorByRequest.set(req, superadminUserId);
}

/** The real superadmin behind the current request's write, or null. */
export function getImpersonatedWriteActor(): string | null {
	const req = currentRequest();
	return req ? (writeActorByRequest.get(req) ?? null) : null;
}
