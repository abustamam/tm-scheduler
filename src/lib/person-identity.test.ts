import { describe, expect, it } from "vitest";
import { type KeeperCandidate, pickKeeper } from "./person-identity";

const c = (o: Partial<KeeperCandidate> & { id: string }): KeeperCandidate => ({
	linked: false,
	historyCount: 0,
	originalJoinDate: null,
	...o,
});

describe("pickKeeper", () => {
	it("returns null for an empty list", () => {
		expect(pickKeeper([])).toBeNull();
	});

	it("prefers a login-linked person over an unlinked one with more history", () => {
		const best = pickKeeper([
			c({ id: "unlinked", historyCount: 99 }),
			c({ id: "linked", linked: true, historyCount: 0 }),
		]);
		expect(best?.id).toBe("linked");
	});

	it("prefers more history when linked status is tied", () => {
		expect(
			pickKeeper([
				c({ id: "a", historyCount: 3 }),
				c({ id: "b", historyCount: 10 }),
			])?.id,
		).toBe("b");
	});

	it("breaks ties among linked/unlinked by history, then oldest join, then id", () => {
		const older = new Date("2020-01-01");
		const newer = new Date("2024-01-01");
		expect(
			pickKeeper([
				c({ id: "b", historyCount: 5, originalJoinDate: newer }),
				c({ id: "a", historyCount: 5, originalJoinDate: older }),
			])?.id,
		).toBe("a"); // older join wins the history tie

		expect(
			pickKeeper([
				c({ id: "z", historyCount: 5 }),
				c({ id: "a", historyCount: 5 }),
			])?.id,
		).toBe("a"); // null join dates → id asc is the final tiebreak
	});

	it("is a pure sort — does not mutate the input array", () => {
		const input = [c({ id: "x" }), c({ id: "y", linked: true })];
		const copy = [...input];
		pickKeeper(input);
		expect(input).toEqual(copy);
	});
});
