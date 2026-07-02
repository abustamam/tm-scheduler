# Light-touch GavelUp Branding for Public Club Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the logged-out club surface (name picker, home, meeting) light-touch GavelUp branding — a shared brand mark in a slim shell header plus Fraunces (`font-display`) headings — matching the authed workspace.

**Architecture:** Extract the currently-private `GavelGlyph` SVG from `_authed.tsx` into a shared `src/components/brand-mark.tsx` (exporting `GavelGlyph` + a `BrandMark` wrapper). Both the authed sidebar and a new slim header in the club shell (`club.$clubId.tsx`) consume it. Three public `h1`s switch from `font-bold` to `font-display font-semibold`. No server/data-model changes.

**Tech Stack:** TanStack Start (React 19), file-based routing, Tailwind CSS v4 (config-less), Vitest + @testing-library/react (jsdom via per-file pragma), Biome.

**Spec:** `docs/superpowers/specs/2026-07-02-public-club-brand-design.md`

**Working directory:** worktree `tm-scheduler-73-public-brand` (branch `73-public-brand`). Run `bun install` once in the worktree before starting if `node_modules` is absent.

---

## File Structure

- **Create:** `src/components/brand-mark.tsx` — shared `GavelGlyph` SVG + `BrandMark` (chip + glyph + Fraunces wordmark, `size` and optional `subtitle`). Single responsibility: render the GavelUp mark.
- **Create:** `src/components/brand-mark.test.tsx` — unit test for `BrandMark` render contract (jsdom).
- **Modify:** `src/routes/_authed.tsx` — replace the inline brand block + private `GavelGlyph` with `<BrandMark size="md" subtitle=… />`.
- **Modify:** `src/routes/club.$clubId.tsx` — expose `clubName`/`clubNumber` in route context; add slim brand header above `<RequireMember>`.
- **Modify:** `src/routes/club.$clubId.index.tsx` — serif the "Hi {name}" `h1`.
- **Modify:** `src/routes/club.$clubId.meeting.$meetingId.tsx` — serif the meeting-theme `h1`.
- **Modify:** `src/components/club/require-member.tsx` — serif the "Who are you?" `h1`.

---

## Task 1: Shared `BrandMark` component

Extract the gavel glyph and wordmark into one reusable component so the authed
sidebar and the public shell render an identical mark. The `md` size must
reproduce the current authed sidebar markup so Task 2's refactor is a no-op
visually.

**Files:**
- Create: `src/components/brand-mark.tsx`
- Test: `src/components/brand-mark.test.tsx`

- [ ] **Step 1: Write the failing test**

`src/components/brand-mark.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

describe("BrandMark", () => {
	it("renders the GavelUp wordmark and accessible glyph title", () => {
		render(<BrandMark />);
		expect(screen.getByText("GavelUp")).toBeInTheDocument();
		// The glyph SVG carries a <title>GavelUp</title> for a11y.
		expect(screen.getByTitle("GavelUp")).toBeInTheDocument();
	});

	it("renders a subtitle when provided", () => {
		render(<BrandMark subtitle="Acme Club · Club 1492" />);
		expect(screen.getByText("Acme Club · Club 1492")).toBeInTheDocument();
	});

	it("omits the subtitle line when not provided", () => {
		render(<BrandMark />);
		expect(screen.queryByText(/Club 1492/)).not.toBeInTheDocument();
	});
});
```

Note: `toBeInTheDocument` comes from `@testing-library/jest-dom`, which is **not**
a dependency here. Use plain assertions instead — rewrite the matchers as shown
in Step 3's test-run expectation. Concretely, replace each
`expect(x).toBeInTheDocument()` with `expect(x).toBeTruthy()` and each
`expect(x).not.toBeInTheDocument()` with `expect(x).toBeNull()` (using
`screen.queryByText` which returns `null` when absent). Final test body:

```tsx
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

describe("BrandMark", () => {
	it("renders the GavelUp wordmark and accessible glyph title", () => {
		render(<BrandMark />);
		expect(screen.getByText("GavelUp")).toBeTruthy();
		expect(screen.getByTitle("GavelUp")).toBeTruthy();
	});

	it("renders a subtitle when provided", () => {
		render(<BrandMark subtitle="Acme Club · Club 1492" />);
		expect(screen.getByText("Acme Club · Club 1492")).toBeTruthy();
	});

	it("omits the subtitle line when not provided", () => {
		render(<BrandMark />);
		expect(screen.queryByText(/Club 1492/)).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../tm-scheduler-73-public-brand && bunx vitest run src/components/brand-mark.test.tsx`
Expected: FAIL — `Failed to resolve import "./brand-mark"` (module does not exist yet).

- [ ] **Step 3: Write the component**

`src/components/brand-mark.tsx`:

```tsx
/**
 * The GavelUp brand mark: a stroke-based gavel glyph in a gradient chip, next to
 * the "GavelUp" wordmark in the Fraunces display face. Shared by the authed
 * sidebar (`_authed.tsx`) and the public club shell (`club.$clubId.tsx`).
 */

/** The raw gavel SVG. Sized by the caller via width/height. */
export function GavelGlyph({ size = 20 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="#fff"
			strokeWidth="2.1"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<title>GavelUp</title>
			<path d="M3 21h9" />
			<path d="m13.5 6.5-7 7" />
			<rect
				x="11.5"
				y="2.6"
				width="6"
				height="3.4"
				rx="1.2"
				transform="rotate(45 14.5 4.3)"
			/>
			<rect
				x="16.2"
				y="7.3"
				width="6"
				height="3.4"
				rx="1.2"
				transform="rotate(45 19.2 9)"
			/>
		</svg>
	);
}

type BrandMarkSize = "sm" | "md";

const SIZES: Record<
	BrandMarkSize,
	{ chip: string; glyph: number; wordmark: string }
> = {
	// `md` reproduces the authed sidebar mark byte-for-byte.
	md: {
		chip: "size-[38px] rounded-[11px]",
		glyph: 20,
		wordmark: "text-[19px]",
	},
	// `sm` is a slightly smaller variant for the public shell header.
	sm: {
		chip: "size-[30px] rounded-[9px]",
		glyph: 16,
		wordmark: "text-[16px]",
	},
};

export function BrandMark({
	size = "md",
	subtitle,
}: {
	size?: BrandMarkSize;
	subtitle?: React.ReactNode;
}) {
	const s = SIZES[size];
	return (
		<div className="flex items-center gap-[11px]">
			<span
				className={`flex shrink-0 items-center justify-center bg-[linear-gradient(150deg,var(--lagoon),var(--lagoon-deep))] shadow-[0_4px_12px_rgba(50,143,151,.35),0_1px_0_rgba(255,255,255,.4)_inset] ${s.chip}`}
			>
				<GavelGlyph size={s.glyph} />
			</span>
			<div className="leading-[1.05]">
				<div
					className={`font-display font-semibold tracking-[-0.01em] ${s.wordmark}`}
				>
					GavelUp
				</div>
				{subtitle ? (
					<div className="mt-0.5 truncate text-[11px] font-semibold tracking-[0.04em] text-[var(--sea-ink-soft)] uppercase">
						{subtitle}
					</div>
				) : null}
			</div>
		</div>
	);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ../tm-scheduler-73-public-brand && bunx vitest run src/components/brand-mark.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ../tm-scheduler-73-public-brand
git add src/components/brand-mark.tsx src/components/brand-mark.test.tsx
git commit -m "feat(brand): shared BrandMark component (#73)"
```

---

## Task 2: Refactor authed sidebar to consume `BrandMark`

Replace the inline brand block in the authed sidebar with the shared component
and delete the now-duplicated private `GavelGlyph`. The rendered sidebar must
look unchanged.

**Files:**
- Modify: `src/routes/_authed.tsx` (brand block ~lines 86-99; private `GavelGlyph` ~lines 208-242)

- [ ] **Step 1: Add the import**

At the top of `src/routes/_authed.tsx`, add to the existing import group (keep
Biome's import ordering — it will reorder on `bun run check`):

```tsx
import { BrandMark } from "#/components/brand-mark";
```

- [ ] **Step 2: Replace the inline brand block**

Find this block (around lines 86-99):

```tsx
				{/* Brand */}
				<div className="flex items-center gap-[11px] px-2 pt-1.5 pb-4">
					<span className="flex size-[38px] shrink-0 items-center justify-center rounded-[11px] bg-[linear-gradient(150deg,var(--lagoon),var(--lagoon-deep))] shadow-[0_4px_12px_rgba(50,143,151,.35),0_1px_0_rgba(255,255,255,.4)_inset]">
						<GavelGlyph />
					</span>
					<div className="leading-[1.05]">
						<div className="font-display text-[19px] font-semibold tracking-[-0.01em]">
							GavelUp
						</div>
						<div className="mt-0.5 truncate text-[11px] font-semibold tracking-[0.04em] text-[var(--sea-ink-soft)] uppercase">
							{clubName} · Club 1492
						</div>
					</div>
				</div>
```

Replace it with:

```tsx
				{/* Brand */}
				<div className="px-2 pt-1.5 pb-4">
					<BrandMark size="md" subtitle={`${clubName} · Club 1492`} />
				</div>
```

- [ ] **Step 3: Delete the now-unused private `GavelGlyph`**

Remove the entire `function GavelGlyph() { … }` definition (around lines 208-242).
`BrandMark` now owns the glyph. (TS strict fails the build on an unused function,
so this deletion is required, not optional.)

- [ ] **Step 4: Verify typecheck + lint pass**

Run: `cd ../tm-scheduler-73-public-brand && bunx tsc --noEmit && bun run check`
Expected: no type errors; Biome reports no errors (it may auto-order the new import — that's fine).

- [ ] **Step 5: Verify the authed sidebar renders unchanged**

Run the dev server and confirm the sidebar brand block looks identical to before
(38px gradient chip, "GavelUp" in Fraunces, club-name caption beneath).
Use the `/browse` skill:

```
bun run dev   # (in the worktree; stop after)
```
Navigate to an authed page (sign in via `/api/dev-login` if `ENABLE_DEV_LOGIN=1`) and eyeball the sidebar. Expected: no visible change.

- [ ] **Step 6: Commit**

```bash
cd ../tm-scheduler-73-public-brand
git add src/routes/_authed.tsx
git commit -m "refactor(brand): authed sidebar consumes shared BrandMark (#73)"
```

---

## Task 3: Slim brand header in the public club shell

Expose the club name/number in route context, then render a slim brand header
above the member gate so it appears on all three public screens.

**Files:**
- Modify: `src/routes/club.$clubId.tsx`

- [ ] **Step 1: Expose club name + number in route context**

In `src/routes/club.$clubId.tsx`, update `beforeLoad`'s return (currently returns
only `clubUuid`/`clubSlug`). The resolved `club` already carries `name` and
`clubNumber` (from `getClubByIdentifier`):

```tsx
	beforeLoad: async ({ params, location }) => {
		const club = await resolveClubOrRedirect(params.clubId, location);
		return {
			clubUuid: club.id,
			clubSlug: club.slug,
			clubName: club.name,
			clubNumber: club.clubNumber,
		};
	},
```

- [ ] **Step 2: Add the header import**

Add to the imports at the top of the file:

```tsx
import { BrandMark } from "#/components/brand-mark";
```

- [ ] **Step 3: Render the slim brand header**

Update `ClubShell` to read the new context and render the header above
`<RequireMember>`:

```tsx
function ClubShell() {
	const { clubId } = Route.useParams();
	const { clubUuid, clubName, clubNumber } = Route.useRouteContext();
	return (
		<div className="mx-auto flex min-h-svh w-full max-w-md flex-col bg-background">
			<header className="flex items-center justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
				<BrandMark size="sm" />
				<span className="truncate text-right text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
					{clubNumber ? `${clubName} · Club ${clubNumber}` : clubName}
				</span>
			</header>
			<RequireMember clubUuid={clubUuid} clubSlug={clubId}>
				<Outlet />
			</RequireMember>
			<Toaster position="top-center" />
		</div>
	);
}
```

- [ ] **Step 4: Verify typecheck + lint pass**

Run: `cd ../tm-scheduler-73-public-brand && bunx tsc --noEmit && bun run check`
Expected: no type errors; Biome clean.

- [ ] **Step 5: Commit**

```bash
cd ../tm-scheduler-73-public-brand
git add src/routes/club.\$clubId.tsx
git commit -m "feat(brand): slim GavelUp header on public club shell (#73)"
```

---

## Task 4: Serif the three public headings

Switch the three main public `h1`s from `font-bold` sans to the `font-display`
serif idiom used by authed page headings.

**Files:**
- Modify: `src/routes/club.$clubId.index.tsx` (~line 55)
- Modify: `src/routes/club.$clubId.meeting.$meetingId.tsx` (~line 209)
- Modify: `src/components/club/require-member.tsx` (`PickNameScreen` `h1`)

- [ ] **Step 1: Club home heading**

In `src/routes/club.$clubId.index.tsx`, change the `h1` (currently
`className="text-2xl font-bold tracking-tight"`) to:

```tsx
					<h1 className="font-display text-2xl font-semibold tracking-tight">
						Hi {member?.name ?? "there"} 👋
					</h1>
```

- [ ] **Step 2: Meeting heading**

In `src/routes/club.$clubId.meeting.$meetingId.tsx`, change the `h1` (currently
`className="text-2xl font-bold tracking-tight"`) to:

```tsx
					<h1 className="font-display text-2xl font-semibold tracking-tight">
						{meeting.theme ?? "Meeting"}
					</h1>
```

- [ ] **Step 3: "Who are you?" heading**

In `src/components/club/require-member.tsx`, the `PickNameScreen` `h1` is
currently `className="font-bold text-2xl text-foreground"`. Change to:

```tsx
				<h1 className="font-display text-2xl font-semibold text-foreground">
					Who are you?
				</h1>
```

- [ ] **Step 4: Verify typecheck + lint pass**

Run: `cd ../tm-scheduler-73-public-brand && bunx tsc --noEmit && bun run check`
Expected: no type errors; Biome clean.

- [ ] **Step 5: Commit**

```bash
cd ../tm-scheduler-73-public-brand
git add src/routes/club.\$clubId.index.tsx "src/routes/club.\$clubId.meeting.\$meetingId.tsx" src/components/club/require-member.tsx
git commit -m "feat(brand): serif headings on public club pages (#73)"
```

---

## Task 5: Full verification pass

Confirm the whole change is green and visually correct end-to-end.

**Files:** none (verification only)

- [ ] **Step 1: Full gate**

Run: `cd ../tm-scheduler-73-public-brand && bun run check && bunx tsc --noEmit && bun run test`
Expected: Biome clean, no type errors, all tests pass (including `server-modules.guard.test.ts` and the new `brand-mark.test.tsx`).

- [ ] **Step 2: Visual check via /browse**

Start the dev server (`bun run dev` in the worktree) and, using the `/browse`
skill, verify against a real club URL (`/club/<slug>`):

1. **Name picker** ("Who are you?") — slim header with mark + club caption at top; "Who are you?" heading in Fraunces serif.
2. Pick a name → **home** ("Hi {name} 👋") — header present; heading serif.
3. Open a meeting → **meeting agenda** — header present; theme heading serif.
4. Sanity: the authed sidebar (sign in) still looks unchanged.

Expected: brand mark + serif headings on all three public screens; no layout breakage in the `max-w-md` column; dark mode still legible (toggle if available).

- [ ] **Step 3: Final state**

No commit needed if steps 1-2 pass with no fixes. If fixes were required, commit
them with a `fix(brand): …` message. The branch `73-public-brand` is now ready
for a PR closing #73.

---

## Self-Review Notes

- **Spec coverage:** BrandMark extraction (Task 1) ✓; authed refactor to shared mark (Task 2) ✓; slim shell header with club caption (Task 3) ✓; three serif headings (Task 4) ✓; testing/verification incl. guard test + browse (Task 5) ✓. Out-of-scope items (print route, not-found screens, colors) are untouched. ✓
- **Type consistency:** `BrandMark` props (`size`, `subtitle`) and `GavelGlyph` prop (`size`) are used identically across Tasks 1-3. Context keys `clubName`/`clubNumber` defined in Task 3 Step 1 and consumed in Step 3. ✓
- **Placeholder scan:** No TBD/TODO; all code shown in full; the `toBeInTheDocument` gotcha is resolved inline in Task 1 Step 1. ✓
