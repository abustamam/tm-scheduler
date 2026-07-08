# Design: Real email delivery for magic-link sign-in

> Resolves issue #1 ("Wire a real email provider for magic-link sign-in"). Status: **implemented** (shipped to `main`; `src/lib/email.ts` + `src/lib/magic-link-email.ts`). Historical design record.

## Problem

Sign-in is magic-link only (ADR-0004) and is the only way in. At the time of writing,
`sendMagicLink` in `src/lib/auth.ts` only `console.log`ged the URL — fine for dev, unusable
for real club members. This was the hard launch blocker: without delivered email, no real
member could sign in. The auth scaffold is already on the Better-Auth `magicLink` plugin;
this work is purely about email **delivery**.

## Decisions (locked)

- **Provider: Resend**, called via the built-in **`fetch`** (`POST https://api.resend.com/emails`).
  No `resend` SDK dependency — a single, stable endpoint doesn't justify the dep or
  supply-chain surface. If/when richer email (agendas, attachments, batch) lands, we
  migrate `email.ts`'s internals to the SDK behind the unchanged `sendEmail` seam.
- **Selection: gate on `RESEND_API_KEY` presence.** Set → send via Resend. Unset → keep
  the current dev console fallback unchanged. No `EMAIL_PROVIDER` switch (YAGNI).
- **`from` address: `EMAIL_FROM` env**, default `"GavelUp <noreply@gavelup.app>"`.
- **Link expiry: pinned to 5 minutes** (`expiresIn: 60 * 5` in the `magicLink` config) so
  the email copy ("expires in 5 minutes") and the actual TTL can't drift. (Better-Auth's
  default is also 300 s, confirmed in `node_modules/better-auth/dist/plugins/magic-link`.)
- **Email body: hand-rolled inline-styled HTML + a required plaintext part.** No template
  engine / React Email yet (same migrate-later posture as the SDK).

## Architecture — three small, single-purpose modules

### 1. `src/lib/email.ts` — transport only (deep module, simple interface)

```ts
export async function sendEmail({ to, subject, html, text }: {
	to: string;       // single recipient for now
	subject: string;
	html: string;
	text: string;     // required — deliverability + accessibility
}): Promise<void>
```

- Reads `process.env.RESEND_API_KEY` and `process.env.EMAIL_FROM` **at call time**
  (not module load) so tests and dev work without env at import.
- **No key →** dev fallback: print a clear `[email:dev]` block (recipient, subject, and
  the `text` body — which carries the raw magic-link URL, preserving the copy-paste flow).
  Does **not** call Resend.
- **Key set →** `POST https://api.resend.com/emails` with `Authorization: Bearer <key>`
  and JSON `{ from: EMAIL_FROM (or default), to, subject, html, text }`.
- **Errors throw, never swallow:** a non-OK HTTP response (or a network error) →
  `console.error` with the recipient + Resend status/message, then `throw new Error(...)`.
  Returns `Promise<void>`; success is the absence of a throw.
- **Security guardrail:** the magic-link URL is logged **only** in the keyless dev path.
  When a real provider is configured the URL (a bearer token) is never logged.
- Future-expandable without breaking callers: `to: string | string[]`, optional
  `attachments`, optional per-call `from` — added when agenda email arrives, not now.

### 2. `src/lib/magic-link-email.ts` — content only (pure function)

```ts
export function buildMagicLinkEmail(url: string): {
	subject: string;
	html: string;
	text: string;
}
```

- Subject: `"Your GavelUp sign-in link"`.
- HTML: minimal, table-free, inline-styled — a short heading, a sentence, a large tappable
  button (`<a>` styled as a button), the raw URL on its own line as a fallback, and a
  footer: "This link expires in 5 minutes. If you didn't request it, you can ignore this
  email." Tone friendly for a non-technical Toastmasters audience.
- Plaintext: the same message with the URL inline.
- Pure and dependency-free, so it's testable **without** importing `auth.ts` (which boots
  `betterAuth()` and needs `DATABASE_URL`).

### 3. `src/lib/auth.ts` — wiring

- `sendMagicLink({ email, url })` calls `buildMagicLinkEmail(url)` then
  `sendEmail({ to: email, ...built })`. The inline TODO/`console.log` is removed.
- Add `expiresIn: 60 * 5` to the `magicLink({...})` config (pins the 5-minute TTL).

## Flow

1. Member submits email on `/signin` → `authClient.signIn.magicLink` → Better-Auth
   `sendMagicLink` endpoint.
2. `sendMagicLink` builds content and calls `sendEmail`.
3. `sendEmail`: keyless → log dev block; keyed → POST to Resend.
4. On send failure, `sendEmail` throws. Better-Auth's endpoint `await`s `sendMagicLink`
   with **no try/catch** (confirmed in the plugin source), so the error becomes an error
   response. `src/routes/signin.tsx` already renders `error.message` in a `role="alert"`
   with a friendly fallback — so the failure UX is already covered end-to-end; no new
   frontend error-handling code is needed.

## Frontend touch-up

`src/routes/signin.tsx` hardcodes `(Dev: the link is printed in the server console.)` in
the "Check your email" success state, shown unconditionally. Gate it on
`import.meta.env.DEV` so production members never see the dev hint. (One line; in scope
because we're flipping this feature from console-only to real delivery.)

## Configuration

| Var | Required? | Purpose |
| --- | --- | --- |
| `RESEND_API_KEY` | No (prod yes) | Gates real sending. Unset = dev console fallback. |
| `EMAIL_FROM` | No | Sender identity. Default `"GavelUp <noreply@gavelup.app>"`. |

Documented alongside `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` in:

- `.env.example` (add both, commented).
- `CLAUDE.md` Environment section.
- `README.md` "Signing in" section + a new **"Email delivery (production)"** checklist.

### Email delivery (production) — ops checklist (README)

Deployment target is **Railway** (ADR-0007); env vars are set in the Railway dashboard.

1. Register **`gavelup.app`**.
2. Add the domain in Resend and create the **SPF + DKIM** DNS records it provides
   (optionally DMARC). Wait for verification.
3. Set `RESEND_API_KEY` and `EMAIL_FROM` in the Railway dashboard.
4. **Escape hatch for early testing:** before the domain is verified, Resend only sends
   from `onboarding@resend.dev` and only to your own account email — set
   `EMAIL_FROM="onboarding@resend.dev"` to smoke-test delivery to your inbox.

No code detects domain verification — that's Resend's responsibility.

## Testing (Vitest, colocated)

- **`src/lib/magic-link-email.test.ts`** — subject present; the URL appears in **both**
  `html` and `text`; the "expires in 5 minutes" and "ignore" copy are present.
- **`src/lib/email.test.ts`** (mock `global.fetch`):
  - No `RESEND_API_KEY` → dev fallback logs, `fetch` **not** called.
  - Key set → `fetch` called once with the Resend URL, `Bearer` auth header, and a body
    carrying the correct `from`/`to`/`subject`/`html`/`text`.
  - `EMAIL_FROM` default vs. override is honored.
  - Non-OK Resend response → `sendEmail` **throws** (no silent swallow).

## Out of scope

- The auth migration itself (already done — magic-link plugin is live).
- Richer email (agendas/reminders), React Email templates, the Resend SDK, batch sending,
  attachments — all deferred behind the stable `sendEmail` seam.
- Any change to rate limiting (the `/sign-in/magic-link` 5/min rule already exists).
