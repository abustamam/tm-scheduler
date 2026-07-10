import { useEffect, useState } from "react";

/**
 * Tracks browser connectivity via `navigator.onLine` and the online/offline
 * events. Assumes online during SSR and the first paint so the offline banner
 * never flashes on a normal load; corrects on mount.
 */
export function useOnlineStatus(): boolean {
	const [online, setOnline] = useState(true);

	useEffect(() => {
		const update = () => setOnline(navigator.onLine);
		update();
		window.addEventListener("online", update);
		window.addEventListener("offline", update);
		return () => {
			window.removeEventListener("online", update);
			window.removeEventListener("offline", update);
		};
	}, []);

	return online;
}

/**
 * Reports whether an active service worker is controlling this page — i.e. a
 * reload would be served from cache, so the current view is available offline.
 */
export function useOfflineReady(): boolean {
	const [ready, setReady] = useState(false);

	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		const update = () => setReady(!!navigator.serviceWorker.controller);
		update();
		navigator.serviceWorker.addEventListener("controllerchange", update);
		return () => {
			navigator.serviceWorker.removeEventListener("controllerchange", update);
		};
	}, []);

	return ready;
}
