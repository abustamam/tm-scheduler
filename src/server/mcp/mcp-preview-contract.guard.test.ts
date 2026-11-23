import { describe, expect, it, vi } from "vitest";

/**
 * protects=the claim the server instructions make about each write tool
 * (preview-first, confirm page, or applies on the first call), so a client that
 * follows them is never surprised by a write (#1657);
 * fails_when=a write tool has no live `planHash` input (a retired one does not count)
 * and is in neither exported list, an immediate-apply tool has a `planHash`, a listed tool is missing from the instructions or is not registered, or
 * an immediate-apply tool's description does not start with
 * IMMEDIATE_APPLY_PREFIX;
 * no_claim=that a tool in a list really behaves that way: the integration tests
 * own that.
 */
vi.mock("#/db", () => ({ db: {} }));

const { MCP_TOOLS } = await import("#/server/mcp/tools");
const {
	CONFIRM_PAGE_TOOLS,
	IMMEDIATE_APPLY_TOOLS,
	IMMEDIATE_APPLY_PREFIX,
	buildMcpInstructions,
} = await import("#/lib/mcp-plan");

const names = MCP_TOOLS.map((t) => t.name);
const instructions = buildMcpInstructions();

describe("MCP preview contract", () => {
	it("every write tool has a live planHash or is in exactly one list", () => {
		let checked = 0;
		for (const t of MCP_TOOLS) {
			if (t.annotations.readOnlyHint) continue;
			checked++;
			// A retired `planHash` key (record_guest_book's) throws if sent, so it
			// is not a live input and must not satisfy the preview contract.
			const hash = (t.config.inputSchema ?? {}).planHash as
				| { description?: string }
				| undefined;
			const hasLiveHash =
				hash !== undefined &&
				!(hash.description ?? "").includes("No longer accepted");
			const inLists =
				(IMMEDIATE_APPLY_TOOLS as readonly string[]).filter((n) => n === t.name)
					.length +
				(CONFIRM_PAGE_TOOLS as readonly string[]).filter((n) => n === t.name)
					.length;
			expect(hasLiveHash || inLists === 1, t.name).toBe(true);
			expect(inLists <= 1, t.name).toBe(true);
		}
		expect(checked).toBeGreaterThan(0);
	});

	it("no immediate-apply tool has a planHash input", () => {
		for (const n of IMMEDIATE_APPLY_TOOLS) {
			const t = MCP_TOOLS.find((x) => x.name === n);
			expect(t, n).toBeDefined();
			expect(Object.hasOwn(t?.config.inputSchema ?? {}, "planHash"), n).toBe(
				false,
			);
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
			expect(d.startsWith(IMMEDIATE_APPLY_PREFIX), n).toBe(true);
		}
	});
});
