/**
 * Publish the VISUAL viewport box to CSS, so a dialog can be sized and placed
 * against the part of the screen the on-screen keyboard has not covered.
 *
 * ## Why this exists (#619, half b)
 *
 * v1.25.2.0 gave `DialogContent` a `max-h-[calc(100svh-2rem)]` ceiling and a
 * scrolling body. That fixed content-overflow and does nothing for a keyboard,
 * because the two are different mechanisms: the platform default for the
 * viewport meta is `interactive-widget=resizes-visual`, so opening the keyboard
 * shrinks the VISUAL viewport and leaves the LAYOUT viewport alone. `svh` is
 * resolved against the layout viewport. So `100svh` still evaluates to the full
 * height, a 533px dialog still fits under its ceiling, nothing overflows, and
 * the scroller never engages. The bottom of the dialog is not overflowing — it
 * is behind the keyboard, and no amount of ceiling can see that.
 *
 * The `visualViewport` API is the only thing that reports the shrunk box. It
 * cannot be reached from CSS, so this module copies it INTO CSS as two custom
 * properties and `dialog.tsx` sizes and positions against them.
 *
 * ## Why not `interactive-widget=resizes-content` in the viewport meta
 *
 * That was candidate 1 on the issue and it is a one-line change, but it is a
 * Chrome-family key: MDN's browser-compat-data carries no entry for it under
 * `meta[name=viewport]` at all, so there is no verified support anywhere else —
 * and the worked example on #619 is an iPhone SE, i.e. exactly the engine with
 * no data. It is also an APP-WIDE layout change (every `svh`-sized surface
 * starts resizing on input focus), which buys an audit this fix does not need.
 * The two compose without conflict if it is ever adopted: with the layout
 * viewport shrinking, `visualViewport.height` reports that same shrunk height
 * and `offsetTop` stays 0, so the values written here are unchanged.
 *
 * ## Why the names are exported
 *
 * A Tailwind arbitrary value is scanned STATICALLY, so `dialog.tsx` must spell
 * these property names as literal text inside its class string — it cannot
 * interpolate the constants. That makes silent drift possible in exactly one
 * direction (rename here, class string keeps the old name, `var()` quietly
 * falls back to `100svh` and the fix is gone with every gate green). So both
 * `dialog-scroll.guard.test.ts` and the browser reachability suite read these
 * exports and assert the class string still spells them.
 */

/** Height of the visual viewport — what is actually visible. */
export const DIALOG_VIEWPORT_HEIGHT = "--dialog-viewport-height";

/**
 * How far the visual viewport has been pushed down inside the layout viewport.
 * Non-zero on iOS, which scrolls the visual viewport to keep a focused input
 * above the keyboard; a dialog centred without it lands under the keyboard even
 * at the correct height.
 */
export const DIALOG_VIEWPORT_TOP = "--dialog-viewport-offset-top";

/** The subset of `VisualViewport` this module reads. */
export type ViewportBox = { height: number; offsetTop: number };

type VisualViewportLike = ViewportBox & {
	/** Pinch-zoom factor. 1 at default zoom; absent on older engines. */
	scale?: number;
	addEventListener: (type: string, listener: () => void) => void;
	removeEventListener: (type: string, listener: () => void) => void;
};

/**
 * The box, or `null` when it should not be trusted.
 *
 * Returning `null` means "no information" and the caller falls back to the
 * `100svh` centred rendering that shipped in v1.25.2.0 — never worse than
 * before, which is the property that makes these three guards safe.
 *
 * All three matter because of HOW CSS fails here, and it is not the way you
 * would guess. A `var()` fallback rescues a MISSING property, not a garbage
 * one: `--dialog-viewport-height: NaNpx` is a perfectly valid custom-property
 * value, and it only becomes invalid when `calc()` substitutes it — which makes
 * the whole declaration invalid at computed-value time. `max-height` then
 * resolves to its initial value `none` and `top` to `auto`. So a bad number
 * does not degrade to the old behaviour, it removes the ceiling entirely and
 * un-anchors a `translate-y(-50%)` box. Hence: validate before publishing.
 */
export function readViewportBox(vv: VisualViewportLike): ViewportBox | null {
	const { height, offsetTop, scale } = vv;

	// A zero or negative height computes `max-height: calc(0px - 2rem)`, which
	// clamps to 0 and collapses the dialog to an invisible strip — and it stays
	// collapsed until the next resize event, because nothing else rewrites it.
	if (!Number.isFinite(height) || height <= 0) return null;
	if (!Number.isFinite(offsetTop)) return null;

	// Pinch-zoom shrinks the visual viewport exactly like a keyboard does, and
	// nothing in `height` distinguishes them — but `scale` does. Without this,
	// zooming into a dialog to read it makes the dialog shrink and re-centre to
	// track the zoom window, fighting the gesture. Zoom is an accessibility
	// affordance, so losing it is worse than not handling the keyboard.
	if (scale !== undefined && Math.abs(scale - 1) > 0.01) return null;

	return { height, offsetTop };
}

type WindowLike = {
	visualViewport?: VisualViewportLike | null;
	document?: { documentElement?: { style: CSSStyleDeclaration } | null } | null;
};

/** Copy a viewport box onto an element's inline style. */
export function writeViewportBox(
	root: { style: CSSStyleDeclaration },
	box: ViewportBox,
): void {
	root.style.setProperty(DIALOG_VIEWPORT_HEIGHT, `${box.height}px`);
	root.style.setProperty(DIALOG_VIEWPORT_TOP, `${box.offsetTop}px`);
}

/**
 * Remove both properties, returning the dialog to its `var()` fallbacks
 * (`100svh` and `0px`) — i.e. exactly the v1.25.2.0 behaviour.
 */
export function clearViewportBox(root: { style: CSSStyleDeclaration }): void {
	root.style.removeProperty(DIALOG_VIEWPORT_HEIGHT);
	root.style.removeProperty(DIALOG_VIEWPORT_TOP);
}

/**
 * Ref count, not a boolean. Dialogs nest (a confirm inside a form), and each
 * open one runs its own effect — so a boolean would let the INNER dialog's
 * unmount clear the properties while the outer one is still open, silently
 * restoring the bug for the dialog still on screen. The listener is attached
 * once and released when the last dialog closes.
 */
let openDialogs = 0;
let detach: (() => void) | null = null;

/**
 * Track the visual viewport for as long as a dialog is open.
 *
 * Call from an effect that runs only while the dialog is MOUNTED, and return
 * the result as the effect's cleanup.
 *
 * Degrades to a no-op wherever `visualViewport` is absent (SSR, jsdom, an
 * ancient engine): the properties are then never written and the `var()`
 * fallbacks in the class string apply, which is the pre-fix rendering rather
 * than a broken one.
 */
export function trackVisualViewport(
	win: WindowLike | undefined = typeof window === "undefined"
		? undefined
		: (window as WindowLike),
): () => void {
	openDialogs += 1;

	const vv = win?.visualViewport;
	const root = win?.document?.documentElement;
	if (vv && root && !detach) {
		const sync = () => {
			const box = readViewportBox(vv);
			// Clear rather than skip: a box that has become untrustworthy must not
			// leave the PREVIOUS one standing, or a dialog stays sized to a keyboard
			// that has since closed.
			if (box) writeViewportBox(root, box);
			else clearViewportBox(root);
		};
		sync();
		// `scroll` as well as `resize`: on iOS the keyboard scrolls the visual
		// viewport as well as shrinking it, and only the scroll event reports the
		// new `offsetTop`. Listening to resize alone leaves the dialog correctly
		// sized and still under the keyboard.
		vv.addEventListener("resize", sync);
		vv.addEventListener("scroll", sync);
		detach = () => {
			vv.removeEventListener("resize", sync);
			vv.removeEventListener("scroll", sync);
			clearViewportBox(root);
		};
	}

	// Guarded against a double release. React StrictMode invokes an effect's
	// cleanup twice in development, and an unguarded decrement would drive the
	// count negative and leak the listener for the rest of the session.
	let released = false;
	return () => {
		if (released) return;
		released = true;
		openDialogs -= 1;
		if (openDialogs <= 0) {
			openDialogs = 0;
			detach?.();
			detach = null;
		}
	};
}

/** Test seam — the module-level count is deliberately not exported for writes. */
export function __openDialogCountForTests(): number {
	return openDialogs;
}
