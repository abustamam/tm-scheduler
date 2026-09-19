/**
 * The agenda editor's sign-in gate (#769).
 *
 * `/club/$clubId` is a PUBLIC shell — a guest reaches the sign-up sheet
 * through it — so this route's `beforeLoad` is the only thing between a
 * session-less visitor and a loader whose first act (`getAgendaDraft` →
 * `requireMeetingTemplateEditor` → `requireUser`) throws a plain `Error`.
 * Thrown from a loader that is the error boundary, which is what an officer
 * with an expired session measured as HTTP 500 and "Something went wrong!"
 * where `/officers` gave them `307 → /signin?redirect=…`.
 *
 * Exercised through `Route.options.beforeLoad` rather than a source grep,
 * following `_authed/officers.test.ts`: the decision is a THROWN redirect
 * carrying nav options, and a grep cannot see which branch throws it or what
 * it targets. The route itself cannot be mounted in vitest (it needs a
 * router, a loader context and a session), so the guard is invoked directly.
 *
 * Three behaviours, and the second two are the ones easy to lose:
 *
 * 1. No session → redirect to `/signin`, carrying this url so the magic link
 *    lands back on the editor.
 * 2. A session that may NOT edit still falls through. Bouncing it to /signin
 *    would loop — it is already signed in, so signing in again returns it
 *    here to be bounced again. The parent's `shell` is false for a signed-in
 *    non-member exactly as it is for a guest, so a gate written against
 *    `shell` alone is the loop.
 * 3. A signed-in member of the viewed club never calls `getAuthContext` at
 *    all. The parent already proved that session; re-asking costs a server
 *    round trip per navigation and, on SSR, a second pass over memberships,
 *    officer positions and the schedule top-up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Both server-fn modules the route imports reach `#/db` at import time
// ("DATABASE_URL is not set" in a unit context). `getAuthContext` is mocked
// because it is the call under test; the agenda-edit module because the
// beforeLoad never reaches it and the loader never runs here.
const getAuthContext = vi.fn();
vi.mock("#/server/auth-context", () => ({
	getAuthContext: () => getAuthContext(),
}));
vi.mock("#/server/meeting-agenda-edit", () => ({
	addAgendaRoleFn: vi.fn(),
	addAgendaRowFn: vi.fn(),
	getAgendaDraft: vi.fn(),
	moveAgendaRowFn: vi.fn(),
	planRoleRemovalFn: vi.fn(),
	removeAgendaRoleFn: vi.fn(),
	removeAgendaRowFn: vi.fn(),
	updateAgendaRowFn: vi.fn(),
}));

import { Route } from "./club.$clubId.meeting.$meetingId_.agenda";

const HREF =
	"/club/thr-speaking-club/meeting/6b971d60-654e-45b2-b5bb-271f026fe586/agenda";

/** Invoke the real guard with the parent shell's `shell` flag and a url. */
async function runBeforeLoad(shell: boolean) {
	const beforeLoad = Route.options.beforeLoad as unknown as (args: {
		context: { shell: boolean };
		location: { href: string };
	}) => unknown;
	if (!beforeLoad) {
		throw new Error("the agenda editor route lost its sign-in guard");
	}
	return await beforeLoad({ context: { shell }, location: { href: HREF } });
}

/** The thrown value, or `undefined` when the guard let the load through. */
async function thrownBy(shell: boolean) {
	try {
		await runBeforeLoad(shell);
		return undefined;
	} catch (e) {
		return e;
	}
}

beforeEach(() => {
	getAuthContext.mockReset();
});

describe("agenda editor sign-in gate (#769)", () => {
	it("sends a signed-out visitor to /signin instead of the error boundary", async () => {
		getAuthContext.mockResolvedValue({ user: null });

		const thrown = await thrownBy(false);

		// TanStack's redirect() throws a Response carrying the nav options; the
		// `to` on it is what separates a 307 from the 500 this issue is about.
		expect(
			thrown,
			"a session-less visitor must be redirected, not allowed into the loader",
		).toBeInstanceOf(Response);
		const options = (
			thrown as Response & {
				options: { to?: string; search?: { redirect?: string } };
			}
		).options;
		expect(options.to).toBe("/signin");
		// Without this the magic link lands on /officers and the officer has to
		// find their way back to the agenda they clicked.
		expect(
			options.search?.redirect,
			"the sign-in bounce must carry the url back",
		).toBe(HREF);
	});

	it("does NOT bounce a signed-in visitor who may not edit (no /signin loop)", async () => {
		// Signed in, but not a member of the viewed club — `shell` is false here
		// for exactly the same reason it is false for a guest. Redirecting would
		// send an already-authenticated user to sign in, which returns them here.
		getAuthContext.mockResolvedValue({ user: { id: "user-1" } });

		const thrown = await thrownBy(false);

		expect(
			thrown,
			"a signed-in visitor must fall through to the loader's own permission error",
		).toBeUndefined();
	});

	it("asks nothing more of the server when the parent already proved the session", async () => {
		// `shell` is true only where `publicShellDecision` saw a user AND a
		// membership in the viewed club — the officer case, i.e. every normal
		// load of this page. A second getAuthContext here would be a round trip
		// per navigation in, for an answer the context already holds.
		getAuthContext.mockRejectedValue(
			new Error("getAuthContext must not be called on the fast path"),
		);

		await expect(runBeforeLoad(true)).resolves.toBeUndefined();
		expect(getAuthContext).not.toHaveBeenCalled();
	});
});
