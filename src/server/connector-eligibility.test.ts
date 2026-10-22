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
