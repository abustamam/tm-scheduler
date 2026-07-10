/**
 * Registers the offline service worker (see `public/sw.js`, issue #174).
 *
 * Only runs in the browser and only in production builds: in dev the SW would
 * cache Vite's unhashed module graph and fight HMR. Safe to call on every
 * render — registration is idempotent.
 */
export function registerServiceWorker(): void {
	if (typeof window === "undefined") return;
	if (!("serviceWorker" in navigator)) return;
	if (!import.meta.env.PROD) return;

	const register = () => {
		navigator.serviceWorker.register("/sw.js").catch(() => {
			// Registration failures are non-fatal — the app works online regardless.
		});
	};

	if (document.readyState === "complete") register();
	else window.addEventListener("load", register, { once: true });
}
