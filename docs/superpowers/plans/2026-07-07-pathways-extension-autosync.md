# Pathways Auto-Sync Browser Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a club officer sync Base Camp Pathways progress into GavelUp with one click from a Chromium extension, instead of hand-copying `/api/bcm/progress` pages out of DevTools.

**Architecture:** A new token-authenticated REST endpoint (`POST /api/pathways/ingest`) reuses the existing `normalizePages` → `parseProgressPages` → `syncClubProgress` pipeline verbatim; the only new server logic is per-club Bearer-token auth. An MV3 (plain-JS, Chromium-only) extension rides the officer's live Base Camp session: a main-world script observes the club GUID, an isolated content script walks all progress pages same-origin, and the service worker POSTs the result to the endpoint.

**Tech Stack:** TanStack Start `server.handlers` routes, Drizzle/Postgres, Zod, Vitest (integration against `tm_test`), Better-Auth (for the admin-only token-management server fns), plain-JS MV3 extension (no bundler).

**Spec:** `docs/superpowers/specs/2026-07-06-pathways-extension-autosync-design.md`

---

## Prerequisites (do once, before Task 1)

This runs in an isolated worktree. A fresh worktree needs deps, env, and a migrated test DB:

- [ ] `bun install`
- [ ] Copy env: `cp ../tm-scheduler/.env.local .env.local`
- [ ] Confirm the `dev-postgres` container is up: `docker ps | grep dev-postgres`
- [ ] Ensure the test DB exists and is migrated. Integration tests read `TEST_DATABASE_URL`:
  ```bash
  export TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test
  # apply current migrations to tm_test (safe to re-run; drizzle tracks applied):
  DATABASE_URL=$TEST_DATABASE_URL bun run db:migrate
  ```
  Run every integration test in this plan with `TEST_DATABASE_URL` set, e.g.
  `TEST_DATABASE_URL=$TEST_DATABASE_URL bunx vitest run <path>`. Without it the suites `skipIf`
  themselves and pass vacuously (see the `hasTestDb` convention).

## File structure

**Server (Phase A):**
- Modify `src/db/schema.ts` — add the `syncTokens` table.
- Create `drizzle/00NN_*.sql` — generated migration (via `bun run db:generate`).
- Create `src/server/sync-tokens-logic.ts` — token crypto + CRUD (db logic; client never imports it).
- Create `src/server/sync-tokens.ts` — admin-guarded `createServerFn`s wrapping the logic.
- Create `src/server/pathways-ingest-logic.ts` — `ingestForToken()` (auth + reuse of the parse/upsert pipeline).
- Create `src/routes/api/pathways/ingest.ts` — the REST route (thin wrapper over `ingestForToken`).
- Create `src/routes/_authed/admin/sync-tokens.tsx` — generate/list/revoke UI.
- Modify `src/routes/_authed/admin/pathways-sync.tsx` — link to the extension/token page.
- Create `src/server/sync-tokens-logic.integration.test.ts` and `src/server/pathways-ingest-logic.integration.test.ts`.

**Extension (Phase B):**
- Modify `vitest.config.ts` — include `extension/**/*.test.js`.
- Modify `biome.json` — include `extension/**/*`.
- Create `extension/manifest.prod.json`, `extension/manifest.dev.json`.
- Create `extension/lib/basecamp-walk.js` (+ `extension/lib/basecamp-walk.test.js`) — pure page-walk.
- Create `extension/inject.js` — main-world GUID observer.
- Create `extension/content.js` — isolated-world walker + message relay.
- Create `extension/background.js` — service worker POST.
- Create `extension/popup.html`, `extension/popup.js` — token/GUID UI + Sync button.
- Create `scripts/build-extension.mjs` — assemble a `dist/extension` for prod or dev.
- Create `extension/README.md` — install + manual smoke-test checklist.

---

## Task 1: `syncTokens` schema + migration

**Files:**
- Modify: `src/db/schema.ts`
- Create: `drizzle/00NN_*.sql` (generated)

- [ ] **Step 1: Add the table to `src/db/schema.ts`.** Place it near the other club-scoped tables. `user` is already imported at the top of the file (used by `people.userId`); reuse it for `createdBy`.

```ts
// ---------------------------------------------------------------------------
// Sync tokens — per-club Bearer credentials for the Pathways auto-sync browser
// extension (#107). The token IS the club identity: the ingest endpoint derives
// clubId from the token, so no session is involved. Raw token is shown once at
// creation and stored only as a SHA-256 hash. Revoked explicitly (revokedAt).
// `basecampClubGuid` is captured on first sync and drives a soft wrong-club warning.
// ---------------------------------------------------------------------------
export const syncTokens = pgTable(
	"sync_tokens",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		clubId: uuid("club_id")
			.notNull()
			.references(() => clubs.id, { onDelete: "cascade" }),
		// SHA-256 hex of the raw token. Lookups are by this column; the raw token
		// is never stored.
		tokenHash: text("token_hash").notNull().unique(),
		// Optional officer-supplied label, e.g. "VPE laptop".
		name: text("name"),
		// Base Camp club GUID observed on sync; null until the first successful sync.
		basecampClubGuid: text("basecamp_club_guid"),
		createdBy: text("created_by")
			.notNull()
			.references(() => user.id),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		lastUsedAt: timestamp("last_used_at"),
		revokedAt: timestamp("revoked_at"),
	},
	(t) => [index("sync_tokens_club_idx").on(t.clubId)],
);
```

- [ ] **Step 2: Generate the migration.**

Run: `bun run db:generate`
Expected: a new `drizzle/00NN_*.sql` creating `sync_tokens`, and no diff on other tables. (If the generate reports "No schema changes", the table wasn't picked up — re-check the export.)

- [ ] **Step 3: Apply it to the dev DB and the test DB.**

Run:
```bash
bun run db:migrate
DATABASE_URL=$TEST_DATABASE_URL bun run db:migrate
```
Expected: both apply the new migration with no error.

- [ ] **Step 4: Commit.**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): sync_tokens table for Pathways auto-sync extension (#107)"
```

---

## Task 2: Token logic — crypto + CRUD (`sync-tokens-logic.ts`)

This is a `*-logic.ts` (db logic the client never imports). All functions are directly testable.

**Files:**
- Create: `src/server/sync-tokens-logic.ts`
- Test: `src/server/sync-tokens-logic.integration.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
/**
 * DB-backed tests for sync-token logic (#107). Tests the plain fns directly;
 * `#/db` is redirected to the test database.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/sync-tokens-logic.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncTokens } from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("sync-token logic", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await testDb.delete(syncTokens).where(eq(syncTokens.clubId, seed.clubId));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("hashToken is deterministic and generateRawToken is prefixed + unique", async () => {
		const { generateRawToken, hashToken } = await import("#/server/sync-tokens-logic");
		const a = generateRawToken();
		const b = generateRawToken();
		expect(a).toMatch(/^gup_[A-Za-z0-9_-]+$/);
		expect(a).not.toBe(b);
		expect(hashToken(a)).toBe(hashToken(a));
		expect(hashToken(a)).not.toBe(hashToken(b));
	});

	it("createSyncToken returns the raw token once and stores only its hash", async () => {
		const { createSyncToken, hashToken } = await import("#/server/sync-tokens-logic");
		const created = await createSyncToken({
			clubId: seed.clubId,
			createdBy: seed.adminUserId,
			name: "VPE laptop",
		});
		expect(created.token).toMatch(/^gup_/);

		const [row] = await testDb
			.select()
			.from(syncTokens)
			.where(eq(syncTokens.id, created.id));
		expect(row.tokenHash).toBe(hashToken(created.token));
		expect(row.name).toBe("VPE laptop");
		// The raw token is nowhere in the row.
		expect(JSON.stringify(row)).not.toContain(created.token);
	});

	it("resolveActiveToken returns the club for a live token and null for a revoked/unknown one", async () => {
		const { createSyncToken, resolveActiveToken, revokeSyncToken } = await import(
			"#/server/sync-tokens-logic"
		);
		const created = await createSyncToken({
			clubId: seed.clubId,
			createdBy: seed.adminUserId,
			name: null,
		});
		const ok = await resolveActiveToken(created.token);
		expect(ok?.clubId).toBe(seed.clubId);
		expect(ok?.basecampClubGuid).toBeNull();

		expect(await resolveActiveToken("gup_does-not-exist")).toBeNull();

		await revokeSyncToken({ clubId: seed.clubId, tokenId: created.id });
		expect(await resolveActiveToken(created.token)).toBeNull();
	});

	it("listSyncTokens never exposes the hash or raw token", async () => {
		const { createSyncToken, listSyncTokens } = await import("#/server/sync-tokens-logic");
		const created = await createSyncToken({
			clubId: seed.clubId,
			createdBy: seed.adminUserId,
			name: "one",
		});
		const list = await listSyncTokens(seed.clubId);
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe(created.id);
		expect(list[0]).not.toHaveProperty("tokenHash");
		expect(JSON.stringify(list)).not.toContain(created.token);
	});
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bunx vitest run src/server/sync-tokens-logic.integration.test.ts`
Expected: FAIL — cannot resolve module `#/server/sync-tokens-logic`.

- [ ] **Step 3: Implement `src/server/sync-tokens-logic.ts`.**

```ts
/**
 * DB logic for Pathways sync tokens (#107). Kept in a `-logic.ts` so `#/db`
 * never leaks into the client bundle (server-modules guard). The raw token is
 * returned exactly once (at creation) and otherwise only ever stored/compared
 * as a SHA-256 hash. Plain SHA-256 is adequate: the token is 256 bits of
 * randomness, so it is not brute-forceable and a slow hash buys nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import { syncTokens } from "#/db/schema";

/** `gup_` + 256 bits of base64url randomness. */
export function generateRawToken(): string {
	return `gup_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

export interface CreatedToken {
	id: string;
	/** Raw token — shown to the admin exactly once, never persisted. */
	token: string;
}

export async function createSyncToken(input: {
	clubId: string;
	createdBy: string;
	name?: string | null;
}): Promise<CreatedToken> {
	const token = generateRawToken();
	const [row] = await db
		.insert(syncTokens)
		.values({
			clubId: input.clubId,
			tokenHash: hashToken(token),
			name: input.name ?? null,
			createdBy: input.createdBy,
		})
		.returning({ id: syncTokens.id });
	if (!row) throw new Error("Failed to create sync token.");
	return { id: row.id, token };
}

export interface SyncTokenSummary {
	id: string;
	name: string | null;
	createdBy: string;
	basecampClubGuid: string | null;
	createdAt: Date;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
}

/** List a club's tokens for the settings UI. Never returns the hash/raw token. */
export async function listSyncTokens(clubId: string): Promise<SyncTokenSummary[]> {
	return db
		.select({
			id: syncTokens.id,
			name: syncTokens.name,
			createdBy: syncTokens.createdBy,
			basecampClubGuid: syncTokens.basecampClubGuid,
			createdAt: syncTokens.createdAt,
			lastUsedAt: syncTokens.lastUsedAt,
			revokedAt: syncTokens.revokedAt,
		})
		.from(syncTokens)
		.where(eq(syncTokens.clubId, clubId));
}

/** Revoke a token. Scoped to the club so an admin can't revoke another club's token. */
export async function revokeSyncToken(input: {
	clubId: string;
	tokenId: string;
}): Promise<void> {
	await db
		.update(syncTokens)
		.set({ revokedAt: new Date() })
		.where(
			and(eq(syncTokens.id, input.tokenId), eq(syncTokens.clubId, input.clubId)),
		);
}

export interface ResolvedToken {
	id: string;
	clubId: string;
	basecampClubGuid: string | null;
}

/** Resolve a raw token to its club, iff it exists and is not revoked. */
export async function resolveActiveToken(
	rawToken: string,
): Promise<ResolvedToken | null> {
	const [row] = await db
		.select({
			id: syncTokens.id,
			clubId: syncTokens.clubId,
			basecampClubGuid: syncTokens.basecampClubGuid,
		})
		.from(syncTokens)
		.where(
			and(
				eq(syncTokens.tokenHash, hashToken(rawToken)),
				isNull(syncTokens.revokedAt),
			),
		);
	return row ?? null;
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bunx vitest run src/server/sync-tokens-logic.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/server/sync-tokens-logic.ts src/server/sync-tokens-logic.integration.test.ts
git commit -m "feat(server): sync-token crypto + CRUD logic (#107)"
```

---

## Task 3: Token management server functions (`sync-tokens.ts`)

Client-reachable server-fn module. The `server-modules.guard.test.ts` requires it to export **only** `createServerFn`s and types — the logic already lives in `sync-tokens-logic.ts`.

**Files:**
- Create: `src/server/sync-tokens.ts`

- [ ] **Step 1: Implement the server-fn module.**

```ts
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole, requireUser } from "./guards";
import {
	type CreatedToken,
	createSyncToken,
	listSyncTokens,
	revokeSyncToken,
	type SyncTokenSummary,
} from "./sync-tokens-logic";

/** Mint a new club sync token. Admin only. Returns the raw token ONCE. */
export const generateSyncToken = createServerFn({ method: "POST" })
	.validator((i: unknown) =>
		z
			.object({ clubId: z.string().uuid(), name: z.string().max(100).optional() })
			.parse(i),
	)
	.handler(async ({ data }): Promise<CreatedToken> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return createSyncToken({
			clubId: data.clubId,
			createdBy: user.id,
			name: data.name ?? null,
		});
	});

/** List a club's sync tokens (no secrets). Admin only. */
export const getSyncTokens = createServerFn({ method: "GET" })
	.validator((i: unknown) => z.object({ clubId: z.string().uuid() }).parse(i))
	.handler(async ({ data }): Promise<SyncTokenSummary[]> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return listSyncTokens(data.clubId);
	});

/** Revoke a club sync token. Admin only. */
export const revokeSyncTokenFn = createServerFn({ method: "POST" })
	.validator((i: unknown) =>
		z.object({ clubId: z.string().uuid(), tokenId: z.string().uuid() }).parse(i),
	)
	.handler(async ({ data }): Promise<{ ok: true }> => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		await revokeSyncToken({ clubId: data.clubId, tokenId: data.tokenId });
		return { ok: true };
	});
```

- [ ] **Step 2: Verify the client-bundle guard still passes.**

Run: `bunx vitest run src/server/server-modules.guard.test.ts`
Expected: PASS — `sync-tokens.ts` exports only `createServerFn`s and types. (If it fails, a non-`createServerFn` value export leaked in — move it to `sync-tokens-logic.ts`.)

- [ ] **Step 3: Verify types compile.**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit.**

```bash
git add src/server/sync-tokens.ts
git commit -m "feat(server): admin-guarded sync-token server fns (#107)"
```

---

## Task 4: Ingest logic (`pathways-ingest-logic.ts`)

The core of the endpoint, extracted so it's directly testable without the Start runtime. Reuses the existing parse/upsert pipeline verbatim.

**Files:**
- Create: `src/server/pathways-ingest-logic.ts`
- Test: `src/server/pathways-ingest-logic.integration.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
/**
 * DB-backed tests for the extension ingest logic (#107).
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/pathways-ingest-logic.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncTokens } from "#/db/schema";
import { cleanup, hasTestDb, type SeededClub, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// One Base Camp page whose single member matches the seeded "Member User" by email.
function pageForEmail(email: string) {
	return {
		results: [
			{
				user: { id: 122747, name: "Member User", email },
				path_name: "Presentation Mastery",
				course_id: "course-v1:Toastmasters+8701+8_15_2023",
				progression: {
					"Level 1": { completed: 5, total: 5, approved: true },
					"Level 2": { completed: 1, total: 3, approved: false },
					"Path Completion": { completed: 0, total: 1 },
				},
			},
		],
	};
}

describe.skipIf(!hasTestDb)("pathways ingest logic", () => {
	let seed: SeededClub;
	let memberEmail: string;
	beforeEach(async () => {
		seed = await seedClub();
		// Matches src/test/db.ts seed: the member-role person's email.
		memberEmail = `member-${seed.memberUserId}@test.example`;
	});
	afterEach(async () => {
		await testDb.delete(syncTokens).where(eq(syncTokens.clubId, seed.clubId));
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	async function mkToken() {
		const { createSyncToken } = await import("#/server/sync-tokens-logic");
		return createSyncToken({ clubId: seed.clubId, createdBy: seed.adminUserId, name: null });
	}

	it("401s on a missing or unknown token", async () => {
		const { ingestForToken, IngestError } = await import("#/server/pathways-ingest-logic");
		await expect(ingestForToken(null, { basecampClubGuid: "g", pages: [] })).rejects.toMatchObject(
			{ status: 401 },
		);
		await expect(
			ingestForToken("gup_nope", { basecampClubGuid: "g", pages: [pageForEmail(memberEmail)] }),
		).rejects.toBeInstanceOf(IngestError);
	});

	it("400s on a body that isn't a Base Camp payload", async () => {
		const { ingestForToken } = await import("#/server/pathways-ingest-logic");
		const { token } = await mkToken();
		await expect(ingestForToken(token, { basecampClubGuid: "g", pages: "nope" })).rejects.toMatchObject(
			{ status: 400 },
		);
		await expect(
			ingestForToken(token, { basecampClubGuid: "g", pages: [{ notResults: 1 }] }),
		).rejects.toMatchObject({ status: 400 });
	});

	it("ingests a matching member and returns a SyncResult", async () => {
		const { ingestForToken } = await import("#/server/pathways-ingest-logic");
		const { token } = await mkToken();
		const result = await ingestForToken(token, {
			basecampClubGuid: "club-guid-1",
			pages: [pageForEmail(memberEmail)],
		});
		expect(result.matched).toBe(1);
		expect(result.pathsUpserted).toBe(1);
		expect(result.warning).toBeUndefined();
	});

	it("stores the GUID on first sync, then soft-warns on a different GUID", async () => {
		const { ingestForToken } = await import("#/server/pathways-ingest-logic");
		const created = await mkToken();
		await ingestForToken(created.token, {
			basecampClubGuid: "club-guid-1",
			pages: [pageForEmail(memberEmail)],
		});
		const [afterFirst] = await testDb
			.select()
			.from(syncTokens)
			.where(eq(syncTokens.id, created.id));
		expect(afterFirst.basecampClubGuid).toBe("club-guid-1");
		expect(afterFirst.lastUsedAt).not.toBeNull();

		const second = await ingestForToken(created.token, {
			basecampClubGuid: "club-guid-2",
			pages: [pageForEmail(memberEmail)],
		});
		expect(second.warning).toMatch(/different Base Camp club/i);
	});
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bunx vitest run src/server/pathways-ingest-logic.integration.test.ts`
Expected: FAIL — cannot resolve `#/server/pathways-ingest-logic`.

- [ ] **Step 3: Implement `src/server/pathways-ingest-logic.ts`.**

```ts
/**
 * Core logic for the extension ingest endpoint (#107). A `-logic.ts` so `#/db`
 * stays out of the client bundle. Reuses the v1 parse/upsert pipeline verbatim
 * (normalizePages → parseProgressPages → syncClubProgress) — this file only adds
 * token auth and the wrong-club soft-warn. Throws `IngestError` with an HTTP
 * status; the route maps it to a Response.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { syncTokens } from "#/db/schema";
import {
	type BcmProgressPage,
	normalizePages,
	parseProgressPages,
} from "#/lib/basecamp-progress";
import { type ResolvedToken, resolveActiveToken } from "./sync-tokens-logic";
import { type SyncResult, syncClubProgress } from "./pathways-sync-logic";

export class IngestError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "IngestError";
	}
}

const bodySchema = z.object({
	basecampClubGuid: z.string().min(1),
	pages: z.array(z.unknown()).min(1),
});

const WRONG_CLUB_WARNING =
	"This looks like a different Base Camp club than last time.";

/**
 * Authenticate a raw Bearer token, parse the Base Camp payload, upsert it, and
 * return the sync result (plus a soft warning if the observed club GUID differs
 * from the one this token synced before).
 */
export async function ingestForToken(
	rawToken: string | null,
	body: unknown,
): Promise<SyncResult & { warning?: string }> {
	if (!rawToken) throw new IngestError(401, "Missing bearer token.");
	const tok = await resolveActiveToken(rawToken);
	if (!tok) throw new IngestError(401, "Invalid or revoked token.");

	const parsed = bodySchema.safeParse(body);
	if (!parsed.success) {
		throw new IngestError(400, "Request body must be { basecampClubGuid, pages }.");
	}

	let rows: ReturnType<typeof parseProgressPages>;
	try {
		rows = parseProgressPages(
			normalizePages(parsed.data.pages as BcmProgressPage[]),
		);
	} catch {
		throw new IngestError(
			400,
			"That doesn't look like a Base Camp progress payload (expected the /api/bcm/progress JSON).",
		);
	}

	const result = await syncClubProgress(tok.clubId, rows);
	const warning = await recordTokenUse(tok, parsed.data.basecampClubGuid);
	return warning ? { ...result, warning } : result;
}

/**
 * Touch lastUsedAt; store the observed GUID on first sync; return a warning when
 * it differs from the stored one (never blocks — a corrected GUID must still work).
 */
async function recordTokenUse(
	tok: ResolvedToken,
	observedGuid: string,
): Promise<string | undefined> {
	const set: { lastUsedAt: Date; basecampClubGuid?: string } = {
		lastUsedAt: new Date(),
	};
	let warning: string | undefined;
	if (tok.basecampClubGuid === null) {
		set.basecampClubGuid = observedGuid;
	} else if (tok.basecampClubGuid !== observedGuid) {
		warning = WRONG_CLUB_WARNING;
	}
	await db.update(syncTokens).set(set).where(eq(syncTokens.id, tok.id));
	return warning;
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL bunx vitest run src/server/pathways-ingest-logic.integration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/server/pathways-ingest-logic.ts src/server/pathways-ingest-logic.integration.test.ts
git commit -m "feat(server): token-authed Pathways ingest logic (#107)"
```

---

## Task 5: Ingest REST route (`api/pathways/ingest.ts`)

Thin wrapper: parse the `Authorization` header + JSON body, delegate to `ingestForToken`, map `IngestError` to a status. No CORS handling — the extension's service worker POSTs with `host_permissions`, so the request is not subject to CORS.

**Files:**
- Create: `src/routes/api/pathways/ingest.ts`

- [ ] **Step 1: Implement the route.**

```ts
import { createFileRoute } from "@tanstack/react-router";
import { IngestError, ingestForToken } from "#/server/pathways-ingest-logic";

/**
 * POST /api/pathways/ingest — the Pathways auto-sync extension (#107) posts here.
 * Auth is a per-club Bearer token (Authorization: Bearer gup_…), NOT a session:
 * the token encodes the club. Body: { basecampClubGuid, pages: BcmProgressPage[] }.
 * Returns the SyncResult (+ optional `warning`) as JSON.
 */
export const Route = createFileRoute("/api/pathways/ingest")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const header = request.headers.get("authorization") ?? "";
				const token = header.startsWith("Bearer ")
					? header.slice("Bearer ".length)
					: null;

				let body: unknown;
				try {
					body = await request.json();
				} catch {
					return Response.json({ error: "Body must be JSON." }, { status: 400 });
				}

				try {
					const result = await ingestForToken(token, body);
					return Response.json(result, { status: 200 });
				} catch (err) {
					if (err instanceof IngestError) {
						return Response.json({ error: err.message }, { status: err.status });
					}
					return Response.json({ error: "Sync failed." }, { status: 500 });
				}
			},
		},
	},
});
```

- [ ] **Step 2: Regenerate the route tree.**

Run: `bun run generate-routes`
Expected: `src/routeTree.gen.ts` now includes `/api/pathways/ingest`. Do not hand-edit it.

- [ ] **Step 3: Manually verify end-to-end against the dev server.**

In one terminal: `bun run dev`. In another, mint a token and curl the endpoint. Use a real club id from your dev DB (find one via `docker exec dev-postgres psql -U dev -d tm_scheduler -c "select id from clubs limit 1;"`), and generate a token by calling `createSyncToken` from a quick script or via the UI built in Task 6. Then:

```bash
# 401 — no token
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/pathways/ingest \
  -H 'content-type: application/json' -d '{"basecampClubGuid":"g","pages":[]}'
# → 401

# 400 — bad payload (with a valid token)
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/pathways/ingest \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"basecampClubGuid":"g","pages":[{"nope":1}]}'
# → 400

# 200 — a well-formed single page
curl -s -X POST http://localhost:3000/api/pathways/ingest \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"basecampClubGuid":"g","pages":[{"results":[]}]}'
# → 200 {"matched":0,"pathsUpserted":0,"unmatched":[]}
```
Expected: the status codes above.

- [ ] **Step 4: Commit.**

```bash
git add src/routes/api/pathways/ingest.ts src/routeTree.gen.ts
git commit -m "feat(api): POST /api/pathways/ingest for extension auto-sync (#107)"
```

---

## Task 6: Token management UI (`admin/sync-tokens.tsx`)

Admin page to generate (shown once), list, and revoke tokens, plus a pointer to the extension. Mirrors the structure/guards of `admin/pathways-sync.tsx`.

**Files:**
- Create: `src/routes/_authed/admin/sync-tokens.tsx`
- Modify: `src/routes/_authed/admin/pathways-sync.tsx`

- [ ] **Step 1: Implement the page.**

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "#/components/page-container";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	generateSyncToken,
	getSyncTokens,
	revokeSyncTokenFn,
} from "#/server/sync-tokens";

export const Route = createFileRoute("/_authed/admin/sync-tokens")({
	beforeLoad: ({ context }) => {
		const adminClub = context.clubs.find((c) => c.clubRole === "admin");
		if (!adminClub) throw redirect({ to: "/" });
		return { adminClub };
	},
	component: SyncTokens,
});

function SyncTokens() {
	const { adminClub } = Route.useRouteContext();
	const clubId = adminClub.clubId;
	const qc = useQueryClient();

	const [name, setName] = useState("");
	const [freshToken, setFreshToken] = useState<string | null>(null);

	const tokensQuery = useQuery({
		queryKey: ["sync-tokens", clubId],
		queryFn: () => getSyncTokens({ data: { clubId } }),
	});

	const generate = useMutation({
		mutationFn: () => generateSyncToken({ data: { clubId, name: name || undefined } }),
		onSuccess: (created) => {
			setFreshToken(created.token);
			setName("");
			qc.invalidateQueries({ queryKey: ["sync-tokens", clubId] });
		},
		onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to create token."),
	});

	const revoke = useMutation({
		mutationFn: (tokenId: string) => revokeSyncTokenFn({ data: { clubId, tokenId } }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["sync-tokens", clubId] }),
		onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to revoke token."),
	});

	return (
		<PageContainer className="space-y-6">
			<div>
				<h1 className="font-display text-[30px] font-semibold tracking-[-0.02em]">
					Base Camp sync tokens
				</h1>
				<p className="text-sm text-muted-foreground">
					Tokens let the Pathways sync browser extension push {adminClub.name}'s Base Camp
					progress into GavelUp. Treat a token like a password.
				</p>
			</div>

			<div className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4">
				<Label htmlFor="token-name">New token label (optional)</Label>
				<div className="flex gap-2">
					<Input
						id="token-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. VPE laptop"
						maxLength={100}
					/>
					<Button onClick={() => generate.mutate()} disabled={generate.isPending}>
						{generate.isPending ? <Loader2 className="size-4 animate-spin" /> : "Generate token"}
					</Button>
				</div>
				{freshToken ? (
					<div className="space-y-1 rounded-md border border-amber-400 bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
						<p className="font-bold">Copy this now — you won't see it again:</p>
						<code className="block break-all font-mono text-xs">{freshToken}</code>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								navigator.clipboard.writeText(freshToken);
								toast.success("Token copied.");
							}}
						>
							Copy
						</Button>
					</div>
				) : null}
			</div>

			<div className="space-y-2">
				<h2 className="text-sm font-bold">Existing tokens</h2>
				{tokensQuery.isLoading ? (
					<Loader2 className="size-4 animate-spin" />
				) : tokensQuery.data && tokensQuery.data.length > 0 ? (
					<ul className="space-y-2">
						{tokensQuery.data.map((t) => (
							<li
								key={t.id}
								className="flex items-center justify-between gap-3 rounded-md border border-[var(--line)] p-3 text-sm"
							>
								<div>
									<span className="font-medium">{t.name ?? "(unnamed)"}</span>{" "}
									<span className="text-muted-foreground">
										{t.revokedAt
											? "· revoked"
											: t.lastUsedAt
												? `· last used ${new Date(t.lastUsedAt).toLocaleDateString()}`
												: "· never used"}
									</span>
								</div>
								{!t.revokedAt ? (
									<Button
										variant="destructive"
										size="sm"
										disabled={revoke.isPending}
										onClick={() => revoke.mutate(t.id)}
									>
										Revoke
									</Button>
								) : null}
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">No tokens yet.</p>
				)}
			</div>
		</PageContainer>
	);
}
```

> Note: confirm `Input` exists at `#/components/ui/input`. If the project has no `Input` component, run `bunx shadcn@latest add input`, or substitute the same `textareaClass`-style bare `<input>` used in `pathways-sync.tsx`.

- [ ] **Step 2: Link to it from the manual sync page.** In `src/routes/_authed/admin/pathways-sync.tsx`, replace the placeholder sentence about a planned extension with a real link. Find the paragraph reading "A browser extension to automate this copy step is planned — for now this manual paste keeps it simple." and change it to:

```tsx
					<p className="text-xs text-muted-foreground">
						Prefer one click? Generate a token on the{" "}
						<a className="underline" href="/admin/sync-tokens">
							Base Camp sync tokens
						</a>{" "}
						page and install the sync browser extension. This manual paste stays as a fallback.
					</p>
```

- [ ] **Step 3: Regenerate routes and typecheck.**

Run: `bun run generate-routes && bunx tsc --noEmit`
Expected: `/_authed/admin/sync-tokens` appears in the route tree; no type errors.

- [ ] **Step 4: Manually verify.** With `bun run dev` running and signed in as an admin, visit `/admin/sync-tokens`: generate a token (it shows once, copy works), it appears in the list, revoke removes the Revoke button and marks it revoked. Use the copied token for the Task 5 curl checks.

- [ ] **Step 5: Commit.**

```bash
git add src/routes/_authed/admin/sync-tokens.tsx src/routes/_authed/admin/pathways-sync.tsx src/routeTree.gen.ts
git commit -m "feat(ui): sync-token admin page + link from manual sync (#107)"
```

---

## Task 7: Extension scaffold + test/lint config

Set up the `extension/` directory and make its pure logic reachable by `bun run test` and Biome.

**Files:**
- Modify: `vitest.config.ts`
- Modify: `biome.json`
- Create: `extension/manifest.prod.json`, `extension/manifest.dev.json`

- [ ] **Step 1: Extend the vitest include** in `vitest.config.ts`:

```ts
	test: {
		environment: "node",
		include: ["src/**/*.test.{ts,tsx}", "extension/**/*.test.js"],
	},
```

- [ ] **Step 2: Extend Biome's file includes** in `biome.json` so extension sources are linted/formatted. Add these entries to the `files.includes` array (alongside the existing `"src/**/*"`):

```json
			"extension/**/*.js",
			"extension/**/*.json",
			"scripts/**/*.mjs",
```

- [ ] **Step 3: Write the production manifest** `extension/manifest.prod.json`:

```json
{
	"manifest_version": 3,
	"name": "GavelUp Pathways Sync",
	"version": "0.1.0",
	"description": "Sync your club's Base Camp Pathways progress into GavelUp in one click.",
	"permissions": ["storage", "activeTab"],
	"host_permissions": [
		"https://basecamp.toastmasters.org/*",
		"https://app.basecamp.toastmasters.org/*",
		"https://gavelup.app/*"
	],
	"background": { "service_worker": "background.js", "type": "module" },
	"action": { "default_popup": "popup.html", "default_title": "GavelUp Pathways Sync" },
	"content_scripts": [
		{
			"matches": ["https://app.basecamp.toastmasters.org/*", "https://basecamp.toastmasters.org/*"],
			"js": ["inject.js"],
			"world": "MAIN",
			"run_at": "document_start"
		},
		{
			"matches": ["https://app.basecamp.toastmasters.org/*", "https://basecamp.toastmasters.org/*"],
			"js": ["lib/basecamp-walk.js", "content.js"],
			"world": "ISOLATED",
			"run_at": "document_start"
		}
	]
}
```

- [ ] **Step 4: Write the dev manifest** `extension/manifest.dev.json` — identical, but the name flags dev and `host_permissions` also allows localhost:

```json
{
	"manifest_version": 3,
	"name": "GavelUp Pathways Sync (DEV)",
	"version": "0.1.0",
	"description": "DEV build — Sync Base Camp Pathways progress into a local/staging GavelUp.",
	"permissions": ["storage", "activeTab"],
	"host_permissions": [
		"https://basecamp.toastmasters.org/*",
		"https://app.basecamp.toastmasters.org/*",
		"https://gavelup.app/*",
		"http://localhost:3000/*"
	],
	"background": { "service_worker": "background.js", "type": "module" },
	"action": { "default_popup": "popup.html", "default_title": "GavelUp Pathways Sync (DEV)" },
	"content_scripts": [
		{
			"matches": ["https://app.basecamp.toastmasters.org/*", "https://basecamp.toastmasters.org/*"],
			"js": ["inject.js"],
			"world": "MAIN",
			"run_at": "document_start"
		},
		{
			"matches": ["https://app.basecamp.toastmasters.org/*", "https://basecamp.toastmasters.org/*"],
			"js": ["lib/basecamp-walk.js", "content.js"],
			"world": "ISOLATED",
			"run_at": "document_start"
		}
	]
}
```

- [ ] **Step 5: Verify config didn't break the suite.**

Run: `bunx vitest run` and `bun run check`
Expected: existing tests still pass (no `extension` tests yet); Biome is clean.

- [ ] **Step 6: Commit.**

```bash
git add vitest.config.ts biome.json extension/manifest.prod.json extension/manifest.dev.json
git commit -m "chore(ext): extension scaffold + vitest/biome includes (#107)"
```

---

## Task 8: Pure page-walk logic (`extension/lib/basecamp-walk.js`)

The one piece with real logic and edge cases (pagination, all-or-nothing abort) — full TDD. It attaches to `globalThis` so the classic content script can use it without ES-module imports, while Vitest imports the file and reads the global.

**Files:**
- Create: `extension/lib/basecamp-walk.js`
- Test: `extension/lib/basecamp-walk.test.js`

- [ ] **Step 1: Write the failing test.**

```js
/**
 * Unit tests for the pure Base Camp page-walk. Injectable fetch, no browser.
 * Run: bunx vitest run extension/lib/basecamp-walk.test.js
 */
import { beforeAll, describe, expect, it } from "vitest";

let walkProgressPages;
beforeAll(async () => {
	await import("./basecamp-walk.js"); // side-effect: sets globalThis.GavelUpBasecamp
	walkProgressPages = globalThis.GavelUpBasecamp.walkProgressPages;
});

function mockFetch(pages) {
	// pages: array of { results, next } — `next` is a URL string or null.
	return async (url) => {
		const pageParam = new URL(url).searchParams.get("page");
		const idx = pageParam ? Number(pageParam) - 1 : 0;
		const page = pages[idx];
		if (!page) throw new Error(`no mock page ${idx}`);
		return { ok: true, status: 200, json: async () => page };
	};
}

describe("walkProgressPages", () => {
	it("follows `next` until null and returns every page object", async () => {
		const pages = [
			{ results: [{ a: 1 }], next: "https://x/api/bcm/progress/?club=g&page=2" },
			{ results: [{ a: 2 }], next: "https://x/api/bcm/progress/?club=g&page=3" },
			{ results: [{ a: 3 }], next: null },
		];
		const out = await walkProgressPages({
			fetchImpl: mockFetch(pages),
			guid: "g",
			csrftoken: "csrf",
		});
		expect(out).toHaveLength(3);
		expect(out.flatMap((p) => p.results)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
	});

	it("sends the required Base Camp headers", async () => {
		let seen;
		const capture = async (url, opts) => {
			seen = { url, opts };
			return { ok: true, status: 200, json: async () => ({ results: [], next: null }) };
		};
		await walkProgressPages({ fetchImpl: capture, guid: "abc", csrftoken: "tok" });
		expect(seen.url).toContain("club=abc");
		expect(seen.opts.headers["X-CSRFToken"]).toBe("tok");
		expect(seen.opts.headers["X-Platform"]).toBe("pathways");
		expect(seen.opts.credentials).toBe("include");
	});

	it("aborts on a non-ok page and throws with the page number (all-or-nothing)", async () => {
		const failOnTwo = async (url) => {
			const page = Number(new URL(url).searchParams.get("page") ?? "1");
			if (page === 2) return { ok: false, status: 500, json: async () => ({}) };
			return {
				ok: true,
				status: 200,
				json: async () => ({ results: [], next: "https://x/api/bcm/progress/?club=g&page=2" }),
			};
		};
		await expect(
			walkProgressPages({ fetchImpl: failOnTwo, guid: "g", csrftoken: "t" }),
		).rejects.toThrow(/page 2/i);
	});

	it("throws if guid is missing", async () => {
		await expect(
			walkProgressPages({ fetchImpl: mockFetch([]), guid: "", csrftoken: "t" }),
		).rejects.toThrow(/club/i);
	});
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `bunx vitest run extension/lib/basecamp-walk.test.js`
Expected: FAIL — `globalThis.GavelUpBasecamp` is undefined.

- [ ] **Step 3: Implement `extension/lib/basecamp-walk.js`.**

```js
/**
 * Pure Base Camp progress page-walk for the GavelUp sync extension (#107).
 * No DOM, no chrome APIs — fetch is injected so it is unit-testable in Node.
 * Attaches to globalThis so the classic (non-module) content script can call it.
 *
 * All-or-nothing: any page that fails aborts the whole walk (throws). A partial
 * sync would silently leave some members stale, which is worse than a retryable
 * failure — syncClubProgress is idempotent so re-running the whole walk is free.
 */
(function attach(root) {
	const BASE = "https://basecamp.toastmasters.org/api/bcm/progress/";

	/**
	 * @param {object} args
	 * @param {(url: string, opts: object) => Promise<{ok:boolean,status:number,json:()=>Promise<any>}>} args.fetchImpl
	 * @param {string} args.guid   Base Camp club GUID
	 * @param {string} args.csrftoken  value of the csrftoken cookie
	 * @returns {Promise<Array<{results: any[]}>>} every page object, in order
	 */
	async function walkProgressPages({ fetchImpl, guid, csrftoken }) {
		if (!guid) throw new Error("No Base Camp club selected (missing club GUID).");
		const headers = {
			Accept: "application/json",
			"USE-JWT-COOKIE": "true",
			"X-Platform": "pathways",
			"X-CSRFToken": csrftoken || "",
		};

		const pages = [];
		let page = 1;
		// Walk sequentially; stop when a page reports no `next`.
		// Guard the loop with a hard cap so a malformed `next` can't spin forever.
		for (let guardCap = 0; guardCap < 1000; guardCap++) {
			const url = `${BASE}?club=${encodeURIComponent(guid)}&page=${page}`;
			let res;
			try {
				res = await fetchImpl(url, { headers, credentials: "include" });
			} catch (err) {
				throw new Error(`Base Camp request failed on page ${page}: ${err.message}`);
			}
			if (!res.ok) {
				throw new Error(`Base Camp returned ${res.status} on page ${page}.`);
			}
			const body = await res.json();
			pages.push(body);
			if (!body || !body.next) break;
			page += 1;
		}
		return pages;
	}

	root.GavelUpBasecamp = { walkProgressPages };
})(typeof globalThis !== "undefined" ? globalThis : self);
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `bunx vitest run extension/lib/basecamp-walk.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit.**

```bash
git add extension/lib/basecamp-walk.js extension/lib/basecamp-walk.test.js
git commit -m "feat(ext): pure Base Camp page-walk with all-or-nothing abort (#107)"
```

---

## Task 9: GUID observer + content script

The main-world `inject.js` watches the page's own `/api/bcm/progress` calls and reports the `club` GUID; the isolated `content.js` remembers it, and on a Sync request from the popup runs the walk (same-origin, with cookies) and forwards the pages to the service worker. These run in the browser only — verified by the manual smoke test in Task 11.

**Files:**
- Create: `extension/inject.js`
- Create: `extension/content.js`

- [ ] **Step 1: Write `extension/inject.js` (main world).**

```js
/**
 * Main-world script (#107): the isolated content script can't see the page's own
 * window.fetch/XHR, so this runs in the page world, wraps them, and forwards any
 * observed Base Camp `club` GUID to the content script via window.postMessage.
 * It never blocks or alters the page's requests.
 */
(function observeClubGuid() {
	function reportFromUrl(url) {
		try {
			const u = new URL(url, location.href);
			if (u.pathname.includes("/api/bcm/progress")) {
				const guid = u.searchParams.get("club");
				if (guid) {
					window.postMessage({ source: "gavelup-inject", type: "club-guid", guid }, "*");
				}
			}
		} catch {
			/* ignore non-URL inputs */
		}
	}

	const origFetch = window.fetch;
	window.fetch = function (input, init) {
		const url = typeof input === "string" ? input : input && input.url;
		if (url) reportFromUrl(url);
		return origFetch.apply(this, arguments);
	};

	const origOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url) {
		if (url) reportFromUrl(url);
		return origOpen.apply(this, arguments);
	};
})();
```

- [ ] **Step 2: Write `extension/content.js` (isolated world).** It shares `document.cookie` with the page (so it can read `csrftoken`) and uses the `GavelUpBasecamp` global from `lib/basecamp-walk.js` (loaded before it per the manifest).

```js
/**
 * Isolated-world content script (#107). Remembers the club GUID observed by
 * inject.js, and on a "gavelup-sync" request from the popup/service worker runs
 * the same-origin page walk (cookies flow because this runs in the Base Camp
 * origin) and returns the collected pages + the GUID.
 */
let lastClubGuid = null;

window.addEventListener("message", (event) => {
	if (event.source !== window) return;
	const data = event.data;
	if (data && data.source === "gavelup-inject" && data.type === "club-guid") {
		lastClubGuid = data.guid;
	}
});

function readCookie(name) {
	const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
	return m ? decodeURIComponent(m[1]) : "";
}

// The popup asks the active tab to sync via chrome.tabs.sendMessage.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || msg.type !== "gavelup-sync") return;
	const guid = msg.guidOverride || lastClubGuid;
	(async () => {
		try {
			if (!guid) {
				sendResponse({
					ok: false,
					error:
						"Couldn't detect the Base Camp club. Open your club's Paths Progress page, or enter the club GUID manually.",
				});
				return;
			}
			const pages = await globalThis.GavelUpBasecamp.walkProgressPages({
				fetchImpl: (url, opts) => fetch(url, opts),
				guid,
				csrftoken: readCookie("csrftoken"),
			});
			sendResponse({ ok: true, guid, pages });
		} catch (err) {
			sendResponse({ ok: false, error: err.message });
		}
	})();
	return true; // async sendResponse
});
```

- [ ] **Step 3: Sanity-check the JS lints.**

Run: `bun run check`
Expected: Biome clean (fix any formatting it flags).

- [ ] **Step 4: Commit.**

```bash
git add extension/inject.js extension/content.js
git commit -m "feat(ext): main-world GUID observer + isolated-world walker (#107)"
```

---

## Task 10: Service worker + popup

The service worker POSTs collected pages to the configured server; the popup stores the token/server URL/optional GUID and drives a sync.

**Files:**
- Create: `extension/background.js`
- Create: `extension/popup.html`
- Create: `extension/popup.js`

- [ ] **Step 1: Write `extension/background.js` (service worker, module).**

```js
/**
 * Service worker (#107). Receives collected Base Camp pages from the popup and
 * POSTs them to GavelUp's ingest endpoint with the club Bearer token. Runs in
 * the extension origin, so the cross-origin POST is allowed by host_permissions
 * (no CORS handling needed on the server).
 */
const DEFAULT_SERVER = "https://gavelup.app";

async function getConfig() {
	const { token, serverUrl } = await chrome.storage.local.get(["token", "serverUrl"]);
	return { token: token || "", serverUrl: serverUrl || DEFAULT_SERVER };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || msg.type !== "gavelup-ingest") return;
	(async () => {
		const { token, serverUrl } = await getConfig();
		if (!token) {
			sendResponse({ ok: false, error: "No GavelUp token set. Paste one in the popup." });
			return;
		}
		try {
			const res = await fetch(`${serverUrl}/api/pathways/ingest`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({ basecampClubGuid: msg.guid, pages: msg.pages }),
			});
			const json = await res.json().catch(() => ({}));
			if (!res.ok) {
				sendResponse({ ok: false, error: json.error || `Server returned ${res.status}.` });
				return;
			}
			sendResponse({ ok: true, result: json });
		} catch (err) {
			sendResponse({ ok: false, error: `Could not reach GavelUp: ${err.message}` });
		}
	})();
	return true; // async sendResponse
});
```

- [ ] **Step 2: Write `extension/popup.html`.**

```html
<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<style>
			body { font: 13px system-ui, sans-serif; width: 320px; padding: 12px; }
			label { display: block; font-weight: 600; margin: 8px 0 2px; }
			input { width: 100%; box-sizing: border-box; padding: 6px; }
			button { margin-top: 10px; padding: 8px 12px; cursor: pointer; }
			.muted { color: #666; font-size: 12px; }
			.result { margin-top: 10px; white-space: pre-wrap; }
			.warn { color: #92400e; }
			.err { color: #b91c1c; }
		</style>
	</head>
	<body>
		<h3>GavelUp Pathways Sync</h3>
		<label for="token">GavelUp token</label>
		<input id="token" type="password" placeholder="gup_…" />
		<label for="server">Server URL</label>
		<input id="server" type="text" placeholder="https://gavelup.app" />
		<label for="guid">Club GUID (optional — auto-detected)</label>
		<input id="guid" type="text" placeholder="detected from Base Camp page" />
		<button id="save">Save settings</button>
		<button id="sync">Sync now</button>
		<div id="result" class="result"></div>
		<script src="popup.js"></script>
	</body>
</html>
```

- [ ] **Step 3: Write `extension/popup.js`.**

```js
/** Popup controller (#107): persist settings, trigger a sync on the active tab. */
const $ = (id) => document.getElementById(id);

async function load() {
	const { token, serverUrl, guidOverride } = await chrome.storage.local.get([
		"token",
		"serverUrl",
		"guidOverride",
	]);
	$("token").value = token || "";
	$("server").value = serverUrl || "https://gavelup.app";
	$("guid").value = guidOverride || "";
}

$("save").addEventListener("click", async () => {
	await chrome.storage.local.set({
		token: $("token").value.trim(),
		serverUrl: $("server").value.trim() || "https://gavelup.app",
		guidOverride: $("guid").value.trim(),
	});
	setResult("Settings saved.");
});

function setResult(text, cls = "") {
	const el = $("result");
	el.textContent = text;
	el.className = `result ${cls}`;
}

$("sync").addEventListener("click", async () => {
	setResult("Syncing…");
	await chrome.storage.local.set({
		token: $("token").value.trim(),
		serverUrl: $("server").value.trim() || "https://gavelup.app",
		guidOverride: $("guid").value.trim(),
	});

	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab || !/basecamp\.toastmasters\.org/.test(tab.url || "")) {
		setResult("Open your Base Camp Paths Progress page first.", "err");
		return;
	}

	// 1) Ask the content script to walk the Base Camp pages.
	let walk;
	try {
		walk = await chrome.tabs.sendMessage(tab.id, {
			type: "gavelup-sync",
			guidOverride: $("guid").value.trim() || null,
		});
	} catch {
		setResult("Couldn't reach the Base Camp page — reload it and retry.", "err");
		return;
	}
	if (!walk || !walk.ok) {
		setResult(walk?.error || "Base Camp sync failed.", "err");
		return;
	}

	// 2) Hand the pages to the service worker to POST to GavelUp.
	const ingest = await chrome.runtime.sendMessage({
		type: "gavelup-ingest",
		guid: walk.guid,
		pages: walk.pages,
	});
	if (!ingest || !ingest.ok) {
		setResult(ingest?.error || "Upload failed.", "err");
		return;
	}

	const r = ingest.result;
	const base = `Matched ${r.matched} · ${r.pathsUpserted} path(s) updated · ${r.unmatched.length} unmatched`;
	setResult(r.warning ? `${base}\n⚠ ${r.warning}` : base, r.warning ? "warn" : "");
});

load();
```

- [ ] **Step 4: Lint.**

Run: `bun run check`
Expected: Biome clean.

- [ ] **Step 5: Commit.**

```bash
git add extension/background.js extension/popup.html extension/popup.js
git commit -m "feat(ext): service-worker POST + popup UI (#107)"
```

---

## Task 11: Build script + install/smoke-test docs

Assemble a loadable extension directory for prod or dev, and document install + a manual smoke test (headless MV3 e2e is out of scope).

**Files:**
- Create: `scripts/build-extension.mjs`
- Create: `extension/README.md`

- [ ] **Step 1: Write `scripts/build-extension.mjs`.**

```js
/**
 * Assemble a loadable MV3 extension into dist/extension-<variant> (#107).
 * Copies the static extension files and the chosen manifest as manifest.json.
 *   node scripts/build-extension.mjs prod   (default)
 *   node scripts/build-extension.mjs dev
 * Load the output via chrome://extensions → Developer mode → Load unpacked.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const variant = process.argv[2] === "dev" ? "dev" : "prod";
const src = join(root, "extension");
const out = join(root, "dist", `extension-${variant}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const staticFiles = [
	"background.js",
	"content.js",
	"inject.js",
	"popup.html",
	"popup.js",
	"lib",
];
for (const f of staticFiles) {
	cpSync(join(src, f), join(out, f), { recursive: true });
}
// Chosen manifest becomes manifest.json.
cpSync(join(src, `manifest.${variant}.json`), join(out, "manifest.json"));

console.log(`Built ${variant} extension → ${out}`);
```

- [ ] **Step 2: Add build scripts to `package.json`.** In the `"scripts"` block add:

```json
		"build:ext": "node scripts/build-extension.mjs prod",
		"build:ext:dev": "node scripts/build-extension.mjs dev",
```

- [ ] **Step 3: Verify the build runs.**

Run: `bun run build:ext && ls dist/extension-prod`
Expected: `manifest.json`, `background.js`, `content.js`, `inject.js`, `popup.html`, `popup.js`, `lib/`.

- [ ] **Step 4: Write `extension/README.md`** with install + smoke test:

```markdown
# GavelUp Pathways Sync — browser extension (#107)

Pulls your club's Base Camp Pathways progress and pushes it to GavelUp in one click.

## Install (Chromium: Chrome/Edge/Brave)

1. Build it: `bun run build:ext` (or `bun run build:ext:dev` for a local server).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `dist/extension-prod` (or `dist/extension-dev`).
4. Click the extension, paste your GavelUp **sync token** (Admin → Base Camp sync tokens),
   set the server URL (prod defaults to https://gavelup.app; dev: http://localhost:3000),
   and **Save settings**.

## Use

1. In Base Camp, open **Base Camp Manager → your club → Paths Progress**.
2. Click the extension → **Sync now**.
3. You'll see "Matched N · P path(s) updated · U unmatched" (plus a warning if the club
   looks different from last time).

## Manual smoke test (do before sharing a build)

- [ ] Load unpacked with no errors on `chrome://extensions`.
- [ ] Save + reopen popup — token/server persist.
- [ ] On Paths Progress, **Sync now** succeeds and the count matches the roster.
- [ ] Bad token → popup shows "Token invalid".
- [ ] Not on a Base Camp tab → popup tells you to open Paths Progress.
- [ ] Confirm on the GavelUp Pathways screens that progress updated.
```

- [ ] **Step 5: Final full check + commit.**

Run: `bun run check && bunx vitest run && bunx tsc --noEmit`
Expected: all green (integration suites need `TEST_DATABASE_URL` to actually run; otherwise they skip).

```bash
git add scripts/build-extension.mjs extension/README.md package.json
git commit -m "chore(ext): prod/dev build script + install & smoke-test docs (#107)"
```

---

## Self-review (against the spec)

- **New REST endpoint** (spec §Server contract) → Tasks 4–5. ✅
- **Per-club Bearer token = club identity, hashed, revocable, lastUsedAt** (spec §sync_tokens) → Tasks 1–3. ✅
- **Reuse normalizePages/parseProgressPages/syncClubProgress verbatim** → Task 4 imports them unchanged. ✅
- **Split content-script (same-origin fetch) / service-worker (POST), no CORS** → Tasks 9–10; manifest worlds in Task 7. ✅
- **Observed club GUID + manual fallback** → Task 9 (`inject.js` observer, `guidOverride` fallback in Task 10 popup). ✅
- **Wrong-club soft-warn, store GUID on first sync** → Task 4 `recordTokenUse` + test. ✅
- **Explicit-revoke tokens** → Task 2 `revokeSyncToken`, no expiry. ✅
- **Two builds (locked prod / permissive dev)** → Tasks 7 + 11. ✅
- **All-or-nothing page walk** → Task 8 abort test + implementation. ✅
- **Admin-only token management UI** → Task 6. ✅
- **Manual smoke test (MV3 e2e out of scope)** → Task 11 README checklist. ✅
- **Unattended sync explicitly deferred to #117** → not in this plan, by design. ✅

Type consistency spot-checks: `ingestForToken(rawToken, body)` and `IngestError.status` are used identically in Task 4 and Task 5. `SyncTokenSummary` fields returned in Task 2 (`id/name/createdBy/basecampClubGuid/createdAt/lastUsedAt/revokedAt`) match the columns read in the Task 6 UI. `generateSyncToken/getSyncTokens/revokeSyncTokenFn` names match between Task 3 and Task 6. `globalThis.GavelUpBasecamp.walkProgressPages({ fetchImpl, guid, csrftoken })` signature matches between Task 8 (def), its test, and Task 9 (caller).
