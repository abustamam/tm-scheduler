/**
 * Unit tests for the request-scoped read-write impersonation marker (#246).
 * `getRequest` is mocked so we control the "current request" object and can
 * assert the mark is scoped to it (keyed on the request, isolated per request).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const currentRequest = { id: "req" } as { id: string } | null;
let requestRef: typeof currentRequest;

vi.mock("@tanstack/react-start/server", () => ({
	getRequest: () => {
		if (!requestRef) throw new Error("No request");
		return requestRef;
	},
}));

import {
	getImpersonatedWriteActor,
	markImpersonatedWrite,
} from "./impersonation-actor";

describe("impersonation write marker", () => {
	beforeEach(() => {
		requestRef = { id: "req-a" };
	});
	afterEach(() => {
		requestRef = null;
	});

	it("returns null when nothing marked the request", () => {
		expect(getImpersonatedWriteActor()).toBeNull();
	});

	it("returns the superadmin id after the guard marks the request", () => {
		markImpersonatedWrite("super-1");
		expect(getImpersonatedWriteActor()).toBe("super-1");
	});

	it("scopes the mark to the request object (a new request is unmarked)", () => {
		markImpersonatedWrite("super-1");
		expect(getImpersonatedWriteActor()).toBe("super-1");
		// A different request (object identity) carries no mark.
		requestRef = { id: "req-b" };
		expect(getImpersonatedWriteActor()).toBeNull();
	});

	it("no-ops outside a request context", () => {
		requestRef = null;
		expect(() => markImpersonatedWrite("super-1")).not.toThrow();
		expect(getImpersonatedWriteActor()).toBeNull();
	});
});
