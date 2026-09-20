/**
 * Server fns for the agenda confirm page (#808).
 *
 * Deliberately thin. Every decision — creator-only, the archive gate, expiry,
 * the double-apply guard, the `McpError`-to-page-state mapping — lives in
 * `agenda-plan-pending-logic.ts`, because a `createServerFn` handler body
 * cannot be executed from vitest and a decision written here is a decision no
 * test can reach.
 *
 * Thin is not EMPTY, and the difference is load-bearing.
 * `public-readers-archive-gate.guard.test.ts` derives its sweep by matching
 * `^export const (\w+) = createServerFn` and treating any body that names no
 * `require*` guard as anonymous — reachable without a session — which then has
 * to be enrolled or waived. A wrapper that delegated `requireUser()` too would
 * land in that set and fail, correctly: the regex is the only thing that knows
 * a session is involved.
 *
 * So each wrapper resolves the session and passes the user id down. It adds no
 * DECISION beyond that, and `agenda-plan-pending-wiring.guard.test.ts` holds it
 * to that.
 *
 * Per the client-bundle rule this module exports only `createServerFn`s and
 * types (`server-modules.guard.test.ts`). The input schemas live in
 * `agenda-plan-pending-schemas.ts` for the SAME reason the decisions live one
 * module down: a `validator` runs only inside the Start runtime, so a schema
 * written here is a schema nothing can parse an input against.
 */
import { createServerFn } from "@tanstack/react-start";
import {
	type AgendaPendingView,
	type ApplyAgendaPendingResult,
	applyPendingPlan,
	loadPendingPlan,
} from "./agenda-plan-pending-logic";
import { applySchema, pendingIdSchema } from "./agenda-plan-pending-schemas";
import { requireUser } from "./guards";

export type { AgendaPendingView, ApplyAgendaPendingResult };

/** The pending plan as its creator sees it. See the logic module. */
export const getAgendaPendingPlan = createServerFn({ method: "GET" })
	.validator((i: unknown) => pendingIdSchema.parse(i))
	.handler(async ({ data }) => {
		const sessionUser = await requireUser();
		return loadPendingPlan({
			pendingId: data.pendingId,
			userId: sessionUser.id,
		});
	});

/** Save the agendas. Refusals come back as a view, never as a thrown error. */
export const applyAgendaPendingPlan = createServerFn({ method: "POST" })
	.validator((i: unknown) => applySchema.parse(i))
	.handler(async ({ data }) => {
		const sessionUser = await requireUser();
		return applyPendingPlan({
			pendingId: data.pendingId,
			userId: sessionUser.id,
			planHash: data.planHash,
		});
	});
