/**
 * Pure unit tests for the ingest logic's route-layer helpers (no DB). The
 * Bearer-header parsing used to live inline in the route wrapper, which runs in
 * no test — a parsing regression there would silently weaken auth while CI
 * stayed green. `#/db` is mocked so importing the module needs no DATABASE_URL.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

const { parseBearerToken } = await import("./pathways-ingest-logic");

describe("parseBearerToken", () => {
	it("returns null for an absent header", () => {
		expect(parseBearerToken(null)).toBeNull();
	});

	it("extracts the token from a well-formed Bearer header", () => {
		expect(parseBearerToken("Bearer abc")).toBe("abc");
	});

	it("is case-insensitive on the scheme (RFC 7235)", () => {
		expect(parseBearerToken("bearer abc")).toBe("abc");
		expect(parseBearerToken("BEARER abc")).toBe("abc");
	});

	it("rejects a non-Bearer scheme", () => {
		expect(parseBearerToken("Basic abc")).toBeNull();
	});

	it("returns null when the scheme is present but the token is missing", () => {
		expect(parseBearerToken("Bearer")).toBeNull();
		expect(parseBearerToken("Bearer ")).toBeNull();
	});

	it("tolerates leading/trailing whitespace around the header", () => {
		expect(parseBearerToken("  Bearer abc  ")).toBe("abc");
	});
});
