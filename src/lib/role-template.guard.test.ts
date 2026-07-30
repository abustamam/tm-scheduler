/**
 * ROLE_TEMPLATE seeds NEW clubs; a data migration refreshes EXISTING ones
 * (#444). Nothing else keeps the two in step, and they fail in opposite,
 * equally quiet ways: edit the template alone and every existing club keeps
 * stale copy forever, write the migration alone and every club created after
 * the deploy gets copy the migration has already replaced.
 *
 * So this asserts the text a description-refresh migration WRITES is text the
 * template actually contains. It reads the migration files rather than a
 * hard-coded list, so a future refresh is covered the day it lands.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLE_TEMPLATE } from "./role-template";

const DRIZZLE_DIR = join(process.cwd(), "drizzle");

/** Every `SET "description" = '…'` value across the migration history. */
function migrationDescriptions(): { file: string; text: string }[] {
	const out: { file: string; text: string }[] = [];
	for (const file of readdirSync(DRIZZLE_DIR).filter((f) =>
		f.endsWith(".sql"),
	)) {
		const sql = readFileSync(join(DRIZZLE_DIR, file), "utf8");
		// Only the SET side — the WHERE side quotes the OLD text on purpose, and
		// that string must NOT still be in the template.
		for (const m of sql.matchAll(
			/SET\s+"description"\s*=\s*\n?\s*'((?:[^']|'')*)'/g,
		)) {
			out.push({ file, text: m[1].replace(/''/g, "'") });
		}
	}
	return out;
}

describe("ROLE_TEMPLATE ⇄ description migrations (#444)", () => {
	const written = migrationDescriptions();

	// Guards the guard: a regex that silently stopped matching would make every
	// assertion below vacuous.
	it("finds the description writes in the migration history", () => {
		expect(written.length).toBeGreaterThan(0);
	});

	it("every description a migration writes is in ROLE_TEMPLATE", () => {
		const template = new Set(ROLE_TEMPLATE.map((r) => r.description));
		const orphaned = written.filter((w) => !template.has(w.text));
		// A miss means the two drifted: either the template was edited without a
		// migration, or a migration writes copy the template no longer seeds.
		expect(orphaned).toEqual([]);
	});

	it("no migration's OLD text is still what the template seeds", () => {
		// The WHERE side quotes the text being replaced. If the template still
		// carries it, the refresh never actually happened on the seed side and new
		// clubs keep getting the copy the migration exists to remove.
		const template = new Set(ROLE_TEMPLATE.map((r) => r.description));
		const stale: string[] = [];
		for (const file of readdirSync(DRIZZLE_DIR).filter((f) =>
			f.endsWith(".sql"),
		)) {
			const sql = readFileSync(join(DRIZZLE_DIR, file), "utf8");
			for (const m of sql.matchAll(
				/AND\s+"description"\s*=\s*\n?\s*'((?:[^']|'')*)'/g,
			)) {
				const old = m[1].replace(/''/g, "'");
				if (template.has(old)) stale.push(`${file}: ${old.slice(0, 60)}…`);
			}
		}
		expect(stale).toEqual([]);
	});
});
