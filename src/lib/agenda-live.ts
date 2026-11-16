import { createMiddleware } from "@tanstack/react-start";

/** The same-browser signal (#1637): any tab that wrote something posts here,
 *  and a Present deck in another tab or window re-reads at once. */
export const AGENDA_CHANNEL = "gavelup-agenda";

export type AgendaChangedMessage = { type: "agenda-changed"; at: number };

/** Tell every other tab of this browser that something was saved. A no-op
 *  where there is no `BroadcastChannel` (SSR, old browsers). */
export function postAgendaChanged(): void {
	if (typeof BroadcastChannel === "undefined") return;
	const channel = new BroadcastChannel(AGENDA_CHANNEL);
	try {
		const message: AgendaChangedMessage = {
			type: "agenda-changed",
			at: Date.now(),
		};
		channel.postMessage(message);
	} finally {
		channel.close();
	}
}

/** Run `cb` whenever ANOTHER tab posts `agenda-changed` (a channel never
 *  delivers to its own instance, and `postAgendaChanged` uses a throwaway one
 *  anyway). Returns the unsubscribe. A no-op where there is no channel. */
export function subscribeAgendaChanged(cb: () => void): () => void {
	if (typeof BroadcastChannel === "undefined") return () => {};
	const channel = new BroadcastChannel(AGENDA_CHANNEL);
	channel.onmessage = (e: MessageEvent<AgendaChangedMessage>) => {
		if (e.data?.type === "agenda-changed") cb();
	};
	return () => channel.close();
}

/**
 * Global function middleware (#1637, wired in `src/start.ts`): after ANY POST
 * server fn resolves, announce a change. Global on purpose, so a role screen
 * added later cannot forget to send it. It posts when the fn RESOLVES, even
 * with `{ ok: false }` (the only cost is one extra public read); a throw posts
 * nothing, and a GET never does.
 */
export const agendaChangedMiddleware = createMiddleware({
	type: "function",
}).client(async ({ next, method }) => {
	const result = await next();
	if (method === "POST") postAgendaChanged();
	return result;
});
