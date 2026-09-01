// @vitest-environment jsdom
/**
 * The JS half of #619's keyboard fix: does the visual viewport actually reach
 * CSS, and does it stop reaching it at the right moment?
 *
 * jsdom performs no layout, so nothing here can see whether the dialog ends up
 * above the keyboard — that is
 * `src/components/ui/dialog-keyboard-reachability.test.ts`, which lays the real
 * class strings out in a browser. What jsdom CAN see is the wiring these
 * assertions are about: which events are subscribed, what gets written, and the
 * ref count that decides when the properties are torn down.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__openDialogCountForTests,
	clearViewportBox,
	DIALOG_VIEWPORT_HEIGHT,
	DIALOG_VIEWPORT_TOP,
	readViewportBox,
	trackVisualViewport,
	writeViewportBox,
} from "./dialog-viewport";

/** A `visualViewport` stand-in whose box can be moved between events. */
function fakeViewport(height: number, offsetTop = 0) {
	const listeners = new Map<string, Set<() => void>>();
	return {
		height,
		offsetTop,
		addEventListener(type: string, listener: () => void) {
			const set = listeners.get(type) ?? new Set();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener(type: string, listener: () => void) {
			listeners.get(type)?.delete(listener);
		},
		/** Fire an event the way the platform would after a keyboard opens. */
		emit(type: string) {
			for (const listener of listeners.get(type) ?? []) listener();
		},
		countFor(type: string) {
			return listeners.get(type)?.size ?? 0;
		},
		total() {
			let n = 0;
			for (const set of listeners.values()) n += set.size;
			return n;
		},
	};
}

function fakeWindow(vv: ReturnType<typeof fakeViewport> | null) {
	const root = document.createElement("html");
	return {
		win: { visualViewport: vv, document: { documentElement: root } },
		root,
	};
}

const read = (root: HTMLElement) => ({
	height: root.style.getPropertyValue(DIALOG_VIEWPORT_HEIGHT),
	top: root.style.getPropertyValue(DIALOG_VIEWPORT_TOP),
});

/**
 * The module holds a process-wide ref count, and vitest runs every test in this
 * file against the same module instance. A test that left the count above zero
 * would leak into the next one and make a teardown assertion pass or fail for
 * the wrong reason, so each test drains it.
 */
const releases: Array<() => void> = [];
function track(win: Parameters<typeof trackVisualViewport>[0]) {
	const release = trackVisualViewport(win);
	releases.push(release);
	return release;
}

afterEach(() => {
	while (releases.length) releases.pop()?.();
	expect(__openDialogCountForTests()).toBe(0);
});

describe("writeViewportBox", () => {
	it("writes both halves of the box in px", () => {
		const root = document.createElement("html");
		writeViewportBox(root, { height: 269, offsetTop: 44 });
		expect(read(root)).toEqual({ height: "269px", top: "44px" });
	});

	it("clears both, so the class string's fallbacks take over", () => {
		const root = document.createElement("html");
		writeViewportBox(root, { height: 269, offsetTop: 44 });
		clearViewportBox(root);
		expect(read(root)).toEqual({ height: "", top: "" });
	});
});

describe("readViewportBox — refuses a box it cannot trust", () => {
	// The stakes are asymmetric and counter-intuitive, which is why these are
	// separate cases rather than one defensive `if`. A `var()` fallback rescues
	// a MISSING property, never a garbage one: `NaNpx` is a valid custom-property
	// value that only goes invalid at `calc()` substitution, taking the whole
	// declaration with it — `max-height: none`, `top: auto`. A bad number is
	// therefore WORSE than no number, so every one of these must return null.
	const base = fakeViewport(269, 0);

	it("accepts an ordinary keyboard-shrunk box", () => {
		expect(readViewportBox({ ...base, height: 269, offsetTop: 44 })).toEqual({
			height: 269,
			offsetTop: 44,
		});
	});

	it("refuses a zero height, which would collapse the dialog", () => {
		// `calc(0px - 2rem)` clamps to 0: an invisible dialog that stays invisible
		// until the next resize event rewrites the property.
		expect(readViewportBox({ ...base, height: 0 })).toBeNull();
	});

	it("refuses a negative height", () => {
		expect(readViewportBox({ ...base, height: -10 })).toBeNull();
	});

	it("refuses a non-finite height", () => {
		expect(readViewportBox({ ...base, height: Number.NaN })).toBeNull();
		expect(
			readViewportBox({ ...base, height: Number.POSITIVE_INFINITY }),
		).toBeNull();
	});

	it("refuses a non-finite offsetTop", () => {
		expect(readViewportBox({ ...base, offsetTop: Number.NaN })).toBeNull();
	});

	it("refuses a pinch-zoomed viewport", () => {
		// Zoom shrinks the visual viewport exactly like a keyboard, and only
		// `scale` tells them apart. Tracking it would make a dialog shrink and
		// re-centre while the user zooms in to read it.
		expect(readViewportBox({ ...base, scale: 2 })).toBeNull();
		expect(readViewportBox({ ...base, scale: 0.5 })).toBeNull();
	});

	it("tolerates floating-point noise around scale 1", () => {
		expect(readViewportBox({ ...base, scale: 1.0001 })).not.toBeNull();
	});

	it("accepts an engine that reports no scale at all", () => {
		const { scale: _drop, ...noScale } = { ...base, scale: 1 };
		expect(readViewportBox(noScale)).not.toBeNull();
	});
});

describe("trackVisualViewport", () => {
	it("clears a previously published box when it stops being trustworthy", () => {
		// Clearing rather than skipping is the whole point: leaving the last good
		// box standing would keep a dialog sized to a keyboard that has closed.
		const vv = fakeViewport(269, 44);
		const { win, root } = fakeWindow(vv);
		track(win);
		expect(read(root).height).toBe("269px");

		vv.height = 0;
		vv.emit("resize");
		expect(read(root)).toEqual({ height: "", top: "" });
	});

	it("recovers once the viewport reports a usable box again", () => {
		const vv = fakeViewport(0);
		const { win, root } = fakeWindow(vv);
		track(win);
		expect(read(root).height).toBe("");

		vv.height = 560;
		vv.emit("resize");
		expect(read(root).height).toBe("560px");
	});

	it("publishes the box immediately, before any event fires", () => {
		// The keyboard can already be up when a dialog opens (a second dialog
		// opened from a form, say). Waiting for a resize would leave that dialog
		// sized to the full layout viewport for as long as nothing moves.
		const { win, root } = fakeWindow(fakeViewport(269, 44));
		track(win);
		expect(read(root)).toEqual({ height: "269px", top: "44px" });
	});

	it("follows a keyboard opening", () => {
		const vv = fakeViewport(560, 0);
		const { win, root } = fakeWindow(vv);
		track(win);
		expect(read(root).height).toBe("560px");

		vv.height = 269;
		vv.emit("resize");
		expect(read(root)).toEqual({ height: "269px", top: "0px" });
	});

	it("follows the visual viewport being SCROLLED, not just resized", () => {
		// iOS scrolls the visual viewport to clear a focused input as well as
		// shrinking it, and reports that as `scroll` with a new `offsetTop`.
		// Subscribing to `resize` alone leaves the dialog correctly sized and
		// still under the keyboard, which is the bug wearing a smaller hat.
		const vv = fakeViewport(560, 0);
		const { win, root } = fakeWindow(vv);
		track(win);

		vv.height = 269;
		vv.offsetTop = 120;
		vv.emit("scroll");
		expect(read(root)).toEqual({ height: "269px", top: "120px" });
	});

	it("unsubscribes and clears when the dialog closes", () => {
		const vv = fakeViewport(560);
		const { win, root } = fakeWindow(vv);
		const release = track(win);
		expect(vv.total()).toBe(2);

		release();
		expect(vv.total()).toBe(0);
		expect(read(root)).toEqual({ height: "", top: "" });
	});

	it("keeps the box while an OUTER dialog is still open", () => {
		// Dialogs nest. A boolean instead of a ref count would let the inner
		// dialog's unmount clear the properties out from under the outer one,
		// which silently restores the bug for the dialog still on screen.
		const vv = fakeViewport(269, 44);
		const { win, root } = fakeWindow(vv);
		const outer = track(win);
		const inner = track(win);

		inner();
		expect(read(root)).toEqual({ height: "269px", top: "44px" });
		expect(vv.total()).toBe(2);

		outer();
		expect(read(root)).toEqual({ height: "", top: "" });
		expect(vv.total()).toBe(0);
	});

	it("subscribes once for several open dialogs", () => {
		const vv = fakeViewport(560);
		const { win } = fakeWindow(vv);
		track(win);
		track(win);
		track(win);
		expect(vv.countFor("resize")).toBe(1);
		expect(vv.countFor("scroll")).toBe(1);
	});

	it("survives a release being called twice", () => {
		// React StrictMode runs an effect's cleanup twice in development. An
		// unguarded decrement drives the count negative, after which the NEXT
		// dialog's release fires teardown while that dialog is still open.
		const vv = fakeViewport(560);
		const { win, root } = fakeWindow(vv);
		const release = track(win);
		release();
		release();
		expect(__openDialogCountForTests()).toBe(0);

		track(win);
		expect(read(root).height).toBe("560px");
		expect(vv.countFor("resize")).toBe(1);
	});

	it("re-subscribes after the last dialog closed", () => {
		const vv = fakeViewport(560);
		const { win, root } = fakeWindow(vv);
		track(win)();
		expect(vv.total()).toBe(0);

		track(win);
		expect(vv.total()).toBe(2);
		expect(read(root).height).toBe("560px");
	});

	it("is a no-op where visualViewport is absent", () => {
		// SSR, jsdom's own window, and any engine without the API. The class
		// string's `var()` fallbacks then apply, which is the v1.25.2.0
		// rendering rather than a broken one.
		const { win, root } = fakeWindow(null);
		expect(() => track(win)()).not.toThrow();
		expect(read(root)).toEqual({ height: "", top: "" });
	});

	it("is a no-op with no window at all", () => {
		expect(() => track(undefined)()).not.toThrow();
	});

	it("reads the ambient window when called with no argument", () => {
		// The default parameter is what `dialog.tsx` actually calls — every test
		// above passes an explicit fake, so without this the production call
		// signature is the one path with no coverage. jsdom supplies a `window`
		// with no `visualViewport`, which is also the shape of an engine that
		// lacks the API: the requirement is that it degrades quietly rather than
		// throwing inside a dialog's effect and blanking the page.
		const before = document.documentElement.getAttribute("style");
		let release: (() => void) | undefined;
		expect(() => {
			release = trackVisualViewport();
		}).not.toThrow();
		releases.push(() => release?.());
		expect(document.documentElement.getAttribute("style")).toBe(before);
	});

	it("does not write to a documentElement it was never given", () => {
		const spy = vi.spyOn(document.documentElement.style, "setProperty");
		const { win } = fakeWindow(fakeViewport(269));
		track(win);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
