import { afterEach, describe, expect, it, vi } from "vitest";
import {
	captureDevMagicLink,
	isDevLoginEnabled,
	takeDevMagicLink,
} from "./dev-login";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("isDevLoginEnabled", () => {
	it("is OFF in production even with the flag set", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("ENABLE_DEV_LOGIN", "1");
		expect(isDevLoginEnabled()).toBe(false);
	});

	it("is OFF in dev without the flag", () => {
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("ENABLE_DEV_LOGIN", "");
		expect(isDevLoginEnabled()).toBe(false);
	});

	it("is ON only in non-production with the explicit flag", () => {
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("ENABLE_DEV_LOGIN", "1");
		expect(isDevLoginEnabled()).toBe(true);
	});
});

describe("captureDevMagicLink / takeDevMagicLink", () => {
	it("round-trips a link by email (case-insensitive) and consumes it once", () => {
		captureDevMagicLink(
			"VPE@Example.com",
			"http://localhost:3000/verify?token=abc",
		);
		expect(takeDevMagicLink("vpe@example.com")).toBe(
			"http://localhost:3000/verify?token=abc",
		);
		// consumed — a second read is empty
		expect(takeDevMagicLink("vpe@example.com")).toBeUndefined();
	});

	it("returns undefined for an unknown email", () => {
		expect(takeDevMagicLink("nobody@example.com")).toBeUndefined();
	});
});
