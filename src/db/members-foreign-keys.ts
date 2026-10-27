import { getTableName, is } from "drizzle-orm";
import { getTableConfig, type PgColumn, PgTable } from "drizzle-orm/pg-core";
import * as dbSchema from "#/db/schema";
import { members } from "#/db/schema";

/** One foreign key to `members.id`, read off the drizzle schema. */
export type MembersForeignKey = {
	/** `table.column`, the name the database and the undo's key table use. */
	key: string;
	/** `undefined` is NO ACTION. */
	onDelete: string | undefined;
	table: PgTable;
	column: PgColumn;
};

/**
 * Every foreign key to `members.id`, read off the drizzle schema (#1322).
 *
 * Lives here, beside the schema, because it needs every table and the schema is
 * only ever imported by name in `src/server` (`meeting-writers.guard.test.ts`
 * refuses a namespace import there, since it hides which table a write names).
 * This module only READS table metadata, and the guest-conversion undo takes the
 * result by name. Reading the metadata also keeps the mentorship tables out of
 * `guest-pipeline-logic.ts`, which `mentorship-not-public.guard.test.ts` forbids
 * from naming them.
 */
export function foreignKeysToMembers(): MembersForeignKey[] {
	const out: MembersForeignKey[] = [];
	const seen = new Set<PgTable>();
	for (const value of Object.values(dbSchema)) {
		if (!is(value, PgTable) || seen.has(value)) continue;
		seen.add(value);
		for (const fk of getTableConfig(value).foreignKeys) {
			const ref = fk.reference();
			if (ref.foreignTable !== members) continue;
			for (const column of ref.columns) {
				out.push({
					key: `${getTableName(value)}.${column.name}`,
					onDelete: fk.onDelete,
					table: value,
					column,
				});
			}
		}
	}
	return out;
}
