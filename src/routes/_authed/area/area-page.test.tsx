// @vitest-environment jsdom
//
// The Area Director's page loader (#1119): what it does with the guard's
// refusal. `getAreaHealth` throws `NO_PERMISSION_MESSAGE` for a person with no
// current term on the area, and for an id that names no area; the loader must
// turn that into the router's not-found, so a refused director sees the same
// page as a link that never existed. Anything else, a real failure, must NOT be
// turned into a 404: it belongs on the error boundary.
//
// Drives the real loader with the server fn stubbed. The refusal itself, and
// the validator behind it, are proven at the real handler in
// `src/server/area-guards.integration.test.ts`.
import { isNotFound } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { NO_PERMISSION_MESSAGE } from "#/lib/permission-message";

const { getAreaHealth } = vi.hoisted(() => ({ getAreaHealth: vi.fn() }));
vi.mock("#/server/area-health", () => ({ getAreaHealth }));

import { Route } from "./$areaId";

const AREA_ID = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";

type Loader = (args: { params: { areaId: string } }) => Promise<unknown>;
const loader = Route.options.loader as Loader;

/** What the loader rejects with, or fails the test if it resolves. */
async function rejection(areaId = AREA_ID): Promise<unknown> {
	try {
		await loader({ params: { areaId } });
	} catch (err) {
		return err;
	}
	throw new Error("the loader resolved; it was expected to reject");
}

describe("the area page loader (#1119)", () => {
	it("asks for the area in the URL, and hands the health to the page", async () => {
		const health = { areaId: AREA_ID, label: "C3", clubs: [] };
		getAreaHealth.mockResolvedValueOnce(health);

		await expect(loader({ params: { areaId: AREA_ID } })).resolves.toBe(health);
		expect(getAreaHealth).toHaveBeenCalledWith({ data: { areaId: AREA_ID } });
	});

	it("turns the guard's refusal into the router's not-found, not an error", async () => {
		getAreaHealth.mockRejectedValueOnce(new Error(NO_PERMISSION_MESSAGE));

		const err = await rejection();

		expect(isNotFound(err)).toBe(true);
	});

	it("does the same for a malformed id, which the server refuses the same way", async () => {
		getAreaHealth.mockRejectedValueOnce(new Error(NO_PERMISSION_MESSAGE));

		const err = await rejection("x".repeat(500));

		expect(isNotFound(err)).toBe(true);
		// The id reached the server fn as written; the refusal is the server's.
		expect(getAreaHealth).toHaveBeenLastCalledWith({
			data: { areaId: "x".repeat(500) },
		});
	});

	it("lets any other failure through to the error boundary", async () => {
		const failure = new Error("connection terminated");
		getAreaHealth.mockRejectedValueOnce(failure);

		const err = await rejection();

		expect(isNotFound(err)).toBe(false);
		expect(err).toBe(failure);
	});

	it("does not mistake the sign-in refusal for a missing page", async () => {
		const signedOut = new Error("You need to be signed in to do that.");
		getAreaHealth.mockRejectedValueOnce(signedOut);

		const err = await rejection();

		expect(isNotFound(err)).toBe(false);
	});
});
