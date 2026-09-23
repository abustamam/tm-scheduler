# ADR-0027: GavelUp is an OAuth 2.1 authorization server, for MCP clients only

Status: Accepted

Relates to: ADR-0004 (magic-link-only authentication), #771 (MCP tracking), #773 (MCP PR1),
#842 (this change), #843 (the connector works).

## Context

`/api/mcp` shipped in #773 and it only works from a machine you own. The credential is a
personal `tmk_` bearer token pasted into `~/.claude.json`, so driving GavelUp from an LLM
means Claude Code, which means your laptop is awake. The thing an officer actually wants is
to say "Dana told me she wants to speak at the next meeting" from a phone and have the
agenda change.

That means claude.ai, and claude.ai's custom-connector UI takes a remote MCP URL plus an
optional OAuth Client ID and Client Secret. There is no field for a static `Authorization`
header, and Anthropic connects from its own cloud IP ranges rather than from your machine.
`gavelup.app` is already publicly reachable, so OAuth is the only missing piece.

ADR-0004 says magic link is the only way in. That stops being the whole story the moment
GavelUp issues access tokens: there is now a second credential type, with its own lifetime,
its own revocation surface and its own consent record.

## Decision

**Better Auth becomes the OAuth 2.1 authorization server**, via `@better-auth/mcp`
registered in `src/lib/auth.ts` alongside `jwt()`. The issuer is Better Auth's own base URL,
`<BETTER_AUTH_URL>/api/auth`, and the protected resource it binds tokens to is
`<BETTER_AUTH_URL>/api/mcp`.

**Magic link remains the only *human* authentication.** OAuth authorizes a *client* against
a session the person already has; it adds no new way to become that person. An OAuth
authorization that finds no session sends the browser to `/signin`, which is the same magic
link it has always been. ADR-0004 is extended here, not replaced.

Five decisions inside that, each one a door deliberately left shut:

### 1. The authorization server lives IN the app, not in front of it

The alternative is a hosted identity provider (Auth0, Clerk, WorkOS) with GavelUp as a
relying party. Rejected because the thing being authorized is *this* app's session and
*this* app's roster identity: `session.create.after` links a signed-in account to its
roster `Person` and reconciles the superadmin flag, and every MCP tool resolves that
person's membership in whichever club its input names. An external IdP would mint an
identity GavelUp then has to map back, which is the mapping that already exists — and it
would add a vendor to the sign-in path of a single-maintainer MVP.

### 2. The built-in `mcp()` plugin in better-auth 1.6 was rejected; we bumped instead

`better-auth@1.6.22` shipped its own `mcp()` plugin, so this could have been done with no
dependency change. Two things found by reading its source say otherwise:

- It is built on `oidc-provider`, which prints its own deprecation notice on load.
- **Its `/mcp/register` endpoint is unauthenticated and ungated.** The handler calls
  `getSessionFromCtx(ctx)` and then uses `session?.session.userId` with optional chaining —
  it never throws on a missing session, carries no `sessionMiddleware`, and never reads
  `allowDynamicClientRegistration`. Adopting it would have put a public endpoint on
  gavelup.app that writes client rows for anyone, and closing it would have meant
  maintaining a route block by hand.

So the change bumps `better-auth` 1.6.22 → 1.7.5 and adds `@better-auth/mcp@1.7.5`, where
registration is opt-in and absent from discovery when off. The bump is the riskiest line in
the whole change — it owns every magic-link sign-in — which is why #842 shipped it as its
own deploy, with the four integration points (Drizzle adapter import path, TanStack cookie
plugin, the `sendMagicLink` metadata signature, and the `session.create.after` hooks plus
the rate-limit rules) verified by an actual sign-in rather than by the suite alone.

### 3. Dynamic Client Registration is OFF

claude.ai is one confidential client, registered out of band; its ID and secret go into
claude.ai's own Advanced settings. DCR would let any caller create a client row on a public
endpoint, and it buys nothing while the answer to "how many clients are there" is one.

Neither `allowDynamicClientRegistration` nor `allowUnauthenticatedClientRegistration` is
passed, so `registration_endpoint` is absent from the discovery documents entirely and a
client never tries it. `well-known-discovery.integration.test.ts` asserts both the absent key
and — the assertion that actually matters — that a registration attempt writes no
`oauth_client` row, because a handler that records the client and then rejects the response
looks identical from outside.

`@better-auth/cimd` is the right answer when this opens to ChatGPT or to other officers. It
buys nothing today.

### 4. No OAuth scopes

An OAuth access token carries the same authority as a `tmk_` token. The write protection
that matters here is the preview-then-apply handshake in
`src/server/mcp/handle-request.ts`, not a scope string, and scopes only start paying rent
when someone who is not the maintainer reads the consent screen. Revisit when a second
person connects.

### 5. `tmk_` tokens keep working

One endpoint, two credential kinds, discriminated by the `tmk_` prefix. #842 changes nothing
about how `/api/mcp` authenticates; #843 adds the OAuth arm beside the existing one.

## The part that does not come for free: discovery at the root

Better Auth is mounted at `/api/auth`, and an OAuth client looks for an authorization server
at the **origin root** — RFC 8414 for `oauth-authorization-server`, RFC 9728 for
`oauth-protected-resource`. `src/routes/api/auth/$.ts` catches `/api/auth/*` and nothing
else, so both root URLs were 404.

`src/routes/[.]well-known.$.ts` serves them. Three things about it are decisions rather than
mechanics:

- **It forwards rather than rebuilding the documents.** The bodies name the provider's
  endpoints, grants and signing algorithms, and whether DCR is on. Restating any of that
  would be a second source of truth that goes stale on a library bump — and
  `registration_endpoint` would then be absent because the route forgot it rather than
  because the provider has DCR off.
- **The two documents are NOT forwarded alike, and where Better Auth serves them is not
  where it looks.** Both come from plugin `onRequest` hooks matching the full request
  pathname, and `auth.handler` runs those hooks before it routes. The MCP plugin matches
  RFC 9728 metadata at the bare root path, so that one forwards unchanged. The OAuth
  provider matches RFC 8414 metadata at `/.well-known/oauth-authorization-server<issuerPath>`
  and `<issuerPath>/.well-known/oauth-authorization-server` — the bare root path is in
  neither set, so it is rewritten onto `/api/auth`. This was established by probe, not from
  the docs.
- **It is an allowlist, not a catch-all.** A splat route is handed every `.well-known` path
  under the origin; passing them all to `auth.handler` would make the route quietly
  responsible for whatever path a dependency claims in a future patch bump. Two exact
  document names are answered and everything else 404s.

## Consequences

- Six new tables plus `jwks` and `oauth_resource` — eight in all — hand-merged into
  `src/db/auth-schema.ts` from the installed plugins and re-exported from `src/db/schema.ts`,
  which is where the Drizzle adapter looks a model up. `auth-schema-oauth-tables.guard.test.ts`
  reads the expected set off the plugins rather than from a list, because a list passes
  forever while a patch bump adds a table. It caught one immediately: #842's issue body
  named five OAuth tables and 1.7.5 declares seven.
- The migration is additive — new tables, no column changes, no backfill — so a revert
  leaves them orphaned and unread. Forward-only, per the startup-migration pattern in
  ADR-0007. No down-migration.
- `BETTER_AUTH_URL` is now load-bearing at import: `mcp()` validates the resource URL at
  construction, so a missing or malformed value takes the app down at boot rather than on
  the first sign-in. That is the intended direction — an authorization server whose issuer
  is `undefined` must not start — and `src/lib/auth.ts` throws with the cause named rather
  than letting the library's `TypeError` surface.
- `tanstackStartCookies()` must stay LAST in the plugins array. Better Auth logs a startup
  warning when it is not, and #842 tripped it: a cookie-integration plugin forwards
  `Set-Cookie` from an `after` hook, so any plugin behind it can set a cookie that never
  reaches the response. The consent round trip #843 builds is cookie-carrying.
- Deleting a user cascades to their refresh tokens and to any stored access-token rows, so
  account deletion is connector revocation. An access token issued as a JWT is not a row
  that cascade can reach, though — it stays cryptographically valid until it expires — so
  `/api/mcp` refuses it by looking the `sub` up on every call (#843), and a deleted user's
  token 401s there. Signing out of a browser session does **not** revoke a
  connector: `oauth_refresh_token.session_id` is `set null` rather than `cascade`, which is
  the plugin's choice and the right one — a person signing out of the web app should not
  silently disconnect their phone.
- Nothing in #842 completes an authorization. #843 builds the round trip and makes
  `/api/mcp` accept an OAuth token; the next section records how.

## #843: `/api/mcp` accepts the token, and the round trip exists

### Two credential kinds, split by prefix, verified by the library

`handle-request.ts` reads the bearer value and branches before anything else: `tmk_…` goes
down the personal-token path exactly as before; anything else — including no credential at
all — goes to `oauth-credential.ts`, which hands the request to `@better-auth/mcp`'s
`requireMcpAuth`. That verifies the JWT against GavelUp's own JWKS and checks signature,
issuer, audience and expiry; the audience is `mcpResourceUrl()`, the same function
`auth.ts` gives `mcp()` as the resource it binds tokens to, so the value a token is issued
for and the value it is checked against cannot drift. **Audience and issuer enforcement is
configuration, not code this repo wrote.** The integration suite proves it with tokens
signed by the real key and exactly one claim wrong.

Wrapping the whole route in `requireMcpAuth` would have rejected every `tmk_` token, which
is why the branch comes first. After it, both kinds resolve to a `user.id` and nothing else:
`adminClubsForUser`, the archive rule and the `actor_member_id` a write is credited to are
the same code for both. `AuthenticatedToken.tokenId` became `credential: McpCredential`, a
union no authorization decision reads. `touchApiToken` fires only on the personal branch,
because an OAuth token has no `api_tokens` row.

Every 401 now carries `WWW-Authenticate: Bearer resource_metadata="…"`, including the `tmk_`
ones. That header is how an MCP client learns where to authorize; a bare 401 dead-ends the
claude.ai connect flow with nothing to act on.

**The JWKS is fetched over HTTP from this same server, and that was an anonymous denial of
service until the review caught it.** `requireMcpAuth` takes a JWKS URL and nothing else, so
it GETs `<BETTER_AUTH_URL>/api/auth/jwks` out through Railway's edge and back, caching the key
set for five minutes. `BETTER_AUTH_URL` therefore has to be the canonical origin (the fetch
refuses redirects). Worse, the verifier refetches for every `kid` it has not cached, with no
cooldown and before checking any signature — and every such fetch arrives from the server's
own address, in one 20-a-minute rate-limit bucket. About 21 junk tokens a minute kept that
bucket empty, and the next legitimate refresh (cache expiry, key rotation) failed: every
claude.ai call answered 500. Four review passes found it independently. `oauth-credential.ts`
now refuses an unknown `kid` BEFORE the verifier, against the key set read in process
(`auth.api.getJwks`, no HTTP), reloading at most once every thirty seconds on a miss; so only
a token signed by a real key can cost a fetch.

Every 401 on the endpoint — both branches — is the JSON-RPC error envelope Better Auth uses,
with the same `WWW-Authenticate` value. A verifier that could not run at all is a 500 with no
challenge, because a 401 would send claude.ai back through consent on every call of an
outage; and a failure after a good token is logged as that, not as "could not verify".

### The cookie guard is an allow-list of one

Adding the OAuth branch brought `#/lib/auth` onto the bearer-only path, and that module is
where every cookie-reading API lives. `mcp-authz.guard.test.ts` keeps its deny-list of
cookie-reading function names and adds the inverse for this module: across
`src/server/mcp/**` and the route, only `oauth-credential.ts` may import it, and only the
`auth` binding. Specifiers are resolved to paths, so `#/`, `@/` and relative spellings are
one import; dynamic `import()`, `require()` and re-exports count. Transitive reach is
deliberately NOT covered — three tools already reach `#/lib/auth` through shared logic
modules — so the behavioural test (a real session cookie, no header, 401 and no write)
remains the half that covers it.

### Sign-in and consent: what the provider actually sends

The provider does not send `?redirect=`. It sends the browser to `/signin?<authorize
query>` or `/oauth/consent?<authorize query>` with a signature over the query appended
(`exp`, `ba_iat`, `sig`, a repeated `ba_param`). Two things follow, both measured in a
browser rather than read in docs:

- **The pages must not let the router touch that query.** TanStack re-serialises search on
  the server and 307s whenever `validateSearch` changes it, and the re-serialised form
  (`ba_param` as a JSON array, numeric-looking values parsed as numbers) no longer matches
  the signature. `/signin` adds nothing to a provider prompt's search, `/oauth/consent`
  passes its search through untouched, and both read `window.location.search` raw.
- **Sign-in resumes by replaying the authorize request**, with the signing parameters
  stripped (`#/lib/oauth-continuation`). A signed-in person reaching authorize is sent on to
  consent with a freshly signed query, so this works wherever the magic link is opened —
  the cross-device case lands on consent in the second browser and completes there — and
  it is immune to the ten-minute expiry on the consent query itself. The replay also drops
  `prompt=login`, `prompt=create` and `max_age`: kept, they sent a person who had just signed
  in straight back to `/signin`, in a loop the review reproduced. The provider's own resume
  path drops the same three after checking the signed `ba_iat`; this one may drop them
  unsigned because it only ever runs as a magic-link callback, i.e. immediately after a
  fresh sign-in.

**Better Auth 1.7.5's magic-link verify decodes its `callbackURL` twice** (`decodeURIComponent`
on a query value the router already decoded). A base64 signature's `%2B` came back as `+`,
read as a space, and the consent POST failed with `invalid_signature`. `/signin` escapes
every `%` in the callback (`#/lib/magic-link-callback`) so the second decode is an exact
inverse, and `oauth-consent.integration.test.ts` pins the double decode itself so the escape
is removed the day the library stops doing it.

The consent screen names the client from a server-side lookup by id, never from its URL.
Four things it does that the obvious version would not, each found in review:

- **Approve connects the account the screen showed, or nothing.** Better Auth records the
  grant for whichever session cookie arrives, and its signed query names no user, so a screen
  opened as A and approved after signing in as B in another tab connected B. The page sends
  the displayed user's id, and a `hooks.before` in `src/lib/auth.ts` refuses the consent POST
  unless it is the session's user (`#/lib/oauth-consent-binding`) — a missing id is refused
  too.
- **Decline stays put** and says the request was not approved, OFFERING the provider's
  `access_denied` redirect as "Return to the app" so the client can stop waiting, rather than
  following it on its own — and rather than redirecting to `/me`, which `_authed` replaces
  with its "not in a club yet" gate for an account with no membership. It no longer says
  "nothing was connected": a decline does not revoke an earlier approval.
- **A lost approval response is reported as unknown**, with no Decline left to press: the
  approval may have been recorded, and a decline would not undo it.
- **It is served with `X-Frame-Options: DENY` and `frame-ancestors 'none'`**, since
  one-click Approve is a clickjacking target.

Its copy states what the server enforces, not what a client might do: some changes apply as
soon as the app makes them (`assign_roles` has no preview step).

### Registering the client

`scripts/register-oauth-client.ts` calls Better Auth's own `/oauth2/create-client` (and
`/oauth2/client/rotate-secret`) as a named superadmin. `bun run build` bundles it to
`.output/register-oauth-client.mjs`, because the runtime image has Node and `.output/` only;
in production it is `node .output/register-oauth-client.mjs` inside the service. It mints a
five-minute session by inserting the row directly and signing its token as Better Auth signs
a cookie, then deletes it — NOT through `internalAdapter.createSession`, whose
`session.create.after` hook reconciles `SUPERADMIN_EMAILS` two-way and, run locally with
production's `DATABASE_URL` and that variable unset, would revoke the maintainer's own flag.
The session carries the signed `dont_remember` cookie, without which the session middleware
extended it to seven days on first use. A failure to delete it is reported beside the secret
rather than replacing it. It refuses a second client with the same name without `--force`,
and prints the secret once.

Only a client's creator may rotate its secret, and `oauth_client.user_id` cascades on user
delete: **deleting the superadmin who registered claude.ai's client deletes the client**, and
every member's connection with it.

### Known and left open

Each raised in review and deliberately not fixed here:

- **No OAuth scopes are checked**; any access token for the `/api/mcp` audience carries full
  authority (decision 4 above). Harmless while one hand-registered client exists; it stops
  being harmless when a second is registered.
- **No way to revoke a connection** from the app. Access tokens are JWTs valid for an hour
  with no revocation check; refresh tokens last thirty days. Revoking means deleting the
  person's `oauth_consent` and `oauth_refresh_token` rows by hand.
- **A client the person already approved gets a code without a consent screen** on a later
  authorize, including one started by someone else's link. What that permits depends on
  claude.ai binding `state` to its own session, which this repo cannot see.
- **Two concurrent runs of the registration script** can both pass the duplicate-name check.
  It is run by one operator, by hand.
- **A newly rotated signing key can be refused for up to thirty seconds** by the `kid` gate's
  miss cooldown, and junk tokens can keep that window open. The answer is a 401 rather than a
  500. No key rotation is configured, so it would take a manual one to hit this.
- **Only `/oauth/consent` refuses to be framed.** `/signin` is still frameable; it has no
  one-click action to hijack.
