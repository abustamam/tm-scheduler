# Plan 023: Production never logs a sign-in link, and a hung mail request cannot stall the poller

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat b955f240..HEAD -- src/lib/email.ts src/lib/email.test.ts .env.example`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (plan 021 first is recommended so the suite's DB tests run, but this plan's tests are unit tests)
- **Category**: security / correctness
- **Planned at**: commit `b955f240`, 2026-10-30

## Why this matters

Magic links are the only way into GavelUp (ADR-0004), and a magic-link URL is
a bearer credential: whoever opens it is signed in as that address. The
transport in `src/lib/email.ts` has a development fallback: when
`RESEND_API_KEY` is unset it prints the whole email body, link included, to
the server console. That fallback has no production guard. A production
deploy whose key is missing (an env mistake, a rotation that was not pasted
back, a new Railway environment) does not fail; it quietly writes every
member's sign-in link to Railway's logs, where anyone with log access can
sign in as anyone while the link is valid. Compare `src/lib/dev-login.ts`,
which gates the other sign-in bypass on `NODE_ENV !== "production"` and says
why in its header.

Second, the Resend `fetch` carries no timeout. `sendEmail` is called from the
in-process poller's delivery pass (`deliverAccessRequestMail`, ADR-0023),
which runs under a `ticking` guard that skips every later tick while one is in
flight — and the retention sweeps for pending plans and access requests (the
only things that delete a visitor's unmasked contact) run AFTER delivery in
the same tick. A black-holed connection to the mail provider holds the tick
open until the runtime's own socket timeout, on the order of minutes, and
every magic-link request in that window hangs the same way.

After this plan: in production without a key, `sendEmail` throws a clean
error and logs one line that names the misconfiguration, never the link; in
every environment the provider call aborts after a fixed timeout and surfaces
as the existing "Failed to send email." error.

## Current state

### Files

- `src/lib/email.ts` — provider-agnostic transport (`sendEmail`), Resend when
  keyed, console fallback otherwise. Client-safe `lib/` module (no `#/db`).
- `src/lib/email.test.ts` — its unit tests (uses `vi.stubEnv`, spies on
  `globalThis.fetch` and `console.log`).
- `src/lib/dev-login.ts` — the production-gate precedent.
- `src/server/reminder-poller.ts` — the tick (`runPollerTick`) with its
  `ticking` overlap guard; NOT edited by this plan, but it is the caller whose
  stall this fixes.
- `.env.example` — documents the env vars.

### Excerpts (as of `b955f240`)

`src/lib/email.ts:68-86`:

```ts
export async function sendEmail({
	to,
	subject,
	html,
	text,
	replyTo,
	idempotencyKey,
}: SendEmailParams): Promise<void> {
	const apiKey = process.env.RESEND_API_KEY;
	const from = process.env.EMAIL_FROM || DEFAULT_FROM;
	const toLabel = Array.isArray(to) ? to.join(", ") : to;

	// Dev fallback: no provider configured. Log the email — the text body carries
	// the magic-link URL, so local sign-in still works by copy-paste. This is the
	// ONLY path that logs the link; when a provider is configured the URL (a
	// bearer token) is never logged.
	if (!apiKey) {
		const replyToNote = replyTo ? ` reply_to=${replyTo}` : "";
		console.log(
			`\n[email:dev] to=${toLabel} subject=${subject}${replyToNote}\n${text}\n`,
		);
		return;
	}
```

`src/lib/email.ts:118-140`:

```ts
	let res: Response;
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		};
		if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
		res = await fetch(RESEND_ENDPOINT, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	} catch (cause) {
		console.error(`[email] network error sending to ${toLabel}:`, cause);
		throw new Error("Failed to send email.");
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		console.error(
			`[email] Resend error sending to ${toLabel}: ${res.status} ${detail}`,
		);
		throw new Error("Failed to send email.");
	}
```

`src/lib/dev-login.ts:17-22` (the precedent to mirror):

```ts
export function isDevLoginEnabled(): boolean {
	return (
		process.env.NODE_ENV !== "production" &&
		process.env.ENABLE_DEV_LOGIN === "1"
	);
}
```

`src/lib/email.test.ts:9-26` (the existing fallback test; it must keep passing
because it does not set `NODE_ENV`):

```ts
describe("sendEmail", () => {
	it("uses the dev fallback (no fetch) when RESEND_API_KEY is unset", async () => {
		vi.stubEnv("RESEND_API_KEY", "");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await sendEmail({
			to: "member@example.com",
			subject: "Hi",
			html: "<p>hello</p>",
			text: "open this: https://gavelup.app/x",
		});

		expect(fetchSpy).not.toHaveBeenCalled();
		const logged = logSpy.mock.calls.flat().join(" ");
		expect(logged).toContain("member@example.com");
		expect(logged).toContain("https://gavelup.app/x");
	});
```

`Dockerfile:52` sets `ENV NODE_ENV=production` in the runtime image, so the
production process always has that value.

`src/server/reminder-poller.ts:63-84` — `runPollerTick` sets `ticking = true`,
awaits `deliverAccessRequestMail()` (which calls `sendEmail`), then
`sweepTick()`, in a `finally` that clears `ticking`. Not edited here.

### Conventions to match

- Numbers that a test must assert live in `src/lib/` as exported constants and
  are asserted ABSOLUTELY (`CODING_STANDARDS.md`, "Test coverage": a bound
  stated relative to the constant it guards cannot fail).
- Log tags: `[email]` for this module (existing), `[email:dev]` for the
  fallback line.
- Biome: tabs, double quotes, organized imports. Conventional commits:
  `fix(email): …`.
- Tests: `vi.stubEnv` + `afterEach(vi.unstubAllEnvs)` as the file already does.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Bootstrap worktree | `bun run worktree:setup "plan 023"` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint gate | `bunx biome check --diagnostic-level=error` | exit 0 |
| This file's tests | `bunx vitest run src/lib/email.test.ts` | all pass |
| Related | `bunx vitest run src/lib/magic-link-email.test.ts src/server/reminder-poller.test.ts` | all pass |
| Mutation | `bun run mutate src/lib/email.ts --literal <old> <new> <label> src/lib/email.test.ts` | red under mutation, restored |
| Full suite | `bun run test` | exit 0 |

## Files

- `src/lib/email.ts`
- `src/lib/email.test.ts`
- `.env.example`

## Scope

**In scope** (the only files you should modify): the three files above.

**Out of scope** (do NOT touch, even though they look related):

- `src/lib/auth.ts` (`sendMagicLink` already awaits `sendEmail` and lets a
  throw surface; nothing to change).
- `src/server/reminder-poller.ts` and `src/server/access-requests-logic.ts` —
  the timeout at the transport is what bounds the tick; reordering the sweep
  before delivery is a separate decision (see Maintenance notes).
- `src/routes/api/health.ts` / `src/lib/auth-init-status.ts` — reporting a
  missing mail key on the health probe would make a deploy fail to promote,
  which is a product call; not here.
- `README.md` — its "Signing in" section describes the dev fallback correctly
  for development; its other problems are a different plan.
- Masking recipient addresses in the error logs (they are the operator's own
  logs; low value, not here).

## Git workflow

- Branch: `email-fails-closed-023`, as a worktree, bootstrapped.
- One or two commits; conventional-commit messages.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the production gate and the timeout constant

In `src/lib/email.ts`, after `const DEFAULT_FROM = …;` (line 2), add:

```ts
/**
 * How long one provider request may take before it is abandoned. `sendEmail`
 * is on the magic-link path AND inside the poller's delivery pass
 * (`src/server/reminder-poller.ts`), whose `ticking` guard skips every later
 * tick while one is in flight — so an unbounded request is an unbounded stall
 * of the retention sweeps behind it. 10 s is many times Resend's normal
 * response and well inside any request timeout in front of this process.
 */
export const EMAIL_PROVIDER_TIMEOUT_MS = 10_000;

/**
 * May this process print an email to the console instead of sending it?
 * Only outside production: the text body carries the magic-link URL, which is
 * a bearer credential, and a production deploy that has lost its
 * RESEND_API_KEY must refuse rather than write every member's sign-in link to
 * the platform logs. Same gate as `isDevLoginEnabled` (`#/lib/dev-login`).
 */
export function consoleFallbackAllowed(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.NODE_ENV !== "production";
}
```

Then change the fallback block quoted in "Current state" to:

```ts
	if (!apiKey) {
		if (!consoleFallbackAllowed()) {
			// One line that names the misconfiguration and NOTHING from the
			// message: not the recipient, not the subject, never the body.
			console.error(
				"[email] RESEND_API_KEY is not set in production; refusing to send or log the message.",
			);
			throw new Error("Email is not configured.");
		}
		const replyToNote = replyTo ? ` reply_to=${replyTo}` : "";
		console.log(
			`\n[email:dev] to=${toLabel} subject=${subject}${replyToNote}\n${text}\n`,
		);
		return;
	}
```

**Verify**: `bun run typecheck` → exit 0; `bunx vitest run src/lib/email.test.ts`
→ the existing tests still pass (none sets `NODE_ENV=production`).

### Step 2: Bound the provider request

In the `fetch` call quoted in "Current state", add a `signal`:

```ts
		res = await fetch(RESEND_ENDPOINT, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			// An abandoned request rejects with a TimeoutError, which the catch
			// below turns into the same "Failed to send email." the caller
			// already handles; see EMAIL_PROVIDER_TIMEOUT_MS.
			signal: AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS),
		});
```

In the `!res.ok` branch, cap the provider body that reaches the log (an error
page can be large):

```ts
		const detail = (await res.text().catch(() => "")).slice(0, 500);
```

**Verify**: `bun run typecheck` → exit 0 (`AbortSignal.timeout` is in the
`ES2022`/`DOM` libs the tsconfig already targets; if the type is missing, see
STOP conditions).

### Step 3: Tests

In `src/lib/email.test.ts`, add inside `describe("sendEmail")` (keep the
existing cases):

```ts
	it("in production with no RESEND_API_KEY, throws and logs nothing from the message", async () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("RESEND_API_KEY", "");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			sendEmail({
				to: "member@club.org",
				subject: "Sign in to GavelUp",
				html: "<p>x</p>",
				text: "open this: https://gavelup.app/api/auth/magic-link/verify?token=SECRET",
			}),
		).rejects.toThrow("Email is not configured.");

		expect(fetchSpy).not.toHaveBeenCalled();
		const everything = [...logSpy.mock.calls, ...errorSpy.mock.calls]
			.flat()
			.map(String)
			.join(" ");
		expect(everything).not.toContain("SECRET");
		expect(everything).not.toContain("member@club.org");
		expect(everything).not.toContain("Sign in to GavelUp");
		expect(everything).toContain("RESEND_API_KEY is not set in production");
	});

	it("outside production the console fallback is allowed", () => {
		expect(consoleFallbackAllowed({ NODE_ENV: "development" })).toBe(true);
		expect(consoleFallbackAllowed({ NODE_ENV: "test" })).toBe(true);
		expect(consoleFallbackAllowed({})).toBe(true);
		expect(consoleFallbackAllowed({ NODE_ENV: "production" })).toBe(false);
	});

	it("bounds the provider request with an absolute timeout", async () => {
		expect(EMAIL_PROVIDER_TIMEOUT_MS).toBe(10_000);
		vi.stubEnv("RESEND_API_KEY", "re_test");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ id: "1" }), { status: 200 }));
		await sendEmail({ to: "a@club.org", subject: "s", html: "h", text: "t" });
		const init = fetchSpy.mock.calls[0]?.[1];
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("a timed-out provider request surfaces as the generic send failure", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new DOMException("The operation was aborted due to timeout", "TimeoutError"),
		);
		await expect(
			sendEmail({ to: "a@club.org", subject: "s", html: "h", text: "t" }),
		).rejects.toThrow("Failed to send email.");
	});
```

Add `consoleFallbackAllowed` and `EMAIL_PROVIDER_TIMEOUT_MS` to the import
from `./email`.

**Verify**: `bunx vitest run src/lib/email.test.ts` → all pass (the existing
dev-fallback test proves the non-production path is unchanged).

**Mutate** (both must go red):

```bash
bun run mutate src/lib/email.ts --literal 'return env.NODE_ENV !== "production";' 'return true;' gate-removed src/lib/email.test.ts
bun run mutate src/lib/email.ts --literal 'signal: AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS),' '' timeout-removed src/lib/email.test.ts
```

### Step 4: Document the behaviour

In `.env.example`, replace the two comment lines above `# RESEND_API_KEY=`
with:

```
# Email delivery for magic-link sign-in (Resend). When RESEND_API_KEY is unset
# OUTSIDE production, sign-in links print to the server console (dev). In
# production (NODE_ENV=production, which the Dockerfile sets) an unset key makes
# every send fail with "Email is not configured." — the link is never logged.
```

**Verify**: `git diff .env.example` shows only that comment change.

### Step 5: Gate

```bash
bun run typecheck && bunx biome check --diagnostic-level=error && bunx vitest run src/lib/email.test.ts src/lib/magic-link-email.test.ts src/server/reminder-poller.test.ts && bun run test
```

→ all exit 0.

## Test plan

- New cases in `src/lib/email.test.ts` (listed in Step 3): production
  fail-closed with nothing from the message logged; the pure gate; the signal
  is passed and the constant is absolute; a timeout rejects as the generic
  failure. Model: the file's existing `vi.stubEnv` / `vi.spyOn(globalThis, "fetch")`
  cases.
- Two mutations, output pasted in the PR body.
- Verification: `bunx vitest run src/lib/email.test.ts` → all pass, including
  4 new.

## Done criteria

- [ ] `bun run typecheck` and `bunx biome check --diagnostic-level=error` exit 0
- [ ] `bunx vitest run src/lib/email.test.ts` passes with 4 new cases; both mutations went red
- [ ] `grep -n "AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS)" src/lib/email.ts` → one match
- [ ] `grep -n "consoleFallbackAllowed()" src/lib/email.ts` → one match, inside the `!apiKey` branch, before the `console.log`
- [ ] `bun run test` exits 0
- [ ] `git status --porcelain` shows only the three in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the live file.
- `bun run typecheck` reports that `AbortSignal.timeout` does not exist on the
  type: report the tsconfig `lib` value; do not add a polyfill.
- Any test outside `src/lib/email.test.ts` fails after the change (a caller
  relied on the fallback in a `NODE_ENV=production` test — find out which
  before changing anything).
- The existing "uses the dev fallback" test fails: vitest's `NODE_ENV` is
  `test`, so it must not; if it does, something else sets production.

## Maintenance notes

- Anyone adding a second app-sent mail (ADR-0028 allows only the closed set:
  magic link, officer-sent invite, operator alerts) inherits both behaviours
  through `sendEmail`; do not add a parallel transport.
- `src/server/reminder-poller.ts` still runs delivery BEFORE the sweeps in one
  tick; the timeout bounds that to ~10 s per send attempt. If the delivery
  pass ever sends more than a handful of mails per tick, reorder the sweep
  first or give it its own guard (its sweep-only timer has no overlap guard
  today).
- Reviewer: confirm the production branch logs no part of the message (the
  test asserts three substrings; read the `console.error` line itself).
- Deferred on purpose: surfacing "mail not configured" on `/api/health`
  (would block deploy promotion — a product decision).
