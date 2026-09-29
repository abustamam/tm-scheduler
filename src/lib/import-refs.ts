/**
 * The kinds of row an imported history maps a source id onto (#1046, epic
 * #1054). `import_refs.kind` is TEXT in the database, deliberately not a
 * pgEnum, so the importer can add a kind without a migration; this list is the
 * one place the allowed values live, and every write to `import_refs` parses
 * its kind through {@link importRefKindSchema}.
 *
 * Adding a kind is a code change here, not a schema change. Removing one is
 * not safe while rows carry it: a re-run would stop recognising them and
 * import duplicates.
 */
import { z } from "zod";

export const IMPORT_REF_KINDS = [
	"meeting",
	"speech",
	"role_slot",
	"guest",
	"person",
	"award",
	"table_topic",
	"attendance",
] as const;

export const importRefKindSchema = z.enum(IMPORT_REF_KINDS);

export type ImportRefKind = z.infer<typeof importRefKindSchema>;
