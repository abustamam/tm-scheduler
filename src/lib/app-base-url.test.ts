// `appBaseUrl()` (#902 moved it here): the server's own absolute origin for
// links written into text a human sends. Expected values are literals, never
// `appBaseUrl()` itself, so a change to the function cannot agree with itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appBaseUrl } from "./app-base-url";

beforeEach(() => {
	vi.unstubAllEnvs();
});
afterEach(() => {
	vi.unstubAllEnvs();
});

describe("appBaseUrl", () => {
	it("returns BETTER_AUTH_URL as given when it has no trailing slash", () => {
		vi.stubEnv("BETTER_AUTH_URL", "https://club.example.com");
		expect(appBaseUrl()).toBe("https://club.example.com");
	});

	it("strips one trailing slash", () => {
		vi.stubEnv("BETTER_AUTH_URL", "https://club.example.com/");
		expect(appBaseUrl()).toBe("https://club.example.com");
	});

	it("strips several trailing slashes", () => {
		vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000///");
		expect(appBaseUrl()).toBe("http://localhost:3000");
	});

	it("falls back to the production origin when BETTER_AUTH_URL is empty", () => {
		vi.stubEnv("BETTER_AUTH_URL", "");
		expect(appBaseUrl()).toBe("https://gavelup.app");
	});

	it("falls back to the production origin when BETTER_AUTH_URL is unset", () => {
		vi.stubEnv("BETTER_AUTH_URL", undefined);
		expect(appBaseUrl()).toBe("https://gavelup.app");
	});
});
