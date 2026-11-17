import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { loadAwardReveal } from "./award-reveal-logic";
import { getSessionUser } from "./guards";

export type { AwardReveal } from "./award-reveal-logic";

/**
 * The confirmed award winners for the Present deck's drum-roll reveal (#1654).
 * Session-gated (see `loadAwardReveal`): `null` for anyone who may not read the
 * minutes' winners, which the deck treats as "show the static slide".
 */
export const getAwardReveal = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z.object({ meetingId: z.string().uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		const user = await getSessionUser();
		return loadAwardReveal(data.meetingId, user?.id ?? null);
	});
