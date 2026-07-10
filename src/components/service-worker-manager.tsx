import { useEffect } from "react";
import { registerServiceWorker } from "#/lib/register-sw";

/** Registers the offline service worker on mount. Renders nothing. */
export function ServiceWorkerManager() {
	useEffect(() => {
		registerServiceWorker();
	}, []);
	return null;
}
