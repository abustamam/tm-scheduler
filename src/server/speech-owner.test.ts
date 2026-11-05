import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

import { speechOwnerOf } from "./slots-logic";

describe("speechOwnerOf (#1518)", () => {
	const empty = {
		assignedMemberId: null,
		personId: null,
		assignedGuestId: null,
	};

	it("a member holder owns through their Person", () => {
		expect(
			speechOwnerOf({ ...empty, assignedMemberId: "m", personId: "p" }),
		).toEqual({ personId: "p" });
	});

	it("a guest holder owns through the guest", () => {
		expect(speechOwnerOf({ ...empty, assignedGuestId: "g" })).toEqual({
			guestId: "g",
		});
	});

	it("an empty slot has no owner", () => {
		expect(speechOwnerOf(empty)).toBeNull();
	});

	it("a member without a Person falls through to nobody", () => {
		expect(speechOwnerOf({ ...empty, assignedMemberId: "m" })).toBeNull();
	});
});
