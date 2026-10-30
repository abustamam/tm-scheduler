# Plan 022: Move off the TanStack Start versions with the reflected-XSS advisory, and clear the other runtime advisories

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat b955f240..HEAD -- package.json bun.lock Dockerfile src/server/mcp/handle-request.ts src/test/bun-version-pin.guard.test.ts .github/dependabot.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S (a lockfile refresh plus one option and one guard), but it needs the full CI run including the hydration gate
- **Risk**: LOW-MED — a framework bump across ~275 server functions; the route hydration gate and the full suite are the net
- **Depends on**: plans/021-test-db-absence-fails-closed.md (so "tests pass" means the DB suites ran)
- **Category**: security / migration
- **Planned at**: commit `b955f240`, 2026-10-30

## Why this matters

`bun audit` (run 2026-10-30) reports two CRITICAL advisories that sit in the
production server bundle and are reachable by anyone on the internet:

- **GHSA-qx66-fv34-fjm8** — unauthenticated reflected XSS in TanStack Start
  server-function responses. Affects `@tanstack/react-start` < 1.168.60 and
  `@tanstack/start-server-core` < 1.169.39. The lockfile resolves 1.168.26 and
  1.169.15. Every `createServerFn` in `src/server/` goes through the affected
  transport, the app has no Content-Security-Policy, and a crafted link runs
  script with a signed-in officer's session. The fix was published
  2026-09-30; the repo has been a month behind it.
- **GHSA-p6vx-979v-rg4c** (plus four HIGH DoS advisories) in `seroval`, the
  serializer TanStack Start uses to decode every server-function payload
  (`node_modules/@tanstack/start-server-core/dist/esm/server-functions-handler.js:23,42`
  call `fromJSON` on the request). Lockfile has 1.5.4; fixed ≥ 1.6.8, latest 1.7.5.

Two HIGH advisories ride along and are cleared by in-range bumps: `zod` 4.4.3
(memory exhaustion validating large arrays; 127 files validate input with
zod; fixed 4.6.6) and `@modelcontextprotocol/sdk` 1.30.0 (validation memory
exhaustion on `/api/mcp`, fixed 1.32.0 **plus** a constructor option that is
off by default).

Every one of these is inside the manifest's existing caret ranges, so this is
a `bun update` of named packages, a one-line option, a Dockerfile pin, and a
Dependabot config so the next advisory is not found by an audit a month late.

## Current state

### Files

- `package.json` — manifest. Relevant lines as of `b955f240`:

```
56:    "@modelcontextprotocol/sdk": "^1.30.0",
63:    "@tanstack/react-router": "^1.170.16",
64:    "@tanstack/react-router-devtools": "^1.167.0",
65:    "@tanstack/react-router-ssr-query": "^1.167.1",
66:    "@tanstack/react-start": "^1.168.26",
67:    "@tanstack/router-plugin": "^1.132.0",
91:    "zod": "^4.4.3"
97:    "@tanstack/router-cli": "^1.132.0",
```

- `bun.lock` — resolved today: `@tanstack/react-start@1.168.26`,
  `@tanstack/start-server-core@1.169.15`, `@tanstack/react-router@1.170.16`,
  `@tanstack/router-core@1.171.13`, `seroval@1.5.4`, `zod@4.4.3` (and a nested
  `zod@4.6.5` under better-auth), `@modelcontextprotocol/sdk@1.30.0`.
- Registry facts fetched 2026-10-30 (`npm view`): `@tanstack/react-start`
  latest **1.169.4** (published 2026-10-22), which pins
  `@tanstack/react-router 1.170.46` and `@tanstack/start-server-core 1.169.45`;
  `@tanstack/react-router@1.170.46` pins `@tanstack/router-core 1.171.39`,
  which requires `seroval ^1.6.7` → resolves to 1.7.5. Latest
  `@tanstack/router-plugin` 1.168.48, `@tanstack/router-cli` 1.167.46,
  `@tanstack/react-router-devtools` 1.167.2 (peers `router-core ^1.171.30`),
  `@tanstack/react-router-ssr-query` 1.167.3, `zod` 4.6.7,
  `@modelcontextprotocol/sdk` 1.32.2.
- `Dockerfile:7` — `FROM oven/bun:1 AS build` (floats; CI pins Bun 1.4.2 via
  `packageManager` in package.json and `bun-version-file` in the workflow).
- `src/test/bun-version-pin.guard.test.ts` — parses `ci.yml` and `package.json`
  and holds every `setup-bun` step to `bun-version-file: package.json`. It
  does not look at the Dockerfile.
- `src/server/mcp/handle-request.ts:92-96`:

```ts
function buildServer(ctx: McpToolContext): McpServer {
	const server = new McpServer(
		{ name: "gavelup", version: "1" },
		{ instructions: INSTRUCTIONS },
	);
```

- `src/lib/mcp-limits.ts` caps the request body at 1,000,000 bytes
  (`MAX_MCP_BODY_BYTES`) and `handle-request.ts:206-246` rejects JSON-RPC
  batches, so the SDK's body/batch advisories are already mitigated; the
  remaining one is argument-element count.
- `.github/dependabot.yml` — does not exist. `.github/` holds only
  `workflows/ci.yml` and `copilot-instructions.md`.
- `src/routeTree.gen.ts` is TRACKED and `bun run dev`/`build` append a footer
  to it that must not be committed (`docs/agents/commands.md`; the
  `.githooks/pre-commit` hook blocks it). `bun run generate-routes` strips it.

### Conventions to match

- Pinning: the three `better-auth` packages are pinned exactly on purpose
  (ADR-0027); this plan does NOT touch them (that is plan "O" in the audit,
  not selected). Everything here stays on caret ranges.
- CI: `bun install --frozen-lockfile` — the committed `bun.lock` must match
  `package.json`. Bun ≥ 1.3 writes a `configVersion` line in the lockfile; use
  the repo's pinned Bun (1.4.2, `bun --version`) so the lockfile format does
  not churn.
- Commit messages: conventional commits, e.g. `fix(deps): …`, `ci: …`.
- `docs/agents/data-and-deploy.md`: changing a `createServerFn`'s `method`
  breaks open tabs. A framework bump does not change methods, but the
  serializer version does change the wire format only if TanStack says so —
  read the react-start changelog between 1.168.26 and the target for the word
  "breaking" before Step 2.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Bootstrap worktree | `bun run worktree:setup "plan 022"` | exit 0 (after plan 021: last line `Done…`) |
| Bun version | `bun --version` | `1.4.2` |
| Audit (read-only) | `bun audit` | lists advisories; exit 1 while any remain |
| Why a package is present | `bun why <pkg>` | dependency chain |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint gate | `bunx biome check --diagnostic-level=error` | exit 0 |
| Route tree | `bun run generate-routes` | exit 0, `git status` clean for `src/routeTree.gen.ts` |
| Tests | `bun run test` | exit 0 |
| Hydration gate | `CHROME_PATH=… bun run test:hydration` (needs Chrome + DB) | all pass; or rely on CI's `hydration` job |
| Build | `bun run build` then `bun run generate-routes` | exit 0; route tree footer removed |

## Files

- `package.json`
- `bun.lock`
- `Dockerfile`
- `src/test/bun-version-pin.guard.test.ts`
- `src/server/mcp/handle-request.ts`
- `src/lib/mcp-limits.ts`
- `src/lib/mcp-limits.test.ts`
- `src/server/mcp/mcp-input-elements.guard.test.ts`
- `.github/dependabot.yml`

## Scope

**In scope** (the only files you should modify): the nine files under
`## Files` (two are created: the guard test and the Dependabot config).

**Out of scope** (do NOT touch, even though they look related):

- `better-auth`, `@better-auth/mcp`, `@better-auth/cimd` — pinned exactly on
  purpose; a separate decision.
- `nitro` — pinned to a nightly on purpose (`vite.config.ts` plugins depend on
  it); do not let `bun update` move it. If `bun update <named packages>` tries
  to change the `nitro` line in `bun.lock`, STOP.
- `src/routeTree.gen.ts` — never hand-edit; regenerate only.
- Any `src/` code other than the two MCP files named above. If the upgrade
  needs a code change elsewhere (a renamed import, a changed type), STOP and
  report the exact error — that is a bigger change than this plan scopes.
- `extension/` and its own lockfile.

## Git workflow

- Branch: `tanstack-start-xss-upgrade-022`, as a worktree, bootstrapped.
- Commit per step. Never `git add -A` after running `bun run dev`/`build`
  (the route-tree footer); use `bun run generate-routes` first.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Record the before state

```bash
bun audit > /tmp/audit-before.txt 2>&1; tail -3 /tmp/audit-before.txt
grep -nE '^\s+"(@tanstack/(react-start|start-server-core|react-router|router-core)|seroval|zod|@modelcontextprotocol/sdk)":' bun.lock | sed -E 's/, "sha512[^"]*"//'
```

→ note the "N vulnerabilities" line and the resolved versions. Paste both in
the PR body later.

### Step 2: Bump the TanStack line, seroval, zod and the MCP SDK (lockfile only)

Raise the stale manifest floors so a future lockfile regeneration cannot
resolve a mismatched pair, then update the lockfile. In `package.json` change
exactly these values:

```
"@modelcontextprotocol/sdk": "^1.32.2",
"@tanstack/react-router": "^1.170.46",
"@tanstack/react-router-devtools": "^1.167.2",
"@tanstack/react-router-ssr-query": "^1.167.3",
"@tanstack/react-start": "^1.169.4",
"@tanstack/router-plugin": "^1.168.48",
"zod": "^4.6.7",
```

and in `devDependencies`:

```
"@tanstack/router-cli": "^1.167.46",
```

Then:

```bash
bun install
bun update seroval
```

(`bun install` resolves the raised floors and rewrites `bun.lock`; the second
command makes sure the transitive `seroval` moves to the newest in-range
release even if the first left it.) Then:

```bash
grep -nE '^\s+"(@tanstack/(react-start|start-server-core|react-router|router-core)|seroval|zod|@modelcontextprotocol/sdk|nitro)":' bun.lock | sed -E 's/, "sha512[^"]*"//'
```

**Verify**: the output shows `@tanstack/react-start@1.169.4` (or newer),
`@tanstack/start-server-core@1.169.45` (≥ 1.169.39), `@tanstack/react-router@1.170.46`,
`seroval@1.7.5` (≥ 1.6.8), `zod@4.6.7` (≥ 4.6.6), `@modelcontextprotocol/sdk@1.32.2`,
and the `nitro` line is UNCHANGED (`nitro-nightly@3.0.1-20260626-071224-83acc441`).
`git diff --stat` touches only `package.json` and `bun.lock`.

```bash
bun run typecheck
```

→ exit 0. (If it reports errors inside `src/`, see STOP conditions.)

### Step 3: Turn on the MCP argument-element cap

The number lives in `src/lib/mcp-limits.ts`, not beside its caller: that
module's header explains that `handle-request.ts` imports `#/db` at load, so a
constant defined there cannot be asserted by a unit test (CODING_STANDARDS.md,
"Test coverage"). Every other MCP ceiling already lives there.

In `src/lib/mcp-limits.ts`, append after `MAX_MCP_BODY_BYTES`:

```ts
/**
 * The MCP SDK's per-call cap on array ELEMENTS plus object KEYS in a tool's
 * arguments (GHSA-46jr-4wx8-v453, sdk < 1.32). The SDK ships it OFF: one
 * request inside the 1 MB body cap could still exhaust memory during
 * validation, and upgrading alone changes nothing. Passed to `new McpServer`
 * in `handle-request.ts` (`mcp-input-elements.guard.test.ts` holds that).
 *
 * 2,000 is far above the largest real input — `record_guest_book.entries` is
 * 100 entries of a handful of keys each — and far below what the body cap
 * would otherwise admit.
 */
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 2_000;
```

In `src/lib/mcp-limits.test.ts`, add the constant to the existing import and
one assertion next to the `MAX_MCP_BODY_BYTES` one:

```ts
		expect(MCP_MAX_TOOL_INPUT_ELEMENTS).toBe(2_000);
```

In `src/server/mcp/handle-request.ts`, add `MCP_MAX_TOOL_INPUT_ELEMENTS` to
the existing `import { MAX_MCP_BODY_BYTES } from "#/lib/mcp-limits";` line,
and change the `McpServer` construction quoted in "Current state" to:

```ts
	const server = new McpServer(
		{ name: "gavelup", version: "1" },
		{
			instructions: INSTRUCTIONS,
			// Off by default in the SDK (GHSA-46jr-4wx8-v453); the number and
			// its reasoning are in `#/lib/mcp-limits`.
			maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS,
		},
	);
```

Create `src/server/mcp/mcp-input-elements.guard.test.ts` (a source guard; it
must not import `handle-request.ts`, which needs a database at load):

```ts
// The MCP SDK's `maxToolInputElements` is OFF by default (GHSA-46jr-4wx8-v453),
// so the option has to be present at the ONE `new McpServer(` site, spelled as
// the shared constant. Comment-blind read (`readSource`): a comment naming the
// option must not satisfy a "must be present" assertion.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const src = readSource(resolve(__dirname, "handle-request.ts"));

describe("MCP tool-input element cap is wired", () => {
	it("passes MCP_MAX_TOOL_INPUT_ELEMENTS to the McpServer constructor", () => {
		const sites = [...src.matchAll(/new McpServer\(/g)];
		expect(sites, "expected exactly one McpServer construction").toHaveLength(1);
		const start = sites[0]?.index ?? -1;
		const end = src.indexOf(");", start);
		expect(end).toBeGreaterThan(start);
		const block = src.slice(start, end);
		expect(block).toContain("maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS");
	});

	it("imports the constant from #/lib/mcp-limits", () => {
		expect(src).toMatch(/import \{[^}]*MCP_MAX_TOOL_INPUT_ELEMENTS[^}]*\} from "#\/lib\/mcp-limits"/);
	});
});
```

**Verify**: `bunx vitest run src/lib/mcp-limits.test.ts src/server/mcp/mcp-input-elements.guard.test.ts` → all pass. Mutate once:

```bash
bun run mutate src/server/mcp/handle-request.ts --literal "maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS," "" cap-removed src/server/mcp/mcp-input-elements.guard.test.ts
```

→ red under mutation, restored.

### Step 4: Pin the Dockerfile's Bun to the CI version and guard it

In `Dockerfile`, change line 7 from `FROM oven/bun:1 AS build` to
`FROM oven/bun:1.4.2 AS build` and add the comment line above it:
`# Same Bun CI proves (package.json packageManager) — #995 is what a drift costs.`

In `src/test/bun-version-pin.guard.test.ts`, add an `it` to the existing
`describe("Bun version pin (#995)")`:

```ts
	it("the Dockerfile build stage uses the same Bun as packageManager", () => {
		const docker = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
		const from = /^FROM oven\/bun:([^\s]+) AS build$/m.exec(docker)?.[1];
		expect(from, "no `FROM oven/bun:<version> AS build` line").toBeDefined();
		expect(from).toBe(pinned);
	});
```

**Verify**: `bunx vitest run src/test/bun-version-pin.guard.test.ts` → all pass.
Mutate: `bun run mutate Dockerfile --literal "FROM oven/bun:1.4.2 AS build" "FROM oven/bun:1 AS build" docker-unpinned src/test/bun-version-pin.guard.test.ts` → red, restored.

### Step 5: Add Dependabot (npm, grouped weekly; github-actions; docker)

Create `.github/dependabot.yml`:

```yaml
# Advisory GHSA-qx66-fv34-fjm8 (critical, server-function XSS) sat unpatched
# for a month because nothing in this repo watches dependencies. Weekly,
# grouped, so a wave does not get one PR per package. Security updates are
# never grouped away: Dependabot opens those individually and immediately.
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    groups:
      minor-and-patch:
        update-types: ["minor", "patch"]
    ignore:
      # Pinned on purpose (ADR-0027 / vite.config.ts); bump by hand.
      - dependency-name: "better-auth"
      - dependency-name: "@better-auth/*"
      - dependency-name: "nitro"
  - package-ecosystem: "npm"
    directory: "/extension"
    schedule:
      interval: "weekly"
    groups:
      minor-and-patch:
        update-types: ["minor", "patch"]
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
  - package-ecosystem: "docker"
    directory: "/"
    schedule:
      interval: "weekly"
```

**Verify**: `bunx js-yaml .github/dependabot.yml > /dev/null` (or
`node -e 'require("js-yaml").load(require("fs").readFileSync(".github/dependabot.yml","utf8"))'`)
→ exit 0 (valid YAML).

### Step 6: Full gate, route tree, audit after

```bash
bun run generate-routes && git status --porcelain src/routeTree.gen.ts
```
→ no output (route tree unchanged by the upgrade; if it IS changed by
`generate-routes` because the generator version moved, inspect the diff: a
pure formatting/generator-version change is acceptable and goes in its own
commit `chore(routes): regenerate route tree`; a changed route list is a STOP).

```bash
bun run typecheck && bunx biome check --diagnostic-level=error && bun run test
```
→ all exit 0; the test summary's skipped count is only the Chrome suites if
`CHROME_PATH` is unset.

```bash
bun run build && bun run generate-routes && git status --porcelain
```
→ build exits 0; after regenerating, `git status` shows only your intended
changes (no route-tree footer).

```bash
bun audit > /tmp/audit-after.txt 2>&1; tail -3 /tmp/audit-after.txt
grep -c "critical:" /tmp/audit-after.txt
```
→ the critical count for `@tanstack/*` and `seroval` is 0. (`shell-quote`
critical under `@tanstack/devtools-vite` → `launch-editor` is dev-only and may
remain; say so in the PR body.)

Then open the PR (if instructed) and read the `hydration` job's result: it is
the one gate that exercises the new server-function transport end to end. The
PR body carries the before/after audit tails and the resolved-version grep.

## Test plan

- New: `src/server/mcp/mcp-input-elements.guard.test.ts` (2 cases, mutated once).
- New `it` in `src/test/bun-version-pin.guard.test.ts` (mutated once).
- Existing suites that most exercise the changed packages and must stay green:
  `src/server/mcp/mcp-route.integration.test.ts`,
  `src/server/mcp/*.integration.test.ts`, `src/server/slots.transport.test.ts`,
  `src/routes/route-hydration.test.ts` (CI `hydration` job), and every
  `*.integration.test.ts` (zod schemas on every server fn).
- Verification: `bun run test` → exit 0 with the DB suites running (plan 021).

## Done criteria

- [ ] `bun.lock` resolves `@tanstack/react-start` ≥ 1.168.60 (target 1.169.4), `@tanstack/start-server-core` ≥ 1.169.39, `seroval` ≥ 1.6.8, `zod` ≥ 4.6.6, `@modelcontextprotocol/sdk` ≥ 1.32.0; `nitro` and the three `better-auth` lines unchanged
- [ ] `bun run typecheck`, `bunx biome check --diagnostic-level=error`, `bun run test`, `bun run build` all exit 0
- [ ] `git status --porcelain src/routeTree.gen.ts` is empty after `bun run generate-routes`
- [ ] `bun audit` output contains no `critical:` line under `@tanstack/` or `seroval`, and no `high:` line under `zod` or `@modelcontextprotocol/sdk`
- [ ] `maxToolInputElements` is passed at the one `new McpServer(` site; its guard test passes and went red under mutation
- [ ] `Dockerfile` build stage is `oven/bun:1.4.2`; its guard passes and went red under mutation
- [ ] `.github/dependabot.yml` exists and parses
- [ ] CI `check`, `hydration`, `extension` all green on the PR
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match (especially the `package.json`
  lines or the `McpServer` construction).
- `bun install` changes the `nitro` or any `better-auth` line in `bun.lock`.
- `bun run typecheck` fails inside `src/` after Step 2 (a TanStack API or type
  changed between 1.168.26 and 1.169.4; report the exact errors).
- The react-start changelog between 1.168.26 and the target names a breaking
  change to server functions, `createServerFn` validation, or the serializer
  wire format.
- `bun run generate-routes` changes the route LIST in `src/routeTree.gen.ts`.
- The `hydration` job fails on the PR with a hydration mismatch (do not retry
  until green; report which route).
- `bun --version` is not 1.4.2 (the lockfile format would churn).

## Maintenance notes

- Dependabot will now open grouped weekly PRs; `better-auth` and `nitro` are
  ignored on purpose and need a human bump (the better-auth trio is 1.7.5 →
  1.7.14 today; its 1.7.7 release notes say pending magic links created
  before the upgrade cannot complete, so deploy off-hours).
- `MCP_MAX_TOOL_INPUT_ELEMENTS` is an absolute number on purpose; if a tool
  legitimately needs more elements, raise it in one place and update the
  guard's literal in the same change.
- Reviewer: confirm the PR body carries the before/after `bun audit` tails and
  that the `hydration` job ran (its count step prints `gate tests: N total`).
- Not done here, recorded for later: `image-size` HIGH via `pptxgenjs`
  (client-lazy, PNG/JPEG only; pptxgenjs has no release since 2025-06), and
  the dev-only advisories (`shell-quote`, `undici` via jsdom, `vite`, `vitest`,
  `js-yaml`, `nanoid`, `postcss`, `browserslist`) which clear with ordinary
  in-range updates Dependabot will propose.
