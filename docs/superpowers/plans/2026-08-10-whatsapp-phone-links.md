# WhatsApp Phone Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every rendered phone number in the app becomes a one-click WhatsApp message link, replacing both `tel:` links and two inert text renders.

**Architecture:** One pure URL builder (`src/lib/whatsapp.ts`) extracted from `src/lib/nudge.ts` so the #485 desktop-vs-mobile rule has exactly one copy; one shared React component (`src/components/whatsapp-phone-link.tsx`) that renders a phone as that link; and read-time E.164 normalization added to the four server payloads that carry a phone, extending the pattern `src/server/meeting-contacts-logic.ts` already uses.

**Tech Stack:** TanStack Start (React 19), Drizzle ORM on Postgres, Vitest (+ jsdom for component tests), Biome, Tailwind v4, lucide-react.

**Spec:** `docs/superpowers/specs/2026-08-10-whatsapp-phone-links-design.md`

---

## Before you start — read this

**Package manager is Bun.** `bun run <script>`, never `npm`. Tests run through **Vitest**, never `bun test`.

**Integration tests SKIP silently without a database.** Every command in this plan that runs an `*.integration.test.ts` sets `TEST_DATABASE_URL` inline. If you drop it, ~630 tests vanish from the run and the pass count still reads green. Do not drop it.

```
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test"
```

**Typecheck is the ONLY thing that type-checks.** `bun run build` and `bun run test` both transpile without checking types. Run `bun run typecheck` before claiming anything is green.

**Read the lint gate with `--diagnostic-level=error`.** `src/db/seed.ts` carries ~118 pre-existing warnings that bury real errors: `bunx biome check --diagnostic-level=error`.

**`bun run build` and `bun run dev` mutate `src/routeTree.gen.ts`** (they append an SSR Register block). If you run either, `git checkout src/routeTree.gen.ts` before committing.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/lib/whatsapp.ts` | The only place that knows how to build a WhatsApp URL. Pure, no `#/db`, no React. |
| `src/lib/whatsapp.test.ts` | Unit tests for the above, including the phone-shape fixture matrix. |
| `src/components/whatsapp-phone-link.tsx` | Renders a phone as a WhatsApp link / plain text / fallback. Owns the SSR platform-detection dance. |
| `src/components/whatsapp-phone-link.test.tsx` | jsdom tests for the three render states. |
| `src/routes/no-tel-links.guard.test.ts` | Source guard: no `tel:` href survives anywhere in `src/`. |

**Modified:**

| File | Change |
|---|---|
| `src/lib/nudge.ts` | Delete private `waDigits` + `whatsappUrlFor`; call `whatsappHref` instead. |
| `src/server/season-grid-logic.ts` | Normalize `phone` to E.164 in the `includeContact` branch. |
| `src/server/club.ts` | Normalize `phone` in `getMemberProfile`; add normalized `phone` to `listClubMembers`. |
| `src/server/guest-pipeline-logic.ts` | Normalize `phone` in `loadGuestPipeline`. |
| `src/components/club/season-grid.tsx` | `tel:` → `<WhatsAppPhoneLink>`. |
| `src/routes/_authed/members.$id.tsx` | `tel:` → `<WhatsAppPhoneLink>`; drop the `Phone` icon import. |
| `src/routes/_authed/admin/vp-membership.tsx` | Split the joined `phone · email` string; phone links. |
| `src/routes/_authed/roster.tsx` | New Phone column. |

---

## Task 1: Extract the WhatsApp URL builder

The #485 desktop/mobile rule currently lives in two private functions inside `src/lib/nudge.ts`. Moving it to its own module is the only part of this change that touches working code, so the existing `nudge.test.ts` acts as the regression gate: **it must pass unchanged**.

**Files:**
- Create: `src/lib/whatsapp.ts`
- Create: `src/lib/whatsapp.test.ts`
- Modify: `src/lib/nudge.ts` (delete lines 59-85, rewrite `buildNudge`'s phone branch)

- [ ] **Step 1: Write the failing test**

Create `src/lib/whatsapp.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { whatsappHref } from "#/lib/whatsapp";

describe("whatsappHref", () => {
	it("sends mobile to wa.me so the installed app takes over", () => {
		expect(whatsappHref("+14155552671", "mobile")).toBe(
			"https://wa.me/14155552671",
		);
	});

	it("sends desktop straight to WhatsApp Web, not the wa.me interstitial", () => {
		// `wa.me` on a desktop dead-ends on an "open in app" screen (#485).
		const href = whatsappHref("+14155552671", "desktop");
		expect(href).toBe(
			"https://web.whatsapp.com/send/?phone=14155552671&type=phone_number&app_absent=0",
		);
		expect(href).not.toContain("wa.me");
	});

	it("appends an encoded message when one is given, on both platforms", () => {
		expect(whatsappHref("+14155552671", "mobile", "Hi Jane, you're up!")).toBe(
			`https://wa.me/14155552671?text=${encodeURIComponent("Hi Jane, you're up!")}`,
		);
		expect(whatsappHref("+14155552671", "desktop", "Hi Jane, you're up!")).toBe(
			`https://web.whatsapp.com/send/?phone=14155552671&text=${encodeURIComponent(
				"Hi Jane, you're up!",
			)}&type=phone_number&app_absent=0`,
		);
	});

	// The fixture matrix is by CHARACTER CLASS, not one happy value — the shapes
	// that actually exist in this database, including what `src/db/seed.ts:874`
	// writes (E.164 with spaces) and a pre-#397 national number.
	it.each([
		["+14155552671", "14155552671"],
		["+1 916 555 0181", "19165550181"],
		["(555) 123-4567", "5551234567"],
		["0044 20 7946 0958", "00442079460958"],
		["+1-415-555-2671", "14155552671"],
	])("strips %s to digits", (input, digits) => {
		expect(whatsappHref(input, "mobile")).toBe(`https://wa.me/${digits}`);
	});

	it.each([null, undefined, "", "   ", "ask at church"])(
		"returns null for %p — there is no chat to open",
		(input) => {
			expect(whatsappHref(input, "mobile")).toBeNull();
			expect(whatsappHref(input, "desktop")).toBeNull();
		},
	);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bunx vitest run src/lib/whatsapp.test.ts
```

Expected: FAIL — `Failed to resolve import "#/lib/whatsapp"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/whatsapp.ts`:

```ts
// The WhatsApp entry point for a platform (#485). `wa.me` is a DEVICE
// redirector: on a phone it hands off to the installed app, but on a desktop it
// lands on an "open in app" interstitial that is a dead end without the desktop
// client. Desktop therefore goes straight to WhatsApp Web.
//
// Pure and client-safe (no `#/db`, no React) so `#/lib/nudge` and the
// `WhatsAppPhoneLink` component both import it. This is the ONLY copy of that
// rule — it was private to `nudge.ts` until every rendered phone became a
// WhatsApp link and a second copy would have been the obvious next step.

import type { Platform } from "#/lib/platform";

/**
 * WhatsApp needs full international digits (country code, no `+`).
 *
 * Stripping is best-effort: a number with no country code produces a link
 * WhatsApp rejects VISIBLY. Callers normalize to E.164 server-side first
 * (`toE164` + `loadClubDefaultCountryCode`), so in practice this only ever sees
 * a well-formed number — see the spec's "Normalize server-side" decision.
 */
function digitsOf(phone: string): string {
	return phone.replace(/\D/g, "");
}

/**
 * A link that opens a WhatsApp conversation with `phone`, or `null` when there
 * is no number to open one with (empty, or no digits at all).
 *
 * `message` prefills the compose box; OMIT it to open a blank chat. The nudge
 * drafts (#37) pass one; the roster/sign-up-sheet/profile links deliberately do
 * not — they have no role or meeting context, so a prefill would be filler.
 */
export function whatsappHref(
	phone: string | null | undefined,
	platform: Platform,
	message?: string,
): string | null {
	const digits = phone ? digitsOf(phone) : "";
	if (!digits) return null;

	// Query-parameter ORDER is preserved exactly as `nudge.ts` built it, so the
	// golden assertions in `nudge.test.ts` still pin the same strings across this
	// extraction.
	const text = message ? `text=${encodeURIComponent(message)}` : "";
	if (platform === "desktop") {
		return `https://web.whatsapp.com/send/?phone=${digits}${
			text ? `&${text}` : ""
		}&type=phone_number&app_absent=0`;
	}
	return `https://wa.me/${digits}${text ? `?${text}` : ""}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bunx vitest run src/lib/whatsapp.test.ts
```

Expected: PASS, 5 test blocks (16 assertions across the `it.each` rows).

- [ ] **Step 5: Re-point `nudge.ts` at the shared builder**

In `src/lib/nudge.ts`, **delete** the two private helpers (the `waDigits` block at lines 59-68 and the `whatsappUrlFor` block at lines 70-85, including their doc comments) and add the import. The file's imports become:

```ts
import { greetingName } from "#/lib/person-name";
import type { Platform } from "#/lib/platform";
import { whatsappHref } from "#/lib/whatsapp";
```

Then replace the phone branch of `buildNudge`:

```ts
export function buildNudge(input: NudgeInput): Nudge {
	const message = messageFor(input);
	const nudge: Nudge = { message };

	// `whatsappHref` returns null when there is no number, which is exactly when
	// `whatsappUrl` should be absent from the result.
	const whatsappUrl = whatsappHref(
		input.phone,
		input.platform ?? "mobile",
		message,
	);
	if (whatsappUrl) nudge.whatsappUrl = whatsappUrl;

	if (input.email) {
		nudge.mailtoUrl = `mailto:${input.email}?subject=${encodeURIComponent(
			subjectFor(input),
		)}&body=${encodeURIComponent(message)}`;
	}

	return nudge;
}
```

- [ ] **Step 6: Run the existing nudge tests UNCHANGED as the regression gate**

```bash
bunx vitest run src/lib/nudge.test.ts src/components/club/nudge-buttons.test.tsx
```

Expected: PASS. `nudge.test.ts` pins the exact URL strings for both platforms; if either changed, the extraction altered behavior and the param order in `whatsappHref` is wrong. Do NOT edit `nudge.test.ts` to make it pass.

- [ ] **Step 7: Typecheck and commit**

```bash
bun run typecheck
git add src/lib/whatsapp.ts src/lib/whatsapp.test.ts src/lib/nudge.ts
git commit -m "refactor(whatsapp): extract the wa.me/web split into one shared builder"
```

---

## Task 2: The `WhatsAppPhoneLink` component

**Files:**
- Create: `src/components/whatsapp-phone-link.tsx`
- Create: `src/components/whatsapp-phone-link.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/whatsapp-phone-link.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppPhoneLink } from "./whatsapp-phone-link";

/** jsdom's own UA is desktop-shaped, so tests that want the mobile branch have
 *  to say so. Restored by `vi.restoreAllMocks` in afterEach. */
function pretendUserAgent(ua: string) {
	vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
}

describe("WhatsAppPhoneLink", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("links a desktop viewer to WhatsApp Web, not the wa.me interstitial", () => {
		render(<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />);
		const link = screen.getByRole("link");
		expect(link.getAttribute("href")).toBe(
			"https://web.whatsapp.com/send/?phone=14155552671&type=phone_number&app_absent=0",
		);
		expect(link.getAttribute("href")).not.toContain("wa.me");
	});

	it("links a mobile viewer to wa.me so the app takes over", () => {
		pretendUserAgent(
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
		);
		render(<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />);
		expect(screen.getByRole("link").getAttribute("href")).toBe(
			"https://wa.me/14155552671",
		);
	});

	it("opens a BLANK chat — no prefilled text on these surfaces", () => {
		render(<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />);
		expect(screen.getByRole("link").getAttribute("href")).not.toContain("text=");
	});

	it("shows the number as the link text and names the destination", () => {
		render(<WhatsAppPhoneLink phone="+14155552671" name="Jane Doe" />);
		const link = screen.getByRole("link");
		expect(link.textContent).toContain("+14155552671");
		expect(link.getAttribute("title")).toBe("Message Jane Doe on WhatsApp");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
	});

	it("renders a digit-less value as visible text, not a dead link", () => {
		render(<WhatsAppPhoneLink phone="ask at church" name="Jane Doe" />);
		expect(screen.queryByRole("link")).toBeNull();
		expect(screen.getByText("ask at church")).toBeTruthy();
	});

	it.each([null, undefined, "", "   "])(
		"renders the fallback for %p",
		(phone) => {
			render(
				<WhatsAppPhoneLink phone={phone} name="Jane Doe" fallback="—" />,
			);
			expect(screen.queryByRole("link")).toBeNull();
			expect(screen.getByText("—")).toBeTruthy();
		},
	);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bunx vitest run src/components/whatsapp-phone-link.test.tsx
```

Expected: FAIL — `Failed to resolve import "./whatsapp-phone-link"`.

- [ ] **Step 3: Write the implementation**

Create `src/components/whatsapp-phone-link.tsx`:

```tsx
import { MessageCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { detectPlatform } from "#/lib/platform";
import { cn } from "#/lib/utils";
import { whatsappHref } from "#/lib/whatsapp";

/**
 * A rendered phone number that opens a WhatsApp conversation.
 *
 * WhatsApp, not `tel:`: nobody reaches for the dialer from a roster screen, and
 * someone who wants to call can copy the number into their own phone app. The
 * chat opens BLANK — these surfaces carry no role or meeting context, and the
 * context-aware drafts belong to `NudgeButtons` (#37).
 */
export function WhatsAppPhoneLink({
	phone,
	name,
	fallback = null,
	className,
}: {
	/** Free text, but callers pass server-normalized E.164 (see the spec). */
	phone: string | null | undefined;
	/** Whose number this is — named in the link title so the destination is
	 *  unambiguous before the tap. */
	name: string;
	/** Rendered when there is no number at all. */
	fallback?: ReactNode;
	className?: string;
}) {
	// `navigator` does not exist during SSR, so detection is deferred to the
	// post-mount render. The server pass AND the first client render both use
	// "mobile" (the historical `wa.me` behavior), so hydration matches; the effect
	// then re-renders with the platform-correct URL (#485).
	//
	// Deliberately NOT `NudgeButtons`' `if (!mounted) return null`. That guard
	// exists there only because its `shareUrl` depends on `window.location.origin`;
	// borrowing it here would blank the number and shift layout on every row.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const platform = mounted ? detectPlatform(navigator) : "mobile";

	const trimmed = (phone ?? "").trim();
	if (trimmed === "") return <>{fallback}</>;

	const href = whatsappHref(trimmed, platform);
	// A stored value with no digits ("ask at church") can't open a chat. Show it
	// as text rather than swallowing it — the reader can still act on it.
	if (!href) return <span className={className}>{trimmed}</span>;

	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			title={`Message ${name} on WhatsApp`}
			className={cn("inline-flex items-center gap-1.5", className)}
		>
			<MessageCircle className="size-3.5 shrink-0" aria-hidden />
			{trimmed}
		</a>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bunx vitest run src/components/whatsapp-phone-link.test.tsx
```

Expected: PASS, 6 test blocks.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/components/whatsapp-phone-link.tsx src/components/whatsapp-phone-link.test.tsx
git commit -m "feat(contact): WhatsAppPhoneLink — a phone number that opens a chat"
```

---

## Task 3: Normalize phone in the season grid payload

`src/server/season-grid-logic.ts:273` ships the raw stored `m.phone`. Normalize it the way `src/server/meeting-contacts-logic.ts:70` already does.

**Files:**
- Modify: `src/server/season-grid-logic.ts:264,273`
- Modify: `src/server/season-grid.integration.test.ts` (add one test)

- [ ] **Step 1: Write the failing test**

Add to `src/server/season-grid.integration.test.ts`, inside the existing `describe.skipIf(!hasTestDb)("loadSeasonGrid", …)` block:

```ts
	it("coalesces a pre-#397 national number to E.164 on the contact axis", async () => {
		const { loadSeasonGrid } = await import("#/server/season-grid-logic");
		// A row as it was stored BEFORE normalize-on-write (#295/#397): no country
		// code. The club has no `default_country_code`, so `+1` applies.
		await testDb
			.update(members)
			.set({ phone: "(415) 555-2671" })
			.where(eq(members.id, seed.memberId));

		const grid = await loadSeasonGrid({
			clubId: seed.clubId,
			orientation: "members",
			includeContact: true,
		});
		const member = grid.members.find((m) => m.id === seed.memberId);
		expect(member?.phone).toBe("+14155552671");
	});
```

Add `members` to the `#/db/schema` import at the top of that file if it is not already there.

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/season-grid.integration.test.ts
```

Expected: FAIL — `expected '(415) 555-2671' to be '+14155552671'`.

If instead every test in the file reports as skipped, `TEST_DATABASE_URL` did not take effect — fix that before continuing, because a skipped suite reads exactly like a passing one.

- [ ] **Step 3: Write the implementation**

In `src/server/season-grid-logic.ts`, add the imports:

```ts
import { toE164 } from "#/lib/phone";
import { loadClubDefaultCountryCode } from "./clubs-logic";
```

Replace lines 269-275 (the `memberRows` build) with:

```ts
	// Coalesce phone to E.164 with the club default country code (#295) so the
	// rendered WhatsApp link is a valid full number even for rows stored before
	// normalize-on-write. Mirrors `meeting-contacts-logic.ts`. Loaded ONLY on the
	// contact path — the public grid runs this same function and must not pay for
	// a query whose result it is forbidden to use.
	const cc = input.includeContact
		? await loadClubDefaultCountryCode(input.clubId)
		: null;
	const memberRows: SeasonGridMember[] = allMemberRows
		.filter((m) => m.status !== "inactive")
		.map((m) =>
			input.includeContact
				? {
						id: m.id,
						name: m.name,
						email: m.email,
						phone: toE164(m.phone, cc),
					}
				: { id: m.id, name: m.name },
		);
```

Note the field is `input.clubId`, not a bare `clubId`, in this function.

**Do not move or flatten the `includeContact` conditional.** `phone` must still be absent — not null — from the payload when `includeContact` is false, which is what `season-grid.integration.test.ts:182` and `:242` assert.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/season-grid.integration.test.ts
```

Expected: PASS, including the two pre-existing PII assertions at lines 182 and 242 — those are the gate that the contact branch still gates.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/server/season-grid-logic.ts src/server/season-grid.integration.test.ts
git commit -m "fix(season-grid): coalesce contact phone to E.164 at read time"
```

---

## Task 4: Normalize + expose phone in the club payloads

Two changes in `src/server/club.ts`: `getMemberProfile` (line 129) normalizes its existing `phone`, and `listClubMembers` (line 32) gains one.

**Files:**
- Modify: `src/server/club.ts:32-100` (`listClubMembers`), `:129-217` (`getMemberProfile`)
- Create: `src/server/club-contact.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/server/club-contact.integration.test.ts`:

```ts
/**
 * DB-backed tests for phone on the club payloads. Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/club-contact.integration.test.ts
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("club payload phone normalization", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
		// A row as stored BEFORE normalize-on-write (#295/#397).
		await testDb
			.update(members)
			.set({ phone: "(415) 555-2671" })
			.where(eq(members.id, seed.memberId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("listClubMembers returns phone, coalesced to E.164", async () => {
		const { loadClubMembers } = await import("#/server/club-logic");
		const rows = await loadClubMembers(seed.clubId);
		const row = rows.find((r) => r.id === seed.memberId);
		expect(row?.phone).toBe("+14155552671");
	});

	it("getMemberProfile returns phone, coalesced to E.164", async () => {
		const { loadMemberProfilePhone } = await import("#/server/club-logic");
		expect(await loadMemberProfilePhone(seed.clubId, seed.memberId)).toBe(
			"+14155552671",
		);
	});
});
```

**Note on why this test imports `#/server/club-logic`:** a `createServerFn` cannot be called from a test — its handler runs behind the Start RPC layer and `requireUser()` has no session. This repo's established answer is to put the directly-testable db logic in a sibling `*-logic.ts` that client code never imports, and have the wrapper's handler call it (see `members-logic.ts`, `activity-feed-logic.ts`). Step 3 does that extraction.

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/club-contact.integration.test.ts
```

Expected: FAIL — `Failed to resolve import "#/server/club-logic"`.

- [ ] **Step 3: Extract the two queries into `club-logic.ts` and normalize**

Create `src/server/club-logic.ts` holding the roster query and the profile query, both normalizing phone. This keeps `club.ts` exporting only `createServerFn`s and types, which `server-modules.guard.test.ts` enforces.

```ts
// Directly-testable db logic behind `club.ts`'s server fns. A `createServerFn`
// cannot be called from a test (no session, no RPC layer), so the query lives
// here and the wrapper's handler calls it — the same split as `members-logic.ts`.
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { toE164 } from "#/lib/phone";
import { loadClubDefaultCountryCode } from "./clubs-logic";

export interface ClubMemberRow {
	id: string;
	name: string;
	email: string | null;
	/** Coalesced to E.164 with the club default country code (#295), so the
	 *  roster's WhatsApp link is a valid full number even for pre-#397 rows. */
	phone: string | null;
	userId: string | null;
	invitedAt: Date | null;
	status: "active" | "inactive";
	createdAt: Date;
	joinedAt: Date | null;
	originalJoinDate: Date | null;
}

/** The club's roster rows with contact. Caller has already authorized. */
export async function loadClubMembers(
	clubId: string,
): Promise<ClubMemberRow[]> {
	const [rows, cc] = await Promise.all([
		db
			.select({
				id: members.id,
				name: members.name,
				email: members.email,
				phone: members.phone,
				userId: people.userId,
				invitedAt: people.invitedAt,
				status: members.status,
				createdAt: members.createdAt,
				joinedAt: members.joinedAt,
				originalJoinDate: people.originalJoinDate,
			})
			.from(members)
			.innerJoin(people, eq(people.id, members.personId))
			.where(eq(members.clubId, clubId))
			.orderBy(asc(members.name)),
		loadClubDefaultCountryCode(clubId),
	]);
	// `?? r.phone` is load-bearing: `toE164` returns null for a value with no
	// digits ("call the office"), which `toStoredPhone` DELIBERATELY stores
	// verbatim so the user can still see and edit it. Dropping to null would make
	// that text vanish from the UI, and it would also starve
	// `WhatsAppPhoneLink`'s digit-less branch, which exists to render exactly
	// this as plain text rather than a dead link.
	return rows.map((r) => ({ ...r, phone: toE164(r.phone, cc) ?? r.phone }));
}

/** One member's normalized phone. Caller has already authorized. */
export async function loadMemberProfilePhone(
	clubId: string,
	memberId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ phone: members.phone })
		.from(members)
		.where(and(eq(members.id, memberId), eq(members.clubId, clubId)))
		.limit(1);
	if (!row) return null;
	// `?? row.phone` for the same reason as above — never turn a visible number
	// into an absent one.
	return (
		toE164(row.phone, await loadClubDefaultCountryCode(clubId)) ?? row.phone
	);
}
```

Then in `src/server/club.ts`:

- `listClubMembers`'s handler replaces its inline `roster` query with `const roster = await loadClubMembers(clubId);` and adds `phone: m.phone,` to the returned object literal (after `email`).
- `getMemberProfile`'s handler wraps its existing `phone` value: change `phone: member.phone,` to `phone: toE164(member.phone, await loadClubDefaultCountryCode(data.clubId)) ?? member.phone,`, importing `toE164` from `#/lib/phone` and `loadClubDefaultCountryCode` from `./clubs-logic`. The `?? member.phone` is required for the reason given in `club-logic.ts` above.

Add a test asserting a digit-less stored value (e.g. `"call the office"`) survives to the payload unchanged rather than becoming null.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/club-contact.integration.test.ts src/server/server-modules.guard.test.ts
```

Expected: PASS on both. The guard test is included because this task adds a module next to a server-fn module and that is exactly the boundary it protects.

- [ ] **Step 5: Guard the auth gate this task just widened**

This task puts a phone number on a payload that previously carried only an email, so the gate in front of it now protects more. But `loadClubMembers` is called directly by the test above — **the gate is not exercised by any test in this task**, and `requireClubViewAccess` throws rather than returning a reduced payload, so there is no "response lacks phone" assertion to write either. The reachable gate is a source guard.

Create `src/server/club-contact-gate.guard.test.ts`:

```ts
// `listClubMembers` and `getMemberProfile` put member CONTACT on their payloads
// (email since #266, phone since the WhatsApp-links change). Both must stay
// behind `requireClubViewAccess` — the club's own signed-in members, never a
// public caller. A `createServerFn` cannot be invoked from a test (no session,
// no RPC layer), so the gate has no behavioural surface here and this source
// guard is what holds it.
import { readSource } from "#/test/guard-source";
import { describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Read comment-blind: these are "this pattern must BE present" assertions, and a
// comment merely NAMING `requireClubViewAccess` would satisfy a raw read while
// the real call was gone. That is the opposite direction from an
// offender-list-must-be-empty guard, which must read raw.
const source = readSource(resolve(ROOT, "src/server/club.ts"));

/** The body of a named `createServerFn` export, up to the next one. */
function handlerOf(name: string): string {
	const start = source.indexOf(`export const ${name} =`);
	expect(start, `${name} not found in club.ts`).toBeGreaterThan(-1);
	const next = source.indexOf("\nexport const ", start + 1);
	return source.slice(start, next === -1 ? undefined : next);
}

describe("club.ts contact payloads stay behind the club view gate", () => {
	it.each(["listClubMembers", "getMemberProfile"])(
		"%s calls requireClubViewAccess",
		(name) => {
			expect(handlerOf(name)).toContain("requireClubViewAccess");
		},
	);

	it("listClubMembers is the payload that carries phone", () => {
		// Pins WHICH function the gate above is protecting — if phone moves to an
		// ungated export, this fails rather than the gate silently covering nothing.
		expect(handlerOf("listClubMembers")).toContain("phone");
	});
});
```

Run it, then **mutate to prove it can fail** — delete the `await requireClubViewAccess(currentUser.id, clubId);` line from `listClubMembers`, re-run, confirm FAIL, then restore it:

```bash
bunx vitest run src/server/club-contact-gate.guard.test.ts
```

Expected: PASS, then FAIL under the mutation, then PASS again after `git checkout src/server/club.ts` — no, restore by hand, since that file has this task's other edits in it. Re-add the line.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/server/club.ts src/server/club-logic.ts src/server/club-contact.integration.test.ts src/server/club-contact-gate.guard.test.ts
git commit -m "feat(club): normalized phone on the roster and profile payloads"
```

---

## Task 5: Normalize phone in the guest pipeline payload

**Files:**
- Modify: `src/server/guest-pipeline-logic.ts:473-533` (`loadGuestPipeline`)
- Modify: `src/server/guest-pipeline.integration.test.ts` (add one test)

- [ ] **Step 1: Write the failing test**

Add to the existing `src/server/guest-pipeline.integration.test.ts` — it already has the `seedClub` / `cleanup` / `vi.mock("#/db")` harness, so do not create a new file. Put this in its own `describe.skipIf(!hasTestDb)` block at the end:

```ts
describe.skipIf(!hasTestDb)("loadGuestPipeline phone normalization", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("coalesces a pre-#397 national number to E.164", async () => {
		const { loadGuestPipeline } = await import("#/server/guest-pipeline-logic");
		// Inserted directly, bypassing `toStoredPhone` — the shape a row written
		// before normalize-on-write actually has. Matched on the returned id rather
		// than the name/phone, so it can't collide with another test's fixture.
		const [row] = await testDb
			.insert(guests)
			.values({
				clubId: seed.clubId,
				name: "Sam Visitor",
				phone: "(415) 555-2671",
			})
			.returning({ id: guests.id });

		const rows = await loadGuestPipeline(seed.clubId);
		expect(rows.find((r) => r.id === row.id)?.phone).toBe("+14155552671");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/guest-pipeline.integration.test.ts
```

Expected: FAIL on the new test only — `expected '(415) 555-2671' to be '+14155552671'`. Every pre-existing test in the file stays green.

- [ ] **Step 3: Write the implementation**

**First, give the `?? raw` rule one home.** This task would otherwise create the THIRD inline copy of `toE164(x, cc) ?? x` — `season-grid-logic.ts:296` and `club-logic.ts:41` are the first two. Hoist it.

Add to `src/lib/phone.ts`, beside `toE164` and `toStoredPhone`:

```ts
/**
 * Normalize a stored phone for READING: E.164 when it can be derived, otherwise
 * the value exactly as stored. The read-side mirror of `toStoredPhone`.
 *
 * The `?? raw` half is load-bearing, and it lives here so it is discoverable from
 * `toE164` rather than rediscovered at each call site. `toE164` returns null for
 * anything with no digits ("call the office"), and `toStoredPhone` DELIBERATELY
 * stores such input verbatim so the member can still see and edit it. A read path
 * using bare `toE164` therefore erases a number the user can currently read — and
 * starves `WhatsAppPhoneLink`'s plain-text branch, which exists to render exactly
 * that case as text rather than a dead link.
 */
export function coalesceToE164(
	raw: string | null | undefined,
	defaultCountryCode?: string | null,
): string | null {
	return toE164(raw, defaultCountryCode) ?? raw ?? null;
}
```

Add unit tests to `src/lib/phone.test.ts`: an already-E.164 value passes through, a national number is promoted with the country code, a digit-less value comes back verbatim, and null/undefined return null.

Then repoint the two existing read paths at it, deleting the inline expression in `src/server/season-grid-logic.ts` and the private `coalescePhone` helper in `src/server/club-logic.ts`. Keep the per-site comments SHORT now that the rationale lives in `#/lib/phone` — a pointer, not a restatement.

**Do NOT** rewire `toStoredPhone` to delegate to the new helper. It is a write path with its own trimming and empty-string semantics, covered by its own tests, and changing it is risk this task does not need.

**Then normalize the guest pipeline.** In `src/server/guest-pipeline-logic.ts`, `loadGuestPipeline` already imports `loadClubDefaultCountryCode` (line 33) and `toStoredPhone` (line 31). Add `coalesceToE164` to the `#/lib/phone` import, then add

```ts
	const cc = await loadClubDefaultCountryCode(clubId);
```

just before the `return rows.map((r) => {` block, and inside that block replace `phone: r.phone,` with:

```ts
			// Coalesced to E.164 (#295) so the pipeline card's WhatsApp link is a
			// valid full number even for rows written before normalize-on-write.
			phone: coalesceToE164(r.phone, cc),
```

Add a test asserting a digit-less stored value survives unchanged.

- [ ] **Step 4: Run the test to verify it passes**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" \
  bunx vitest run src/server/guest-pipeline.integration.test.ts \
    src/server/season-grid.integration.test.ts \
    src/server/club-contact.integration.test.ts \
    src/lib/phone.test.ts
```

Expected: PASS across all four — the three read paths now share one helper, so the two already-shipped ones are regression surface for this refactor.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/server/guest-pipeline-logic.ts src/server/guest-pipeline.integration.test.ts
git commit -m "fix(guests): coalesce pipeline phone to E.164 at read time"
```

---

## Task 6: Sign-up sheet contact column

**Files:**
- Modify: `src/components/club/season-grid.tsx:692-703`
- Modify: `src/components/club/season-grid.test.tsx` (add a describe block)

- [ ] **Step 1: Write the failing test**

Add to `src/components/club/season-grid.test.tsx`. This reuses the file's existing `data` fixture and mirrors its `renderMembersGrid` helper (line 100) — `SeasonGrid` renders `<Link>`s, so it has to mount under a router:

```tsx
// Members × Meetings with the signed-in contact columns on. `members` carries
// the contact payload; `memberNames` drives the row labels.
const contactData: SeasonGridData = {
	...data,
	members: [
		{ id: "c1", name: "Carla Nguyen", email: null, phone: "+14155552671" },
	],
	memberNames: [{ id: "c1", name: "Carla Nguyen" }],
};

async function renderContactGrid() {
	const rootRoute = createRootRoute({
		component: () => (
			<SeasonGrid
				data={contactData}
				orientation="members"
				count="all"
				currentMemberId="admin-1"
				canManageOthers
				showContact
				clubId="club-1"
			/>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("SeasonGrid contact column", () => {
	it("renders the member's phone as a WhatsApp link, not a dialer link", async () => {
		await renderContactGrid();
		const link = screen.getByRole("link", { name: /\+14155552671/ });
		const href = link.getAttribute("href") ?? "";
		expect(href).toContain("whatsapp");
		expect(href).not.toContain("tel:");
		expect(link.getAttribute("title")).toBe("Message Carla Nguyen on WhatsApp");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bunx vitest run src/components/club/season-grid.test.tsx
```

Expected: FAIL — the href is `tel:+14155552671`.

- [ ] **Step 3: Write the implementation**

In `src/components/club/season-grid.tsx`, add the import:

```tsx
import { WhatsAppPhoneLink } from "#/components/whatsapp-phone-link";
```

and replace the phone cell (lines 692-703):

```tsx
												<td className="px-3 py-1 text-left text-xs whitespace-nowrap">
													<WhatsAppPhoneLink
														phone={contact?.phone}
														name={row.label}
														fallback={
															<span className="text-muted-foreground">—</span>
														}
														className="text-primary"
													/>
												</td>
```

`row.label` is the member's display name in the members orientation (it is what line 551 renders as the row header), so it is the right `name` prop here.

- [ ] **Step 4: Run the test to verify it passes**

```bash
bunx vitest run src/components/club/season-grid.test.tsx
```

Expected: PASS, including every pre-existing block in that file.

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add src/components/club/season-grid.tsx src/components/club/season-grid.test.tsx
git commit -m "feat(season-grid): contact phone opens WhatsApp instead of the dialer"
```

---

## Task 7: Member detail header

**Files:**
- Modify: `src/routes/_authed/members.$id.tsx:1-14` (imports), `:211-219` (the phone anchor)

- [ ] **Step 1: Replace the `tel:` anchor**

In `src/routes/_authed/members.$id.tsx`, replace lines 211-219:

```tsx
							{member.phone ? (
								<WhatsAppPhoneLink
									phone={member.phone}
									name={member.name}
									className="hover:text-[var(--sea-ink)]"
								/>
							) : null}
```

Add the import:

```tsx
import { WhatsAppPhoneLink } from "#/components/whatsapp-phone-link";
```

and **remove `Phone` from the `lucide-react` import block** (lines 7-14) — the component supplies its own `MessageCircle`, and strict TS fails the build on an unused import. The block becomes:

```tsx
import {
	Archive,
	ArchiveRestore,
	CalendarPlus,
	ChevronLeft,
	Mail,
	ShieldCheck,
} from "lucide-react";
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: clean. A failure naming `Phone` means the icon is still imported or still used elsewhere in the file — grep it: `grep -n "Phone" src/routes/_authed/members.\$id.tsx`.

- [ ] **Step 3: Commit**

```bash
git add "src/routes/_authed/members.\$id.tsx"
git commit -m "feat(members): profile phone opens WhatsApp instead of the dialer"
```

---

## Task 8: Guest pipeline card

The card currently joins phone and email into one string (`vp-membership.tsx:302`), which cannot carry a link. Split it into elements.

**Files:**
- Modify: `src/routes/_authed/admin/vp-membership.tsx:302, 314-318`

- [ ] **Step 1: Replace the joined string with elements**

Delete line 302:

```tsx
	const contact = [guest.phone, guest.email].filter(Boolean).join(" · ");
```

and replace the contact block (lines 314-318) with:

```tsx
					{guest.phone || guest.email ? (
						<div className="flex min-w-0 flex-wrap items-center gap-x-2 truncate text-xs text-[var(--sea-ink-soft)]">
							<WhatsAppPhoneLink
								phone={guest.phone}
								name={guest.name}
							/>
							{guest.phone && guest.email ? <span>·</span> : null}
							{guest.email ? (
								<a href={`mailto:${guest.email}`} className="hover:underline">
									{guest.email}
								</a>
							) : null}
						</div>
					) : null}
```

Add the import:

```tsx
import { WhatsAppPhoneLink } from "#/components/whatsapp-phone-link";
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: clean. An error about an unused `contact` binding means line 302 was not deleted.

- [ ] **Step 3: Commit**

```bash
git add src/routes/_authed/admin/vp-membership.tsx
git commit -m "feat(guests): pipeline card phone opens WhatsApp"
```

---

## Task 9: Roster phone column

**READ THIS BEFORE EDITING.** The roster row is an **overlay-link row**: an absolutely-positioned `<Link>` at `z-0` fills the whole row, and every content cell carries `pointer-events-none` so clicks fall through to it (see the comment at `roster.tsx:334-337`). A WhatsApp anchor dropped into a content cell will **render correctly, have the right href, pass a jsdom test, and be unclickable** — the row link swallows the click and opens the member profile instead.

The Phone cell must therefore follow the `RowInviteControl` pattern at line 396: `relative z-[2]` and **no** `pointer-events-none`.

jsdom performs no layout, so no test in this repo can catch a mistake here. It is verified by hand in Step 6.

**Files:**
- Modify: `src/routes/_authed/roster.tsx:79` (`TABLE_GRID`), `:93-127` (`RosterRow`), `:141-143` (`gridCols`), `:146-165` (row build), `:294-297` (header), `:390-393` (cells)

- [ ] **Step 1: Widen both grid templates for a fifth column**

Line 79:

```tsx
const TABLE_GRID =
	"grid-cols-[1fr_34px] sm:grid-cols-[1fr_150px_170px_150px_34px]";
```

Lines 141-143:

```tsx
	const gridCols = canManage
		? "grid-cols-[1fr_64px] sm:grid-cols-[1fr_140px_160px_150px_64px]"
		: TABLE_GRID;
```

- [ ] **Step 2: Carry phone onto the row type and the row build**

In the `RosterRow` interface (after the `email` field at line 96):

```tsx
	/** Contact phone on file, server-normalized to E.164 — renders as a
	 *  WhatsApp link. */
	phone: string | null;
```

In the `rows` map (after `email: m.email,` at line 159):

```tsx
			phone: m.phone,
```

- [ ] **Step 3: Add the header cell**

After line 296 (`<div className="hidden sm:block">Pathway</div>`):

```tsx
					<div className="hidden sm:block">Phone</div>
```

- [ ] **Step 4: Add the body cell**

After the Pathway cell (lines 390-393):

```tsx
							{/* Phone — z-[2] and NOT pointer-events-none, like the invite
							    control below: the row's overlay Link would otherwise swallow
							    the tap and open the profile instead of WhatsApp. */}
							<div className="relative z-[2] hidden min-w-0 truncate text-xs text-[var(--sea-ink-soft)] sm:block">
								<WhatsAppPhoneLink
									phone={m.phone}
									name={m.name}
									fallback="—"
								/>
							</div>
```

Add the import:

```tsx
import { WhatsAppPhoneLink } from "#/components/whatsapp-phone-link";
```

- [ ] **Step 5: Typecheck and run the suite**

```bash
bun run typecheck
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bun run test
```

Expected: typecheck clean, suite green.

- [ ] **Step 6: Verify the click by hand — the part no test covers**

```bash
bun run dev
```

Open `http://localhost:3000/roster`, then:

1. Confirm a Phone column appears at `sm` and above with a WhatsApp icon beside each number.
2. **Click a phone number.** It must open WhatsApp Web in a new tab. If it navigates to the member profile instead, the cell is still being swallowed by the row's overlay `<Link>` — re-check that the cell has `relative z-[2]` and does NOT have `pointer-events-none`.
3. Click anywhere else in the row and confirm it still opens the profile.

Then stop the dev server and restore the generated route tree, which `bun run dev` mutates:

```bash
git checkout src/routeTree.gen.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/_authed/roster.tsx
git commit -m "feat(roster): phone column with a WhatsApp link"
```

---

## Task 10: Source guard — no `tel:` link comes back

Both `tel:` links are gone after Tasks 6 and 7. This guard is the ratchet that keeps them gone. It asserts an **offender list is EMPTY**, so it reads source **raw** rather than through `#/test/guard-source` — a comment can only ever add a false offender there, so blanking comments would loosen it, not harden it. That is the opposite direction from the "pattern must BE present" guards.

**Files:**
- Create: `src/routes/no-tel-links.guard.test.ts`

- [ ] **Step 1: Write the guard**

Create `src/routes/no-tel-links.guard.test.ts`:

```ts
// Enforces the WhatsApp-over-dialer decision (spec 2026-08-10): no rendered
// phone number links to `tel:`. Nobody reaches for the dialer from a roster
// screen; someone who wants to call copies the number into their own phone app.
// Phone numbers render through `WhatsAppPhoneLink` instead.
//
// A source-grep guard because the change is a NEGATIVE — "this scheme is not
// used" — which no behavioural test can assert across a whole tree. Modelled on
// `ti-wordmark.guard.test.ts`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../..");

/** A `tel:` URL in an href or a template literal. */
const TEL_LINK = /["'`]tel:|href=\{`tel:/;

const SCAN_ROOTS = ["src"];
const SKIP_DIRS = new Set(["node_modules", ".output", ".vite", "dist", "build"]);
const SCANNED = /\.(m?[jt]sx?)$/i;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) walk(abs, out);
		else out.push(abs);
	}
	return out;
}

const sourceFiles = SCAN_ROOTS.filter((r) => existsSync(resolve(ROOT, r)))
	.flatMap((r) => walk(resolve(ROOT, r)))
	// This guard states the pattern it forbids, so it can't be its own offender.
	.filter((abs) => abs !== SELF);

describe("no tel: links — phone numbers open WhatsApp", () => {
	it("walks a non-trivial source tree (so a broken walk can't pass vacuously)", () => {
		expect(sourceFiles.length).toBeGreaterThan(100);
	});

	it("no source file links a phone number with the tel: scheme", () => {
		const offenders: string[] = [];
		for (const abs of sourceFiles) {
			if (!SCANNED.test(abs)) continue;
			// Deliberately NOT `#/test/guard-source` (which blanks comments). This
			// asserts an offender list is EMPTY, so a comment can only ever add a
			// false offender — stripping would LOOSEN the guard, not harden it.
			if (TEL_LINK.test(readFileSync(abs, "utf8"))) {
				offenders.push(relative(ROOT, abs));
			}
		}
		expect(
			offenders,
			"These files link a phone number with `tel:`. Phone numbers render " +
				"through `WhatsAppPhoneLink` — see " +
				"docs/superpowers/specs/2026-08-10-whatsapp-phone-links-design.md.",
		).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it — expect PASS**

```bash
bunx vitest run src/routes/no-tel-links.guard.test.ts
```

Expected: PASS. A guard added after the offenders are gone starts green, which is why Step 3 is not optional.

- [ ] **Step 3: MUTATE to prove the guard can fail**

A guard that has never failed is indistinguishable from one that cannot fail. Temporarily reintroduce an offender:

```bash
printf '\n// mutation check\nconst dead = `tel:+15551234567`;\n' >> src/lib/whatsapp.ts
bunx vitest run src/routes/no-tel-links.guard.test.ts
```

Expected: **FAIL**, listing `src/lib/whatsapp.ts` in the offenders array.

If it PASSES, the guard is broken — most likely `TEL_LINK` or `SCANNED` does not match. Fix it before continuing.

Then revert the mutation:

```bash
git checkout src/lib/whatsapp.ts
bunx vitest run src/routes/no-tel-links.guard.test.ts
```

Expected: PASS again.

- [ ] **Step 4: Commit**

```bash
git add src/routes/no-tel-links.guard.test.ts
git commit -m "test(guard): no tel: links — phone numbers open WhatsApp"
```

---

## Task 11: Full gate run

**Files:** none — this task only runs gates.

- [ ] **Step 1: Typecheck**

```bash
bun run typecheck
```

Expected: no output, exit 0.

- [ ] **Step 2: Full suite WITH the database**

```bash
TEST_DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bun run test
```

Expected: green. Confirm the total test count is in the thousands — a count in the hundreds means `TEST_DATABASE_URL` did not take and the integration suites silently skipped.

If a schema-dependent suite errors, sync the test database (this is the one database `db:push` is for):

```bash
DATABASE_URL="postgresql://dev:dev@localhost:5432/tm_test" bun run db:push --force
```

- [ ] **Step 3: Lint, at error level**

```bash
bunx biome check --diagnostic-level=error
```

Expected: no errors. `bun run fix` applies the auto-fixable part (formatting + import organization). Do **not** pass `--unsafe`.

- [ ] **Step 4: Confirm the working tree is clean**

```bash
git status --porcelain
```

Expected: empty. If `src/routeTree.gen.ts` appears, `git checkout src/routeTree.gen.ts` — `dev`/`build` append an SSR Register block to it.

---

## Task 12: Normalize the production database (human-run)

This step writes to production and is **not** for an autonomous agent to run. Surface it to the maintainer and stop.

**Files:** none — this runs `scripts/backfill-phone-e164.ts`.

- [ ] **Step 1: Dry run against prod**

```bash
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.prod.local | head -1 | tr -d '"')" \
  bun run scripts/backfill-phone-e164.ts
```

**Confirm the first line prints the Railway host, not `localhost`.** `set -a; . ./.env.prod.local` does NOT work under zsh — the connection string's unquoted `&` is a parse error, `DATABASE_URL` never gets set, and Bun silently falls back to `.env.local`, running the whole thing against dev. That line exists to make the misfire visible.

- [ ] **Step 2: Review the guest-collision report**

The script reports guest rows that #397 duplicated — two rows for one visitor, one per spelling of their phone. It only **reports** them; merging two visit histories is a VP Membership judgment call (which name, which stage), not a backfill's. Hand that list to the maintainer before applying.

- [ ] **Step 3: Apply**

```bash
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.prod.local | head -1 | tr -d '"')" \
  bun run scripts/backfill-phone-e164.ts --apply
```

The script is idempotent (`toStoredPhone` of an already-E.164 value is that value), so a re-run is a no-op.

- [ ] **Step 4: Re-run the dry run to confirm convergence**

```bash
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env.prod.local | head -1 | tr -d '"')" \
  bun run scripts/backfill-phone-e164.ts
```

Expected: `Would change 0 of N rows with a phone.`

---

## Done

Ship with `/ship`. The diff is well under the thresholds that trigger `/ship`'s specialist fan-out, but run `/review` first and ask for the **adversarial** pass — it is the only whole-diff look, and running it before `/ship` is the single biggest lever on churn here.
