/**
 * Server fns for the guest-book confirm page (#806).
 *
 * Deliberately thin. Every decision — creator-only, the archive gate, expiry,
 * the double-apply guard, the `McpError`-to-page-state mapping — lives in
 * `guest-book-pending-logic.ts`, because a `createServerFn` handler body cannot
 * be executed from vitest and a decision written here is a decision no test can
 * reach.
 *
 * Thin is not EMPTY, and the difference is load-bearing.
 * `public-readers-archive-gate.guard.test.ts` derives its sweep by matching
 * `^export const (\w+) = createServerFn` and treating any body that names no
 * `require*` guard as anonymous — reachable without a session — which then has
 * to be enrolled in `WIRINGS`/`WRITE_GATES`/`REVIEWED_UNGATED` or fail. A
 * wrapper that delegated everything, `requireUser()` included, would land in
 * that anonymous set and fail, correctly: the regex is the only thing that
 * knows a session is involved. `src/server/club-logo.ts` is the repo's
 * precedent for keeping the guard call here.
 *
 * So each wrapper resolves the session and passes the user id down. It adds no
 * DECISION beyond that, and `guest-book-pending-wiring.guard.test.ts` holds it
 * to that.
 *
 * Per the client-bundle rule this module exports only `createServerFn`s and
 * types (`server-modules.guard.test.ts`).
 *
 * The input schemas live in `guest-book-pending-schemas.ts` for the SAME
 * reason the decisions live one module down: a `validator` runs only inside
 * the Start runtime, so a schema written here is a schema nothing can parse an
 * input against. `patchSchema` shipped with a duplicate discriminator and
 * broke every edit on the page with every gate green — see that module.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireUser } from "./guards";
import {
	type ApplyPendingResult,
	applyPendingPlan,
	loadPendingPlan,
	type PendingPlanView,
	patchPendingPlan,
} from "./guest-book-pending-logic";
import {
	applySchema,
	patchSchema,
	pendingIdSchema,
} from "./guest-book-pending-schemas";

export type { ApplyPendingResult, PendingPlanView };

/** The pending plan as its creator sees it — UNMASKED. See the logic module. */
export const getGuestBookPendingPlan = createServerFn({ method: "GET" })
	.validator((i: unknown) => pendingIdSchema.parse(i))
	.handler(async ({ data }) => {
		const sessionUser = await requireUser();
		return loadPendingPlan({
			pendingId: data.pendingId,
			userId: sessionUser.id,
		});
	});

/** Persist one correction and re-plan. Returns a FRESH planHash. */
export const patchGuestBookPendingPlan = createServerFn({ method: "POST" })
	.validator((i: unknown) => patchSchema.parse(i))
	.handler(async ({ data }) => {
		const sessionUser = await requireUser();
		return patchPendingPlan({
			pendingId: data.pendingId,
			userId: sessionUser.id,
			edit: data.edit,
		});
	});

/** Record the page. Refusals come back as a view, never as a thrown error. */
export const applyGuestBookPendingPlan = createServerFn({ method: "POST" })
	.validator((i: unknown) => applySchema.parse(i))
	.handler(async ({ data }) => {
		const sessionUser = await requireUser();
		return applyPendingPlan({
			pendingId: data.pendingId,
			userId: sessionUser.id,
			planHash: data.planHash,
		});
	});
