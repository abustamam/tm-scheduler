/**
 * Register the OAuth client claude.ai connects to `/api/mcp` with, once
 * (#843 / ADR-0027). Or rotate its secret.
 *
 *   bun run scripts/register-oauth-client.ts --as <superadmin email> \
 *     --name "claude.ai" --redirect-uri <uri from claude.ai>
 *   bun run scripts/register-oauth-client.ts --as <superadmin email> \
 *     --rotate-secret <client_id>
 *
 * Runs against whatever `DATABASE_URL` is in the environment, so the same
 * script serves local dev and production: in production, run it inside the
 * deployed service (`railway ssh`), where `DATABASE_URL`, `BETTER_AUTH_URL`
 * and `BETTER_AUTH_SECRET` are already the server's own. Bun auto-loads
 * `.env.local` locally.
 *
 * Take the redirect URI from claude.ai, not from memory: start adding the
 * connector, read `redirect_uri` off the authorize request it makes (or the
 * error it gets), and register exactly that. A wrong one fails closed with an
 * opaque OAuth error.
 *
 * Refuses to create a second client with the same name unless `--force` is
 * passed. Prints the secret to stdout exactly once. The logic, and why it
 * mints its own session instead of signing in, is in
 * `register-oauth-client-logic.ts`.
 */
import { db } from "#/db";
import { auth } from "#/lib/auth";
import {
	describeOutcome,
	parseRegisterArgs,
	registerOAuthClient,
	USAGE,
} from "./register-oauth-client-logic";

async function main(): Promise<number> {
	const args = parseRegisterArgs(process.argv.slice(2));
	if ("error" in args) {
		console.error(`${args.error}\n\n${USAGE}`);
		return 2;
	}
	const context = await auth.$context;
	const outcome = await registerOAuthClient(
		{ db, handler: auth.handler, context },
		args,
	);
	const { lines, exitCode } = describeOutcome(outcome, args);
	for (const line of lines) {
		(exitCode === 0 ? console.log : console.error)(line);
	}
	return exitCode;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(err);
		process.exit(1);
	},
);
