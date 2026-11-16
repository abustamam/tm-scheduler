import { createMiddleware } from "@tanstack/react-start";

/** The same-browser signal (#1637): any tab that wrote something posts here,
 *  and a Present deck in another tab or window re-reads at once. */
export const AGENDA_CHANNEL = "gavelup-agenda";

export type AgendaChangedMessage = { type: "agenda-changed"; at: number };

const hasChannel = () =>
	typeof window !== "undefined" && typeof BroadcastChannel !== "undefined";

/** Tell every tab of this browser that something was saved. A no-op on the
 *  server and where there is no `BroadcastChannel`, and it NEVER throws: the
 *  save it follows has already succeeded, so a failing channel must not turn
 *  it into an error. */
export function postAgendaChanged(): void {
	if (!hasChannel()) return;
	try {
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
	} catch {
		// Best effort only.
	}
}

/** Run `cb` whenever an `agenda-changed` message arrives on this channel. That
 *  includes this tab's own posts (`postAgendaChanged` uses a throwaway channel
 *  instance, and instances of one name all receive each other's messages).
 *  Returns the unsubscribe. A no-op on the server and where there is no
 *  channel. */
export function subscribeAgendaChanged(cb: () => void): () => void {
	if (!hasChannel()) return () => {};
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
