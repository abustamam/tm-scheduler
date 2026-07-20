# VPE tap-to-nudge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a VPE/Toastmaster-of-the-Day a one-tap way to open their own WhatsApp or email pre-drafted with a member's name, role, date, and the public meeting link — a confirm nudge on filled slots and a recruit nudge on open slots.

**Architecture:** A pure `buildNudge` primitive in `#/lib` turns (target, role, meeting, mode) into `wa.me`/`mailto:` URLs. Contact (phone/email) is loaded only on the `canManage`-gated meeting payload, via exported logic functions that integration tests call directly. A `NudgeButtons` client component renders the channels; it's wired onto filled-slot rows and behind an open-slot "Nudge someone" searchable picker in `_authed/meetings.$id.tsx`. The app only ever composes a draft — the human sends it. No PII on the public payload; no auto-send; no logging.

**Tech Stack:** TanStack Start (React 19), Drizzle/Postgres, Vitest, shadcn/ui + cmdk, Biome. Package manager: Bun.

**Spec:** `docs/superpowers/specs/2026-07-20-tap-to-nudge-design.md`

---

## File Structure

**Create:**
- `src/lib/nudge.ts` — pure `buildNudge` primitive (no `#/db`). Client-safe.
- `src/lib/nudge.test.ts` — unit tests for `buildNudge`.
- `src/server/meeting-contacts-logic.ts` — `loadRosterWithContact` + `loadHolderContacts` (db logic; testable; never imported by client).
- `src/server/meeting-contacts.integration.test.ts` — integration tests for the loaders.
- `src/components/club/nudge-buttons.tsx` — WhatsApp/Email affordances from a `buildNudge` result.
- `src/components/club/nudge-buttons.test.tsx` — jsdom component tests.
- `src/components/club/nudge-recruit-picker.tsx` — open-slot searchable member picker → recruit nudge.

**Modify:**
- `src/server/meetings.ts` — in `loadMeetingDetail`: extend the gated `roster` with phone/email and attach gated holder contact to held slots.
- `src/server/public-reads.integration.test.ts` — extend the `getMeetingPublic` mirror + add assertions that the non-`canManage` path exposes no contact (PII guard).
- `src/routes/_authed/meetings.$id.tsx` — render `NudgeButtons` on filled slots and the recruit picker on open slots, when `canManage`.

---

## Task 1: `buildNudge` pure primitive

**Files:**
- Create: `src/lib/nudge.ts`
- Test: `src/lib/nudge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/nudge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildNudge } from "./nudge";

const base = {
	name: "Jane",
	roleName: "Timer",
	meetingDate: "Thu, Jul 23",
	shareUrl: "https://gavelup.app/club/mcf/meeting/abc",
};

describe("buildNudge", () => {
	it("confirm mode names the role and includes the link", () => {
		const r = buildNudge({ ...base, email: "j@x.io", mode: "confirm" });
		expect(r.message).toBe(
			"Hi Jane, just confirming you're our Timer for the Thu, Jul 23 meeting. Details: https://gavelup.app/club/mcf/meeting/abc",
		);
	});

	it("recruit mode uses the ask phrasing", () => {
		const r = buildNudge({ ...base, email: "j@x.io", mode: "recruit" });
		expect(r.message).toBe(
			"Hi Jane, would you be open to taking Timer at our Thu, Jul 23 meeting? Info here: https://gavelup.app/club/mcf/meeting/abc",
		);
	});

	it("builds a wa.me link from a phone, stripping +, spaces, dashes", () => {
		const r = buildNudge({ ...base, phone: "+1 (415) 555-2671", mode: "confirm" });
		expect(r.whatsappUrl).toBe(
			`https://wa.me/14155552671?text=${encodeURIComponent(r.message)}`,
		);
	});

	it("omits whatsappUrl when there is no phone", () => {
		const r = buildNudge({ ...base, email: "j@x.io", mode: "confirm" });
		expect(r.whatsappUrl).toBeUndefined();
	});

	it("builds a mailto with subject + body, omits it when no email", () => {
		const withEmail = buildNudge({ ...base, email: "j@x.io", mode: "confirm" });
		expect(withEmail.mailtoUrl).toBe(
			`mailto:j@x.io?subject=${encodeURIComponent(
				"Confirming your Timer role — Thu, Jul 23",
			)}&body=${encodeURIComponent(withEmail.message)}`,
		);
		const noEmail = buildNudge({ ...base, phone: "14155552671", mode: "confirm" });
		expect(noEmail.mailtoUrl).toBeUndefined();
	});

	it("recruit subject asks about the open role", () => {
		const r = buildNudge({ ...base, email: "j@x.io", mode: "recruit" });
		expect(r.mailtoUrl).toContain(
			encodeURIComponent("Open Timer role — Thu, Jul 23 meeting?"),
		);
	});

	it("keeps special characters in names intact through URL encoding", () => {
		const r = buildNudge({
			...base,
			name: "O'Brien",
			phone: "14155552671",
			email: "o@x.io",
			mode: "confirm",
		});
		expect(r.message).toContain("Hi O'Brien,");
		// The name survives encoding: decoding the channel payload recovers it.
		// (encodeURIComponent leaves apostrophes literal, so don't assert %27.)
		const waText = decodeURIComponent(r.whatsappUrl?.split("?text=")[1] ?? "");
		expect(waText).toContain("O'Brien");
		const mailBody = decodeURIComponent(r.mailtoUrl?.split("&body=")[1] ?? "");
		expect(mailBody).toContain("O'Brien");
	});

	it("returns neither channel when no contact is present", () => {
		const r = buildNudge({ ...base, mode: "confirm" });
		expect(r.whatsappUrl).toBeUndefined();
		expect(r.mailtoUrl).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/nudge.test.ts`
Expected: FAIL — `buildNudge` is not exported (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/nudge.ts`:

```ts
// Pure, client-safe helper (#37) that composes a person-to-person nudge for a
// role — a `wa.me` and/or `mailto:` draft a VPE opens in their OWN app and then
// edits and sends. NO `#/db` here so the meeting-detail client route can call it.
// The app only ever DRAFTS; the human sends.

export type NudgeMode = "confirm" | "recruit";

export interface NudgeInput {
	name: string;
	/** E.164-ish free text; may be null/absent. */
	phone?: string | null;
	email?: string | null;
	roleName: string;
	/** Already formatted friendly, in the club's timezone (footerDate). */
	meetingDate: string;
	/** Absolute public meeting URL (caller prepends window.location.origin). */
	shareUrl: string;
	mode: NudgeMode;
}

export interface Nudge {
	message: string;
	/** Omitted when the target has no phone. */
	whatsappUrl?: string;
	/** Omitted when the target has no email. */
	mailtoUrl?: string;
}

function messageFor(i: NudgeInput): string {
	return i.mode === "confirm"
		? `Hi ${i.name}, just confirming you're our ${i.roleName} for the ${i.meetingDate} meeting. Details: ${i.shareUrl}`
		: `Hi ${i.name}, would you be open to taking ${i.roleName} at our ${i.meetingDate} meeting? Info here: ${i.shareUrl}`;
}

function subjectFor(i: NudgeInput): string {
	return i.mode === "confirm"
		? `Confirming your ${i.roleName} role — ${i.meetingDate}`
		: `Open ${i.roleName} role — ${i.meetingDate} meeting?`;
}

/**
 * `wa.me` needs full international digits (country code, no `+`). We strip to
 * digits best-effort — a number stored without a country code produces a link
 * WhatsApp rejects VISIBLY, and the caller always offers Email as a fallback.
 * Reliable normalization is tracked as a follow-up (club default country code
 * + E.164 input standardization).
 */
function waDigits(phone: string): string {
	return phone.replace(/\D/g, "");
}

export function buildNudge(input: NudgeInput): Nudge {
	const message = messageFor(input);
	const nudge: Nudge = { message };

	const digits = input.phone ? waDigits(input.phone) : "";
	if (digits) {
		nudge.whatsappUrl = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
	}

	if (input.email) {
		nudge.mailtoUrl = `mailto:${input.email}?subject=${encodeURIComponent(
			subjectFor(input),
		)}&body=${encodeURIComponent(message)}`;
	}

	return nudge;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/lib/nudge.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/nudge.ts src/lib/nudge.test.ts
git commit -m "feat(nudge): pure buildNudge primitive for wa.me/mailto drafts (#37)"
```

---

## Task 2: Gated contact loaders (db logic)

**Files:**
- Create: `src/server/meeting-contacts-logic.ts`
- Test: `src/server/meeting-contacts.integration.test.ts`

These are the ONLY new db reads. They are called from `loadMeetingDetail` exclusively when `canManage`, so contact is never fetched for a public caller. Kept in a `*-logic.ts` (never imported by client) per the server-bundle rule, and exported so integration tests call the real code (unlike the private `loadMeetingDetail`).

- [ ] **Step 1: Write the failing test**

Create `src/server/meeting-contacts.integration.test.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guests, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";
import {
	loadHolderContacts,
	loadRosterWithContact,
} from "./meeting-contacts-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

async function addMember(
	clubId: string,
	name: string,
	opts: { phone?: string | null; email?: string | null; status?: "active" | "inactive" } = {},
): Promise<string> {
	const personId = await seedPerson({ name });
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId,
			name,
			clubRole: "member",
			status: opts.status ?? "active",
			phone: opts.phone ?? null,
			email: opts.email ?? null,
		})
		.returning({ id: members.id });
	if (!row) throw new Error("member insert failed");
	return row.id;
}

async function addGuest(
	clubId: string,
	name: string,
	opts: { phone?: string | null; email?: string | null } = {},
): Promise<string> {
	const [row] = await testDb
		.insert(guests)
		.values({ clubId, name, phone: opts.phone ?? null, email: opts.email ?? null })
		.returning({ id: guests.id });
	if (!row) throw new Error("guest insert failed");
	return row.id;
}

describe.skipIf(!hasTestDb)("meeting contacts (integration)", () => {
	let seeded: SeededClub;

	beforeEach(async () => {
		seeded = await seedClub();
	});

	afterEach(async () => {
		await cleanup(seeded.clubId, [seeded.adminUserId, seeded.memberUserId]);
	});

	it("loadRosterWithContact returns active members with phone/email", async () => {
		await addMember(seeded.clubId, "Has Both", {
			phone: "14155550001",
			email: "both@x.io",
		});
		await addMember(seeded.clubId, "Inactive", {
			phone: "14155550002",
			status: "inactive",
		});

		const roster = await loadRosterWithContact(seeded.clubId);
		const names = roster.map((r) => r.name);
		expect(names).toContain("Has Both");
		// Inactive members are excluded from the recruiting pool.
		expect(names).not.toContain("Inactive");
		const both = roster.find((r) => r.name === "Has Both");
		expect(both?.phone).toBe("14155550001");
		expect(both?.email).toBe("both@x.io");
	});

	it("loadHolderContacts resolves member and guest contact by id", async () => {
		const memberId = await addMember(seeded.clubId, "Holder M", {
			phone: "14155550003",
			email: "m@x.io",
		});
		const guestId = await addGuest(seeded.clubId, "Holder G", { email: "g@x.io" });

		const map = await loadHolderContacts([memberId], [guestId]);
		expect(map.get(`member:${memberId}`)).toEqual({
			phone: "14155550003",
			email: "m@x.io",
		});
		expect(map.get(`guest:${guestId}`)).toEqual({ phone: null, email: "g@x.io" });
	});

	it("loadHolderContacts returns an empty map for empty inputs (no query)", async () => {
		const map = await loadHolderContacts([], []);
		expect(map.size).toBe(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-contacts.integration.test.ts`
Expected: FAIL — module `./meeting-contacts-logic` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/meeting-contacts-logic.ts`:

```ts
// Contact loaders for the VPE tap-to-nudge (#37). Called ONLY from the
// canManage-gated branch of `loadMeetingDetail`, so member/guest phone+email is
// never fetched for a public caller. In a `*-logic.ts` (never imported by
// client) per the server-bundle rule; exported so integration tests call the
// real code. See `docs/superpowers/specs/2026-07-20-tap-to-nudge-design.md`.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "#/db";
import { guests, members } from "#/db/schema";

export interface Contact {
	phone: string | null;
	email: string | null;
}

export interface RosterContact extends Contact {
	id: string;
	name: string;
}

/** Active members of the club with contact — the recruiting pool. */
export async function loadRosterWithContact(
	clubId: string,
): Promise<RosterContact[]> {
	return db
		.select({
			id: members.id,
			name: members.name,
			phone: members.phone,
			email: members.email,
		})
		.from(members)
		.where(and(eq(members.clubId, clubId), eq(members.status, "active")))
		.orderBy(members.name);
}

/**
 * Resolve contact for held slots, keyed `member:<id>` / `guest:<id>`. Handles
 * holders who are NOT in the active roster (inactive members, guests). Runs no
 * query for an empty id list.
 */
export async function loadHolderContacts(
	memberIds: string[],
	guestIds: string[],
): Promise<Map<string, Contact>> {
	const map = new Map<string, Contact>();

	if (memberIds.length > 0) {
		const rows = await db
			.select({ id: members.id, phone: members.phone, email: members.email })
			.from(members)
			.where(inArray(members.id, memberIds));
		for (const r of rows) {
			map.set(`member:${r.id}`, { phone: r.phone, email: r.email });
		}
	}

	if (guestIds.length > 0) {
		const rows = await db
			.select({ id: guests.id, phone: guests.phone, email: guests.email })
			.from(guests)
			.where(inArray(guests.id, guestIds));
		for (const r of rows) {
			map.set(`guest:${r.id}`, { phone: r.phone, email: r.email });
		}
	}

	return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/meeting-contacts.integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/meeting-contacts-logic.ts src/server/meeting-contacts.integration.test.ts
git commit -m "feat(nudge): gated member/guest contact loaders (#37)"
```

---

## Task 3: Wire gated contact into `loadMeetingDetail` + PII guard

**Files:**
- Modify: `src/server/meetings.ts` (the `loadMeetingDetail` function, ~lines 195–248)
- Test: `src/server/public-reads.integration.test.ts` (extend the mirror + assertions)

The meeting payload gains contact ONLY when `canManage`, mirroring the existing `const roster = canManage ? … : []` pattern. Held slots get `holderPhone`/`holderEmail` (null when public).

- [ ] **Step 1: Write the failing test (PII guard)**

In `src/server/public-reads.integration.test.ts`, find the `getMeetingPublic` mirror (around line 41) — it hardcodes `canManage = false` and rebuilds the roster/slots. Add these assertions in the existing `describe` block (after the "reports Not-Available members" test):

```ts
it("PII guard: the public (no-session) payload carries no member contact", async () => {
	const res = await getMeetingPublic(seed.meetingId);
	// Roster is management-only; never present on the public payload.
	expect(res?.roster ?? []).toEqual([]);
	// No slot exposes holder contact on the public path.
	for (const slot of res?.slots ?? []) {
		expect(
			(slot as { holderPhone?: unknown }).holderPhone ?? null,
		).toBeNull();
		expect(
			(slot as { holderEmail?: unknown }).holderEmail ?? null,
		).toBeNull();
	}
});
```

Note: the mirror `getMeetingPublic` builds its own result object. Update the mirror so its returned slots include `holderPhone: null, holderEmail: null` and `roster: []` — matching what the real `loadMeetingDetail` returns on the public path. (This keeps the mirror faithful; the assertion then guards the shape.)

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/public-reads.integration.test.ts`
Expected: FAIL — the mirror's slots have no `holderPhone`/`holderEmail` keys yet, or the mirror needs updating. (If you update the mirror first, it passes trivially; the real guarantee is Step 3 keeping `loadMeetingDetail` in sync.)

- [ ] **Step 3: Implement — extend `loadMeetingDetail`**

In `src/server/meetings.ts`:

(a) Add the import near the other `#/server` imports at the top:

```ts
import { loadHolderContacts, loadRosterWithContact } from "./meeting-contacts-logic";
```

(b) Replace the existing gated `roster` block (currently `{ id, name }` only):

```ts
	const roster = canManage
		? await db
				.select({ id: members.id, name: members.name })
				.from(members)
				.where(
					and(eq(members.clubId, meeting.clubId), eq(members.status, "active")),
				)
				.orderBy(asc(members.name))
		: [];
```

with a call to the new loader:

```ts
	// Roster for the VPE assign/recruit picker — active members with contact for
	// tap-to-nudge (#37). Management-only: contact is never fetched for a public
	// caller (loadRosterWithContact isn't called when !canManage).
	const roster = canManage
		? await loadRosterWithContact(meeting.clubId)
		: [];
```

(c) After `slots` is built (after the `resolveEvaluatorLinks` line) and after `roster`, attach gated holder contact. Add:

```ts
	// Holder contact for filled-slot confirm nudges (#37). Gated: only queried
	// when the caller manages the club. `holderPhone`/`holderEmail` are null on
	// the public payload.
	const holderContacts = canManage
		? await loadHolderContacts(
				slots.flatMap((s) => (s.assigneeId ? [s.assigneeId] : [])),
				slots.flatMap((s) => (s.assigneeGuestId ? [s.assigneeGuestId] : [])),
			)
		: new Map<string, { phone: string | null; email: string | null }>();

	const slotsWithContact = slots.map((s) => {
		const key = s.assigneeGuestId
			? `guest:${s.assigneeGuestId}`
			: s.assigneeId
				? `member:${s.assigneeId}`
				: null;
		const c = key ? holderContacts.get(key) : undefined;
		return {
			...s,
			holderPhone: c?.phone ?? null,
			holderEmail: c?.email ?? null,
		};
	});
```

(d) In the returned object, replace `slots` with `slots: slotsWithContact`. (The return currently spreads/returns `slots`; use `slotsWithContact` there.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bunx vitest run src/server/public-reads.integration.test.ts`
Expected: PASS (existing tests + the new PII guard).

Run: `bun run typecheck`
Expected: PASS (no type errors from the new `holderPhone`/`holderEmail` slot fields).

- [ ] **Step 5: Commit**

```bash
git add src/server/meetings.ts src/server/public-reads.integration.test.ts
git commit -m "feat(nudge): expose gated holder/roster contact on the meeting payload (#37)"
```

---

## Task 4: `NudgeButtons` component

**Files:**
- Create: `src/components/club/nudge-buttons.tsx`
- Test: `src/components/club/nudge-buttons.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/club/nudge-buttons.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NudgeButtons } from "./nudge-buttons";

const base = {
	name: "Jane",
	roleName: "Timer",
	meetingDate: "Thu, Jul 23",
	shareUrl: "https://gavelup.app/club/mcf/meeting/abc",
	mode: "confirm" as const,
};

describe("NudgeButtons", () => {
	afterEach(() => cleanup());

	it("shows a WhatsApp link when the target has a phone", () => {
		render(<NudgeButtons {...base} phone="14155552671" email={null} />);
		const wa = screen.getByRole("link", { name: /whatsapp/i });
		expect(wa.getAttribute("href")).toContain("https://wa.me/14155552671");
		expect(wa.getAttribute("target")).toBe("_blank");
	});

	it("shows an Email link when the target has an email", () => {
		render(<NudgeButtons {...base} phone={null} email="j@x.io" />);
		const mail = screen.getByRole("link", { name: /email/i });
		expect(mail.getAttribute("href")).toContain("mailto:j@x.io");
	});

	it("shows only the present channel, not a disabled placeholder", () => {
		render(<NudgeButtons {...base} phone={null} email="j@x.io" />);
		expect(screen.queryByRole("link", { name: /whatsapp/i })).toBeNull();
	});

	it("renders a muted no-contact state when neither is present", () => {
		render(<NudgeButtons {...base} phone={null} email={null} />);
		expect(screen.getByText(/no contact on file/i)).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/club/nudge-buttons.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/club/nudge-buttons.tsx`:

```tsx
import { Mail, MessageCircle } from "lucide-react";
import { buildNudge, type NudgeMode } from "#/lib/nudge";
import { Button } from "#/components/ui/button";

/**
 * WhatsApp/Email tap-to-nudge affordances (#37). Renders only the channels the
 * target has; a muted "No contact on file" when neither. Links open the VPE's
 * own app pre-drafted — the human edits and sends. The app never sends.
 */
export function NudgeButtons({
	name,
	phone,
	email,
	roleName,
	meetingDate,
	shareUrl,
	mode,
}: {
	name: string;
	phone: string | null;
	email: string | null;
	roleName: string;
	meetingDate: string;
	shareUrl: string;
	mode: NudgeMode;
}) {
	const nudge = buildNudge({
		name,
		phone,
		email,
		roleName,
		meetingDate,
		shareUrl,
		mode,
	});

	if (!nudge.whatsappUrl && !nudge.mailtoUrl) {
		return (
			<span className="text-xs text-[var(--sea-ink-soft)]">
				No contact on file
			</span>
		);
	}

	return (
		<div className="flex items-center gap-1.5">
			{nudge.whatsappUrl ? (
				<Button asChild size="sm" variant="outline">
					<a href={nudge.whatsappUrl} target="_blank" rel="noopener noreferrer">
						<MessageCircle className="size-4" aria-hidden />
						WhatsApp
					</a>
				</Button>
			) : null}
			{nudge.mailtoUrl ? (
				<Button asChild size="sm" variant="outline">
					<a href={nudge.mailtoUrl}>
						<Mail className="size-4" aria-hidden />
						Email
					</a>
				</Button>
			) : null}
		</div>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/club/nudge-buttons.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/club/nudge-buttons.tsx src/components/club/nudge-buttons.test.tsx
git commit -m "feat(nudge): NudgeButtons channel component (#37)"
```

---

## Task 5: Filled-slot confirm nudge

**Files:**
- Modify: `src/routes/_authed/meetings.$id.tsx`

Render `NudgeButtons` (`mode="confirm"`) on each **held** slot row when `canManage`, using the holder's contact from the payload. The share path is `/club/${clubSlug}/meeting/${meeting.id}`; compute the absolute URL client-side (like `ShareLinkButton`).

- [ ] **Step 1: Add a client-side absolute share URL near the top of `MeetingDetail`**

After the loader destructure (where `clubSlug`, `meeting`, `canManage`, `timezone` are in scope), add:

```tsx
	const shareUrl =
		typeof window === "undefined"
			? `/club/${clubSlug}/meeting/${meeting.id}`
			: `${window.location.origin}/club/${clubSlug}/meeting/${meeting.id}`;
```

- [ ] **Step 2: Add the friendly date**

The payload already carries `timezone` and the meeting's `scheduledAt`. Reuse the existing `footerDate` helper (already imported in this file via the slide-layout/meeting utilities; if not imported, add `import { footerDate } from "#/lib/slide-layout";`). Compute:

```tsx
	const nudgeDate = footerDate(meeting.scheduledAt, timezone);
```

- [ ] **Step 3: Render `NudgeButtons` on held slots**

Import at the top:

```tsx
import { NudgeButtons } from "#/components/club/nudge-buttons";
```

In the slot-row rendering, for a slot that is **filled** (`slot.assigneeName != null`) and when `canManage`, render:

```tsx
{canManage && slot.assigneeName ? (
	<NudgeButtons
		name={slot.assigneeName}
		phone={slot.holderPhone}
		email={slot.holderEmail}
		roleName={slot.roleName}
		meetingDate={nudgeDate}
		shareUrl={shareUrl}
		mode="confirm"
	/>
) : null}
```

Place it in the slot row's action area (alongside the existing claim/release controls). If the slot list is rendered by a child component rather than inline, thread `canManage`, `shareUrl`, and `nudgeDate` to it as props and render `NudgeButtons` there.

- [ ] **Step 4: Verify typecheck + existing tests**

Run: `bun run typecheck`
Expected: PASS.

Run: `bunx vitest run src/components/agenda/meeting-present.test.tsx src/routes` 2>/dev/null || true — then run the meeting-detail-related tests if any. At minimum:
Run: `bun run typecheck && bunx vitest run src/components/club/nudge-buttons.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/_authed/meetings.\$id.tsx
git commit -m "feat(nudge): confirm-nudge buttons on filled slots (#37)"
```

---

## Task 6: Open-slot recruit picker

**Files:**
- Create: `src/components/club/nudge-recruit-picker.tsx`
- Modify: `src/routes/_authed/meetings.$id.tsx`

A "Nudge someone" trigger on each open slot opens a searchable member list (cmdk), each member annotated ("Not available" / "Already: {role}" / "no contact"), never filtered. Selecting a member reveals their `NudgeButtons` in `recruit` mode.

- [ ] **Step 1: Write the picker component**

Create `src/components/club/nudge-recruit-picker.tsx`:

```tsx
import { useMemo, useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "#/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { Button } from "#/components/ui/button";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import type { RosterContact } from "#/server/meeting-contacts-logic";

export interface RecruitTarget extends RosterContact {
	/** Member has a member_availability row for this meeting. */
	notAvailable: boolean;
	/** Role this member already holds in this meeting, if any. */
	alreadyRole: string | null;
}

/**
 * Open-slot recruiting picker (#37). Lists all active members, searchable,
 * annotated but NEVER filtered — the VPE decides whom to personally ask. On
 * pick, shows that member's WhatsApp/Email recruit draft (or a no-contact note).
 */
export function NudgeRecruitPicker({
	roleName,
	meetingDate,
	shareUrl,
	targets,
}: {
	roleName: string;
	meetingDate: string;
	shareUrl: string;
	targets: RecruitTarget[];
}) {
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<RecruitTarget | null>(null);
	const sorted = useMemo(
		() => [...targets].sort((a, b) => a.name.localeCompare(b.name)),
		[targets],
	);

	return (
		<Popover
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) setPicked(null);
			}}
		>
			<PopoverTrigger asChild>
				<Button size="sm" variant="outline">
					Nudge someone
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-72 p-0" align="start">
				{picked ? (
					<div className="space-y-2 p-3">
						<div className="text-sm font-semibold">{picked.name}</div>
						<NudgeButtons
							name={picked.name}
							phone={picked.phone}
							email={picked.email}
							roleName={roleName}
							meetingDate={meetingDate}
							shareUrl={shareUrl}
							mode="recruit"
						/>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setPicked(null)}
						>
							← Back to list
						</Button>
					</div>
				) : (
					<Command>
						<CommandInput placeholder="Search members…" />
						<CommandList>
							<CommandEmpty>No members found.</CommandEmpty>
							<CommandGroup>
								{sorted.map((t) => (
									<CommandItem
										key={t.id}
										value={t.name}
										onSelect={() => setPicked(t)}
									>
										<span className="flex-1 truncate">{t.name}</span>
										{t.notAvailable ? (
											<span className="ml-2 text-xs text-[var(--warning-strong)]">
												Not available
											</span>
										) : null}
										{t.alreadyRole ? (
											<span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
												Already: {t.alreadyRole}
											</span>
										) : null}
										{!t.phone && !t.email ? (
											<span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
												no contact
											</span>
										) : null}
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				)}
			</PopoverContent>
		</Popover>
	);
}
```

- [ ] **Step 2: Build the `RecruitTarget[]` in the route and render the picker on open slots**

In `src/routes/_authed/meetings.$id.tsx`, the loader already provides `roster` (now `{id,name,phone,email}`), `unavailableMembers`, and `slots`. Compute the annotated targets once in `MeetingDetail`:

```tsx
	const recruitTargets = useMemo(() => {
		const unavailableIds = new Set(unavailableMembers.map((m) => m.id));
		// Which role (if any) each member already holds in this meeting.
		const heldRoleByMember = new Map<string, string>();
		for (const s of slots) {
			if (s.assigneeId && !heldRoleByMember.has(s.assigneeId)) {
				heldRoleByMember.set(s.assigneeId, s.roleName);
			}
		}
		return roster.map((m) => ({
			...m,
			notAvailable: unavailableIds.has(m.id),
			alreadyRole: heldRoleByMember.get(m.id) ?? null,
		}));
	}, [roster, unavailableMembers, slots]);
```

Import at the top:

```tsx
import { NudgeRecruitPicker } from "#/components/club/nudge-recruit-picker";
```

(`useMemo` is already imported in this file; if not, add it to the `react` import.)

For each **open** slot (`slot.assigneeName == null`) when `canManage`, render:

```tsx
{canManage && !slot.assigneeName ? (
	<NudgeRecruitPicker
		roleName={slot.roleName}
		meetingDate={nudgeDate}
		shareUrl={shareUrl}
		targets={recruitTargets}
	/>
) : null}
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: PASS. (`unavailableMembers` is `{ id, name }[]` — confirmed in `src/server/meetings.ts` — so `unavailableMembers.map((m) => m.id)` is correct.)

- [ ] **Step 4: Run the component + unit suites**

Run: `bunx vitest run src/components/club/nudge-buttons.test.tsx src/lib/nudge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/club/nudge-recruit-picker.tsx src/routes/_authed/meetings.\$id.tsx
git commit -m "feat(nudge): open-slot recruit picker with availability annotations (#37)"
```

---

## Task 7: Full gates + final commit

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: PASS (this is the only real type gate).

- [ ] **Step 2: Biome**

Run: `bunx biome check src --write` then `bunx biome check src --diagnostic-level=error`
Expected: No errors (warnings pre-exist).

- [ ] **Step 3: Full test suite with DB**

Run: `TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test bun run test`
Expected: PASS — all suites, including the new `nudge`, `meeting-contacts`, and `nudge-buttons` tests and the PII guard in `public-reads`.

- [ ] **Step 4: Server-bundle guard sanity**

Confirm `src/lib/nudge.ts` imports no `#/db`, and `src/server/meeting-contacts-logic.ts` is not imported by any client route (only by `meetings.ts`).

Run: `bunx vitest run src/server/server-modules.guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit any formatting**

```bash
git add -A
git commit -m "chore(nudge): formatting + gate pass (#37)" || echo "nothing to commit"
```

---

## Self-review notes (author)

- **Spec coverage:** buildNudge (Task 1) ↔ spec §nudge.ts; gated contact + PII boundary (Tasks 2–3) ↔ spec §PII; NudgeButtons + no-contact (Task 4) ↔ Q4; filled-slot confirm (Task 5) ↔ scope; recruit picker annotate-not-filter (Task 6) ↔ Q3; tests (all tasks) + guard ↔ spec §Testing. Follow-ups (#295, per-role page) are out of scope by design.
- **No auto-send / no logging:** honored — every channel is a client-side anchor; no server write, no activity_log.
- **Known caveat carried into code comments:** wa.me best-effort (Task 1 `waDigits` docstring), reliability deferred to #295.
