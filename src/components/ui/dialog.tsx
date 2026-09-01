"use client";

import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";
import { Button } from "#/components/ui/button.tsx";
import { trackVisualViewport } from "#/lib/dialog-viewport.ts";
import { cn } from "#/lib/utils.ts";

function Dialog({
	...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
	...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
	...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
	return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
	...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
	return (
		<DialogPrimitive.Overlay
			data-slot="dialog-overlay"
			className={cn(
				"fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * Publishes the visual viewport box to CSS while a dialog is open, so the
 * ceiling and the centring below can be measured against the part of the screen
 * the on-screen keyboard has NOT covered (#619). Renders nothing.
 *
 * It sits inside `DialogPrimitive.Content` on purpose, and the choice is
 * narrower than "somewhere under the portal". An effect in `DialogContent`
 * itself would run for every dialog COMPONENT in the tree, open or not, because
 * call sites render the element unconditionally and Radix decides presence
 * internally — so it has to be under the portal. But Radix wraps EACH portal
 * child in its own `Presence`, and this one declares no exit animation, so as a
 * SIBLING of `Content` it unmounts the moment `open` flips while `Content` is
 * still playing its fade-out. Measured in the browser: the properties cleared
 * with the dialog still in the DOM, which with a keyboard up would grow the
 * closing dialog from 237px back to 528px and re-centre it mid-fade. As a CHILD
 * of `Content` its lifetime is `Content`'s, exit animation included.
 */
function DialogViewportSync() {
	React.useEffect(() => trackVisualViewport(), []);
	return null;
}

function DialogContent({
	className,
	children,
	showCloseButton = true,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
	showCloseButton?: boolean;
}) {
	return (
		<DialogPortal data-slot="dialog-portal">
			<DialogOverlay />
			<DialogPrimitive.Content
				data-slot="dialog-content"
				className={cn(
					// SHELL. Owns the ceiling, the padding and the chrome; it does NOT
					// scroll. The scrolling BODY is the inner element below, and the
					// split is what keeps the close button reachable (#627).
					//
					// The ceiling itself is #619: this element is `fixed` and centred by
					// `translate-y-[-50%]`, so content taller than the viewport hangs
					// off BOTH ends and the document cannot scroll it back — a fixed
					// box is not in the document's scroll flow. Without a ceiling the
					// overflow is not below the fold, it is unreachable: measured on
					// the public identity dialog at a 400px-tall viewport, the
					// "I'm new — add me" control sat at y=404 with no scrollable
					// ancestor anywhere between it and the body.
					// `svh`, not `vh`: `vh` is the LARGE viewport height, so it
					// under-accounts for mobile browser chrome and the ceiling lands
					// below the fold on exactly the devices that need it.
					//
					// `p-6` stays HERE rather than moving to the body, and that is the
					// whole reason this fix was shippable. `cn()` is tailwind-merge, so
					// a caller's padding override has to land on the same element as
					// the default or it silently stops working — `CommandDialog` passes
					// `p-0`. Padding on the shell also means the body's scrolled
					// content is clipped 24px inside the rounded corner instead of
					// running into it.
					//
					// `overflow-hidden` so the body's scrolled content is clipped by
					// the rounded corners. Every call site's own className is a
					// `sm:max-w-*` width, so nothing out there fights `flex flex-col`.
					//
					// KEYBOARD OCCLUSION is the second half of #619, and it is a
					// different mechanism that the ceiling above cannot see. The
					// viewport meta has no `interactive-widget`, so the platform
					// default `resizes-visual` shrinks the VISUAL viewport and leaves
					// the LAYOUT viewport alone — and `svh` resolves against the
					// layout viewport. `100svh` therefore still evaluates to the full
					// height with the keyboard up: a 533px dialog fits under its
					// ceiling, nothing overflows, the scroller never engages, and the
					// bottom of the dialog is not below the fold but behind the
					// keyboard.
					//
					// So both the ceiling and the CENTRING are measured against the
					// visual viewport instead, published as two custom properties by
					// `DialogViewportSync` above. `top` is the half that is easy to
					// forget: shrinking the box without moving it leaves a correctly
					// sized dialog still centred on the layout viewport, i.e. still
					// under the keyboard. `--dialog-viewport-offset-top` is what iOS
					// reports when it scrolls the visual viewport to clear a focused
					// input.
					//
					// The `var()` FALLBACKS (`100svh`, `0px`) are the whole no-JS
					// story: with no `visualViewport`, during SSR, and before the
					// effect runs, these two utilities compute to exactly the
					// `max-h-[calc(100svh-2rem)]` and `top-[50%]` that shipped in
					// v1.25.2.0. Nothing regresses when the properties are absent.
					//
					// Do NOT spell the property names differently here than in
					// `#/lib/dialog-viewport` — a Tailwind arbitrary value is scanned
					// statically, so this string cannot interpolate those constants,
					// and a rename on one side alone makes `var()` fall silently back
					// to `100svh` with every gate green. `dialog-scroll.guard.test.ts`
					// asserts the two spellings match.
					"fixed top-[calc(var(--dialog-viewport-offset-top,0px)_+_var(--dialog-viewport-height,100svh)*0.5)] left-[50%] z-50 flex max-h-[calc(var(--dialog-viewport-height,100svh)-2rem)] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] flex-col overflow-hidden rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
					className,
				)}
				{...props}
			>
				{/*
				 * BODY — the scroll container, and the only thing that moves.
				 *
				 * `min-h-0` is load-bearing, not defensive. A flex child's default
				 * `min-height: auto` refuses to shrink below its content, so
				 * `overflow-y-auto` on it produces a box that GROWS instead of
				 * scrolling: the shell's `max-h` would then clip it with no way to
				 * scroll, which is #619 again wearing a different shape and passing
				 * any grep that only asks whether `overflow-y-auto` is present. This
				 * repo already has a gate for exactly that class of mistake —
				 * `pinned-column-reachability.test.ts`, written after a sticky column
				 * shipped twice with an unreachable tail.
				 *
				 * `gap-4` and `grid` move here from the shell so spacing between
				 * DialogHeader/Footer/content is unchanged; the shell is now a
				 * one-child flex column.
				 */}
				<DialogViewportSync />
				<div
					data-slot="dialog-body"
					className="grid min-h-0 gap-4 overflow-y-auto overscroll-contain"
				>
					{children}
				</div>
				{/*
				 * OUTSIDE the body on purpose. An absolutely-positioned child of a
				 * scroll container scrolls WITH the content: measured before this
				 * change, the close button went from y=33 to y=-56 after an 89px
				 * scroll, and the only remaining exits were Escape (no such key on a
				 * phone) and a 16px overlay strip, against a 44px minimum tap target.
				 * On the shell it is a child of a box that never scrolls, so it stays
				 * put. `top-4` (16px) sits inside the shell's 24px padding, so the
				 * body's content never reaches it.
				 */}
				{showCloseButton && (
					<DialogPrimitive.Close
						data-slot="dialog-close"
						className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
					>
						<XIcon />
						<span className="sr-only">Close</span>
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Content>
		</DialogPortal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
			{...props}
		/>
	);
}

function DialogFooter({
	className,
	showCloseButton = false,
	children,
	...props
}: React.ComponentProps<"div"> & {
	showCloseButton?: boolean;
}) {
	return (
		<div
			data-slot="dialog-footer"
			className={cn(
				"flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
				className,
			)}
			{...props}
		>
			{children}
			{showCloseButton && (
				<DialogPrimitive.Close asChild>
					<Button variant="outline">Close</Button>
				</DialogPrimitive.Close>
			)}
		</div>
	);
}

function DialogTitle({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn("text-lg leading-none font-semibold", className)}
			{...props}
		/>
	);
}

function DialogDescription({
	className,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn("text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
};
