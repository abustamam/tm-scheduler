// Vitest setup: provide deterministic defaults for server secrets that some code
// paths require, so tests don't depend on a developer's `.env.local` being loaded
// (vitest does not load it) or on CI exporting them. Real env values always win
// (`??=` only fills an UNSET var), so this never masks a configured secret.
//
// Needed by the reminder unsubscribe token (#274): `buildUnsubscribeUrl` signs
// with BETTER_AUTH_SECRET, exercised transitively by the reminder-delivery tests.
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

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
