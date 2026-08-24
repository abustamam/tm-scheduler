// Vitest setup: provide deterministic defaults for server secrets that some code
// paths require, so tests don't depend on a developer's `.env.local` being loaded
// (vitest does not load it) or on CI exporting them. Real env values always win
// (`??=` only fills an UNSET var), so this never masks a configured secret.
//
// Needed by the reminder unsubscribe token (#274): `buildUnsubscribeUrl` signs
// with BETTER_AUTH_SECRET, exercised transitively by the reminder-delivery tests.
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

// jsdom implements pointer EVENTS but not the pointer CAPTURE methods, so any
// library that claims the pointer on `pointerdown` throws
// `event.target.setPointerCapture is not a function` the moment a test clicks
// it with `userEvent` (which fires the real pointer sequence; `fireEvent.click`
// does not, and papering over it that way would stop testing what a user does).
//
// Sonner does exactly this to implement swipe-to-dismiss, so a test that mounts
// `<Toaster />` and clicks a toast ACTION — the agenda editor's Undo — takes an
// uncaught exception. Vitest reports it as an unhandled error and exits
// non-zero while every assertion still passes, which is the worst shape: green
// tests, red build, and a warning that the errors "might cause false positive
// tests".
//
// Guarded on absence so a future jsdom that ships them wins.
if (typeof Element !== "undefined") {
	const proto = Element.prototype as unknown as Record<string, unknown>;
	proto.setPointerCapture ??= function setPointerCapture() {};
	proto.releasePointerCapture ??= function releasePointerCapture() {};
	proto.hasPointerCapture ??= function hasPointerCapture() {
		return false;
	};
}

// jsdom implements `window.innerWidth` but NOT `window.matchMedia`, so a
// component that subscribes to a breakpoint the way a browser does throws here
// while working in production. Rather than let that push components back to a
// one-shot `innerWidth` read — which is the bug this exists to make testable: a
// sampled width freezes at mount while the CSS it must agree with re-evaluates
// on every resize — give jsdom a real implementation.
//
// It evaluates `(min-width: Npx)` / `(max-width: Npx)` against the live
// `window.innerWidth` and re-evaluates on `resize`, so a test simulates a
// rotation by setting `window.innerWidth` and dispatching `resize`. Guarded on
// `window` because this same setup file runs for the default `node` environment,
// and on the method being absent so a future jsdom that ships one wins.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
	const parse = (query: string) => {
		const m = /\((min|max)-width:\s*(\d+)px\)/.exec(query);
		if (!m) return () => false;
		const px = Number(m[2]);
		return m[1] === "min"
			? () => window.innerWidth >= px
			: () => window.innerWidth <= px;
	};

	window.matchMedia = (query: string): MediaQueryList => {
		const evaluate = parse(query);
		const listeners = new Set<(e: MediaQueryListEvent) => void>();
		const list = {
			media: query,
			get matches() {
				return evaluate();
			},
			onchange: null,
			addEventListener: (
				type: string,
				fn: (e: MediaQueryListEvent) => void,
			) => {
				if (type === "change") listeners.add(fn);
			},
			removeEventListener: (
				type: string,
				fn: (e: MediaQueryListEvent) => void,
			) => {
				if (type === "change") listeners.delete(fn);
			},
			dispatchEvent: () => true,
			// Deprecated pair, still called by some libraries.
			addListener: (fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
			removeListener: (fn: (e: MediaQueryListEvent) => void) =>
				listeners.delete(fn),
		} as unknown as MediaQueryList;

		window.addEventListener("resize", () => {
			for (const fn of listeners) {
				fn({ matches: evaluate(), media: query } as MediaQueryListEvent);
			}
		});
		return list;
	};
}
