import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
	type ConsentClientLookup,
	lookupConsentClient,
} from "./oauth-consent-logic";

export type { ConsentClientLookup } from "./oauth-consent-logic";

/**
 * The signed-in person and the requesting OAuth client, for `/oauth/consent`
 * (#843). A READ, so GET. It carries the request's own cookie to Better Auth,
 * because `getOAuthClientPublic` is session-gated.
 */
export const getOAuthConsentClient = createServerFn({ method: "GET" })
	.validator((i: unknown) =>
		z.object({ clientId: z.string().min(1).max(256) }).parse(i),
	)
	.handler(async ({ data }): Promise<ConsentClientLookup> => {
		const request = getRequest();
		return lookupConsentClient(request.headers, data.clientId);
	});
