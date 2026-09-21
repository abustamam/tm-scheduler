/**
 * `showWriteError`'s three branches (#761).
 *
 * Runs in the default `node` environment with `window` stubbed, not jsdom:
 * the module touches exactly `window.location.pathname`, `.search` and
 * `.assign`, and jsdom's `location` is non-configurable — spying on `assign`
 * there is a fight with the environment rather than a test of this code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	NOT_ON_ROSTER_MESSAGE,
	SIGN_IN_REQUIRED_MESSAGE,
} from "#/lib/write-proof";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const { showWriteError } = await import("./write-error-toast");

const assign = vi.fn();

beforeEach(() => {
	toastError.mockClear();
	assign.mockClear();
	vi.stubGlobal("window", {
		location: {
			pathname: "/club/abc/meeting/2026-09-20",
			search: "?tab=agenda&x=1",
			assign,
		},
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
});

/** The options object of the most recent `toast.error` call, if any. */
function lastOptions(): { action?: { label: string; onClick: () => void } } {
	return (toastError.mock.calls.at(-1)?.[1] ?? {}) as {
		action?: { label: string; onClick: () => void };
	};
}

describe("showWriteError", () => {
	it("offers a Sign in action that returns to where the refusal happened", () => {
		showWriteError(new Error(SIGN_IN_REQUIRED_MESSAGE), "Couldn't claim role.");

		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError.mock.calls[0]?.[0]).toBe(SIGN_IN_REQUIRED_MESSAGE);

		const action = lastOptions().action;
		expect(action?.label).toBe("Sign in");

		// Not just "there is an action" — where it goes. The path carries its
		// QUERY STRING, and it is encoded, so the `&` cannot split the redirect.
		expect(assign).not.toHaveBeenCalled();
		action?.onClick();
		expect(assign).toHaveBeenCalledWith(
			"/signin?redirect=%2Fclub%2Fabc%2Fmeeting%2F2026-09-20%3Ftab%3Dagenda%26x%3D1",
		);
	});

	it("gives the not-on-roster refusal NO action", () => {
		// Offering "Sign in" to somebody already signed in sends them round the
		// magic-link loop forever, which is why the two refusals are distinct
		// strings rather than one.
		showWriteError(new Error(NOT_ON_ROSTER_MESSAGE), "Couldn't update.");

		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError.mock.calls[0]?.[0]).toBe(NOT_ON_ROSTER_MESSAGE);
		expect(toastError.mock.calls[0]?.[1]).toBeUndefined();
		expect(lastOptions().action).toBeUndefined();
	});

	it("is byte-identical to today's behaviour for every other error", () => {
		// The branch that must not change: ~15 call sites were converted to this
		// helper, and for anything that is not one of the two write-proof
		// refusals the user must see exactly what they saw before.
		showWriteError(new Error("This meeting is locked."), "Couldn't update.");
		expect(toastError).toHaveBeenLastCalledWith("This meeting is locked.");
		expect(lastOptions().action).toBeUndefined();

		// A non-Error throw falls back to the call site's own string.
		showWriteError("nope", "Couldn't claim role.");
		expect(toastError).toHaveBeenLastCalledWith("Couldn't claim role.");

		showWriteError(undefined, "Couldn't save that answer.");
		expect(toastError).toHaveBeenLastCalledWith("Couldn't save that answer.");

		// A bare string carrying the refusal TEXT is not an Error, so it does not
		// get the action — the matchers are `instanceof Error` on purpose.
		showWriteError(SIGN_IN_REQUIRED_MESSAGE, "Couldn't update.");
		expect(toastError).toHaveBeenLastCalledWith("Couldn't update.");
		expect(assign).not.toHaveBeenCalled();
	});

	it("reads the location at CLICK time, not at import time", () => {
		// The module is imported during SSR, where `window` does not exist. If the
		// path were captured at module scope this test would have observed the
		// stale beforeEach value; it also proves the import itself never touched
		// `window`, since the stub is installed after it.
		showWriteError(new Error(SIGN_IN_REQUIRED_MESSAGE), "x");
		const action = lastOptions().action;
		vi.stubGlobal("window", {
			location: { pathname: "/officers", search: "", assign },
		});
		action?.onClick();
		expect(assign).toHaveBeenCalledWith("/signin?redirect=%2Fofficers");
	});
});
