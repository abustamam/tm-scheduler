import { createServerFn } from "@tanstack/react-start";
import { submitAccessRequestLogic } from "./access-requests-logic";
import { accessRequestSchema } from "./access-requests-schemas";

// The db-touching logic lives in `access-requests-logic.ts` (never imported by
// client routes) so it can't drag `#/db` → `pg` into the browser bundle. This
// module exports ONLY createServerFns + types — see `server-modules.guard.test.ts`.
export type { SubmitAccessRequestResult } from "./access-requests-logic";
export type { AccessRequestFormInput } from "./access-requests-schemas";

/**
 * The `/request-access` form (#866). PUBLIC — no session, like
 * `submitGuestBook`: anyone may ask for access, signed in or not. Validation is
 * the schema; the bot filters and caps are the logic's.
 */
export const submitAccessRequest = createServerFn({ method: "POST" })
	.validator((input: unknown) => accessRequestSchema.parse(input))
	.handler(async ({ data }) => submitAccessRequestLogic(data));
