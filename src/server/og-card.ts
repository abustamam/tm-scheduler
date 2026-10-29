import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	loadPublicClubCardInput,
	loadPublicMeetingCardInput,
	ogCardVersion,
} from "#/server/og-card-logic";

/**
 * The `?v=` a page puts on its `og:image` URL (#1411): the hash of the same
 * input the endpoint hashes for its ETag, so the two cannot disagree. PUBLIC;
 * null for an unknown or archived club. Callers treat a failure as "no `?v=`".
 */
export const getClubOgVersion = createServerFn({ method: "GET" })
	.validator((d: unknown) => z.object({ clubId: z.string().uuid() }).parse(d))
	.handler(async ({ data }) => {
		const input = await loadPublicClubCardInput(data.clubId);
		return input ? ogCardVersion(input) : null;
	});

export const getMeetingOgVersion = createServerFn({ method: "GET" })
	.validator((d: unknown) =>
		z.object({ clubId: z.string().uuid(), key: z.string().min(1) }).parse(d),
	)
	.handler(async ({ data }) => {
		const input = await loadPublicMeetingCardInput(data.clubId, data.key);
		return input ? ogCardVersion(input) : null;
	});
