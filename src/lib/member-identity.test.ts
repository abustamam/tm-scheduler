// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	clearStoredMember,
	memberKey,
	readStoredMember,
	resolveAsSeed,
	type StoredMember,
	storeMember,
} from "./member-identity";

describe("member-identity store", () => {
	const clubId = "club-1";
	afterEach(() => localStorage.clear());
	it("round-trips a member", () => {
		storeMember(clubId, { id: "m1", name: "Faisal" });
		expect(readStoredMember(clubId)).toEqual({ id: "m1", name: "Faisal" });
	});
	it("returns null when unset", () => {
		expect(readStoredMember(clubId)).toBeNull();
	});
	it("clear removes it", () => {
		storeMember(clubId, { id: "m1", name: "F" });
		clearStoredMember(clubId);
		expect(readStoredMember(clubId)).toBeNull();
	});
	it("malformed value → null (not a throw)", () => {
		localStorage.setItem(memberKey(clubId), "{bad");
		expect(readStoredMember(clubId)).toBeNull();
	});
});

/**
 * `?as=<memberId>` seeding (#665). These are the decision's whole surface: the
 * route does nothing with the param except ask this function, so a rule that is
 * not asserted here is not enforced anywhere reachable — a route file cannot be
 * mounted in vitest.
 *
 * Every case asserts the WHOLE returned object with `toEqual`, not just one
 * field, so a change that fixes one arm by breaking another cannot pass.
 */
describe("resolveAsSeed (?as= identity seeding, #665)", () => {
	const candidate: StoredMember = { id: "m-real", name: "Amara" };
	const session: StoredMember = { id: "m-session", name: "Signed In" };
	const someoneElse: StoredMember = { id: "m-alice", name: "Alice" };

	it("seeds a server-validated member into a browser with no identity", () => {
		expect(
			resolveAsSeed({
				asParam: "m-real",
				sessionMember: null,
				candidate,
				existingPick: null,
			}),
		).toEqual({ seed: candidate, stripParam: true });
	});

	it("does nothing at all when there is no ?as= param", () => {
		// stripParam false matters: a replace-navigation on every render of a
		// param-less page would fight the router for no reason.
		for (const asParam of [null, undefined, ""]) {
			expect(
				resolveAsSeed({
					asParam,
					sessionMember: null,
					candidate,
					existingPick: null,
				}),
			).toEqual({ seed: null, stripParam: false });
		}
	});

	it("never writes over a signed-in member's identity", () => {
		// The gate would win the RENDER either way (`sessionMember ?? picked`);
		// what this protects is the localStorage pick underneath, which resurfaces
		// when they sign out. Asserting `seed: null` is the whole point — a naive
		// implementation seeds here and every gate still looks green.
		expect(
			resolveAsSeed({
				asParam: "m-real",
				sessionMember: session,
				candidate,
				existingPick: null,
			}),
		).toEqual({ seed: null, stripParam: true });
	});

	it("does not re-point a browser that is already someone ELSE", () => {
		// The identity written here is the club-WIDE `gavelup:member:<club>` key
		// that drives claimSlot, releaseSlot, the season grid's availability
		// toggles and the activity-feed attribution behind all of them. So Alice
		// tapping a forwarded link naming Bob must not become Bob everywhere in
		// that club. The page still renders as the ?as= member — it reads that
		// from the server-validated payload, not from localStorage.
		expect(
			resolveAsSeed({
				asParam: "m-real",
				sessionMember: null,
				candidate,
				existingPick: someoneElse,
			}),
			// stripParam FALSE, and that is not an oversight. The route derives who
			// the page is about as `session ?? as ?? pick`, so dropping the param
			// flips the page to the OTHER member — Priya reading "Hi Omar" over
			// Omar's roles, one tap from answering as him. Verified in a browser;
			// no unit test on this function alone could have seen it.
		).toEqual({ seed: null, stripParam: false });
	});

	it("still seeds when the existing pick already IS that member", () => {
		// The half that fails if someone "fixes" the case above by never seeding.
		// A re-tap of your own link is the common case and writing the same value
		// again is a no-op, so it must stay on the seeding path.
		expect(
			resolveAsSeed({
				asParam: "m-real",
				sessionMember: null,
				candidate,
				existingPick: { id: "m-real", name: "Amara" },
			}),
		).toEqual({ seed: candidate, stripParam: true });
	});

	it("strips the param but stores nothing when the server rejected the id", () => {
		// candidate null = loadPublicPersonalMeetingView said no (unknown id,
		// wrong club, inactive member, malformed, or archived club).
		expect(
			resolveAsSeed({
				asParam: "not-a-member",
				sessionMember: null,
				candidate: null,
				existingPick: null,
			}),
		).toEqual({ seed: null, stripParam: true });
	});

	it("refuses to seed a candidate that is not the id ?as= named", () => {
		// The caller derives both from one fetch, so they agree today — but if a
		// session appears or drops between the fetch and this call, `candidate`
		// becomes the SESSION member and seeding it would write that identity
		// under the authority of an `?as=` the visitor never had.
		expect(
			resolveAsSeed({
				asParam: "m-real",
				sessionMember: null,
				candidate: { id: "m-someone-else", name: "Not Amara" },
				existingPick: null,
			}),
		).toEqual({ seed: null, stripParam: true });
	});

	it("strips a rejected param even for a signed-in member", () => {
		expect(
			resolveAsSeed({
				asParam: "not-a-member",
				sessionMember: session,
				candidate: null,
				existingPick: null,
			}),
		).toEqual({ seed: null, stripParam: true });
	});
});
