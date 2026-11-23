import { describe, expect, it, vi } from "vitest";

/**
 * protects=the claim the server instructions make about each write tool
 * (preview-first, confirm page, or applies on the first call), so a client that
 * follows them is never surprised by a write (#1657);
 * fails_when=a write tool has no `planHash` input and is in neither exported
 * list, a listed tool is missing from the instructions or is not registered, or
 * an immediate-apply tool's description lacks "APPLIES IMMEDIATELY" or the
 * ask-first line;
 * no_claim=that a tool in a list really behaves that way: the integration tests
 * own that.
 */
vi.mock("#/db", () => ({ db: {} }));

const { MCP_TOOLS } = await import("#/server/mcp/tools");
const {
	CONFIRM_PAGE_TOOLS,
	IMMEDIATE_APPLY_TOOLS,
	IMMEDIATE_APPLY_WORDING,
	buildMcpInstructions,
} = await import("#/lib/mcp-plan");

const names = MCP_TOOLS.map((t) => t.name);
const instructions = buildMcpInstructions();

describe("MCP preview contract", () => {
	it("every write tool takes planHash or is in exactly one list", () => {
		for (const t of MCP_TOOLS) {
			if (t.annotations.readOnlyHint) continue;
			const hasHash = Object.hasOwn(t.config.inputSchema ?? {}, "planHash");
			const inLists =
				(IMMEDIATE_APPLY_TOOLS as readonly string[]).filter((n) => n === t.name)
					.length +
				(CONFIRM_PAGE_TOOLS as readonly string[]).filter((n) => n === t.name)
					.length;
			expect(hasHash || inLists === 1, t.name).toBe(true);
			expect(inLists <= 1, t.name).toBe(true);
		}
	});

	it("every listed tool is registered and named in the instructions", () => {
		for (const n of [...IMMEDIATE_APPLY_TOOLS, ...CONFIRM_PAGE_TOOLS]) {
			expect(names, n).toContain(n);
			expect(instructions, n).toContain(n);
		}
	});

	it("instructions tell the model to confirm before an immediate-apply call", () => {
		expect(instructions).toContain("BEFORE calling");
	});

	it("every immediate-apply description says so and asks first", () => {
		for (const n of IMMEDIATE_APPLY_TOOLS) {
			const d = MCP_TOOLS.find((t) => t.name === n)?.config.description ?? "";
			expect(d, n).toContain(IMMEDIATE_APPLY_WORDING);
			expect(d, n).toContain("BEFORE calling");
		}
	});
});
