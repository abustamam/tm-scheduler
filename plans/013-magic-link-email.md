# Plan 013: Wire real email delivery for magic-link sign-in (Resend)

> **For agentic workers:** Use superpowers:subagent-driven-development or
> superpowers:executing-plans to run this task-by-task. Steps use checkbox
> (`- [ ]`) syntax for tracking.
>
> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 21ad077..HEAD -- src/lib/auth.ts src/routes/signin.tsx .env.example`
> If any of those files changed since this plan was written, compare the "Current
> state" excerpts below against the live code; on a mismatch, treat it as a STOP
> condition.

**Goal:** Deliver the magic-link sign-in email via Resend when configured, keep
the console fallback in dev, and never silently swallow a send failure.

**Architecture:** Three small modules — `src/lib/email.ts` (provider-agnostic
transport over `fetch`), `src/lib/magic-link-email.ts` (pure content builder),
and `src/lib/auth.ts` (wires them into the Better-Auth `magicLink` plugin and
pins the link TTL). No new npm dependency; Resend is one `POST` via the built-in
`fetch`.

**Tech Stack:** TanStack Start (React 19), Better-Auth `magicLink` plugin,
Resend HTTP API, Vitest. Biome: **tabs + double quotes**, strict TS
(no-unused-locals/params).

## Status

- **Priority**: P1 (launch blocker — issue #1, `pre-launch`)
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (006 rate limiting already shipped; domain + Railway vars done)
- **Category**: feature / pre-launch
- **Planned at**: commit `21ad077`, 2026-06-26
- **Issue**: [#1](https://github.com/abustamam/tm-scheduler/issues/1)
- **Design**: `docs/design/magic-link-email.md`

## Why this matters

Sign-in is magic-link only (ADR-0004) and is the only way in. `sendMagicLink`
currently only `console.log`s the URL — fine for dev, unusable for real club
members who can't read the server console. Without delivered email no member can
sign in, so this is the hard launch blocker. The auth scaffold is already on the
Better-Auth `magicLink` plugin; this is purely about email **delivery**.

## Current state

`src/lib/auth.ts` (entire file):

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "#/db";

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg" }),
	rateLimit: {
		enabled: true,
		// Global default: 20 requests per 60 s (covers all auth endpoints).
		window: 60,
		max: 20,
		// Tighter rule for the magic-link sign-in path to prevent email-bomb / account-enumeration.
		customRules: {
			"/sign-in/magic-link": { window: 60, max: 5 },
		},
	},
	plugins: [
		magicLink({
			sendMagicLink: async ({ email, url }) => {
				// TODO: wire a real email provider (e.g. Resend / SES) before
				// production. For local dev we just log the link so you can copy it.
				console.log(`\n[magic-link] sign-in link for ${email}:\n${url}\n`);
			},
		}),
		tanstackStartCookies(),
	],
});
```

`src/routes/signin.tsx` — the "Check your email" success state contains this
hardcoded, always-rendered line (other parts of the file are unchanged and out
of scope):

```tsx
<p className="text-muted-foreground">
	(Dev: the link is printed in the server console.)
</p>
```

Facts confirmed against the installed packages:
- Better-Auth `await`s `options.sendMagicLink(...)` with **no try/catch**
  (`node_modules/better-auth/dist/plugins/magic-link/index.mjs`), so a throw
  becomes an error response — `signin.tsx` already renders `error.message`.
- Default link TTL is 300 s (`opts.expiresIn || 300`); we pin it explicitly.
- No `resend` package is installed — intentional; we use `fetch`.
- Node is v24 (global `fetch` and `Response` available).

## Commands you will need

| Purpose   | Command                              | Expected on success |
|-----------|--------------------------------------|---------------------|
| Run tests | `bunx vitest run src/lib`            | all pass            |
| One file  | `bunx vitest run src/lib/email.test.ts` | pass             |
| Typecheck | `bunx tsc --noEmit`                  | exit 0              |
| Build     | `bun run build`                      | exit 0              |
| Lint/fmt  | `bun run check`                      | exit 0              |

## Scope

**In scope** (create/modify):
- Create `src/lib/email.ts` + `src/lib/email.test.ts`
- Create `src/lib/magic-link-email.ts` + `src/lib/magic-link-email.test.ts`
- Modify `src/lib/auth.ts` (wire sender, pin `expiresIn`)
- Modify `src/routes/signin.tsx` (gate the dev hint on `import.meta.env.DEV`)
- Modify docs: `.env.example`, `CLAUDE.md`, `README.md`
- Update `plans/README.md` status row

**Out of scope** (do NOT touch):
- The `resend` SDK / any new dependency — use `fetch`.
- Rate limiting (already configured in `auth.ts`).
- Richer email (agendas, reminders, attachments, batch, React Email) — deferred
  behind the `sendEmail` seam.
- Any change to `src/routes/api/auth/$.ts` or the auth schema.

## Git workflow

- Already on branch `feat/magic-link-email` (the design doc is committed there).
- One conventional commit per task as noted in the steps.
- Do NOT push or open a PR unless instructed.

---

## Task 1: `sendEmail` transport (`src/lib/email.ts`)

**Files:**
- Create: `src/lib/email.ts`
- Test: `src/lib/email.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/email.test.ts`. Uses `vi.stubEnv` (read at call time) and a
mocked `globalThis.fetch`.

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "./email";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

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

	it("POSTs to Resend with bearer auth and the right body when keyed", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		vi.stubEnv("EMAIL_FROM", "GavelUp <noreply@gavelup.app>");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ id: "1" }), { status: 200 }));

		await sendEmail({
			to: "member@example.com",
			subject: "Subj",
			html: "<p>H</p>",
			text: "T",
		});

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe("https://api.resend.com/emails");
		const headers = init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer re_test");
		const body = JSON.parse(init?.body as string);
		expect(body).toMatchObject({
			from: "GavelUp <noreply@gavelup.app>",
			to: "member@example.com",
			subject: "Subj",
			html: "<p>H</p>",
			text: "T",
		});
	});

	it("falls back to the default from address when EMAIL_FROM is unset", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		vi.stubEnv("EMAIL_FROM", "");
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		await sendEmail({ to: "a@b.com", subject: "S", html: "<p></p>", text: "t" });

		const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
		expect(body.from).toBe("GavelUp <noreply@gavelup.app>");
	});

	it("throws (does not swallow) when Resend returns a non-OK response", async () => {
		vi.stubEnv("RESEND_API_KEY", "re_test");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad", { status: 422 }));
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			sendEmail({ to: "a@b.com", subject: "S", html: "<p></p>", text: "t" }),
		).rejects.toThrow("Failed to send email.");
	});
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bunx vitest run src/lib/email.test.ts`
Expected: FAIL — `sendEmail` / module `./email` not found.

- [ ] **Step 3: Implement `src/lib/email.ts`**

```ts
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "GavelUp <noreply@gavelup.app>";

export interface SendEmailParams {
	to: string;
	subject: string;
	html: string;
	text: string;
}

/**
 * Provider-agnostic email transport. Sends via Resend when RESEND_API_KEY is
 * set; otherwise logs to the console (dev). Throws on send failure — callers
 * (e.g. Better-Auth's sendMagicLink) rely on the throw surfacing a clean error.
 *
 * The transport seam is deliberately minimal; `to`/attachments/`from`-override
 * can be added non-breakingly when richer email (agendas) lands.
 */
export async function sendEmail({
	to,
	subject,
	html,
	text,
}: SendEmailParams): Promise<void> {
	const apiKey = process.env.RESEND_API_KEY;
	const from = process.env.EMAIL_FROM || DEFAULT_FROM;

	// Dev fallback: no provider configured. Log the email — the text body carries
	// the magic-link URL, so local sign-in still works by copy-paste. This is the
	// ONLY path that logs the link; when a provider is configured the URL (a
	// bearer token) is never logged.
	if (!apiKey) {
		console.log(`\n[email:dev] to=${to} subject=${subject}\n${text}\n`);
		return;
	}

	let res: Response;
	try {
		res = await fetch(RESEND_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ from, to, subject, html, text }),
		});
	} catch (cause) {
		console.error(`[email] network error sending to ${to}:`, cause);
		throw new Error("Failed to send email.");
	}

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		console.error(`[email] Resend error sending to ${to}: ${res.status} ${detail}`);
		throw new Error("Failed to send email.");
	}
}
```

- [ ] **Step 4: Run tests; verify they pass**

Run: `bunx vitest run src/lib/email.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/email.ts src/lib/email.test.ts
git commit -m "feat: add Resend email transport with dev console fallback"
```

---

## Task 2: Magic-link content (`src/lib/magic-link-email.ts`)

**Files:**
- Create: `src/lib/magic-link-email.ts`
- Test: `src/lib/magic-link-email.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/magic-link-email.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMagicLinkEmail } from "./magic-link-email";

describe("buildMagicLinkEmail", () => {
	const url =
		"https://gavelup.app/api/auth/magic-link/verify?token=abc123&callbackURL=/";
	const built = buildMagicLinkEmail(url);

	it("uses the GavelUp subject", () => {
		expect(built.subject).toBe("Your GavelUp sign-in link");
	});

	it("includes the url in both html and text", () => {
		expect(built.html).toContain(url);
		expect(built.text).toContain(url);
	});

	it("states the 5-minute expiry and an ignore note in both parts", () => {
		expect(built.text).toContain("expires in 5 minutes");
		expect(built.text.toLowerCase()).toContain("ignore");
		expect(built.html).toContain("expires in 5 minutes");
	});
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bunx vitest run src/lib/magic-link-email.test.ts`
Expected: FAIL — module `./magic-link-email` not found.

- [ ] **Step 3: Implement `src/lib/magic-link-email.ts`**

Pure, dependency-free (importable without booting `auth.ts`). Inline-styled,
table-free HTML + a plaintext part. The `url` is produced by Better-Auth (our
own origin + token), not user input.

```ts
const EXPIRY_MINUTES = 5;

export interface MagicLinkEmail {
	subject: string;
	html: string;
	text: string;
}

/** Build the magic-link sign-in email (subject + HTML + plaintext). */
export function buildMagicLinkEmail(url: string): MagicLinkEmail {
	const subject = "Your GavelUp sign-in link";

	const text = [
		"Sign in to GavelUp",
		"",
		"Click the link below to sign in. No password needed.",
		"",
		url,
		"",
		`This link expires in ${EXPIRY_MINUTES} minutes. If you didn't request it, you can safely ignore this email.`,
	].join("\n");

	const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;">
      <h1 style="font-size:20px;color:#18181b;margin:0 0 16px;">Sign in to GavelUp</h1>
      <p style="font-size:15px;line-height:1.5;color:#3f3f46;margin:0 0 24px;">
        Click the button below to sign in. No password needed.
      </p>
      <a href="${url}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:8px;">
        Sign in
      </a>
      <p style="font-size:13px;line-height:1.5;color:#71717a;margin:24px 0 0;">
        Or paste this link into your browser:<br />
        <a href="${url}" style="color:#3f3f46;word-break:break-all;">${url}</a>
      </p>
      <p style="font-size:13px;line-height:1.5;color:#a1a1aa;margin:24px 0 0;">
        This link expires in ${EXPIRY_MINUTES} minutes. If you didn't request it, you can safely ignore this email.
      </p>
    </div>
  </body>
</html>`;

	return { subject, html, text };
}
```

- [ ] **Step 4: Run tests; verify they pass**

Run: `bunx vitest run src/lib/magic-link-email.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/magic-link-email.ts src/lib/magic-link-email.test.ts
git commit -m "feat: add magic-link email content builder"
```

---

## Task 3: Wire the sender into Better-Auth (`src/lib/auth.ts`)

**Files:**
- Modify: `src/lib/auth.ts`

No unit test for this task — `auth.ts` instantiates `betterAuth()` at import
(needs `DATABASE_URL`), so it's verified via typecheck + build. The behavior it
composes is covered by Tasks 1 and 2.

- [ ] **Step 1: Replace the `sendMagicLink` stub and pin the TTL**

Edit `src/lib/auth.ts`. Add the two imports and replace the `magicLink({...})`
block. Keep the existing `rateLimit` block exactly as-is. Final file:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { db } from "#/db";
import { sendEmail } from "./email";
import { buildMagicLinkEmail } from "./magic-link-email";

export const auth = betterAuth({
	database: drizzleAdapter(db, { provider: "pg" }),
	rateLimit: {
		enabled: true,
		// Global default: 20 requests per 60 s (covers all auth endpoints).
		window: 60,
		max: 20,
		// Tighter rule for the magic-link sign-in path to prevent email-bomb / account-enumeration.
		customRules: {
			"/sign-in/magic-link": { window: 60, max: 5 },
		},
	},
	plugins: [
		magicLink({
			// Magic links are the only way in — keep the window short. Pinned so
			// the email copy ("expires in 5 minutes") cannot drift from the TTL.
			expiresIn: 60 * 5,
			sendMagicLink: async ({ email, url }) => {
				const { subject, html, text } = buildMagicLinkEmail(url);
				await sendEmail({ to: email, subject, html, text });
			},
		}),
		tanstackStartCookies(),
	],
});
```

- [ ] **Step 2: Typecheck + build**

Run: `bunx tsc --noEmit` → exit 0
Run: `bun run build` → exit 0

(If `expiresIn` is rejected by the installed Better-Auth types, that's a STOP
condition — report the actual option name.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/auth.ts
git commit -m "feat: send real magic-link emails and pin 5-minute TTL"
```

---

## Task 4: Gate the dev hint in the sign-in UI (`src/routes/signin.tsx`)

**Files:**
- Modify: `src/routes/signin.tsx`

- [ ] **Step 1: Gate the dev-only line on `import.meta.env.DEV`**

Find this block in the "Check your email" state:

```tsx
							<p className="text-muted-foreground">
								(Dev: the link is printed in the server console.)
							</p>
```

Replace it with:

```tsx
							{import.meta.env.DEV ? (
								<p className="text-muted-foreground">
									(Dev: the link is printed in the server console.)
								</p>
							) : null}
```

- [ ] **Step 2: Typecheck + build + lint**

Run: `bunx tsc --noEmit` → exit 0
Run: `bun run build` → exit 0
Run: `bun run check` → exit 0

- [ ] **Step 3: Commit**

```bash
git add src/routes/signin.tsx
git commit -m "fix: hide the dev console hint on the sign-in page in production"
```

---

## Task 5: Documentation (`.env.example`, `CLAUDE.md`, `README.md`)

**Files:**
- Modify: `.env.example`
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: `.env.example` — add the two vars (commented)**

After the `BETTER_AUTH_SECRET=` line, add:

```bash

# Email delivery for magic-link sign-in (Resend). When RESEND_API_KEY is unset,
# sign-in links print to the server console (dev). Set both in production.
# RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
# EMAIL_FROM=GavelUp <noreply@gavelup.app>
```

- [ ] **Step 2: `CLAUDE.md` — update the auth bullet and Environment section**

In the **Stack** section's Better-Auth bullet, replace the "still stubbed"
sentence:

> Magic-link delivery is
> still stubbed: `sendMagicLink` only `console.log`s the URL, so a real email provider (Resend/SES)
> must be wired before production (tracked as a pre-launch issue).

with:

> Magic-link delivery goes through **Resend** (`src/lib/email.ts`,
> `src/lib/magic-link-email.ts`) when `RESEND_API_KEY` is set; with no key it
> falls back to logging the URL to the server console (dev).

In the **Environment** section, after the `Required: ...` line, add:

```
Optional (magic-link email delivery): `RESEND_API_KEY` and `EMAIL_FROM`
(default `"GavelUp <noreply@gavelup.app>"`). Unset → magic-link URLs print to the
server console (dev); set both in production to send via Resend.
```

- [ ] **Step 3: `README.md` — replace the "Signing in (dev)" section**

Replace the existing `### Signing in (dev)` heading and its paragraph with:

```markdown
### Signing in

Auth is **magic-link only** (ADR-0004).

**In development**, no email provider is configured — when you request a sign-in
link the URL is **printed to the server console**. Copy it from the terminal
running `bun run dev` and open it.

**In production**, magic links are delivered by **Resend**. Set these env vars
(in the Railway dashboard, per ADR-0007):

| Var | Purpose |
| --- | --- |
| `RESEND_API_KEY` | Resend API key. Its presence switches on real sending. |
| `EMAIL_FROM` | Sender identity. Defaults to `GavelUp <noreply@gavelup.app>`. |

The sending domain (`gavelup.app`) must be verified in Resend (SPF/DKIM DNS
records) before delivery works. Before the domain is verified you can smoke-test
by setting `EMAIL_FROM="onboarding@resend.dev"` (Resend then only delivers to
your own account email).
```

- [ ] **Step 4: Full gate**

Run: `bun run check` → exit 0
Run: `bun run build` → exit 0

- [ ] **Step 5: Commit**

```bash
git add .env.example CLAUDE.md README.md
git commit -m "docs: document Resend magic-link email vars and sign-in flow"
```

---

## Task 6: Update the plans index

**Files:**
- Modify: `plans/README.md`

- [ ] **Step 1: Add a status row**

Add this row to the "Execution order & status" table (after the `012` row):

```
| 013 | Wire real email delivery (magic-link via Resend) | P1 | M | — | [#1](https://github.com/abustamam/tm-scheduler/issues/1) | DONE — on branch feat/magic-link-email |
```

- [ ] **Step 2: Commit**

```bash
git add plans/README.md
git commit -m "docs: add plan 013 status row"
```

---

## Final verification

- [ ] `bunx vitest run src/lib` → all pass (7 new tests; existing suites still pass)
- [ ] `bunx tsc --noEmit` → exit 0
- [ ] `bun run build` → exit 0
- [ ] `bun run check` → exit 0

### Optional manual smoke test (needs DB + a Resend key)

1. Put a real `RESEND_API_KEY` and `EMAIL_FROM="onboarding@resend.dev"` in
   `.env.local`, run `bun run dev`, request a link to your own Resend-account
   email, and confirm it arrives.
2. With `RESEND_API_KEY` unset, confirm the link still prints to the console.
   Do not commit anything from this step.

## Test plan

- `email.test.ts`: dev fallback skips `fetch` and logs recipient + URL; keyed
  path POSTs to Resend with bearer auth and correct body; `EMAIL_FROM` default vs
  override; non-OK response throws (no silent swallow).
- `magic-link-email.test.ts`: subject; URL in html **and** text; expiry + ignore
  copy present.
- `auth.ts` / `signin.tsx`: covered by typecheck + build (no unit test).

## Done criteria

ALL must hold:

- [ ] `sendEmail` sends via Resend when `RESEND_API_KEY` is set, else logs (dev)
- [ ] Send failure throws a clean `Error` (verified by test), not a silent swallow
- [ ] `magicLink` config pins `expiresIn: 60 * 5` and the email copy says 5 minutes
- [ ] The sign-in dev hint only renders under `import.meta.env.DEV`
- [ ] `.env.example`, `CLAUDE.md`, `README.md` document `RESEND_API_KEY`/`EMAIL_FROM`
- [ ] `bunx vitest run src/lib`, `bunx tsc --noEmit`, `bun run build`, `bun run check` all green
- [ ] `plans/README.md` row for 013 updated

## STOP conditions

Stop and report (do not improvise) if:
- The installed Better-Auth `magicLink` plugin rejects `expiresIn` or has a
  materially different option name — report the actual API.
- Global `fetch`/`Response` are unavailable in the test or build runtime
  (shouldn't happen on Node v24) — report rather than adding a polyfill/dep.
- Adding the modules breaks the existing test suite or the build.

## Maintenance notes

- When agenda/reminder email arrives, that's the moment to revisit the `resend`
  SDK and a templating lib (React Email) — both swap in **behind** the unchanged
  `sendEmail` seam, so callers don't change. Extend `SendEmailParams` (e.g.
  `to: string | string[]`, optional `attachments`) non-breakingly then.
- Keep the 5-minute TTL and the email copy in sync (both reference 5 minutes); if
  you change `expiresIn`, update `EXPIRY_MINUTES` in `magic-link-email.ts`.
- The magic-link URL is logged **only** in the keyless dev path — preserve that
  invariant; the URL embeds a bearer token.
