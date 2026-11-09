import { describe, expect, it, vi } from "vitest";

/**
 * protects=what `tools/list` tells a client about each tool's effects;
 * fails_when=a tool leaves `readOnlyHint` out (the protocol then reads it as a
 * writer, and ChatGPT Pro hides it), a writer is marked read-only, or a writer
 * leaves `destructiveHint` / `idempotentHint` out (flipping `assign_roles` to
 * read-only, or `whoami` to a writer, is the mutation check);
 * no_claim=that a tool marked read-only writes nothing: the hint is a
 * declaration, and the type allows no other shape, but only review keeps it
 * true. Adding a read-only tool means editing this list, on purpose.
 */
vi.mock("#/db", () => ({ db: {} }));

const { MCP_TOOLS } = await import("#/server/mcp/tools");

describe("MCP tool annotations", () => {
	it("every tool states readOnlyHint itself", () => {
		for (const t of MCP_TOOLS) {
			expect(Object.hasOwn(t.annotations ?? {}, "readOnlyHint"), t.name).toBe(
				true,
			);
			expect(typeof t.annotations.readOnlyHint, t.name).toBe("boolean");
		}
	});

	it("exactly these tools are read-only", () => {
		expect(
			MCP_TOOLS.filter((t) => t.annotations.readOnlyHint)
				.map((t) => t.name)
				.sort(),
		).toEqual([
			"find_people",
			"get_agenda",
			"get_import_report",
			"get_lineup_blast",
			"get_my_feedback",
			"get_my_schedule",
			"list_meetings",
			"whoami",
		]);
	});

	it("every writer states destructiveHint and idempotentHint", () => {
		for (const t of MCP_TOOLS) {
			if (t.annotations.readOnlyHint) continue;
			expect(typeof t.annotations.destructiveHint, t.name).toBe("boolean");
			expect(typeof t.annotations.idempotentHint, t.name).toBe("boolean");
		}
	});

	it("a tool that can clear or remove what is there is destructive", () => {
		const destructive = MCP_TOOLS.filter(
			(t) => !t.annotations.readOnlyHint && t.annotations.destructiveHint,
		)
			.map((t) => t.name)
			.sort();
		expect(destructive).toEqual([
			"assign_roles",
			"cancel_meeting",
			"claim_open_role",
			"edit_agenda",
			"edit_member",
			"edit_role_slots",
			"set_attendance",
			"set_awards",
			"set_contact_preference",
			"set_my_attendance",
			"update_meeting_schedule",
		]);
	});

	it("exactly these writers are idempotent", () => {
		const idempotent = MCP_TOOLS.filter(
			(t) => !t.annotations.readOnlyHint && t.annotations.idempotentHint,
		)
			.map((t) => t.name)
			.sort();
		expect(idempotent).toEqual([
			"cancel_meeting",
			"edit_member",
			"reschedule_meeting",
			"restore_meeting",
			"set_attendance",
			"set_awards",
			"set_contact_preference",
			"set_my_attendance",
			"update_meeting_schedule",
		]);
	});
});
