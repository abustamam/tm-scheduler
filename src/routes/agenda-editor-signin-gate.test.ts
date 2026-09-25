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
 * Two behaviours, and the second is the one easy to lose. Both cases below
 * carry the parent's `shell` alongside its `hasSession`, because the whole
 * point of the gate reading `hasSession` is that the two differ: a gate
 * rewritten against `shell` still type-checks and still passes the first
 * test, and only the second one catches it.
 */
import { describe, expect, it, vi } from "vitest";

// The route imports `#/server/meeting-agenda-edit`, which reaches `#/db` at
// import time ("DATABASE_URL is not set" in a unit context). The beforeLoad
// never touches it and the loader never runs here.
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
// Same reason: the loader resolves the URL key through this module first
// (#877), and it reaches `#/db` too.
vi.mock("#/server/meeting-key", () => ({
	resolveMeetingKeyForUser: vi.fn(),
}));

import { Route } from "./club.$clubId.meeting.$meetingId_.agenda";

const HREF =
	"/club/thr-speaking-club/meeting/6b971d60-654e-45b2-b5bb-271f026fe586/agenda";

/** Invoke the real guard with the parent shell's context and a url. */
async function runBeforeLoad(context: { shell: boolean; hasSession: boolean }) {
	const beforeLoad = Route.options.beforeLoad as unknown as (args: {
		context: { shell: boolean; hasSession: boolean };
		location: { href: string };
	}) => unknown;
	if (!beforeLoad) {
		throw new Error("the agenda editor route lost its sign-in guard");
	}
	return await beforeLoad({ context, location: { href: HREF } });
}

/** The thrown value, or `undefined` when the guard let the load through. */
async function thrownBy(context: { shell: boolean; hasSession: boolean }) {
	try {
		await runBeforeLoad(context);
		return undefined;
	} catch (e) {
		return e;
	}
}

describe("agenda editor sign-in gate (#769)", () => {
	it("sends a signed-out visitor to /signin instead of the error boundary", async () => {
		const thrown = await thrownBy({ shell: false, hasSession: false });

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
		// for exactly the same reason it is false for a guest, while `hasSession`
		// is true. Redirecting would send an already-authenticated user to sign
		// in, which returns them here.
		const thrown = await thrownBy({ shell: false, hasSession: true });

		expect(
			thrown,
			"a signed-in visitor must fall through to the loader's own permission error",
		).toBeUndefined();
	});
});
