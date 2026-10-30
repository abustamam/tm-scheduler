# Plan 024: `getSessionUser` treats only "no request context" as signed-out; a session-lookup failure is an error

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat b955f240..HEAD -- src/server/guards.ts src/server/auth-context.ts src/routes/_authed.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW-MED — every server fn resolves its session through this one function; the change only affects the path where the session lookup THROWS
- **Depends on**: plans/021-test-db-absence-fails-closed.md (so the integration suites that exercise guards actually run when you run the suite)
- **Category**: correctness
- **Planned at**: commit `b955f240`, 2026-10-30

## Why this matters

`getSessionUser` in `src/server/guards.ts` is the one place every server
function asks "who is calling?". It wraps two different things in one bare
`catch { return null }`: `getRequest()`, which throws when there is no request
context (tests, direct calls), and `auth.api.getSession(...)`, which throws
when the session lookup itself fails (the database is briefly unreachable,
the pool is exhausted, Better-Auth's adapter errors). The comment above the
catch only considers the first case. The second is reported to every caller
as "there is nobody signed in", and the callers act on that:

- `getAuthContext` (`src/server/auth-context.ts:32-46`) returns `user: null`
  AND deletes the `VIEW_AS_COOKIE` ("a lapsed session cannot call setViewAs").
- `src/routes/_authed.tsx:18-24` redirects to `/signin` on `user: null`. For a
  magic-link-only app that is a sign-out: the officer is bounced to the
  sign-in page, their "preview as member" cookie is gone, and nothing says why.
- Public pages (`src/routes/club.$clubId.tsx:25-27`) fall back to the
  anonymous shell, so a signed-in member sees the name-pick for a blip.
- Mutating fns via `requireUser` report "You need to be signed in to do that."
  for what is actually an outage.

After this plan: a missing request context still yields `null` (every test
and direct call keeps working); a failing session lookup propagates as an
error, so the layout renders its error boundary rather than redirecting, no
cookie is cleared, and the message is the truth.

## Current state

### Files

- `src/server/guards.ts` — the guard functions; `getSessionUser` at :61-73,
  `requireUser` at :76-82.
- `src/server/auth-context.ts` — `getAuthContext` server fn (the app shell's
  identity); first caller to react to `null`.
- `src/routes/_authed.tsx` — authed layout `beforeLoad`; redirects on `null`.
- `src/components/route-error.tsx` — the route error boundary that a thrown
  loader error reaches (not edited).

### Excerpts (as of `b955f240`)

`src/server/guards.ts:1,5` (imports that matter):

```ts
import { getRequest } from "@tanstack/react-start/server";
import { auth } from "#/lib/auth";
```

`src/server/guards.ts:61-82`:

```ts
/** Raw session user (or null) for the current request. Server-only.
 *  Returns null when called outside a request context (e.g. integration tests
 *  or public server fns invoked without a session). */
export async function getSessionUser() {
	try {
		const request = getRequest();
		const session = await auth.api.getSession({ headers: request.headers });
		return session?.user ?? null;
	} catch {
		// No request context (test env, direct call) — treat as unauthenticated.
		return null;
	}
}

/** Like getSessionUser but throws — use inside mutating server fns. */
export async function requireUser() {
	const user = await getSessionUser();
	if (!user) {
		throw new Error("You need to be signed in to do that.");
	}
	return user;
}
```

What `getRequest()` throws without a context
(`node_modules/@tanstack/start-server-core/dist/esm/request-response.js:50-55`):

```js
	const event = eventStorage.getStore();
	if (!event) throw new Error(`No StartEvent found in AsyncLocalStorage. Make sure you are using the function within the server runtime.`);
```

`src/server/auth-context.ts:35-46`:

```ts
	async () => {
		const user = await getSessionUser();
		if (!user) {
			// A lapsed session cannot call `setViewAs`, so the preview cookie it left
			// behind is cleared here (#1113): the next person on this browser must not
			// inherit it. Only when present, so an ordinary anonymous load sets nothing.
			try {
				if (getCookie(VIEW_AS_COOKIE))
					deleteCookie(VIEW_AS_COOKIE, { path: "/" });
			} catch {
				// Off a request context (tests): nothing to clear.
			}
```

`src/routes/_authed.tsx:18-24`:

```ts
	beforeLoad: async ({ location }) => {
		const ctx = await getAuthContext();
		if (!ctx.user) {
			throw redirect({
				to: "/signin",
				search: { redirect: location.href },
			});
		}
```

Callers of `getSessionUser` outside `guards.ts` (13 files, all keep working
unchanged because the `null` contract for "no context" is preserved):
`write-actor-logic.ts`, `voting.ts`, `attendance-actor-logic.ts`,
`auth-context.ts`, `project-picker.ts`, `timings-logic.ts`, `lineup-blast.ts`,
`meetings.ts`, `slots.ts`, `pathways-read.ts`, `minutes.ts`,
`src/routes/api/meetings.$id.minutes.pdf.ts`, `src/routes/api/clubs.$clubId.export.zip.ts`.

How existing tests stand in for the two dependencies
(`src/server/asserted-plan-only.integration.test.ts:50-57`):

```ts
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...
	getRequest: () => request,
	...
vi.mock("#/lib/auth", () => ({
	auth: { api: { getSession: async () => null } },
}));
```

and a module that imports `#/db` at load is made importable in a unit test by
`vi.mock("#/db", () => ({ db: {} }))` (pattern in
`src/server/role-sheets-pdf-logic.test.ts`).

### Conventions to match

- A denial message is a named constant compared by identity
  (`guards.ts:55-59` comment: "Anything NOT in this vocabulary is rethrown, so
  drift fails loudly instead of widening a fallback"). This plan adds no new
  message; it stops a non-denial from being read as one.
- Biome: tabs, double quotes. Conventional commits: `fix(auth): …`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Bootstrap worktree | `bun run worktree:setup "plan 024"` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint gate | `bunx biome check --diagnostic-level=error` | exit 0 |
| New unit test | `bunx vitest run src/server/guards-session.test.ts` | all pass |
| Guards' behavioural suites | `bunx vitest run src/server/auth-context-clubs.integration.test.ts src/server/asserted-plan-only.integration.test.ts src/server/slots.transport.test.ts` | all pass |
| Full suite | `bun run test` | exit 0 |

## Files

- `src/server/guards.ts`
- `src/server/guards-session.test.ts`

## Scope

**In scope** (the only files you should modify): the two files above (the
test is new).

**Out of scope** (do NOT touch, even though they look related):

- `src/server/auth-context.ts` — its `null` handling is correct for a real
  signed-out user; after this plan an outage no longer reaches it as `null`.
- `src/routes/_authed.tsx`, `src/routes/club.$clubId.tsx` — the redirect on a
  real `null` stays; a thrown error reaches the router's error component, which
  is the intended outcome.
- `src/components/route-error.tsx` — if its copy for a loader error is
  unfriendly, that is a separate change; do not edit it here.
- `requireUser` and every other guard in `guards.ts` — unchanged.
- Any attempt to retry the session lookup or add a circuit breaker.

## Git workflow

- Branch: `session-guard-errors-024`, as a worktree, bootstrapped.
- One commit; conventional-commit message.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Check what the session lookup does with an ordinary invalid cookie

The change below lets a THROW from `auth.api.getSession` propagate. That is
only safe if an absent, expired or garbage session cookie makes
`getSession` RESOLVE to `null` rather than throw. Confirm it before editing:

```bash
grep -rn "session_token\|getSession" node_modules/better-auth/dist/api/routes/session.mjs 2>/dev/null | head -20
```

(If the file is elsewhere: `grep -rln "getSession" node_modules/better-auth/dist/api | head`.)
Read the handler: a missing cookie or a lookup miss must return `null` (look
for `return ctx.json(null)` / `return null` on the not-found path, not a
`throw new APIError`). If instead it throws `APIError("UNAUTHORIZED")` for a
missing or invalid cookie, STOP (see STOP conditions) — the plan's premise is
wrong for this Better-Auth version.

**Verify**: you can quote the not-found return line in the PR body.

### Step 2: Split the two concerns in `getSessionUser`

Replace `getSessionUser` (and its doc comment) in `src/server/guards.ts` with:

```ts
/** Raw session user (or null) for the current request. Server-only.
 *
 *  Returns null when called outside a request context (integration tests, a
 *  direct call) and when the request carries no valid session. It does NOT
 *  return null when the session LOOKUP fails: a database blip in
 *  `auth.api.getSession` used to read as "nobody is signed in", which bounced
 *  an officer to /signin, deleted their view-as cookie (`getAuthContext`), and
 *  served public readers the anonymous variant. Such an error now propagates,
 *  so the layout renders an error instead of signing the member out. */
export async function getSessionUser() {
	let request: Request;
	try {
		request = getRequest();
	} catch {
		// No request context (test env, direct call) — treat as unauthenticated.
		return null;
	}
	const session = await auth.api.getSession({ headers: request.headers });
	return session?.user ?? null;
}
```

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Unit-test the four outcomes

Create `src/server/guards-session.test.ts`:

```ts
// `getSessionUser` is every server fn's "who is calling?". Four outcomes, one
// of which was wrong until this file existed: a FAILING session lookup must
// not read as "signed out" (which redirects to /signin and clears the view-as
// cookie), it must surface as the error it is.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// guards.ts imports `#/db` at load; nothing here touches the database.
vi.mock("#/db", () => ({ db: {} }));
vi.mock("@tanstack/react-start/server", () => ({
	getRequest: vi.fn(),
	getCookie: vi.fn(),
	deleteCookie: vi.fn(),
	setCookie: vi.fn(),
}));
vi.mock("#/lib/auth", () => ({
	auth: { api: { getSession: vi.fn() } },
}));

import { getRequest } from "@tanstack/react-start/server";
import { auth } from "#/lib/auth";
import { getSessionUser, requireUser } from "./guards";

const request = new Request("http://localhost:3000/", {
	headers: { cookie: "x=y" },
});
const user = { id: "u1", email: "m@club.org" };

beforeEach(() => {
	vi.mocked(getRequest).mockReturnValue(request as never);
});
afterEach(() => {
	vi.clearAllMocks();
});

describe("getSessionUser", () => {
	it("is null outside a request context, without asking the session store", async () => {
		vi.mocked(getRequest).mockImplementation(() => {
			throw new Error("No StartEvent found in AsyncLocalStorage.");
		});
		await expect(getSessionUser()).resolves.toBeNull();
		expect(auth.api.getSession).not.toHaveBeenCalled();
	});

	it("is null when the request carries no valid session", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
		await expect(getSessionUser()).resolves.toBeNull();
		expect(auth.api.getSession).toHaveBeenCalledWith({ headers: request.headers });
	});

	it("is the user when the session resolves", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue({ user } as never);
		await expect(getSessionUser()).resolves.toEqual(user);
	});

	it("propagates a failing session lookup instead of reading it as signed-out", async () => {
		const outage = new Error("connect ECONNREFUSED");
		vi.mocked(auth.api.getSession).mockRejectedValue(outage);
		await expect(getSessionUser()).rejects.toBe(outage);
	});
});

describe("requireUser", () => {
	it("still throws the sign-in message for a real signed-out caller", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
		await expect(requireUser()).rejects.toThrow(
			"You need to be signed in to do that.",
		);
	});

	it("does not turn an outage into the sign-in message", async () => {
		vi.mocked(auth.api.getSession).mockRejectedValue(new Error("pool exhausted"));
		await expect(requireUser()).rejects.toThrow("pool exhausted");
	});
});
```

If importing `./guards` fails at load because another of its imports
(`./impersonation-logic`, `./meeting-authz-logic`, `./officers-logic`,
`./membership-pick-order`) evaluates something against `db` at module scope,
add `vi.mock("./<that module>", () => ({ ...only the named exports guards.ts imports... }))`
for that module and say so in the PR body. Do not mock `./guards` itself.

**Verify**: `bunx vitest run src/server/guards-session.test.ts` → 6 passed.

**Mutate**: reintroduce the bug and watch the fourth case fail:

```bash
bun run mutate src/server/guards.ts --literal "	const session = await auth.api.getSession({ headers: request.headers });
	return session?.user ?? null;" "	try {
		const session = await auth.api.getSession({ headers: request.headers });
		return session?.user ?? null;
	} catch {
		return null;
	}" swallow-restored src/server/guards-session.test.ts
```

→ red under mutation (the "propagates a failing session lookup" and "does not
turn an outage" cases), restored. If `--literal` with a multi-line string is
awkward in your shell, mutate the single line
`return session?.user ?? null;` → `return null;` instead and confirm the
"is the user when the session resolves" case goes red; then ALSO confirm by
reading that the `try` no longer encloses the `getSession` call.

### Step 4: Behavioural suites and the full run

```bash
bunx vitest run src/server/auth-context-clubs.integration.test.ts src/server/asserted-plan-only.integration.test.ts src/server/slots.transport.test.ts src/server/mcp/mcp-route.integration.test.ts
bun run typecheck && bunx biome check --diagnostic-level=error && bun run test
```

→ all exit 0. Read the summary: the only skips are Chrome suites (if
`CHROME_PATH` is unset).

## Test plan

- New `src/server/guards-session.test.ts`: four `getSessionUser` outcomes and
  two `requireUser` outcomes (listed in Step 3). Pattern: the `vi.mock` shapes
  from `src/server/asserted-plan-only.integration.test.ts:50-57` and the
  `#/db` stub from `src/server/role-sheets-pdf-logic.test.ts`.
- Existing suites that run the real guard chain against the test database
  (`auth-context-clubs.integration.test.ts` and the transport tests) must stay
  green; they exercise the `null`-without-context path.
- Verification: the commands in Step 4.

## Done criteria

- [ ] `bun run typecheck` and `bunx biome check --diagnostic-level=error` exit 0
- [ ] `bunx vitest run src/server/guards-session.test.ts` → 6 passed; the mutation in Step 3 went red
- [ ] In `src/server/guards.ts`, the `try` around `getRequest()` does not enclose `auth.api.getSession` (`grep -n -A3 "request = getRequest" src/server/guards.ts` shows the `catch` closing before the `getSession` line)
- [ ] `bun run test` exits 0
- [ ] The PR body quotes the Better-Auth not-found return line from Step 1
- [ ] `git status --porcelain` shows only the two in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 shows `auth.api.getSession` THROWS for a missing or invalid cookie in
  the installed Better-Auth (1.7.5): then an anonymous visitor would hit the
  error path on every public page. Report the line; the fix would need to
  classify `APIError` status codes, which is a different plan.
- The "Current state" excerpt of `getSessionUser` does not match.
- Any integration suite that previously passed now fails with
  `No StartEvent found in AsyncLocalStorage` — a caller depended on a thrown
  `getSession` being swallowed; name the suite and stop.
- `bun run test` shows new failures in `src/routes/*` or `auth-context*`.

## Maintenance notes

- The contract is now: `null` = no request context OR no valid session;
  throw = the lookup itself failed. Keep both halves in the doc comment; a
  future "make it resilient" change that re-wraps `getSession` in a catch
  reintroduces the silent sign-out.
- Reviewer: check the diff moves the `getSession` call OUT of the `try` rather
  than adding a second `try`; the mutation output in the PR body should show
  the propagation case going red.
- What a thrown loader error looks like to a member is owned by
  `src/components/route-error.tsx`; if it reads badly for an outage, follow up
  there, not in the guard.
- Deferred on purpose: distinguishing Better-Auth `APIError` by status (a
  401/403 from the adapter would still propagate as an error after this plan;
  Step 1 establishes that the ordinary not-signed-in case resolves to `null`,
  so that is not expected on a normal request).
