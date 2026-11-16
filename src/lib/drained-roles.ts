// The drain's "this role op left the queue" message (#1638). CLIENT-ONLY.
//
// It rides the SAME channel as `agenda-changed` (`src/lib/agenda-live.ts`, which
// this file leaves alone) as one more field on that message, so the deck's
// existing listener still re-reads on it, and a separate listener here picks up
// the payload. The drain posts it after the IndexedDB removal has committed.
import type { DrainedRoleOp } from "#/lib/project-slots";

/** Kept equal to `AGENDA_CHANNEL` by a test rather than imported: a test that
 *  mocks `agenda-live` for its subscription must not be able to break this. */
export const DRAINED_CHANNEL = "gavelup-agenda";

export type DrainedMessage = {
	type: "agenda-changed";
	at: number;
	drained: DrainedRoleOp[];
};

const hasChannel = () =>
	typeof window !== "undefined" && typeof BroadcastChannel !== "undefined";

/** Tell every tab of this browser which role ops just left the queue, and how
 *  they ended. Never throws: the drain has already written. */
export function postRoleOpsDrained(drained: DrainedRoleOp[]): void {
	if (!hasChannel()) return;
	try {
		const channel = new BroadcastChannel(DRAINED_CHANNEL);
		try {
			const message: DrainedMessage = {
				type: "agenda-changed",
				at: Date.now(),
				drained,
			};
			channel.postMessage(message);
		} finally {
			channel.close();
		}
	} catch {
		// Best effort only.
	}
}

/** Run `cb` for each drained role op a tab announced, with the time the
 *  message was posted. Returns the unsubscribe. */
export function subscribeRoleOpsDrained(
	cb: (drained: DrainedRoleOp[], at: number) => void,
): () => void {
	if (!hasChannel()) return () => {};
	const channel = new BroadcastChannel(DRAINED_CHANNEL);
	channel.onmessage = (e: MessageEvent<Partial<DrainedMessage>>) => {
		const d = e.data;
		if (d?.type === "agenda-changed" && Array.isArray(d.drained)) {
			cb(d.drained, typeof d.at === "number" ? d.at : Date.now());
		}
	};
	return () => channel.close();
}
