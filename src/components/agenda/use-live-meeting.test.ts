// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_MEETING_REFRESH_MS, useLiveMeeting } from "./use-live-meeting";

// Control the subscription directly: the hook's job is what it does with it.
const { listeners } = vi.hoisted(() => ({
	listeners: new Set<() => void>(),
}));
vi.mock("#/lib/agenda-live", () => ({
	subscribeAgendaChanged: (cb: () => void) => {
		listeners.add(cb);
		return () => listeners.delete(cb);
	},
}));
const broadcast = () => {
	for (const cb of [...listeners]) cb();
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	listeners.clear();
});

const SNAP = { who: "Ann" };
const FRESH = { who: "Bo" };

function hook(fetcher: () => Promise<typeof SNAP>) {
	const qc = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client: qc }, children);
	return renderHook(() => useLiveMeeting(SNAP, ["c", "m"], fetcher), {
		wrapper,
	});
}

describe("useLiveMeeting (#1637)", () => {
	// protects=a same-laptop save shows at once and a burst cannot flood the
	// server; fails_when=no leading refetch, no throttle, or a trailing one lost;
	// no_claim=nothing about the poll.
	it("refetches at once on the first broadcast and at most once more for a burst", async () => {
		const fetcher = vi.fn().mockResolvedValue(FRESH);
		const view = hook(fetcher);
		expect(fetcher).not.toHaveBeenCalled();
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(view.result.current).toEqual(FRESH);
		await act(async () => {
			for (let n = 0; n < 10; n++) broadcast();
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(600);
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		// The throttle window re-arms, so it settles with nothing further.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	// protects=edits from another device arrive even when this tab is hidden;
	// fails_when=refetchIntervalInBackground is dropped (the poll pauses hidden)
	// or the cadence changes; no_claim=real browser timer throttling.
	it("polls at 30s with the tab hidden", async () => {
		const hidden = vi
			.spyOn(document, "visibilityState", "get")
			.mockReturnValue("hidden");
		const fetcher = vi.fn().mockResolvedValue(FRESH);
		const view = hook(fetcher);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(LIVE_MEETING_REFRESH_MS - 100);
		});
		expect(fetcher).not.toHaveBeenCalled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(200);
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(view.result.current).toEqual(FRESH);
		hidden.mockRestore();
	});

	// protects=the deck never blanks: a not-found answer (meeting deleted, club
	// archived) is a throw and keeps the last good copy; fails_when=the hook
	// returns undefined/the snapshot after a failure; no_claim=nothing about
	// which server message signals it.
	it("a not-found answer keeps the last good copy", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(FRESH)
			.mockRejectedValueOnce(new Error("Meeting not found."));
		const view = hook(fetcher);
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(view.result.current).toEqual(FRESH);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1100);
			broadcast();
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(view.result.current).toEqual(FRESH);
	});

	// protects=network off shows no error and no blank names; fails_when=a
	// rejection reaches the return value; no_claim=nothing about recovery timing.
	it("a rejected fetch keeps the snapshot, and the next success updates it", async () => {
		const fetcher = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("Failed to fetch"))
			.mockResolvedValueOnce(FRESH);
		const view = hook(fetcher);
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(view.result.current).toEqual(SNAP);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1100);
			broadcast();
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(view.result.current).toEqual(FRESH);
	});
});
