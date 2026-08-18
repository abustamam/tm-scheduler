import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ONLINE_WRITE_TIMEOUT_MS,
	raceWithDeadline,
} from "#/lib/offline-write-deadline";

describe("ONLINE_WRITE_TIMEOUT_MS", () => {
	it("stays inside an ABSOLUTE band, not one stated relative to itself", () => {
		// Deliberately two hard numbers. `expect(TIMEOUT).toBeLessThanOrEqual(
		// TIMEOUT)` passes for every value including one that reintroduces the
		// forever-hang this constant exists to bound (CLAUDE.md, "a test stated
		// RELATIVE to the constant it guards cannot fail"), and the whole reason
		// the number lives in `src/lib/` is so this assertion can reach it.
		//
		// Ceiling: past ~10s of a dead chip with no spinner, an officer mid-roll-
		// call reloads the page, which is the outcome the deadline exists to
		// prevent — a deadline longer than a human's patience is the hang wearing
		// a number. 15s is that ceiling with room, and it fails on the values that
		// matter (60_000, 600_000, Number.MAX_SAFE_INTEGER).
		expect(ONLINE_WRITE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
		// Floor: a write that is merely SLOW must not be timed out. One round trip
		// on congested club wifi is a multi-second affair, and timing that out
		// queues a write that in fact landed — harmless on the server (the replay
		// is idempotent) but the chip does not move until the drain lands, so the
		// officer taps again. 100ms would make that the normal case.
		expect(ONLINE_WRITE_TIMEOUT_MS).toBeGreaterThanOrEqual(4_000);
	});
});

describe("raceWithDeadline", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reports the work when it finishes first", async () => {
		await expect(raceWithDeadline(Promise.resolve(1), 50)).resolves.toBe(
			"settled",
		);
	});

	it("reports a timeout when the work never settles", async () => {
		vi.useFakeTimers();
		const raced = raceWithDeadline(new Promise<void>(() => {}), 1_000);
		await vi.advanceTimersByTimeAsync(1_001);
		await expect(raced).resolves.toBe("timeout");
	});

	it("re-throws a rejection that arrives before the deadline", async () => {
		// The caller's existing error handling — the toast on a failed write —
		// has to keep working, so a real error must not be flattened into an
		// outcome value.
		await expect(
			raceWithDeadline(Promise.reject(new Error("boom")), 1_000),
		).rejects.toThrow("boom");
	});

	it("swallows a rejection that arrives AFTER the deadline", async () => {
		// The abandoned request is nobody's caller any more, so its rejection has
		// no handler left — and an unhandled rejection on the meeting page is
		// logged for every viewer, including anonymous ones. `Promise.race`
		// consumes it; this test is what says so.
		vi.useFakeTimers();
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			let fail!: (err: Error) => void;
			const work = new Promise<void>((_, reject) => {
				fail = reject;
			});
			const raced = raceWithDeadline(work, 1_000);
			await vi.advanceTimersByTimeAsync(1_001);
			expect(await raced).toBe("timeout");
			fail(new Error("late"));
			// Two macrotask turns is more than enough for Node to report one.
			vi.useRealTimers();
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("clears its timer, so a settled race leaves nothing pending", async () => {
		vi.useFakeTimers();
		const clear = vi.spyOn(globalThis, "clearTimeout");
		await raceWithDeadline(Promise.resolve(1), 60_000);
		expect(clear).toHaveBeenCalled();
		// A leaked 60s timer keeps a vitest worker — and a real page — awake for
		// the full deadline after the write has already landed.
		expect(vi.getTimerCount()).toBe(0);
	});
});
