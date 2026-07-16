// Nitro runtime plugin — the boot hook that turns the reminder queue on.
// Registered via `plugins` in `nitro()` in `vite.config.ts`, it runs ONCE when
// the Node server starts (ADR-0007's single persistent process; ADR-0023), so
// the in-process reminder poller (#271) needs no external cron or edge worker.
// The `close` hook stops the interval on graceful shutdown so a dev-server
// restart doesn't leak a poller.
import { definePlugin } from "nitro";
import { startReminderPoller, stopReminderPoller } from "./reminder-poller";

export default definePlugin((nitroApp) => {
	startReminderPoller();
	nitroApp.hooks.hook("close", () => {
		stopReminderPoller();
	});
});
