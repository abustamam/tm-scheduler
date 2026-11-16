// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The middleware is driven through its client callback with a stubbed `next`;
// the real channel is Node's/jsdom's own BroadcastChannel.
import {
	AGENDA_CHANNEL,
	agendaChangedMiddleware,
	postAgendaChanged,
	subscribeAgendaChanged,
} from "./agenda-live";

afterEach(() => vi.unstubAllGlobals());

const tick = () => new Promise((r) => setTimeout(r, 20));

type ClientFn = (ctx: {
	next: () => Promise<unknown>;
	method: string;
}) => Promise<unknown>;
function clientFn(): ClientFn {
	const opts = (
		agendaChangedMiddleware as unknown as {
			options: { client: ClientFn };
		}
	).options;
	return opts.client;
}

describe("agenda-live channel (#1637)", () => {
	// protects=a post in one tab reaches a subscriber in another;
	// fails_when=the channel name differs between sender and receiver or the
	// message is not delivered; no_claim=nothing about cross-window delivery in a
	// real browser, only that two instances of the same channel talk.
	it("delivers a post to a subscriber, until it unsubscribes", async () => {
		const cb = vi.fn();
		const off = subscribeAgendaChanged(cb);
		postAgendaChanged();
		await tick();
		expect(cb).toHaveBeenCalledTimes(1);
		off();
		postAgendaChanged();
		await tick();
		expect(cb).toHaveBeenCalledTimes(1);
		expect(AGENDA_CHANNEL).toBe("gavelup-agenda");
	});

	// protects=SSR and old browsers do not throw; fails_when=the guard on
	// BroadcastChannel is removed; no_claim=nothing about the middleware.
	it("is a no-op without BroadcastChannel", () => {
		vi.stubGlobal("BroadcastChannel", undefined);
		expect(() => postAgendaChanged()).not.toThrow();
		const off = subscribeAgendaChanged(() => {});
		expect(() => off()).not.toThrow();
	});

	// protects=a resolved POST announces a change (including a refusal that
	// resolves with ok:false); fails_when=the post is dropped or conditioned on
	// the result; no_claim=nothing about GET or a throw.
	it("the middleware posts after a POST resolves, refusal included", async () => {
		const cb = vi.fn();
		const off = subscribeAgendaChanged(cb);
		const result = { ok: false };
		await expect(
			clientFn()({ method: "POST", next: async () => result }),
		).resolves.toBe(result);
		await tick();
		expect(cb).toHaveBeenCalledTimes(1);
		off();
	});

	// protects=a throw posts nothing and a GET never posts; fails_when=the post
	// moves before next() or ignores method; no_claim=nothing about POST success.
	it("the middleware posts nothing on a throw or a GET", async () => {
		const cb = vi.fn();
		const off = subscribeAgendaChanged(cb);
		await expect(
			clientFn()({
				method: "POST",
				next: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");
		await clientFn()({ method: "GET", next: async () => 1 });
		await tick();
		expect(cb).not.toHaveBeenCalled();
		off();
	});
});
