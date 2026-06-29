// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	clearStoredMember,
	memberKey,
	readStoredMember,
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
