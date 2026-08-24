// src/test/template-beat-ids.ts
//
// Attach synthetic ids to seed beats so a test can RENDER them.
//
// `TemplateBeatSeed` deliberately has no `id`: a seed is pre-insert, and
// `seed-global-templates.ts` spreads the whole object into `.values(...)`, so
// an id on a seed would be written as the primary key of a uuid column (see
// `TemplateBeatSeed`'s docblock). `buildTemplateRows` needs ids, because the
// agenda editor addresses a beat by one.
//
// Tests that render a seed therefore need to bridge the two, and this is the
// one place that does it. The ids are positional placeholders, never uuids and
// never written anywhere — using an obviously-fake shape keeps them from being
// mistaken for real rows if one ever leaks into an assertion message.
import type {
	TemplateBeatRow,
	TemplateBeatSeed,
} from "#/lib/agenda-template-rows";

export function withBeatIds(beats: TemplateBeatSeed[]): TemplateBeatRow[] {
	return beats.map((b, i) => ({ ...b, id: `seed-beat-${i}` }));
}
