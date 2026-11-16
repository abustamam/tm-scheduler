// @vitest-environment jsdom
/**
 * protects=`useQueuedWriteFlag` reports, for the write that just returned,
 *   whether it was queued (its direct call never resolved); a direct call that
 *   resolves late or a write that throws never touches another write's flag
 *   (#1648);
 * fails_when=the verdict is read from shared state a late resolve can clear, a
 *   throw clears the flag, or `consume` stops clearing it;
 * no_claim=the queue itself (use-offline-minutes tests) and what the callers
 *   skip (use-meeting-cover-offline, meeting-agenda-offline-refresh).
 */
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useQueuedWriteFlag } from "./queued-write-flag";

const setup = () => renderHook(() => useQueuedWriteFlag()).result;

describe("useQueuedWriteFlag", () => {
	it("a write whose direct call resolved is not queued", async () => {
		const flag = setup();
		await flag.current.run(async (track) => track(async () => 1)());
		expect(flag.current.consume()).toBe(false);
	});

	it("a write whose direct call never ran is queued, once", async () => {
		const flag = setup();
		await flag.current.run(async () => {});
		expect(flag.current.consume()).toBe(true);
		expect(flag.current.consume()).toBe(false);
	});

	it("run resolves with the write's result", async () => {
		const flag = setup();
		expect(await flag.current.run(async () => "r")).toBe("r");
	});

	it("a direct write after a queued one resets the flag", async () => {
		const flag = setup();
		await flag.current.run(async () => {});
		await flag.current.run(async (track) => track(async () => 1)());
		expect(flag.current.consume()).toBe(false);
	});

	it("a throwing write leaves the flag alone, set or clear", async () => {
		const flag = setup();
		await expect(
			flag.current.run(async () => {
				throw new Error("x");
			}),
		).rejects.toThrow("x");
		expect(flag.current.consume()).toBe(false);
		await flag.current.run(async () => {});
		await expect(
			flag.current.run(async () => {
				throw new Error("x");
			}),
		).rejects.toThrow("x");
		expect(flag.current.consume()).toBe(true);
	});

	it("a direct call resolving after its write returned does not clear a later write's flag", async () => {
		const flag = setup();
		let lateDirect: () => Promise<unknown> = async () => {};
		await flag.current.run(async (track) => {
			lateDirect = track(async () => 1);
		});
		flag.current.consume();
		await flag.current.run(async () => {}); // second write, queued
		await lateDirect();
		expect(flag.current.consume()).toBe(true);
	});

	it("keeps one identity across renders", () => {
		const r = renderHook(() => useQueuedWriteFlag());
		const first = r.result.current;
		r.rerender();
		expect(r.result.current).toBe(first);
	});
});
