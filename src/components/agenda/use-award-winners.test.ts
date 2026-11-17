// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedOp } from "#/lib/offline-minutes-queue";
import { useAwardWinners } from "./use-award-winners";

const { listeners, getAwardReveal, readQueue } = vi.hoisted(() => ({
	listeners: new Set<() => void>(),
	getAwardReveal: vi.fn(),
	readQueue: vi.fn(),
}));
vi.mock("#/lib/agenda-live", () => ({
	subscribeAgendaChanged: (cb: () => void) => {
		listeners.add(cb);
		return () => listeners.delete(cb);
	},
}));
vi.mock("#/lib/offline-minutes-queue", () => ({ readQueue }));
vi.mock("#/server/award-reveal", () => ({ getAwardReveal }));

const broadcast = () => {
	for (const cb of [...listeners]) cb();
};

beforeEach(() => {
	vi.useFakeTimers();
	readQueue.mockResolvedValue([]);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	listeners.clear();
	getAwardReveal.mockReset();
	readQueue.mockReset();
});

const setOp = (
	category: "best_speaker" | "best_evaluator" | "best_table_topics",
	name: string,
	queuedAt = 1,
): QueuedOp => ({
	type: "setAward",
	opId: `op-${category}-${queuedAt}`,
	queuedAt,
	category,
	name,
	isGuest: false,
});

function mount(onSlide = true, qc = new QueryClient(), meetingId = "m1") {
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client: qc }, children);
	const view = renderHook(
		({ onSlide, meetingId }) =>
			useAwardWinners(meetingId, { enabled: true, onSlide }),
		{ wrapper, initialProps: { onSlide, meetingId } },
	);
	return Object.assign(view, { qc });
}
const flush = (ms = 10) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

describe("useAwardWinners (#1654)", () => {
	// protects=AC14: a queued award shows with no reload when the broadcast says
	// the queue changed, even though the fetch never answers; fails_when=the queue
	// read is chained behind the fetch or the broadcast is not heard; no_claim=the
	// drain.
	it("re-reads the queue on the broadcast while the fetch hangs", async () => {
		getAwardReveal.mockReturnValue(new Promise(() => {}));
		const view = mount();
		await flush();
		expect(view.result.current).toEqual([]);
		readQueue.mockResolvedValue([setOp("best_table_topics", "Tess")]);
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(view.result.current).toEqual([
			{ category: "best_table_topics", name: "Tess" },
		]);
	});

	// protects=a private window with no IndexedDB still works; fails_when=a
	// thrown read rejects out of the hook or blanks the fetched winners;
	// no_claim=any queue content.
	it("treats a queue read that throws as an empty queue", async () => {
		readQueue.mockRejectedValue(new Error("no indexedDB"));
		getAwardReveal.mockResolvedValue({
			winners: [{ category: "best_speaker", name: "Sam" }],
		});
		const view = mount();
		await flush();
		expect(view.result.current).toEqual([
			{ category: "best_speaker", name: "Sam" },
		]);
	});

	// protects=AC16: after the queue drains, the queued name stays until a LATER
	// fetch returns it, and at no point shows the pre-queue winner; fails_when=
	// the dequeued op vanishes from the projection or a fetch that started BEFORE
	// the drain read clears the overlay; no_claim=the 5s cadence.
	it("keeps a drained award projected until a later fetch returns non-null data", async () => {
		getAwardReveal.mockResolvedValue({
			winners: [{ category: "best_table_topics", name: "Old" }],
		});
		readQueue.mockResolvedValue([setOp("best_table_topics", "New")]);
		const view = mount();
		await flush();
		expect(view.result.current).toEqual([
			{ category: "best_table_topics", name: "New" },
		]);

		// The drain: the op leaves the queue, the server still says "Old".
		readQueue.mockResolvedValue([]);
		await vi.advanceTimersByTimeAsync(5);
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(view.result.current).toEqual([
			{ category: "best_table_topics", name: "New" },
		]);

		// A later fetch returns the confirmed name; the overlay may drop.
		await vi.advanceTimersByTimeAsync(5);
		getAwardReveal.mockResolvedValue({
			winners: [{ category: "best_table_topics", name: "New" }],
		});
		await flush(5100);
		expect(view.result.current).toEqual([
			{ category: "best_table_topics", name: "New" },
		]);
		// Now the server is the source: a different server answer shows through.
		getAwardReveal.mockResolvedValue({
			winners: [{ category: "best_table_topics", name: "Other" }],
		});
		await flush(5100);
		expect(view.result.current).toEqual([
			{ category: "best_table_topics", name: "Other" },
		]);
	});

	// protects=AC16's "no flash back": a fetch that STARTED before the drain's
	// queue read cannot have seen the op, so its stale answer must not clear the
	// overlay; fails_when=any resolving fetch clears it; no_claim=the later-fetch
	// release (previous test).
	it("a fetch that started before the drain read does not clear the overlay", async () => {
		let resolveStale: (v: unknown) => void = () => {};
		getAwardReveal.mockReturnValueOnce(
			new Promise((r) => {
				resolveStale = r;
			}),
		);
		readQueue.mockResolvedValue([setOp("best_table_topics", "New")]);
		const view = mount();
		await flush(); // fetch in flight (started now); queue read shows "New"
		expect(view.result.current).toEqual([
			{ category: "best_table_topics", name: "New" },
		]);
		await vi.advanceTimersByTimeAsync(50);
		readQueue.mockResolvedValue([]); // the drain
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(1);
		});
		await act(async () => {
			resolveStale({
				winners: [{ category: "best_table_topics", name: "Old" }],
			});
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(view.result.current).toEqual([
			{ category: "best_table_topics", name: "New" },
		]);
	});

	// protects=a signed-out projector keeps showing its own drained award, and
	// leaving the slide ends it; fails_when=a null answer drops the overlay or the
	// overlay outlives the slide; no_claim=re-entry data (deck test).
	it("keeps the overlay across a null answer until the slide is left", async () => {
		getAwardReveal.mockResolvedValue(null);
		readQueue.mockResolvedValue([setOp("best_speaker", "Sam")]);
		const view = mount();
		await flush();
		readQueue.mockResolvedValue([]);
		await vi.advanceTimersByTimeAsync(5);
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(1);
		});
		await flush(5100);
		expect(view.result.current).toEqual([
			{ category: "best_speaker", name: "Sam" },
		]);
		view.rerender({ onSlide: false, meetingId: "m1" });
		await flush();
		expect(view.result.current).toEqual([]);
	});

	// protects=item 1: a reopened deck never shows the previous session's cached
	// winners (an in-app sign-out keeps the QueryClient), not while its own fetch
	// is pending and not when it rejects (offline); fails_when=the hook consumes
	// data this mount did not fetch; no_claim=the cache's lifetime (next test).
	it.each([
		["is still pending", () => new Promise(() => {})],
		["rejects", () => Promise.reject(new Error("offline"))],
	])("does not show the last session's cached winners while its own fetch %s", async (_n, second) => {
		getAwardReveal.mockResolvedValueOnce({
			winners: [{ category: "best_speaker", name: "Last Session" }],
		});
		const first = mount();
		await flush();
		expect(first.result.current).toEqual([
			{ category: "best_speaker", name: "Last Session" },
		]);
		first.unmount(); // sign-out: the deck closes, the QueryClient lives on
		getAwardReveal.mockImplementation(second);
		const again = mount(true, first.qc);
		await flush();
		expect(again.result.current).toEqual([]);
		await flush(5100);
		expect(again.result.current).toEqual([]);
	});

	// protects=item 1: nothing is kept in the cache once the deck closes;
	// fails_when=gcTime is not 0; no_claim=what a mount does with data.
	it("keeps nothing in the cache after the deck closes", async () => {
		getAwardReveal.mockResolvedValue({
			winners: [{ category: "best_speaker", name: "Sam" }],
		});
		const view = mount();
		await flush();
		expect(view.qc.getQueryData(["award-reveal", "m1"])).toBeDefined();
		view.unmount();
		await flush();
		expect(view.qc.getQueryData(["award-reveal", "m1"])).toBeUndefined();
	});

	// protects=item 3 / AC16: a fetch that STARTS after the drain's queue read
	// began but before it resolved cannot have seen the op, so it must not clear
	// the overlay; fails_when=the overlay is stamped before the read resolves;
	// no_claim=a fetch that starts after the read (the later-fetch test).
	it("a fetch that starts while the drain read is pending does not clear the overlay", async () => {
		readQueue.mockResolvedValue([setOp("best_table_topics", "New")]);
		getAwardReveal.mockReturnValueOnce(new Promise(() => {}));
		const view = mount();
		await flush();
		expect(view.result.current).toEqual([
			{ category: "best_table_topics", name: "New" },
		]);
		let resolveRead: (v: QueuedOp[]) => void = () => {};
		readQueue.mockImplementationOnce(
			() =>
				new Promise<QueuedOp[]>((r) => {
					resolveRead = r;
				}),
		);
		let resolveFetch: (v: unknown) => void = () => {};
		getAwardReveal.mockReturnValueOnce(
			new Promise((r) => {
				resolveFetch = r;
			}),
		);
		await act(async () => {
			broadcast(); // the drain read starts and hangs
			await vi.advanceTimersByTimeAsync(5);
		});
		await act(async () => {
			void view.qc.refetchQueries({ queryKey: ["award-reveal", "m1"] });
			await vi.advanceTimersByTimeAsync(5);
		});
		readQueue.mockResolvedValue([]);
		await act(async () => {
			resolveRead([]); // the drain: the op is gone
			await vi.advanceTimersByTimeAsync(1);
		});
		await act(async () => {
			resolveFetch({
				winners: [{ category: "best_table_topics", name: "Old" }],
			});
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(view.result.current).toEqual([
			{ category: "best_table_topics", name: "New" },
		]);
	});

	// protects=item 4: leaving the slide clears only what a null answer was
	// holding; an entry nothing has answered survives leave and re-entry; fails_when=
	// every exit clears the overlay; no_claim=the null case (above).
	it("keeps an unconfirmed drained award across leaving and re-entering the slide", async () => {
		getAwardReveal.mockReturnValue(new Promise(() => {}));
		readQueue.mockResolvedValue([setOp("best_speaker", "Sam")]);
		const view = mount();
		await flush();
		readQueue.mockResolvedValue([]);
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(5);
		});
		expect(view.result.current).toEqual([
			{ category: "best_speaker", name: "Sam" },
		]);
		view.rerender({ onSlide: false, meetingId: "m1" });
		await flush();
		view.rerender({ onSlide: true, meetingId: "m1" });
		await flush();
		expect(view.result.current).toEqual([
			{ category: "best_speaker", name: "Sam" },
		]);
	});

	// protects=item 5: another meeting starts from nothing; fails_when=the old
	// meeting's queue or overlay is shown under the new id; no_claim=the new
	// meeting's own queue (its read hangs here).
	it("resets its queue and overlay when the meeting changes", async () => {
		getAwardReveal.mockReturnValue(new Promise(() => {}));
		readQueue.mockResolvedValue([setOp("best_speaker", "Sam")]);
		const view = mount();
		await flush();
		expect(view.result.current).toHaveLength(1);
		readQueue.mockReturnValue(new Promise(() => {}));
		view.rerender({ onSlide: true, meetingId: "m2" });
		await flush();
		expect(view.result.current).toEqual([]);
		// And the new meeting's own queue is read.
		readQueue.mockResolvedValue([setOp("best_evaluator", "Eve")]);
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(5);
		});
		expect(view.result.current).toEqual([
			{ category: "best_evaluator", name: "Eve" },
		]);
	});

	// protects=item 6: a queue read that throws is an EMPTY queue, and the
	// previous ops are not treated as drained into the overlay; fails_when=the
	// old queue is kept or projected from the overlay; no_claim=a throw on mount
	// (the earlier test).
	it("a later queue read that throws empties the queue without a ghost overlay", async () => {
		getAwardReveal.mockReturnValue(new Promise(() => {}));
		readQueue.mockResolvedValue([setOp("best_speaker", "Sam")]);
		const view = mount();
		await flush();
		expect(view.result.current).toHaveLength(1);
		readQueue.mockRejectedValue(new Error("no indexedDB"));
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(5);
		});
		expect(view.result.current).toEqual([]);
		readQueue.mockResolvedValue([]);
		await act(async () => {
			broadcast();
			await vi.advanceTimersByTimeAsync(5);
		});
		expect(view.result.current).toEqual([]);
	});
});
