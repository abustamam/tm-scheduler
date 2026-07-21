import { describe, expect, it } from "vitest";
import { inviteStateOf } from "./invite-state";

describe("inviteStateOf", () => {
	it("is 'joined' when the person is linked to an account", () => {
		expect(inviteStateOf({ userId: "u1", invitedAt: null })).toBe("joined");
	});

	it("'joined' wins even if an invite was also sent earlier", () => {
		expect(inviteStateOf({ userId: "u1", invitedAt: new Date() })).toBe(
			"joined",
		);
	});

	it("is 'invited' when an invite was sent but not yet accepted", () => {
		expect(inviteStateOf({ userId: null, invitedAt: new Date() })).toBe(
			"invited",
		);
	});

	it("accepts an ISO string invitedAt (server-serialized dates)", () => {
		expect(
			inviteStateOf({ userId: null, invitedAt: "2026-07-20T00:00:00.000Z" }),
		).toBe("invited");
	});

	it("is 'none' when never invited and unlinked", () => {
		expect(inviteStateOf({ userId: null, invitedAt: null })).toBe("none");
	});
});
