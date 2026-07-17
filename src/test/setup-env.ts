// Vitest setup: provide deterministic defaults for server secrets that some code
// paths require, so tests don't depend on a developer's `.env.local` being loaded
// (vitest does not load it) or on CI exporting them. Real env values always win
// (`??=` only fills an UNSET var), so this never masks a configured secret.
//
// Needed by the reminder unsubscribe token (#274): `buildUnsubscribeUrl` signs
// with BETTER_AUTH_SECRET, exercised transitively by the reminder-delivery tests.
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
