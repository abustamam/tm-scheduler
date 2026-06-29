# GavelUp UI — conventions for building with this design system

GavelUp is the UI kit for a Toastmasters meeting scheduler. It is a **shadcn/ui (new-york) + Tailwind v4** component set. All components are on `window.GavelUp.*` (loaded from the root `_ds_bundle.js`); import them as `import { Button, Card } from "tm-scheduler"`.

## Setup / wrapping

- **No provider is required for styling.** All design tokens are plain CSS custom properties on `:root` in `styles.css` (which `@import`s `_ds_bundle.css`). A component is styled the moment that stylesheet is on the page.
- **Dark mode:** tokens flip under a `.dark` ancestor. Put `className="dark"` (or `class="dark"`) on a wrapper to render the dark theme; there is no JS theme provider in the bundle.
- **Toasts:** mount `<Toaster />` once near the app root. Toasts are fired imperatively via sonner's `toast(...)` — `toast` is **not** in this bundle, so `import { toast } from "sonner"` separately to trigger them. `Toaster` itself renders nothing until a toast fires (that is why its card is a placeholder).

## Styling idiom — READ THIS

The shipped stylesheet is a **static, pre-compiled Tailwind subset**: it contains only the utility classes these components already use. There is **no Tailwind compiler at design time**, so **new/arbitrary utility classes you add will NOT resolve** (e.g. `mt-8`, `grid-cols-3`, `gap-4` are not guaranteed to exist). Style your own layout one of three safe ways, in order of preference:

1. **Drive components through their props** — `variant` and `size` carry the design language (see each `.d.ts`). Always safe.
2. **Use the design tokens via CSS variables** — `style={{ color: "var(--muted-foreground)", background: "var(--card)" }}`. Always safe.
3. **Inline styles for layout/spacing** — `style={{ display: "flex", gap: 12 }}`. Do not reach for Tailwind utilities for your own glue.

### Token vocabulary (CSS variables, all on `:root`, flipped under `.dark`)

- **Semantic (shadcn):** `--background` / `--foreground`, `--card` / `--card-foreground`, `--popover` / `--popover-foreground`, `--primary` / `--primary-foreground`, `--secondary` / `--secondary-foreground`, `--muted` / `--muted-foreground`, `--accent` / `--accent-foreground`, `--destructive` / `--destructive-foreground`, `--border`, `--input`, `--ring`, `--radius` (`0.625rem`).
- **Brand (Toastmasters palette):** `--lagoon`, `--lagoon-deep`, `--sea-ink`, `--sea-ink-soft`, `--palm`, `--sand`, `--foam`, `--surface`, `--surface-strong`. Components default to the shadcn semantic tokens; use the brand vars for accents/marketing surfaces.
- **Type:** body font is **Manrope** (`var(--font-sans)`); **Fraunces** is the serif display face (`fontFamily: "'Fraunces', Georgia, serif"`). Both load from a remote font host already referenced by the stylesheet.

## Components

Primary components (each has its own `.d.ts` + `.prompt.md`): **Button** (`variant`: default/secondary/outline/ghost/destructive/link; `size`: default/sm/lg/xs/icon…), **Badge** (same variants), **Input**, **Label**, **Card**, **Dialog**, **Sheet**, **Toaster**.

Compound components expose named parts (all on `window.GavelUp.*`) — compose them, don't rebuild them:

- **Card:** `Card` › `CardHeader` (`CardTitle`, `CardDescription`, `CardAction`) › `CardContent` › `CardFooter`.
- **Dialog:** `Dialog` › `DialogTrigger` + `DialogContent` (`DialogHeader` › `DialogTitle`/`DialogDescription`, `DialogFooter`, `DialogClose`). `DialogContent` takes `showCloseButton`; `DialogFooter` takes `showCloseButton`.
- **Sheet:** same shape as Dialog (`SheetTrigger`, `SheetContent` with a `side` prop top/right/bottom/left, `SheetHeader`/`SheetTitle`/`SheetDescription`, `SheetFooter`, `SheetClose`).
- **Input + Label:** pair them with a shared `id`/`htmlFor`. `Input` honors `aria-invalid` and `disabled`.

## Where the truth lives

Read the bundle's `styles.css` (and the `_ds_bundle.css` it imports) for the exact tokens, and each component's `.d.ts` (props) + `.prompt.md` (usage) before styling.

## Idiomatic snippet

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Button, Badge } from "tm-scheduler";

export function MeetingCard() {
  return (
    <Card style={{ maxWidth: 380 }}>
      <CardHeader>
        <CardTitle>Weekly Chapter Meeting</CardTitle>
        <CardDescription>Tue, Jul 7 · 7:00 PM · Room 204</CardDescription>
        <CardAction><Badge variant="secondary">Open</Badge></CardAction>
      </CardHeader>
      <CardContent>
        <p style={{ margin: 0, fontSize: 14, color: "var(--muted-foreground)" }}>
          2 of 7 roles still need a volunteer.
        </p>
      </CardContent>
      <CardFooter style={{ gap: 8 }}>
        <Button size="sm">Sign up</Button>
        <Button size="sm" variant="outline">View agenda</Button>
      </CardFooter>
    </Card>
  );
}
```
