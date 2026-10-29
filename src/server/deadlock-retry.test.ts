import { describe, expect, it } from "vitest";
import { deadlock } from "#/test/deadlock";
import { CLUB_BUSY_MESSAGE } from "./club-write-lock";
import { withDeadlockRetry } from "./deadlock-retry";

describe("withDeadlockRetry (#1388)", () => {
	// protects=a 40P01 on the first attempt reruns the whole unit once, and outer state comes from the second attempt only;
	// fails_when=the helper does not retry, or reuses state from the aborted attempt;
	// no_claim=real deadlocks (integration suites).
	it("reruns once on 40P01 and keeps only the second attempt's outer state", async () => {
		let outer: string | null = null;
		let calls = 0;
		const result = await withDeadlockRetry(async () => {
			calls++;
			outer = `attempt-${calls}`;
			if (calls === 1) throw deadlock();
			return "done";
		});
		expect(result).toBe("done");
		expect(calls).toBe(2);
		expect(outer).toBe("attempt-2");
	});

	it("finds the code on a wrapped cause, as drizzle wraps pg errors", async () => {
		let calls = 0;
		await withDeadlockRetry(async () => {
			calls++;
			if (calls === 1) throw new Error("query failed", { cause: deadlock() });
		});
		expect(calls).toBe(2);
	});

	it("two 40P01s give CLUB_BUSY_MESSAGE with the last driver error as cause", async () => {
		const second = deadlock();
		let calls = 0;
		const err = await withDeadlockRetry(async () => {
			calls++;
			throw calls === 1 ? deadlock() : second;
		}).catch((e: unknown) => e);
		expect(calls).toBe(2);
		expect((err as Error).message).toBe(CLUB_BUSY_MESSAGE);
		expect((err as Error).cause).toBe(second);
	});

	it("does not retry any other error", async () => {
		for (const e of [
			Object.assign(new Error("dup"), { code: "23505" }),
			new Error("Member is not eligible"),
		]) {
			let calls = 0;
			await expect(
				withDeadlockRetry(async () => {
					calls++;
					throw e;
				}),
			).rejects.toBe(e);
			expect(calls).toBe(1);
		}
	});

	it("a non-deadlock error on the second attempt propagates as itself", async () => {
		const dup = Object.assign(new Error("dup"), { code: "23505" });
		let calls = 0;
		await expect(
			withDeadlockRetry(async () => {
				calls++;
				throw calls === 1 ? deadlock() : dup;
			}),
		).rejects.toBe(dup);
	});
});
