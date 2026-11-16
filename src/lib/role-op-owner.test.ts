/**
 * protects=who owns a queued role op: by member id, and by user id when the
 *   member is null on both sides (an impersonating superadmin); an op with no
 *   stamp at all is not checked;
 * fails_when=null === null reads as "same person" for two memberless users,
 *   or an unstamped op is refused;
 * no_claim=the handlers' use of it (slots-queued-handlers.integration.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
	PermanentRefusal,
	toPermanentRefusal,
} from "#/server/permanent-refusal";
import { roleOpOwnerMismatch } from "./role-op-owner";

describe("roleOpOwnerMismatch (#1638)", () => {
	it("compares member ids", () => {
		expect(
			roleOpOwnerMismatch({ queuedBy: "a" }, { memberId: "b", userId: "u" }),
		).toBe(true);
		expect(
			roleOpOwnerMismatch({ queuedBy: "a" }, { memberId: "a", userId: "u" }),
		).toBe(false);
	});

	it("compares user ids when both members are null", () => {
		const queued = { queuedBy: null, queuedByUserId: "su1" };
		expect(roleOpOwnerMismatch(queued, { memberId: null, userId: "su2" })).toBe(
			true,
		);
		expect(roleOpOwnerMismatch(queued, { memberId: null, userId: "su1" })).toBe(
			false,
		);
	});

	it("compares user ids when the member is unknown (archived club)", () => {
		expect(
			roleOpOwnerMismatch(
				{ queuedBy: "a", queuedByUserId: "u1" },
				{ memberId: undefined, userId: "u2" },
			),
		).toBe(true);
	});

	it("does not check an op that carries no stamp", () => {
		expect(roleOpOwnerMismatch({}, { memberId: "b", userId: "u" })).toBe(false);
	});
});

describe("toPermanentRefusal (#1638)", () => {
	const known = new Set(["Known refusal."]);
	// protects=P5: conversion is by exact message on a plain Error only;
	// fails_when=any plain Error, or a subclass carrying the message, converts.
	it("converts only a plain Error with a known message", () => {
		expect(() =>
			toPermanentRefusal(new Error("Known refusal."), known),
		).toThrow(PermanentRefusal);
		const other = new Error("Connection terminated");
		expect(() => toPermanentRefusal(other, known)).toThrow(other);
		class Driver extends Error {}
		const sub = new Driver("Known refusal.");
		expect(() => toPermanentRefusal(sub, known)).toThrow(sub);
	});
});
