// `mayUseConnector` (#852): the one statement of who may connect an app.
// `memberClubsForUser` is the DB-backed half and has its own coverage through
// `/api/mcp`; this pins what the rule makes of its answer.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./mcp/authz-logic", () => ({ memberClubsForUser: vi.fn() }));

import { mayUseConnector } from "./connector-eligibility";
import { memberClubsForUser, type TokenClub } from "./mcp/authz-logic";

const club = (archived: boolean): TokenClub =>
	({ clubId: crypto.randomUUID(), archived }) as TokenClub;

beforeEach(() => {
	vi.mocked(memberClubsForUser).mockReset();
});

/**
 * Card: protects=`mayUseConnector` is true exactly when the user is an active
 * member (any standing) of at least one open club (#1281); fails_when=it
 * returns true for no club or only archived clubs, or false for a plain
 * member; no_claim=`memberClubsForUser` is mocked here, so the membership
 * query itself is covered by `mcp-member-audience.integration.test.ts`.
 */
describe("mayUseConnector", () => {
	it("is true for an active member (any standing) of at least one open club", async () => {
		vi.mocked(memberClubsForUser).mockResolvedValue([club(true), club(false)]);
		expect(await mayUseConnector("user-1")).toBe(true);
		expect(memberClubsForUser).toHaveBeenCalledExactlyOnceWith("user-1");
	});

	it("is false for someone who is an active member nowhere", async () => {
		vi.mocked(memberClubsForUser).mockResolvedValue([]);
		expect(await mayUseConnector("user-1")).toBe(false);
	});

	it("is false when every club they belong to is archived", async () => {
		vi.mocked(memberClubsForUser).mockResolvedValue([club(true), club(true)]);
		expect(await mayUseConnector("user-1")).toBe(false);
	});
});
