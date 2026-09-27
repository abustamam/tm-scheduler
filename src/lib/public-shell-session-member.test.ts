import { describe, expect, it } from "vitest";
import { type AuthContextLite, sessionMemberFor } from "./public-shell";

const CLUB = "club-a";
const OTHER = "club-b";

function ctx(over: Partial<AuthContextLite> = {}): AuthContextLite {
	return {
		user: { id: "u-1", name: "Sally Session", email: "sally@example.com" },
		clubs: [{ clubId: CLUB }],
		currentMemberId: "m-1",
		activeClubId: CLUB,
		...over,
	};
}

// #962: the ballot escapes the club shell, so it needs the shell's
// session-to-member mapping stated where it can reach it.
describe("sessionMemberFor", () => {
	it("is the session's member for a signed-in member of the active viewed club", () => {
		expect(sessionMemberFor(ctx(), CLUB)).toEqual({
			id: "m-1",
			name: "Sally Session",
		});
	});

	it("falls back to the email when the account name is empty, as it is in production", () => {
		expect(
			sessionMemberFor(
				ctx({ user: { id: "u-1", name: "", email: "sally@example.com" } }),
				CLUB,
			)?.name,
		).toBe("sally@example.com");
	});

	it("is null when signed out", () => {
		expect(
			sessionMemberFor(
				ctx({ user: null, clubs: [], activeClubId: null }),
				CLUB,
			),
		).toBeNull();
	});

	it("is null for a signed-in user who is not a member of the viewed club", () => {
		expect(
			sessionMemberFor(
				ctx({ clubs: [{ clubId: OTHER }], activeClubId: OTHER }),
				CLUB,
			),
		).toBeNull();
	});

	it("is null for a member of the viewed club while another club is active", () => {
		// `currentMemberId` belongs to the ACTIVE club here, so returning it would
		// vote as the member row of a different club.
		expect(
			sessionMemberFor(
				ctx({
					clubs: [{ clubId: OTHER }, { clubId: CLUB }],
					activeClubId: OTHER,
					currentMemberId: "m-other",
				}),
				CLUB,
			),
		).toBeNull();
	});

	it("is null when the viewed club is active but no member row resolved", () => {
		expect(sessionMemberFor(ctx({ currentMemberId: null }), CLUB)).toBeNull();
	});
});
