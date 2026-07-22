# Public Guest Read-Only Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public `/club/:clubId` season grid and meeting agenda readable by anyone (no name-pick gate), collecting the lightweight name-pick identity inline only when a visitor tries to participate; add a guest-resources strip and an always-present "identify" control; and stop search engines indexing these member-data pages.

**Architecture:** Invert the `RequireMember` layout gate into an `IdentityGateProvider` that exposes a `requireIdentity()` promise (resolves the stored identity, or opens a name-pick dialog and resolves on pick). The shared `meetingViewer` learns to *offer* claim/availability to a no-identity ("prospective") visitor while restricting take-over to the signed-in shell path. Participate handlers resolve identity before mutating. No server/DB changes — the claim/release/reassign/availability server fns are already member-keyed and session-free.

**Tech Stack:** TanStack Start (React 19, file routing), Vitest + `@testing-library/react` (jsdom via `// @vitest-environment jsdom` docblock), Biome, TypeScript strict. Package manager **Bun**.

**Spec:** `docs/superpowers/specs/2026-07-21-public-guest-readonly-views-design.md`

---

## File Structure

**New files**
- `src/components/club/identity-gate.tsx` — `IdentityGateProvider` + `useRequireIdentity()` context (owns the name-pick dialog; single-flight, null-abort, `promptIdentity`).
- `src/components/club/pick-name-form.tsx` — the roster-search + "I'm new — add me" form, extracted from `PickNameScreen` so both the (retired) full-page gate's replacement and the dialog reuse it.
- `src/components/club/viewing-as.tsx` — always-present "Viewing as" bar (guest + identified/switch states); replaces `signing-up-as.tsx`.
- `src/components/club/guest-resources.tsx` — compact "New to Toastmasters?" strip.
- Test files alongside each.

**Modified**
- `src/lib/meeting-viewer.ts` — `isSignedIn` input; prospective offer capabilities; `canTakeOver = isSignedIn`.
- `src/routes/_authed/meetings.$id.tsx` — pass `isSignedIn: true`.
- `src/routes/club.$clubId.tsx` — swap `RequireMember` → `IdentityGateProvider`; add robots noindex.
- `src/routes/club.$clubId_.guest-book.tsx`, `…present.tsx`, `…print.tsx` — robots noindex.
- `src/components/agenda/meeting-agenda.tsx` — render claim for prospective; resolve identity at claim click.
- `src/components/club/grid-cell.tsx`, `src/components/club/season-grid.tsx` — prospective claim path.
- `src/routes/club.$clubId.meeting.$meetingId.tsx` — `requireIdentity()`-first actions; `isSignedIn`; viewing-as + resources.
- `src/routes/club.$clubId.index.tsx` — resources strip + "Your upcoming roles" guest empty state; viewing-as.

**Retired**
- `src/components/club/require-member.tsx` + `require-member.test.tsx`.
- `src/components/club/signing-up-as.tsx` + `signing-up-as.test.tsx` (replaced by `viewing-as`).

---

## Task 0: Prerequisites (worktree setup)

This worktree may lack dependencies. Component tests need jsdom; no DB is required for any test in this plan.

- [ ] **Step 1: Install deps and env**

Run:
```bash
bun install
cp ../../../.env.local .env.local 2>/dev/null || true
```
Expected: `bun install` completes. (`.env.local` copy is best-effort — not needed for these tests, but keeps `bun run dev` usable.)

- [ ] **Step 2: Baseline green**

Run: `bun run typecheck`
Expected: PASS (clean baseline before changes).

---

## Task 1: `meetingViewer` — prospective offers + take-over guardrail

**Files:**
- Modify: `src/lib/meeting-viewer.ts`
- Test: `src/lib/meeting-viewer.test.ts`
- Modify (call sites): `src/routes/_authed/meetings.$id.tsx:175-181`, `src/routes/club.$clubId.meeting.$meetingId.tsx:187-193`

The current rule gates every mutating capability on `hasIdentity`. New rules: a no-identity ("prospective") visitor is *offered* `canClaim` + `canToggleAvailability` (they identify at click); `canTakeOver` follows the new `isSignedIn` input only (no booting a held role via the honor-system name-pick); `canReleaseOwn`/`canEditOwnSpeech` still need an established identity holding the slot. `lockedViewer` already zeroes everything, so locked/past meetings stay read-only.

- [ ] **Step 1: Rewrite the viewer tests for the new semantics**

Replace the body of `src/lib/meeting-viewer.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { meetingViewer } from "./meeting-viewer";

// Default fixture = an anonymous self-serve (name-pick) identity: has an id but
// is NOT signed in. This is the honor-system path that must NOT be able to boot.
const base = {
	currentMemberId: "m1" as string | null,
	canManage: false,
	isTmod: false,
	isGrammarian: false,
	isEditableWindow: true,
	isSignedIn: false,
};

describe("meetingViewer", () => {
	it("admin gets the full management + meta-edit set, no focused WOD dialog", () => {
		const v = meetingViewer({ ...base, canManage: true, isSignedIn: true });
		expect(v.canManage).toBe(true);
		expect(v.canAssign).toBe(true);
		expect(v.canManageSpeakers).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false);
		expect(v.canToggleAvailability).toBe(true);
	});

	it("an anonymous name-pick member can claim/release/toggle but CANNOT take over", () => {
		const v = meetingViewer(base);
		expect(v.canClaim).toBe(true);
		expect(v.canReleaseOwn).toBe(true);
		expect(v.canToggleAvailability).toBe(true);
		expect(v.canEditOwnSpeech).toBe(true);
		expect(v.canTakeOver).toBe(false); // honor-system path may not boot a held role
		expect(v.canManage).toBe(false);
		expect(v.canAssign).toBe(false);
	});

	it("a signed-in member additionally gets take-over", () => {
		const v = meetingViewer({ ...base, isSignedIn: true });
		expect(v.canTakeOver).toBe(true);
		expect(v.canClaim).toBe(true);
		expect(v.canReleaseOwn).toBe(true);
	});

	it("a prospective visitor (no identity) is offered claim + availability, nothing that needs a held slot", () => {
		const v = meetingViewer({ ...base, currentMemberId: null });
		expect(v.canClaim).toBe(true); // offered — identity resolved at click
		expect(v.canToggleAvailability).toBe(true);
		expect(v.canTakeOver).toBe(false);
		expect(v.canReleaseOwn).toBe(false); // holds no slot yet
		expect(v.canEditOwnSpeech).toBe(false);
	});

	it("a prospective visitor who is somehow signed-in is still offered take-over via isSignedIn", () => {
		const v = meetingViewer({ ...base, currentMemberId: null, isSignedIn: true });
		expect(v.canTakeOver).toBe(true);
	});

	it("a non-admin TMOD gets assign/speakers/meta-edit but no focused WOD dialog", () => {
		const v = meetingViewer({ ...base, isTmod: true });
		expect(v.canAssign).toBe(true);
		expect(v.canManageSpeakers).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false);
	});

	it("a pure Grammarian (not TMOD, not admin) gets the focused WOD dialog", () => {
		const v = meetingViewer({ ...base, isGrammarian: true });
		expect(v.canEditWod).toBe(true);
		expect(v.canEditMeetingMeta).toBe(false);
	});

	it("a TMOD who is also Grammarian uses meta-edit, not the focused WOD dialog", () => {
		const v = meetingViewer({ ...base, isTmod: true, isGrammarian: true });
		expect(v.canEditMeetingMeta).toBe(true);
		expect(v.canEditWod).toBe(false);
	});

	it("a closed edit window disables meta-edit + WOD but leaves claim/release", () => {
		const admin = meetingViewer({
			...base,
			canManage: true,
			isSignedIn: true,
			isEditableWindow: false,
		});
		expect(admin.canEditMeetingMeta).toBe(false);
		const gram = meetingViewer({
			...base,
			isGrammarian: true,
			isEditableWindow: false,
		});
		expect(gram.canEditWod).toBe(false);
		expect(gram.canClaim).toBe(true);
		expect(gram.canReleaseOwn).toBe(true);
	});
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `bunx vitest run src/lib/meeting-viewer.test.ts`
Expected: FAIL — `meetingViewer` doesn't accept `isSignedIn` and `canTakeOver` still follows `hasIdentity`.

- [ ] **Step 3: Update `meetingViewer`**

In `src/lib/meeting-viewer.ts`, add the `isSignedIn` doc + input and change the offer/take-over rules. Update the `MeetingViewer` interface doc for `canClaim`/`canTakeOver` and the `meetingViewer` function:

Replace the `meetingViewer` function (lines 62-86) with:

```ts
export function meetingViewer(input: {
	currentMemberId: string | null;
	canManage: boolean;
	isTmod: boolean;
	isGrammarian: boolean;
	isEditableWindow: boolean;
	/** The real-auth (Better-Auth) shell path (#317). Take-over ("boot" a held
	 *  role) is granted ONLY here — the honor-system name-pick path may claim
	 *  open slots but not reassign someone else's. Optional, defaults to false
	 *  (fail closed: no take-over unless a caller opts in). */
	isSignedIn?: boolean;
}): MeetingViewer {
	const hasIdentity = input.currentMemberId !== null;
	const manages = input.canManage;
	const runsMeeting = manages || input.isTmod;
	return {
		currentMemberId: input.currentMemberId,
		canManage: manages,
		canAssign: runsMeeting,
		canManageSpeakers: runsMeeting,
		canEditMeetingMeta: runsMeeting && input.isEditableWindow,
		// Offered to everyone incl. a no-identity visitor (they identify at click);
		// lockedViewer denies these for a locked/past meeting.
		canToggleAvailability: true,
		canClaim: true,
		// Boot a held role: real sign-in only (spec decision #6).
		canTakeOver: input.isSignedIn ?? false,
		// Need an established identity that actually holds the slot.
		canEditOwnSpeech: hasIdentity,
		canReleaseOwn: hasIdentity,
		canEditWod:
			input.isGrammarian && !input.isTmod && !manages && input.isEditableWindow,
	};
}
```

Making `isSignedIn` **optional (default false)** keeps the 15+ existing `meetingViewer(...)` call sites in the test files compiling untouched — only the real routes (Step 4) and the two take-over tests (Step 4b) need edits.

Then update the two doc-comment lines in the `MeetingViewer` interface:
- `canClaim` (around lines 35-40): change to
  `/** Claim an open slot. Offered to any visitor incl. a no-identity one (who identifies at click); a lockedViewer denies it. */`
- `canTakeOver` (line 32): change to
  `/** Take over someone else's filled slot — SIGNED-IN only (no honor-system booting). */`

- [ ] **Step 4: Update the two call sites so the project compiles**

In `src/routes/_authed/meetings.$id.tsx`, add `isSignedIn: true` to the `meetingViewer` call (this route is always authenticated). Change lines 175-181 to:

```ts
	const baseViewer = meetingViewer({
		currentMemberId,
		canManage: effectiveCanManage,
		isTmod,
		isGrammarian,
		isEditableWindow: !locked && !over,
		isSignedIn: true,
	});
```

In `src/routes/club.$clubId.meeting.$meetingId.tsx`, add `isSignedIn: session !== null` to the `meetingViewer` call. Change lines 187-193 to:

```ts
	const baseViewer = meetingViewer({
		currentMemberId: myId,
		canManage: false,
		isTmod,
		isGrammarian,
		isEditableWindow: !over,
		isSignedIn: session !== null,
	});
```

- [ ] **Step 4b: Fix the two agenda tests whose take-over semantics change**

`canTakeOver` is now signed-in-only, so two existing cases in `src/components/agenda/meeting-agenda.test.tsx` need updating (all other 14 call sites compile and pass unchanged because `isSignedIn` is optional and they don't assert take-over):

1. The test **"hides manager-only controls for a signed-in non-manager"** (around lines 120-144) asserts `screen.getByText("take over")` — a *signed-in* member keeps take-over, so add `isSignedIn: true` to its `meetingViewer({...})` call and update the stale comment. Change its viewer call to:

```ts
			meetingViewer({
				currentMemberId: "me",
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
				isSignedIn: true,
			}),
```

   and replace the comment above the assertion (the "#302 parity … the unified viewer grants it on any identity" lines) with:

```ts
			// A signed-in non-manager keeps self-serve take-over; only the
			// manager-only controls above stay hidden. (Take-over is now
			// signed-in-only — see the self-asserted-member case below.)
```

2. The test **"shows takeover but no admin controls for a self-asserted member"** (around lines 146-167) now contradicts decision #6 — a self-asserted (name-pick, not signed-in) member must NOT get take-over. Leave its `meetingViewer({...})` call as-is (no `isSignedIn` → false), rename the test to **"hides takeover for a self-asserted (name-pick) member"**, and change the take-over assertion (line 162) from:

```ts
		expect(screen.getByText("take over")).toBeTruthy();
```

   to:

```ts
		expect(screen.queryByText("take over")).toBeNull();
```

   (Keep the other assertions in that test — no Confirm, no "Open roles:", no Reassign — unchanged.)

> The null-identity test **"gives a visitor with no name a read-only agenda (claim disabled)"** (line 169) still passes after this task — the agenda's own `currentMemberId !== null` guard at `meeting-agenda.tsx:160` is untouched until Task 7, which is where that test flips.

- [ ] **Step 5: Run the tests + typecheck — verify green**

Run: `bunx vitest run src/lib/meeting-viewer.test.ts src/components/agenda/meeting-agenda.test.tsx src/lib/meeting-lifecycle.test.ts && bun run typecheck`
Expected: PASS. (Typecheck confirms the two real routes supply `isSignedIn`; the agenda + lifecycle suites confirm the take-over semantic flip.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/meeting-viewer.ts src/lib/meeting-viewer.test.ts src/components/agenda/meeting-agenda.test.tsx src/routes/_authed/meetings.\$id.tsx src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "feat(viewer): offer claim to prospective visitors, gate take-over to signed-in"
```

---

## Task 2: `PickNameForm` extraction + `IdentityGateProvider`

**Files:**
- Create: `src/components/club/pick-name-form.tsx`
- Create: `src/components/club/identity-gate.tsx`
- Test: `src/components/club/identity-gate.test.tsx`

`requireIdentity()` is the seam every participate action calls. It resolves the stored/session identity immediately, or opens the name-pick dialog and resolves with the newly-picked member. Dismissal resolves `null` (abort). Concurrent calls share one pending promise (single-flight). `promptIdentity()` force-opens the dialog for the "switch identity" flow.

- [ ] **Step 1: Create `PickNameForm` (extracted roster picker)**

Create `src/components/club/pick-name-form.tsx`:

```tsx
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { initialsOf, toneFromSeed } from "#/lib/avatar";
import type { StoredMember } from "#/lib/member-identity";
import { officerPositionLabel } from "#/lib/officers";
import { addMember, listMembers } from "#/server/members";
import { MemberAvatar } from "./member-avatar";

/**
 * Roster search + "I'm new — add me" picker. Extracted from the retired
 * `PickNameScreen` so the identity dialog reuses it. Router-independent:
 * `clubUuid` is passed in; on pick it calls `onPicked` with the chosen/created
 * member. Renders inside a Dialog (no full-page chrome of its own).
 */
export function PickNameForm({
	clubUuid,
	onPicked,
}: {
	clubUuid: string;
	onPicked: (m: StoredMember) => void;
}) {
	const [query, setQuery] = useState("");
	const [newName, setNewName] = useState("");

	const { data: members = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
	});

	const addMutation = useMutation({
		mutationFn: (name: string) =>
			addMember({ data: { clubId: clubUuid, name } }),
	});

	const filtered = members.filter((m) =>
		m.name.toLowerCase().includes(query.trim().toLowerCase()),
	);

	async function handleAdd() {
		const name = newName.trim();
		if (!name || addMutation.isPending) return;
		try {
			const result = await addMutation.mutateAsync(name);
			onPicked({ id: result.id, name });
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Couldn't add you — try again.",
			);
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="space-y-2">
				<Label htmlFor="member-search">Search members</Label>
				<Input
					id="member-search"
					type="search"
					placeholder="Type your name…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					autoComplete="off"
				/>
			</div>

			<ul className="flex max-h-[40svh] flex-col gap-2 overflow-y-auto">
				{filtered.map((m) => (
					<li key={m.id}>
						<button
							type="button"
							onClick={() => onPicked({ id: m.id, name: m.name })}
							className="flex w-full items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent"
						>
							<MemberAvatar
								tone={toneFromSeed(m.id)}
								initials={initialsOf(m.name)}
								size={38}
							/>
							<span className="flex min-w-0 flex-col">
								<span className="truncate font-medium text-foreground">
									{m.name}
								</span>
								{m.officerPositions.length ? (
									<span className="truncate text-muted-foreground text-xs">
										{m.officerPositions.map(officerPositionLabel).join(", ")}
									</span>
								) : null}
							</span>
						</button>
					</li>
				))}
				{filtered.length === 0 ? (
					<li className="px-1 py-2 text-muted-foreground text-sm">
						No members match “{query}”.
					</li>
				) : null}
			</ul>

			<div className="space-y-2 border-border border-t pt-4">
				<Label htmlFor="new-member-name">I'm new — add me</Label>
				<div className="flex gap-2">
					<Input
						id="new-member-name"
						placeholder="Your name"
						value={newName}
						onChange={(e) => setNewName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void handleAdd();
							}
						}}
						autoComplete="off"
					/>
					<Button
						type="button"
						onClick={() => void handleAdd()}
						disabled={!newName.trim() || addMutation.isPending}
					>
						Add me
					</Button>
				</div>
			</div>
		</div>
	);
}
```

> Note: `initialsOf`, `toneFromSeed`, `MemberAvatar`, `officerPositionLabel`, `addMember`, `listMembers` are all the exact imports the current `PickNameScreen` uses (`require-member.tsx:5-12`) — copy them verbatim.

- [ ] **Step 2: Write the failing provider test**

Create `src/components/club/identity-gate.test.tsx`:

```tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearStoredMember } from "#/lib/member-identity";

// Stub the roster server fns the dialog's PickNameForm calls.
vi.mock("#/server/members", () => ({
	listMembers: vi.fn(async () => [
		{ id: "m-jane", name: "Jane Doe", officerPositions: [] },
	]),
	addMember: vi.fn(async () => ({ id: "m-new" })),
}));

import { IdentityGateProvider, useRequireIdentity } from "./identity-gate";

const CLUB_UUID = "11111111-1111-1111-1111-111111111111";
const CLUB_SLUG = "club-slug";

function Harness({ onResult }: { onResult: (v: unknown) => void }) {
	const { member, requireIdentity } = useRequireIdentity();
	return (
		<div>
			<p>member: {member ? member.name : "none"}</p>
			<button
				type="button"
				onClick={async () => onResult(await requireIdentity())}
			>
				act
			</button>
		</div>
	);
}

function renderHarness(onResult: (v: unknown) => void) {
	const qc = new QueryClient();
	return render(
		<QueryClientProvider client={qc}>
			<IdentityGateProvider
				clubUuid={CLUB_UUID}
				clubSlug={CLUB_SLUG}
				sessionMember={null}
			>
				<Harness onResult={onResult} />
			</IdentityGateProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => clearStoredMember(CLUB_SLUG));
afterEach(() => {
	cleanup();
	clearStoredMember(CLUB_SLUG);
});

describe("IdentityGateProvider", () => {
	it("opens the dialog when no identity and resolves with the picked member", async () => {
		const results: unknown[] = [];
		renderHarness((v) => results.push(v));
		await userEvent.click(screen.getByText("act"));
		// Dialog opens with the roster.
		await userEvent.click(await screen.findByText("Jane Doe"));
		await waitFor(() =>
			expect(results).toEqual([{ id: "m-jane", name: "Jane Doe" }]),
		);
		// Identity now persists — the bar reflects it.
		expect(screen.getByText("member: Jane Doe")).toBeTruthy();
	});

	it("resolves null when the dialog is dismissed (abort)", async () => {
		const results: unknown[] = [];
		renderHarness((v) => results.push(v));
		await userEvent.click(screen.getByText("act"));
		await screen.findByText("Jane Doe");
		await userEvent.keyboard("{Escape}");
		await waitFor(() => expect(results).toEqual([null]));
	});
});
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `bunx vitest run src/components/club/identity-gate.test.tsx`
Expected: FAIL — `identity-gate` module / exports don't exist.

- [ ] **Step 4: Implement `IdentityGateProvider`**

Create `src/components/club/identity-gate.tsx`:

```tsx
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import {
	type StoredMember,
	useCurrentMember,
} from "#/lib/member-identity";
import { PickNameForm } from "./pick-name-form";

interface IdentityGateValue {
	/** The effective identity: session member (shell) or the name-pick, else null. */
	member: StoredMember | null;
	/** Resolve the current identity, or open the picker and resolve on pick.
	 *  Resolves `null` when the picker is dismissed (caller aborts). */
	requireIdentity: () => Promise<StoredMember | null>;
	/** Force-open the picker to switch identity (used by "not you?" / "I'm a
	 *  member"). Dismissal keeps the current identity. */
	promptIdentity: () => void;
}

const IdentityGateContext = createContext<IdentityGateValue | null>(null);

export function useRequireIdentity(): IdentityGateValue {
	const ctx = useContext(IdentityGateContext);
	if (!ctx) {
		throw new Error("useRequireIdentity must be used within IdentityGateProvider");
	}
	return ctx;
}

export function IdentityGateProvider({
	clubUuid,
	clubSlug,
	sessionMember,
	children,
}: {
	clubUuid: string;
	clubSlug: string;
	/** Signed-in member of this club (shell path) — takes precedence over the
	 *  name-pick and means the picker never needs to open. */
	sessionMember: StoredMember | null;
	children: React.ReactNode;
}) {
	const { member: picked, setMember } = useCurrentMember(clubSlug);
	const effective = sessionMember ?? picked;

	const [open, setOpen] = useState(false);
	// Pending requireIdentity() resolvers — single-flight: every call made while
	// the picker is open resolves together on the next pick/dismiss.
	const resolvers = useRef<((m: StoredMember | null) => void)[]>([]);

	const flush = useCallback((m: StoredMember | null) => {
		const pending = resolvers.current;
		resolvers.current = [];
		for (const r of pending) r(m);
	}, []);

	const requireIdentity = useCallback(() => {
		if (effective) return Promise.resolve(effective);
		return new Promise<StoredMember | null>((resolve) => {
			resolvers.current.push(resolve);
			setOpen(true);
		});
	}, [effective]);

	const promptIdentity = useCallback(() => setOpen(true), []);

	const handlePicked = useCallback(
		(m: StoredMember) => {
			setMember(m);
			flush(m);
			setOpen(false);
		},
		[setMember, flush],
	);

	// Dialog closed WITHOUT a pick → resolve any pending callers with null
	// (abort). A switch (promptIdentity with an existing identity) simply keeps
	// the current identity because there were no pending resolvers.
	const handleOpenChange = useCallback(
		(next: boolean) => {
			setOpen(next);
			if (!next) flush(null);
		},
		[flush],
	);

	const value = useMemo(
		() => ({ member: effective, requireIdentity, promptIdentity }),
		[effective, requireIdentity, promptIdentity],
	);

	return (
		<IdentityGateContext.Provider value={value}>
			{children}
			<Dialog open={open} onOpenChange={handleOpenChange}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Who are you?</DialogTitle>
						<DialogDescription>
							Pick your name to continue. This just tags what you sign up for —
							no account needed.
						</DialogDescription>
					</DialogHeader>
					{open ? (
						<PickNameForm clubUuid={clubUuid} onPicked={handlePicked} />
					) : null}
				</DialogContent>
			</Dialog>
		</IdentityGateContext.Provider>
	);
}
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `bunx vitest run src/components/club/identity-gate.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add src/components/club/pick-name-form.tsx src/components/club/identity-gate.tsx src/components/club/identity-gate.test.tsx
git commit -m "feat(club): IdentityGateProvider + requireIdentity seam + PickNameForm"
```

---

## Task 3: Wire the club layout + noindex; retire `RequireMember`

**Files:**
- Modify: `src/routes/club.$clubId.tsx`
- Delete: `src/components/club/require-member.tsx`, `src/components/club/require-member.test.tsx`
- Modify: `src/routes/club.$clubId_.guest-book.tsx`, `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`, `src/routes/club.$clubId_.meeting.$meetingId.print.tsx`

- [ ] **Step 1: Swap the gate in the layout — wrap BOTH paths**

`useRequireIdentity()` is called by the route components rendered in the `<Outlet/>` (Tasks 4/6/7), so the provider must be present on **both** the signed-in shell path AND the anonymous path — otherwise the shell path throws "must be used within IdentityGateProvider." On the shell path the provider is a pass-through (the session member means the dialog never opens).

In `src/routes/club.$clubId.tsx`:
- Replace the import on line 11 `import { RequireMember } from "#/components/club/require-member";` with
  `import { IdentityGateProvider } from "#/components/club/identity-gate";`.
- Add `effectiveMemberId` to the route-context destructure (line 53) so we can build the session member:

```tsx
	const { clubUuid, clubName, clubNumber, shell, authCtx, effectiveMemberId } =
		Route.useRouteContext();
```

- Just below that destructure, compute the session member (same shape the pages use):

```tsx
	const sessionMember =
		effectiveMemberId && authCtx?.user
			? { id: effectiveMemberId, name: authCtx.user.name || authCtx.user.email }
			: null;
```

- In the **shell** branch (the `if (shell && authCtx)` return, lines 76-86), wrap the `<Outlet />` with the provider:

```tsx
		return (
			<AppShell
				{...shellPropsFromContext(authCtx)}
				onSignOut={handleSignOut}
				onExitImpersonation={handleExitImpersonation}
			>
				<IdentityGateProvider
					clubUuid={clubUuid}
					clubSlug={clubId}
					sessionMember={sessionMember}
				>
					<Outlet />
				</IdentityGateProvider>
			</AppShell>
		);
```

- In the **anonymous** branch, replace the `RequireMember` wrapper (lines 109-111):

```tsx
			<RequireMember clubUuid={clubUuid} clubSlug={clubId}>
				<Outlet />
			</RequireMember>
```

with:

```tsx
			<IdentityGateProvider
				clubUuid={clubUuid}
				clubSlug={clubId}
				sessionMember={null}
			>
				<Outlet />
			</IdentityGateProvider>
```

- [ ] **Step 2: Add robots noindex to the layout route**

In `src/routes/club.$clubId.tsx`, add a `head` to the route definition (inside `createFileRoute("/club/$clubId")({ ... })`, alongside `beforeLoad`/`component`):

```ts
	head: () => ({
		// Member-data pages are for people you share the link with, not search
		// discovery (spec decision #5). Covers the nested index + meeting agenda.
		meta: [{ name: "robots", content: "noindex, nofollow" }],
	}),
```

- [ ] **Step 3: Add robots noindex to the three escaped public routes**

Each of these underscore-escaped routes does NOT nest under the layout, so each needs its own `head`. In `src/routes/club.$clubId_.guest-book.tsx`, `src/routes/club.$clubId_.meeting.$meetingId.present.tsx`, and `src/routes/club.$clubId_.meeting.$meetingId.print.tsx`, add the same `head` block to each route's options:

```ts
	head: () => ({
		meta: [{ name: "robots", content: "noindex, nofollow" }],
	}),
```

> If a route already defines `head`, merge the `{ name: "robots", … }` entry into its existing `meta` array instead of adding a second `head`.

- [ ] **Step 4: Delete the retired component + its test**

Run:
```bash
git rm src/components/club/require-member.tsx src/components/club/require-member.test.tsx
```

- [ ] **Step 5: Typecheck + full test run**

Run: `bun run typecheck && bunx vitest run src/routes src/components/club`
Expected: PASS. No remaining importer of `require-member` (grep to confirm):
Run: `grep -rn "require-member\|RequireMember" src || echo "clean"`
Expected: `clean`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(club): view-open layout via IdentityGateProvider; noindex public club routes; retire RequireMember"
```

---

## Task 4: "Viewing as" bar (replaces `SigningUpAs`)

**Files:**
- Create: `src/components/club/viewing-as.tsx`
- Test: `src/components/club/viewing-as.test.tsx`
- Delete: `src/components/club/signing-up-as.tsx`, `src/components/club/signing-up-as.test.tsx`
- Modify (wire in): `src/routes/club.$clubId.meeting.$meetingId.tsx`, `src/routes/club.$clubId.index.tsx`

Always-present identity control. Guest state → "Viewing as guest · I'm a member →" (opens the picker, the discoverable entry point for a TMOD/Grammarian who has nothing to claim). Identified state → "Signing up as {name} · not you?" where "not you?" opens the picker to switch.

- [ ] **Step 1: Write the failing test**

Create `src/components/club/viewing-as.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewingAs } from "./viewing-as";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ViewingAs", () => {
	it("guest state invites the visitor to identify", async () => {
		const promptIdentity = vi.fn();
		render(<ViewingAs member={null} promptIdentity={promptIdentity} />);
		expect(screen.getByText(/viewing as guest/i)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /i'm a member/i }));
		expect(promptIdentity).toHaveBeenCalledOnce();
	});

	it("identified state shows the name and a switch affordance", async () => {
		const promptIdentity = vi.fn();
		render(
			<ViewingAs
				member={{ id: "m1", name: "Jane Doe" }}
				promptIdentity={promptIdentity}
			/>,
		);
		expect(screen.getByText(/jane doe/i)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /not you/i }));
		expect(promptIdentity).toHaveBeenCalledOnce();
	});
});
```

`ViewingAs` takes `member` + `promptIdentity` as props (pure/presentational); the routes pass them from `useRequireIdentity()`.

- [ ] **Step 2: Run the test — verify it fails**

Run: `bunx vitest run src/components/club/viewing-as.test.tsx`
Expected: FAIL — `viewing-as` module doesn't exist.

- [ ] **Step 3: Implement `ViewingAs`**

Create `src/components/club/viewing-as.tsx`:

```tsx
import type { StoredMember } from "#/lib/member-identity";

/**
 * Always-present identity control on the public club surfaces. Replaces
 * `SigningUpAs`. Guest state invites identifying (the discoverable entry point
 * for a TMOD/Grammarian, who hold slots and have nothing to *claim*);
 * identified state shows the name with a "not you?" switch. Both open the
 * name-pick dialog via `promptIdentity`.
 */
export function ViewingAs({
	member,
	promptIdentity,
}: {
	member: StoredMember | null;
	promptIdentity: () => void;
}) {
	if (!member) {
		return (
			<p className="text-sm text-muted-foreground">
				Viewing as guest
				<span aria-hidden> · </span>
				<button
					type="button"
					onClick={promptIdentity}
					className="font-medium text-foreground underline underline-offset-2 hover:text-foreground"
				>
					I'm a member →
				</button>
			</p>
		);
	}
	return (
		<p className="text-sm text-muted-foreground">
			Signing up as{" "}
			<span className="font-medium text-foreground">{member.name}</span>
			<span aria-hidden> · </span>
			<button
				type="button"
				onClick={promptIdentity}
				className="underline underline-offset-2 hover:text-foreground"
			>
				not you?
			</button>
		</p>
	);
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bunx vitest run src/components/club/viewing-as.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire it into the meeting page**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`:
- Replace the import (line 24) `import { SigningUpAs } from "#/components/club/signing-up-as";` with
  `import { ViewingAs } from "#/components/club/viewing-as";`
  and add `import { useRequireIdentity } from "#/components/club/identity-gate";`.
- Change the identity destructure (line 150) to also read `source`, and add the gate hook:
  `const { member, source } = useEffectiveMember(clubId, session);`
  `const { promptIdentity } = useRequireIdentity();`
- Replace the `<SigningUpAs clubSlug={clubId} />` usage (line 326) with an anon-only bar (a signed-in shell member has no localStorage identity to switch, matching the old `SigningUpAs`, which rendered nothing without one):
  ```tsx
  {source === "anon" ? (
  	<ViewingAs member={member} promptIdentity={promptIdentity} />
  ) : null}
  ```

- [ ] **Step 6: Wire it into the season-grid page**

In `src/routes/club.$clubId.index.tsx`:
- Add imports: `import { ViewingAs } from "#/components/club/viewing-as";` and
  `import { useRequireIdentity } from "#/components/club/identity-gate";`.
- In `ClubHome`, after `const { member, clearMember, source } = useEffectiveMember(clubId, session);` (line 54), add:
  `const { promptIdentity } = useRequireIdentity();`
- Replace the header "not you?" block (lines 90-103, the `<div className="flex items-center justify-between pt-2">…</div>`) so the greeting keeps its title and the identity control becomes the always-present bar:

```tsx
			<div className="flex items-center justify-between pt-2">
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					Hi {member?.name ?? "there"} 👋
				</h1>
			</div>
			{source === "anon" ? (
				<ViewingAs member={member} promptIdentity={promptIdentity} />
			) : null}
```

  (`clearMember` is no longer used here — the switch flow lives in `promptIdentity`. Remove `clearMember` from the destructure on line 54 to satisfy no-unused-locals.)

- [ ] **Step 7: Delete the retired `SigningUpAs`**

Run:
```bash
git rm src/components/club/signing-up-as.tsx src/components/club/signing-up-as.test.tsx
grep -rn "signing-up-as\|SigningUpAs" src || echo "clean"
```
Expected: `clean`.

- [ ] **Step 8: Typecheck + tests + commit**

Run: `bun run typecheck && bunx vitest run src/components/club/viewing-as.test.tsx`
Expected: PASS.

```bash
git add -A
git commit -m "feat(club): always-present 'Viewing as' identity bar; retire SigningUpAs"
```

---

## Task 5: Guest-resources strip

**Files:**
- Create: `src/components/club/guest-resources.tsx`
- Test: `src/components/club/guest-resources.test.tsx`
- Modify (wire in): `src/routes/club.$clubId.index.tsx`, `src/routes/club.$clubId.meeting.$meetingId.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/club/guest-resources.test.tsx`:

```tsx
// @vitest-environment jsdom
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GuestResources } from "./guest-resources";

afterEach(cleanup);

// GuestResources renders <Link>s, so mount it under a minimal router — mirrors
// the pattern in onboarding-checklist.test.tsx.
async function renderGuestResources() {
	const rootRoute = createRootRoute({ component: () => <GuestResources /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("GuestResources", () => {
	it("links to the three guest-relevant resources", async () => {
		await renderGuestResources();
		expect(screen.getByText(/what to expect/i)).toBeTruthy();
		expect(screen.getByText(/first-time guest faq/i)).toBeTruthy();
		expect(screen.getByText(/meeting roles/i)).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bunx vitest run src/components/club/guest-resources.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `GuestResources`**

Create `src/components/club/guest-resources.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

/** Slugs live in `src/data/resources.ts` — these three are the guest-facing ones. */
const GUEST_LINKS: { slug: string; label: string }[] = [
	{ slug: "what-to-expect", label: "What to expect" },
	{ slug: "guest-faq", label: "First-time guest FAQ" },
	{ slug: "meeting-roles", label: "Meeting roles" },
];

/**
 * Compact "New to Toastmasters?" strip shown on both public club surfaces (spec
 * decision #4). Generic content — no coupling to club/meeting data.
 */
export function GuestResources() {
	return (
		<section className="rounded-xl border border-[var(--line)] bg-card p-4">
			<p className="text-sm font-semibold text-foreground">
				New to Toastmasters?
			</p>
			<ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
				{GUEST_LINKS.map((r) => (
					<li key={r.slug}>
						<Link
							to="/resources/$slug"
							params={{ slug: r.slug }}
							className="inline-flex items-center gap-1 text-sm font-medium text-[var(--lagoon-deep)] no-underline hover:underline"
						>
							{r.label}
							<ArrowRight className="size-3.5" aria-hidden />
						</Link>
					</li>
				))}
			</ul>
		</section>
	);
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `bunx vitest run src/components/club/guest-resources.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into the season grid (replace the ad-hoc link)**

In `src/routes/club.$clubId.index.tsx`:
- Add `import { GuestResources } from "#/components/club/guest-resources";`.
- Replace the ad-hoc `<Link to="/resources/$slug" …>New to Toastmasters? See what to expect…</Link>` block (lines 105-111) with `<GuestResources />`.

- [ ] **Step 6: Wire into the meeting agenda page**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`:
- Add `import { GuestResources } from "#/components/club/guest-resources";`.
- Add `<GuestResources />` just after the closing `</header>` (line 363), before `<MeetingAgenda … />`.

- [ ] **Step 7: Typecheck + tests + commit**

Run: `bun run typecheck && bunx vitest run src/components/club/guest-resources.test.tsx`
Expected: PASS.

```bash
git add -A
git commit -m "feat(club): guest-resources strip on public season grid + meeting agenda"
```

---

## Task 6: Season-grid prospective claim + "Your upcoming roles" guest state

**Files:**
- Modify: `src/components/club/grid-cell.tsx`
- Modify: `src/components/club/season-grid.tsx`
- Modify: `src/routes/club.$clubId.index.tsx`
- Test: `src/components/club/grid-cell.test.tsx` (new)

Today an open cell only shows "Claim" when `currentMemberId` is set (`grid-cell.tsx:64`). For a prospective visitor we render "Claim" and resolve identity on click via a new optional `onClaimIntent` seam. The `SeasonGrid` gets a `requireIdentity` prop and its `claim` handler resolves identity.

- [ ] **Step 1: Write a failing grid-cell test (prospective claim renders + fires intent)**

Create `src/components/club/grid-cell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewCell } from "#/lib/season-grid-view";
import { GridCell } from "./grid-cell";

afterEach(cleanup);

// ViewCell shape verified against src/lib/season-grid-view.ts (all six fields).
const openCell: ViewCell = {
	meetingId: "meeting-1",
	kind: "open",
	text: "Timer",
	title: "Timer",
	slotId: "slot-1",
	memberId: null,
};

describe("GridCell prospective claim", () => {
	// The claim branch of GridCell returns a plain <button> (no <Link>), so no
	// router harness is needed — render it directly.
	it("shows Claim and fires onClaim even with no identity", async () => {
		const onClaim = vi.fn();
		render(
			<GridCell
				cell={openCell}
				currentMemberId={null}
				prospectiveClaim
				onClaim={onClaim}
			/>,
		);
		const btn = await screen.findByRole("button", { name: /claim/i });
		await userEvent.click(btn);
		expect(onClaim).toHaveBeenCalledWith("slot-1");
	});
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bunx vitest run src/components/club/grid-cell.test.tsx`
Expected: FAIL — `prospectiveClaim` prop doesn't exist; claim not rendered for null id.

- [ ] **Step 3: Add the prospective path to `GridCell`**

In `src/components/club/grid-cell.tsx`:
- Add a prop `prospectiveClaim?: boolean;` to the component's props type (near `currentMemberId`), documented:
  `/** Public read-only surface: show "Claim" on OPEN cells even with no identity — the caller resolves identity on click (spec: read-only-by-default). */`
- Change the `isClaimable` derivation (line 69) from:
  `const isClaimable = interactive && cell.kind === "open";`
  to:
  `const isClaimable = (interactive || prospectiveClaim) && cell.kind === "open";`
- The claim button block already guards `onClaim && cell.slotId` (line 112) and calls `onClaim(slotId)` — no change needed there; it now also fires for the prospective case.

- [ ] **Step 4: Thread `requireIdentity` through `SeasonGrid`**

In `src/components/club/season-grid.tsx`:
- Add a prop `requireIdentity?: () => Promise<import("#/lib/member-identity").StoredMember | null>;` to the `SeasonGrid` props (documented: "Public surface: resolve/collect identity before a claim when there's no `currentMemberId`.").
- Change the `claim` handler (lines 109-129) to resolve identity first:

```ts
	async function claim(slotId: string) {
		let memberId = currentMemberId;
		if (!memberId && requireIdentity) {
			const me = await requireIdentity();
			if (!me) return;
			memberId = me.id;
		}
		if (!memberId) return;
		setBusySlotId(slotId);
		try {
			await claimSlot({
				data: { slotId, memberId, actorMemberId: memberId },
			});
			await onChanged?.();
			toast.success("Role claimed.", {
				action: { label: "Undo", onClick: () => release(slotId) },
			});
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Couldn't claim role.");
		} finally {
			setBusySlotId(null);
		}
	}
```

- Compute a prospective flag and pass it + a claim-enabled `GridCell`. The claim cells currently only render when `actingMemberId` is set via `currentMemberId={actingMemberId}` on `GridCell` (line 608). Change the roles-orientation cell so open cells are claimable when either identity or `requireIdentity` exists:
  - Near line 96, after `const actingMemberId = …`, add:
    `const prospectiveClaim = orientation === "roles" && !currentMemberId && !!requireIdentity;`
  - On the `<GridCell … />` at lines 606-620, add the prop `prospectiveClaim={prospectiveClaim}`.

- [ ] **Step 5: Pass `requireIdentity` from the season-grid page + guest "Your upcoming roles"**

In `src/routes/club.$clubId.index.tsx`:
- Ensure `const { promptIdentity } = useRequireIdentity();` (added in Task 4) also destructures `requireIdentity`:
  `const { requireIdentity, promptIdentity } = useRequireIdentity();`
- Pass it to `<SeasonGrid … requireIdentity={requireIdentity} />` (add the prop to the existing usage at lines 128-142).
- Fix the "Your upcoming roles" perpetual-loading state for guests. Replace the loading branch (lines 148-158) so a no-identity visitor gets a CTA instead of a spinner:

```tsx
				{!member ? (
					<p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
						Claim a role in the sheet above to see it here.
					</p>
				) : commitments.isPending ? (
					<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
						<span className="flex items-center gap-2">
							<Loader2 className="size-4 animate-spin" aria-hidden />
							Loading your roles…
						</span>
					</div>
				) : commitments.data && commitments.data.length > 0 ? (
```

  (This replaces the `{!member || commitments.isPending ? ( … ) :` head of the ternary at lines 148-159 up to the `commitments.data && …` branch. Keep the rest of the ternary — the roles list and the empty state — unchanged.)

- [ ] **Step 6: Run tests + typecheck**

Run: `bunx vitest run src/components/club/grid-cell.test.tsx && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(club): prospective claim on the public sign-up grid; guest 'your roles' state"
```

---

## Task 7: Meeting-agenda prospective claim + identity-gated actions

**Files:**
- Modify: `src/components/agenda/meeting-agenda.tsx`
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx`

The agenda re-guards claim on a non-null id (`meeting-agenda.tsx:160`). Decouple that so claim renders for a prospective visitor, and resolve identity at the claim click (identify-first ordering) via a new optional `requireIdentity` prop. The page's `actions` and `toggleAvailability` also resolve identity, so the collected id is always fresh (no stale-closure risk).

- [ ] **Step 1: Add `requireIdentity` prop + prospective claim to the agenda**

In `src/components/agenda/meeting-agenda.tsx`:
- Add to `MeetingAgendaProps` (the props type; near the other optional props) :
  `/** Public surface: resolve/collect identity before opening the claim flow when there's no identity. */`
  `requireIdentity?: () => Promise<import("#/lib/member-identity").StoredMember | null>;`
  and destructure `requireIdentity` in the component signature (add it to the destructured props around lines 150-153).
- Change line 160 from:
  `const canClaim = currentMemberId !== null && viewer.canClaim;`
  to:
  `const canClaim = viewer.canClaim;`
- Add a claim-click handler that resolves identity first. Immediately after the `run(...)` helper (after line 202), add:

```ts
	async function handleClaimClick(slot: AgendaSlot) {
		if (slot.status !== "open" || !canClaim) return;
		if (currentMemberId === null && requireIdentity) {
			const me = await requireIdentity();
			if (!me) return; // dismissed → abort
		}
		setClaimSlotState(slot);
	}
```

- Replace the two open-slot click handlers to use it:
  - Line 420-421: `onClick={() => { if (isOpen && canClaim) setClaimSlotState(slot); }}` → `onClick={() => handleClaimClick(slot)}`
  - Line 569: `onClick={() => canClaim && setClaimSlotState(slot)}` → `onClick={() => handleClaimClick(slot)}`

(The `ClaimSheet` itself needs no change: it never displays the claimer identity, and its internal `canClaim` guard now passes for prospective visitors — the real identity is resolved by the click handler and re-confirmed by `actions.claim` in Step 2.)

- [ ] **Step 2: Make the page actions + availability resolve identity**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`:
- Add `import { useRequireIdentity } from "#/components/club/identity-gate";` (if not already added in Task 4) and, inside `MeetingView`, `const { requireIdentity } = useRequireIdentity();` (alongside the `promptIdentity` from Task 4 — destructure both: `const { requireIdentity, promptIdentity } = useRequireIdentity();`).
- Replace `toggleAvailability` (lines 204-228) so it resolves identity first:

```ts
	async function toggleAvailability() {
		const me = await requireIdentity();
		if (!me) return;
		setAvailBusy(true);
		try {
			if (isUnavailable) {
				await clearAvailability({
					data: { memberId: me.id, meetingId, clubId: clubUuid },
				});
				toast.success("You're marked as available again.");
			} else {
				await setAvailability({
					data: { memberId: me.id, meetingId, clubId: clubUuid },
				});
				toast.success("Got it — you can't make this one.");
			}
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setAvailBusy(false);
		}
	}
```

  > Note `isUnavailable` is derived from `myId` (line 172). For a prospective visitor `myId` is null so `isUnavailable` is false — the button reads "I can't make this one", resolves identity, then marks unavailable. After the pick, a re-render recomputes `isUnavailable` correctly. This is acceptable (worst case: the label lags one interaction).

- Replace the `actions` object's identity guards (lines 232-269) with the `requireIdentity`-first pattern. Each handler resolves a fresh id:

```ts
	const actions: MeetingAgendaActions = {
		claim: async (slot, speakerDetails) => {
			const me = await requireIdentity();
			if (!me) return;
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: me.id,
					actorMemberId: me.id,
					speakerDetails,
				},
			});
		},
		release: async (slot) => {
			const me = await requireIdentity();
			if (!me) return;
			await releaseSlot({ data: { slotId: slot.id, actorMemberId: me.id } });
		},
		takeover: async (slot) => {
			const me = await requireIdentity();
			if (!me) return;
			await reassignSlot({
				data: { slotId: slot.id, memberId: me.id, actorMemberId: me.id },
			});
		},
		addSpeaker: async () => {
			const me = await requireIdentity();
			if (!me) return;
			await addSpeakerSlot({
				data: { meetingId, actorMemberId: me.id, selfMemberId: me.id },
			});
			toast.success("Speaker added.");
		},
		removeSpeaker: async () => {
			const me = await requireIdentity();
			if (!me) return;
			await removeSpeakerSlot({
				data: { meetingId, actorMemberId: me.id, selfMemberId: me.id },
			});
			toast.success("Speaker removed.");
		},
		onMutated: () => router.invalidate(),
	};
```

- Pass the prop to `<MeetingAgenda … requireIdentity={requireIdentity} />` (add to the existing usage at lines 365-383).

- [ ] **Step 3: Typecheck + agenda tests**

Run: `bun run typecheck && bunx vitest run src/components/agenda/meeting-agenda.test.tsx`
Expected: PASS. (The existing agenda tests pass an authed viewer with a real id, so `handleClaimClick` short-circuits `requireIdentity` — behavior unchanged for them.)

- [ ] **Step 4: Extend the agenda test harness + flip the null-identity test**

In `src/components/agenda/meeting-agenda.test.tsx`:

1. Add the userEvent import at the top (the file currently imports only `cleanup, render, screen`):

```ts
import userEvent from "@testing-library/user-event";
```

2. Extend the `renderAgenda` helper to forward a `requireIdentity`. Change its signature (around line 56) and add the prop to the `<MeetingAgenda … />` it renders:

```ts
function renderAgenda(
	viewer: ReturnType<typeof meetingViewer>,
	slots: AgendaSlot[],
	pairedRoleIds?: Set<string>,
	requireIdentity?: () => Promise<{ id: string; name: string } | null>,
) {
```

   and add `requireIdentity={requireIdentity}` alongside the other props (e.g. after `onMetaSaved={() => {}}`).

3. Replace the existing test **"gives a visitor with no name a read-only agenda (claim disabled)"** (lines 169-183) — the inverted model makes Claim *enabled* for a no-name visitor, resolving identity on click:

```tsx
	it("gives a visitor with no name an enabled Claim that resolves identity on click", async () => {
		const requireIdentity = vi.fn(async () => null); // dismissed → aborts
		renderAgenda(
			meetingViewer({
				currentMemberId: null,
				canManage: false,
				isTmod: false,
				isGrammarian: false,
				isEditableWindow: true,
			}),
			[slot({ status: "open" })],
			undefined,
			requireIdentity,
		);
		const claim = screen.getByRole("button", { name: /^Claim / });
		expect((claim as HTMLButtonElement).disabled).toBe(false);
		await userEvent.click(claim);
		expect(requireIdentity).toHaveBeenCalled();
		// Still no manager assign picker for an anonymous visitor.
		expect(screen.queryByRole("button", { name: /Assign/ })).toBeNull();
	});
```

- [ ] **Step 5: Run the agenda tests + commit**

Run: `bunx vitest run src/components/agenda/meeting-agenda.test.tsx && bun run typecheck`
Expected: PASS. (The locked-viewer "open slots can't be claimed" test still passes — `lockedViewer` zeroes `canClaim`, so the button stays disabled there.)

```bash
git add -A
git commit -m "feat(agenda): prospective claim + requireIdentity-gated actions on the public meeting view"
```

---

## Task 8: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Type-check the whole project**

Run: `bun run typecheck`
Expected: PASS (the only real type gate — build/test transpile without checking).

- [ ] **Step 2: Lint/format gate**

Run: `bun run check`
Expected: PASS. Fix any Biome findings (tabs, double quotes, import order) it reports.

- [ ] **Step 3: Full unit/component test run**

Run: `bunx vitest run src/lib src/components src/routes`
Expected: PASS. (These suites are pure/jsdom; no DB needed. The DB-backed `src/server/*.integration.test.ts` suites are unaffected by this change — the claim/release/reassign server fns are untouched — but if you run them, set `TEST_DATABASE_URL` per the repo's testing notes.)

- [ ] **Step 4: Manual smoke checklist (record results in the PR description)**

Start `bun run dev` and, as an **anonymous** visitor (no localStorage identity, e.g. a fresh private window):
- [ ] `/club/:slug` renders the sign-up sheet with **no** "Who are you?" gate; a "Viewing as guest · I'm a member →" bar is present; the guest-resources strip shows.
- [ ] Tapping an **open** role cell opens the name-pick dialog; picking a name completes the claim; identity persists (bar now says "Signing up as …").
- [ ] `/club/:slug/meeting/:id` renders read-only; open slots show "Claim"; **filled slots show no "take over"** (anon path); tapping Claim → dialog → claim completes.
- [ ] Dismissing the dialog (Escape) fires nothing.
- [ ] View source / devtools: the page `<head>` contains `<meta name="robots" content="noindex, nofollow">`; `/resources` does **not**.
- [ ] "I'm a member →" opens the dialog without needing a claim (TMOD/Grammarian entry point); identifying as the TMOD reveals the assign/edit affordances.

- [ ] **Step 5: Update the memory note (optional but recommended)**

If keeping session memory current, update `signed-in-member-parity.md` / add a note that the public `/club/:clubId` subtree is now read-only-by-default with identity-gated participation, take-over is signed-in-only, and the routes carry `noindex`.

---

## Cross-cutting notes

- **No server/DB changes.** Every mutation still goes through the existing member-keyed server fns. If a step tempts you to touch `src/server/*`, stop — it's out of scope (the one exception, `addMember` rate-limiting, is deferred to issue #326).
- **`requireIdentity` is the single seam.** Never read `currentMemberId`/`myId` from a closure to build a mutation payload on the public surface — always `const me = await requireIdentity(); if (!me) return;`. This is what makes the collected id fresh after an inline pick.
- **Biome:** tabs, double quotes, organized imports. Run `bun run check` before each commit if unsure.
- **Retirements:** after Tasks 3 & 4, `grep -rn "RequireMember\|SigningUpAs\|signing-up-as\|require-member" src` must print nothing.
</content>
