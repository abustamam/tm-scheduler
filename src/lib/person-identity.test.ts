import { describe, expect, it } from "vitest";
import {
	absorbedEnrollmentMoves,
	earliestDate,
	type KeeperCandidate,
	pickKeeper,
} from "./person-identity";

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

describe("earliestDate", () => {
	it("returns the other date when one side is null", () => {
		const d = new Date("2020-01-01");
		expect(earliestDate(null, d)).toBe(d);
		expect(earliestDate(d, null)).toBe(d);
	});

	it("returns null when both sides are null", () => {
		expect(earliestDate(null, null)).toBeNull();
	});

	it("returns the earlier of two dates", () => {
		const older = new Date("2020-01-01");
		const newer = new Date("2024-01-01");
		expect(earliestDate(older, newer)).toBe(older);
		expect(earliestDate(newer, older)).toBe(older);
	});
});

describe("absorbedEnrollmentMoves", () => {
	const at = (iso: string) => new Date(iso);

	it("moves when the keeper isn't enrolled in that path (keeper = null)", () => {
		expect(
			absorbedEnrollmentMoves(
				{ approved: 0, lastSyncedAt: at("2020-01-01") },
				null,
			),
		).toBe(true);
	});

	it("moves when the absorbed enrollment has more approved levels", () => {
		expect(
			absorbedEnrollmentMoves(
				{ approved: 2, lastSyncedAt: at("2020-01-01") },
				{ approved: 1, lastSyncedAt: at("2024-01-01") },
			),
		).toBe(true);
	});

	it("does not move when the keeper's enrollment has more approved levels", () => {
		expect(
			absorbedEnrollmentMoves(
				{ approved: 1, lastSyncedAt: at("2024-01-01") },
				{ approved: 2, lastSyncedAt: at("2020-01-01") },
			),
		).toBe(false);
	});

	it("moves on a tie in approved levels when the absorbed synced more recently", () => {
		expect(
			absorbedEnrollmentMoves(
				{ approved: 1, lastSyncedAt: at("2024-01-01") },
				{ approved: 1, lastSyncedAt: at("2020-01-01") },
			),
		).toBe(true);
	});

	it("does not move on a tie in approved levels when the keeper synced more recently", () => {
		expect(
			absorbedEnrollmentMoves(
				{ approved: 1, lastSyncedAt: at("2020-01-01") },
				{ approved: 1, lastSyncedAt: at("2024-01-01") },
			),
		).toBe(false);
	});
});
