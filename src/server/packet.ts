import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { loadPacketContext } from "#/server/packet-context-logic";

/**
 * Server fns for the meeting packet (#589).
 *
 * Exports ONLY `createServerFn`s, per the rule `server-modules.guard.test.ts`
 * enforces: a plain db-touching export in a module a client route imports drags
 * `#/db` → `pg` → `Buffer` into the browser bundle. The db work lives in
 * `packet-pdf-logic.ts`; the pure rule the dialog applies lives in
 * `#/lib/meeting-packet`.
 */

/**
 * What the packet dialog needs to tick the right boxes before the user touches
 * anything: which roles this meeting runs, whether it votes on phones, and
 * whether there is a word to print.
 *
 * PUBLIC, matching the packet endpoint and the per-sheet route beside it. It
 * ships role NAMES and two booleans — strictly less than the ballot, the
 * printed agenda or the role sheets themselves already show.
 */
export const getPacketContext = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z.object({ meetingId: z.string().uuid() }).parse(input),
	)
	.handler(async ({ data }) => loadPacketContext(data.meetingId));
