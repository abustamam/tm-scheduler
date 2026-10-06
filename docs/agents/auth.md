# Stack: authentication and the OAuth server, in full

Moved verbatim out of `CLAUDE.md` on 2026-10-05 so it stops riding in every session's and every subagent's context on every call (see `docs/agents/token-usage.md`). A code comment citing a CLAUDE.md paragraph by name means the same paragraph here.

- **Better-Auth** for authentication (`src/lib/auth.ts`), mounted at `src/routes/api/auth/$.ts`
  via the `server.handlers` pattern. **Magic-link is the only** sign-in method: `src/lib/auth.ts`
  uses the Better-Auth `magicLink` plugin with the Drizzle adapter (`drizzleAdapter(db, { provider: "pg" })`)
  and the `tanstackStartCookies` plugin — no email+password, and no OAuth *sign-in*.
  **That same instance IS an OAuth 2.1 authorization server** (#842 / ADR-0027): `jwt()` +
  `mcp()` from `@better-auth/mcp` make it issue access tokens for `/api/mcp`, so claude.ai
  can connect from Anthropic's cloud. OAuth authorizes a CLIENT against a session the person
  already has — it adds no way to sign in, and one that finds no session lands on `/signin`.
  Three things that bite:
  **`tanstackStartCookies()` must be LAST in the plugins array** (it forwards `Set-Cookie`
  from an `after` hook, so a plugin behind it can set a cookie that never reaches the
  response — Better Auth logs a startup warning, which is the only signal);
  **`BETTER_AUTH_URL` is now load-bearing at import**, because `mcp()` validates the resource
  URL at construction and a missing one takes the app down at boot rather than on first
  sign-in; and **Dynamic Client Registration is deliberately off**, so adding either
  `allow*ClientRegistration` option opens a public client-writing endpoint on gavelup.app —
  `well-known-discovery.integration.test.ts` fails you first, by row count rather than by
  status. The two discovery documents are served at the ORIGIN ROOT by
  `src/routes/[.]well-known.$.ts`, which forwards an ALLOWLISTED pair to `auth.handler`
  rather than rebuilding them; the two are not forwarded alike, and
  `src/lib/well-known-forward.ts` says why.
  **`/api/mcp` accepts two credential kinds** (#843) — how people connect, and the maintainer's
  register/rotate/revoke runbook, is `docs/claude-connector.md` — split by prefix in `handle-request.ts`:
  `tmk_…` is a personal token (Claude Code, pasted into a header), anything else is an OAuth
  access token (claude.ai) verified by `src/server/mcp/oauth-credential.ts` — the ONLY file on
  the MCP path allowed to import `#/lib/auth`, and `mcp-authz.guard.test.ts` holds that by
  resolved path. Both resolve to a user id and nothing else, so clubs and attribution are the
  same for both. The verifier fetches its JWKS over HTTP from this same server, so
  `oauth-credential.ts` refuses an unknown `kid` BEFORE it (a flood of junk `kid`s otherwise
  drains the rate-limit bucket every refetch shares, and real calls 500). **claude.ai needs no
  registered client** (#852): `cimd()` from `@better-auth/cimd` lets it identify itself by a
  Client ID Metadata Document URL, and only `CIMD_ALLOWED_CLIENT_IDS`
  (`src/lib/oauth-connector-clients.ts`) is admitted, by EXACT match, twice: a `hooks.before`
  refuses any other URL-shaped client id before the provider resolves the client
  (`unlistedCimdClientId` lists every place one is read from), and `isMetadataDocumentUrlAllowed`
  checks again before any fetch — widen that set, never the match, or `/oauth2/authorize` fetches whatever URL a caller
  names and writes a client row from it. It sits after `mcp()`, before `tanstackStartCookies()`.
  Tests `vi.mock("#/lib/cimd-transport")` and serve `src/test/fixtures/claude-cimd-metadata.json`.
  Only officers may APPROVE a connection: `mayUseConnector` (`src/server/connector-eligibility.ts`)
  is the one statement of that rule, checked in the consent `hooks.before` and read by `/me` and
  `/oauth/consent` — so a test that approves must sign in as an admin or officer of an open club.
  A confidential client, if one is ever needed again, is registered with
  `scripts/register-oauth-client.ts` — `node .output/register-oauth-client.mjs`
  in production, since the image has no Bun — never by INSERT. Two traps in the browser half: the provider sends `/signin` and `/oauth/consent` a
  SIGNED query, so neither page may let the router rewrite its search (a changed
  `validateSearch` 307s and breaks the signature — read `window.location.search` raw); and
  Better Auth's magic-link verify decodes `callbackURL` twice, so a callback carrying `%XX`
  goes through `magicLinkCallbackURL` (`src/lib/magic-link-callback.ts`) or lands corrupted.
  Magic-link delivery goes through **Resend** (`src/lib/email.ts`, `src/lib/magic-link-email.ts`) when `RESEND_API_KEY` is set; with no key it falls back to logging the URL to the server console (dev). The React client is
  `src/lib/auth-client.ts` (`authClient.useSession()` / `signOut()`, see
  `src/routes/_authed.tsx`).
