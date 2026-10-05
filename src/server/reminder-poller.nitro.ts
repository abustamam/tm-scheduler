// Nitro runtime plugin — the boot hook that starts the background poller.
// Registered via `plugins` in `nitro()` in `vite.config.ts`, it runs ONCE when
// the Node server starts (ADR-0007's single persistent process; ADR-0023), so
// the in-process poller needs no external cron or edge worker. It sends no
// reminders (ADR-0028); see `reminder-poller.ts` for what it runs and why the
// file keeps its name.
// The `close` hook stops the interval on graceful shutdown so a dev-server
// restart doesn't leak a poller.
import { definePlugin } from "nitro";
import { startBackgroundPoller, stopBackgroundPoller } from "./reminder-poller";

export default definePlugin((nitroApp) => {
	startBackgroundPoller();
	nitroApp.hooks.hook("close", () => {
		stopBackgroundPoller();
	});
});
