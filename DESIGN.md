---
# gstack: design-md-format=spec
name: GavelUp
description: Calm coastal teal and palm green on foam; a fast, legible tool for claiming a meeting role from a phone.
colors:
  primary: "#246f76"          # --lagoon-ink; dark: #60d7cf (--lagoon)
  on-primary: "#ffffff"       # dark: #0a1418
  background: "#f3faf5"       # --foam; dark: #0a1418
  surface: "#ffffff"          # --card; dark: #101d22
  muted-surface: "#e7f0e8"    # --sand; dark: #1c3238
  text: "#173a40"             # --sea-ink; dark: #d7ece8
  text-muted: "#416166"       # --sea-ink-soft; dark: #afcdc8
  border: "rgba(23, 58, 64, 0.14)"   # dark: rgba(141, 229, 219, 0.18)
  status-open: "#d99a2e"      # --warning; dark: #e0b357
  status-open-text: "#8f640c" # --warning-foreground, 5.3:1 on white; dark: #e6c98a
  status-open-surface: "#fdf3e7"     # dark: rgba(224, 179, 87, 0.14)
  status-filled: "#2f6a4a"    # --palm; dark: #6ec89a
  on-status-filled: "#ffffff" # dark: #0a1418
  status-filled-ring: "#1e4a33"      # dark: #2f6a4a
  status-taken-surface: "rgba(47, 106, 74, 0.12)"  # dark: rgba(110, 200, 154, 0.14)
  error: "oklch(0.505 0.213 27.518)" # dark: oklch(0.704 0.191 22.216)
  on-accent-fill: "#0a1418"
typography:
  display:
    fontFamily: Fraunces
    fontWeight: 600
    fontSize: clamp(1.875rem, 1.4rem + 2vw, 2.5rem)
    lineHeight: 1.1
    letterSpacing: -0.02em
  heading:
    fontFamily: Fraunces
    fontWeight: 600
    fontSize: 1.5rem
    lineHeight: 1.25
    letterSpacing: -0.02em
  title:
    fontFamily: Manrope
    fontWeight: 600
    fontSize: 1.25rem
    lineHeight: 1.35
  body:
    fontFamily: Manrope
    fontWeight: 400
    fontSize: 1rem
    lineHeight: 1.55
  small:
    fontFamily: Manrope
    fontWeight: 400
    fontSize: 0.875rem
    lineHeight: 1.45
  label:
    fontFamily: Manrope
    fontWeight: 600
    fontSize: 0.75rem
    lineHeight: 1.4
  numeric:
    fontFamily: Manrope
    fontFeature: tnum
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.lg}"
  grid-cell-claim:
    backgroundColor: "{colors.status-open-surface}"
    borderColor: "{colors.status-open}"
    textColor: "{colors.status-open-text}"
    rounded: "{rounded.md}"
  grid-cell-open:
    borderColor: "{colors.status-open}"
    textColor: "{colors.status-open-text}"
    rounded: "{rounded.md}"
  grid-cell-taken:
    backgroundColor: "{colors.status-taken-surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
  grid-cell-mine:
    backgroundColor: "{colors.status-filled}"
    textColor: "{colors.on-status-filled}"
    rounded: "{rounded.md}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.xl}"
---

# GavelUp

## Overview

**Creative North Star:** a calm coastal palette carrying a fast tool: the one thing a first-time
member remembers is "I saw what's open and claimed it in one tap."
**Product context:** a mobile-first web app for Toastmasters clubs. Members claim meeting roles
from a phone; officers (VPE, admin) run meetings, agendas, print layouts, roll, timer, minutes and
the back office. Replaces a shared spreadsheet; incumbents are Easy-Speak and FreeToastHost.
**Mode per surface:**
- Operate: sign-up grid, meeting page, roll, timer, officer consoles (most of the app).
- Persuade: home, /tour, /districts.
- Read: resources articles (`.prose-gavelup`).
- Print: agendas, table tents, role sheets (own rules in `PRINT_PAGE_CSS`, outside this scale).
**Key characteristics:**
- What's open is the loudest thing on any scheduling surface.
- One primary action per person per screen.
- Serif page titles, sans everything else.
- Teal for going somewhere, green for filled, amber for needs someone.

## Colors

**Strategy:** Committed. Lagoon teal owns navigation and primary actions; neutrals derive from it
(sea-ink text, sand and foam surfaces). Status colors are semantic, and each hue has one meaning.
**Light or dark:** both, following the system setting. Members check the sheet on a phone at
any hour and officers project in dimly lit rooms; neither scene dominates.

Two layers, and components use only the second:
1. **Brand ramp** (`--sea-ink`, `--lagoon*`, `--palm`, `--sand`, `--foam`, `--warning*`) lives in
   `src/styles.css` only.
2. **Semantic tokens** (`background`, `foreground`, `muted-foreground`, `primary`, `success`,
   `warning`, `destructive`, `border`, and the status tokens) are what components reference.
   `text-[var(--sea-ink-soft)]` in a component is `text-muted-foreground` spelled the long way.

Status hues, everywhere a role slot appears (public grid, signed-in grid, agenda, MCP previews):
- **Amber = open, needs someone.** Read-only: dashed amber border. Actionable: amber surface,
  solid amber border, amber text "Claim".
- **Green = filled.** Someone else's: green-tinted surface, full-strength foreground text.
  Yours: solid green fill plus the `status-filled-ring`.
- **Red = not available, and destructive actions.** Nothing else.
- **Teal = navigation and primary buttons.** Never a status.

Muted text is `muted-foreground` at full strength. No opacity modifiers (`/60`, `/70`) on text:
they drop under AA. Timer card colors (green/yellow/red) are domain colors and get named tokens
rather than hex in components. Chart tokens derive from the brand ramp, not shadcn's defaults.

Dark mode keeps the elevation order background < card < popover < muted, each step a teal-tinted
lift, rather than inverting lightness.

## Typography

Fraunces is the display voice and Manrope the working voice; both are the existing identity.
Fraunces is a very common display choice; it stays because it is GavelUp's, set upright at 600,
on page titles and section headings only, at most one display line per screen. Manrope does
everything a user reads to act.

Scale: six steps on roughly a 1.25 ratio (12, 14, 16, 20, 24, 30-40px). On-screen floor is 12px,
`label` only (legends, counts, metadata). Grid cells, buttons and list rows are `small` (14px).
Body copy is 16px. Arbitrary sizes (`text-[11px]`, `text-[11.5px]`, `text-[10px]`) are retired.
Print layouts are exempt and keep `MIN_FIT_SCALE`.

Weights: Manrope 400, 600, 700; Fraunces 600. Load only those (Google Fonts, `display=swap`).
Times, durations, counts and the timer use `tabular-nums` so digits do not jitter.

## Layout

Containers stay as declared in `src/styles.css`: `workspace` 1180px, `public` 64rem, `reading`
48rem. Phone first: design at 375px, then widen.

Spacing rhythm on the 4px base: 8 or 12px inside a component, 16 or 24px between components,
32 or 48px between sections. No arbitrary spacing values.

Density rules for Operate surfaces:
- The scheduling grid starts within the first screen on a phone. Officer utilities (copy links,
  print) collapse into one Share menu above it; view and count filters share one row.
- The sticky label column is capped at 9rem, left-aligned, truncated with the full name in
  `title`. On a phone the default view is upcoming meetings; past meetings are one tap away.
- A list of navigation items is one grouped list with dividers, not a stack of cards.
- A roster or roll row is one line: name, role chip, status control. Contact actions live in the
  row's menu.

## Elevation & Depth

Depth comes from offset, soft-blur shadows and tinted surfaces, never a zero-offset glow. Cards
sit on `background` with a 1px `border`. Popovers and menus get the one stronger shadow. The
sticky header is the one translucent, blurred layer. No card inside a card.

Background: one lagoon wash at the top-left (`--hero-a`) over `background`. No second halo, no
highlight layer, no grid overlay (R4): the grid and the open roles carry the screen.

## Shapes

`--radius` is 10px (`lg`). Grid cells and inputs `md` (8px), chips `full`, cards and phone-level
panels `xl` (14px). A nested element's radius is its parent's radius minus the gap between them.

## Components

- **Buttons:** primary is solid `primary`; everything else outline or ghost. One primary per
  person per screen: on the meeting page a member's primary is "I'll be there"; an officer's
  Present is the only other prominent action, and the rest live in a Manage menu.
  Member-facing buttons are 44px tall on phones; `xs`/`icon-xs` sizes are for dense officer
  tables on desktop only.
- **Grid cells:** 44px tall below `md`, 32px at `md` and up (#224). States as in Colors. Busy
  state: optimistic fill (see Motion), not a spinner replacing the label.
- **Focus:** `focus-visible` ring, 3px, `ring` at 50%, on every interactive element.
- **Disabled:** 50% opacity plus `pointer-events: none`; never the only signal of state.
- **Empty, loading, error:** every list and grid ships all three. A write error rolls back the
  optimistic state and shows the existing write-error toast.

## Do's and Don'ts

- Do reference semantic tokens in components; keep the brand ramp in `src/styles.css`.
- Do make open roles the most visible element on any scheduling surface.
- Do keep on-screen text at 12px or larger and grid text at 14px.
- Do scope transitions to the properties that change.
- Do give every list its empty, loading and error states.
- Don't use green for anything actionable that isn't yet filled.
- Don't put opacity modifiers on text colors.
- Don't add a ninth equal-weight button; add it to a menu.
- Don't use `transition-all`, or animate layout properties.
- Don't add hex values or raw Tailwind palette colors (`amber-700`, `red-400`) in components.

## Motion

- **Approach:** minimal-functional. Motion confirms a state change; it never decorates.
- **Easing:** enter `cubic-bezier(0.2, 0, 0, 1)` (ease-out), exit `cubic-bezier(0.4, 0, 1, 1)`
  (ease-in), move ease-in-out.
- **Duration:** micro 120ms (hover, press, focus), short 200ms (state change, menu open),
  medium 300ms (sheet and dialog enter). Nothing longer in the app.
- **Reduced motion:** a `prefers-reduced-motion: reduce` block in `src/styles.css` drops
  transitions and animations to near zero.
- **The one authored moment:** the claim. The tapped cell fills from amber outline to solid
  green in 200ms with a check, and the column's "N open" count ticks down, applied optimistically
  and rolled back on error.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-24 | DESIGN.md created as a refinement of the shipped identity | /design-consultation audit of 233 component files and live /schedule and /next at 375px; identity kept, scale, color use, spacing, density and motion tightened |
| 2026-10-24 | Memorable thing: "I saw what's open and claimed it in one tap" | 93% of logged writes are the scheduling loop; first-time viewers are members on phones |
| 2026-10-24 | Amber = open on every surface, including the Claim button (R1) | Open was amber on the public grid and green on the signed-in grid, where green also meant filled |
| 2026-10-24 | Phone grid defaults to upcoming meetings (R2) | Past meetings took the first columns; with a 9rem label column, two upcoming meetings now fit at 375px |
| 2026-10-24 | Optimistic claim fill (R3) | Makes one tap feel like one tap; the write-error toast already handles rollback |
| 2026-10-24 | Fraunces kept as display despite being a common choice | It is the shipped identity; constrained to upright 600 page titles |
| 2026-10-24 | Background cut to one lagoon wash (R4) | The palm halo, bottom wash, `body::before` highlight and `body::after` grid overlay sat behind every Operate screen; the top-left wash alone keeps the identity |
