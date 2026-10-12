// Superadmin impersonation server fns (#185 / ADR-0020). Thin `createServerFn`
// wrappers ONLY — db logic lives in `impersonation-logic.ts` so the Start compiler
// strips it from the client bundle (enforced by `server-modules.guard.test.ts`).
//
// Both are platform-level (gated by `requireSuperadmin`), NOT per-club — a
// superadmin starts/ends their own session. Starting one grants read-only view
// access to the target club (via the read-access guards); it never bypasses the
// per-club mutating guards.
import { createServerFn } from "@tanstack/react-start";
import { deleteCookie } from "@tanstack/react-start/server";
import { VIEW_AS_COOKIE } from "#/lib/view-as";
import { requireSuperadmin, requireUser } from "./guards";
import {
	endImpersonation as endImpersonationDb,
	startImpersonation as startImpersonationDb,
	startImpersonationSchema,
} from "./impersonation-logic";

export const startImpersonation = createServerFn({ method: "POST" })
	.validator((i: unknown) => startImpersonationSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireSuperadmin(user.id);
		return startImpersonationDb(user.id, data);
	});

export const endImpersonation = createServerFn({ method: "POST" }).handler(
	async () => {
		const user = await requireUser();
		await requireSuperadmin(user.id);
		const ended = await endImpersonationDb(user.id);
		// Exit on the banner ends "Preview as member" too (#1113 / ADR-0020): the
		// preview composes with a session and must not outlive it.
		deleteCookie(VIEW_AS_COOKIE, { path: "/" });
		return ended;
	},
);
