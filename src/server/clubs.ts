import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { resolveClubByIdentifier } from "./clubs-logic";

/** Resolve a club URL segment (slug | club number | UUID) to the club.
 *  PUBLIC — no session required. */
export const getClubByIdentifier = createServerFn({ method: "GET" })
	.validator((identifier: unknown) => z.string().min(1).parse(identifier))
	.handler(async ({ data }) => resolveClubByIdentifier(data));
