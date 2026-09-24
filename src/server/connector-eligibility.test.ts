// `mayUseConnector` (#852): the one statement of who may connect an app.
// `adminClubsForUser` is the DB-backed half and has its own coverage through
// `/api/mcp`; this pins what the rule makes of its answer.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./mcp/authz-logic", () => ({ adminClubsForUser: vi.fn() }));

import { mayUseConnector } from "./connector-eligibility";
import { adminClubsForUser, type TokenClub } from "./mcp/authz-logic";

const club = (archived: boolean): TokenClub =>
	({ clubId: crypto.randomUUID(), archived }) as TokenClub;

beforeEach(() => {
	vi.mocked(adminClubsForUser).mockReset();
});

describe("mayUseConnector", () => {
	it("is true for an admin or officer of at least one open club", async () => {
		vi.mocked(adminClubsForUser).mockResolvedValue([club(true), club(false)]);
		expect(await mayUseConnector("user-1")).toBe(true);
		expect(adminClubsForUser).toHaveBeenCalledExactlyOnceWith("user-1");
	});

	it("is false for someone who is an admin or officer nowhere", async () => {
		vi.mocked(adminClubsForUser).mockResolvedValue([]);
		expect(await mayUseConnector("user-1")).toBe(false);
	});

	it("is false when every club they are an officer of is archived", async () => {
		vi.mocked(adminClubsForUser).mockResolvedValue([club(true), club(true)]);
		expect(await mayUseConnector("user-1")).toBe(false);
	});
});
