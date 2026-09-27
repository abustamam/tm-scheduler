/**
 * `getBallotDeviceToken` (#765): the possession proof the ballot sends with
 * every cast, so a vote can be changed only from the phone that cast it.
 *
 * Vitest runs in `node`, so `window.localStorage` is stubbed per case.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BALLOT_DEVICE_KEY, getBallotDeviceToken } from "./ballot-device";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function memoryStorage(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		getItem: vi.fn((k: string) => store.get(k) ?? null),
		setItem: vi.fn((k: string, v: string) => {
			store.set(k, v);
		}),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("getBallotDeviceToken", () => {
	it("mints a UUID once and stores it under the ballot-device key", () => {
		const storage = memoryStorage();
		vi.stubGlobal("window", { localStorage: storage });

		const token = getBallotDeviceToken();

		expect(token).toMatch(UUID);
		expect(storage.store.get(BALLOT_DEVICE_KEY)).toBe(token);
		expect(storage.setItem).toHaveBeenCalledTimes(1);
	});

	it("reuses the stored token on every later call", () => {
		const existing = "3f2b8c1e-0d4a-4e5b-9c6d-7e8f9a0b1c2d";
		const storage = memoryStorage({ [BALLOT_DEVICE_KEY]: existing });
		vi.stubGlobal("window", { localStorage: storage });

		expect(getBallotDeviceToken()).toBe(existing);
		expect(getBallotDeviceToken()).toBe(existing);
		expect(storage.setItem).not.toHaveBeenCalled();
	});

	it("replaces a stored value that is not a UUID, which the server would refuse", () => {
		const storage = memoryStorage({ [BALLOT_DEVICE_KEY]: "not-a-uuid" });
		vi.stubGlobal("window", { localStorage: storage });

		const token = getBallotDeviceToken();

		expect(token).toMatch(UUID);
		expect(storage.store.get(BALLOT_DEVICE_KEY)).toBe(token);
	});

	it("falls back to one token for the page's lifetime when storage throws", () => {
		vi.stubGlobal("window", {
			localStorage: {
				getItem: () => {
					throw new Error("SecurityError");
				},
				setItem: () => {
					throw new Error("SecurityError");
				},
			},
		});

		const first = getBallotDeviceToken();
		expect(first).toMatch(UUID);
		// The same token again, so a mis-tap can still be corrected before reload.
		expect(getBallotDeviceToken()).toBe(first);
	});
});
