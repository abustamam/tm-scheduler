import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./guards";
import {
	type ConnectedApp,
	type DisconnectResult,
	disconnectApp,
	listConnectedApps,
} from "./oauth-grants-logic";

export type { ConnectedApp, DisconnectResult } from "./oauth-grants-logic";

/**
 * The OAuth apps a person has connected (#851), managed on `/me` beside their
 * personal access tokens.
 *
 * `requireUser()` and no `clubId`, like `api-tokens.ts`: a grant belongs to a
 * person, not a club. Shown to EVERYONE signed in, with no officer check — a
 * person who somehow holds a grant must always be able to remove it.
 */

/** The caller's own grants. Scoped by the session's user id in the query. */
export const getConnectedApps = createServerFn({ method: "GET" }).handler(
	async (): Promise<ConnectedApp[]> => {
		const user = await requireUser();
		return listConnectedApps(user.id);
	},
);

/**
 * Disconnect one of the caller's OWN grants. The client id is not an
 * authority: clients are shared across users, and `disconnectApp` scopes every
 * statement by the session's user id, so any id reaches only the caller's rows.
 */
export const disconnectConnectedApp = createServerFn({ method: "POST" })
	.validator((i: unknown) =>
		z.object({ clientId: z.string().min(1).max(512) }).parse(i),
	)
	.handler(async ({ data }): Promise<DisconnectResult> => {
		const user = await requireUser();
		return disconnectApp(user.id, data.clientId);
	});
