/**
 * #1213: every key `members-logic.ts` lists as printing a member's name on a
 * past agenda or its minutes is covered by the guest-conversion undo, so a new
 * name-printing key cannot be added there and forgotten here. Role slots are the
 * one exception: the undo refuses them with its own held-slots check.
 */
import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

const { undoNameBlankingChecks } = await import(
	"#/server/guest-pipeline-logic"
);
const { PAST_AGENDA_MEMBER_KEYS, PAST_AGENDA_TIME_WINDOW_KEYS } = await import(
	"#/server/members-logic"
);

describe("undo guest conversion covers every past-agenda name key (#1213)", () => {
	it("has a created-scope check for each key of both lists, role slots aside", () => {
		const checks = undoNameBlankingChecks();
		const covered = new Set(checks.flatMap((c) => c.columns));
		for (const key of [
			...PAST_AGENDA_MEMBER_KEYS,
			...PAST_AGENDA_TIME_WINDOW_KEYS,
		]) {
			const table = getTableName(key.table);
			if (table === "role_slots") continue;
			expect(covered, table).toContain(`${table}.${key.memberColumn.name}`);
		}
		expect(checks.every((c) => c.scope === "created")).toBe(true);
		expect(covered).toContain("club_action_items.owner_member_id");
	});
});
