# ADR-0004: Magic-link-only authentication (Better-Auth)

Status: Accepted

## Context

Users are Toastmasters club members, many non-technical and reluctant to adopt new tools.
Every bit of sign-in friction (passwords to create and forget, OAuth consent screens) is a
reason not to use the app at all — and adoption is the whole point of beating the spreadsheet.

## Decision

Use **Better-Auth** configured for **email magic link only**. No passwords, no OAuth.
Configured in `src/lib/auth.ts` with the `magicLink` plugin and the Drizzle adapter; mounted
at `src/routes/api/auth/$.ts`.

## Consequences

- A member signs in by entering an email and clicking a link — nothing to remember.
- In development, `sendMagicLink` logs the URL to the console; **a real email provider
  (e.g. Resend / SES) must be wired before production** (tracked as a Phase-2 / pre-launch
  issue).
- Requires `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` in the environment.
