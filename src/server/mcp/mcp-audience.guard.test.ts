import { describe, expect, it, vi } from "vitest";

/**
 * #1281. protects=the set of tools a plain club member may call;
 * fails_when=any tool other than these five declares `audience: "member"`
 * (flipping `assign_roles` is the mutation check), or one of them stops;
 * no_claim=that a listed tool is itself safe for a member: each still
 * authorizes through `authenticateToken` and its own query. Adding a member
 * tool means editing this list, on purpose.
 */
vi.mock("#/db", () => ({ db: {} }));

const { MCP_TOOLS } = await import("#/server/mcp/tools");

describe("MCP tool audiences (#1281)", () => {
	it("exactly the five member tools", () => {
		expect(
			MCP_TOOLS.filter((t) => t.audience === "member")
				.map((t) => t.name)
				.sort(),
		).toEqual([
			"claim_open_role",
			"get_my_feedback",
			"get_my_schedule",
			"set_my_attendance",
			"whoami",
		]);
	});

	it("every tool declares an audience", () => {
		for (const t of MCP_TOOLS) {
			expect(["officer", "member"], t.name).toContain(t.audience);
		}
	});
});
