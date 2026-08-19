/**
 * Idempotently seeds the GLOBAL agenda templates.
 *
 * Safe to re-run: keyed on `meeting_templates.key` where `club_id IS NULL`, and
 * it REPLACES the template's beats and roles rather than appending, so an edit
 * to `src/lib/contest-template.ts` reaches an already-seeded database.
 *
 * Materialized `role_definitions` rows are NOT touched — a club may have renamed
 * them, and #445 makes the club's own name authoritative. Use
 * `scripts/resync-template-roles.ts` to push a seed change into those.
 *
 * Deleting the template's roles/beats is safe precisely because slots do NOT
 * reference them: slots reference the materialized `role_definitions` rows.
 *
 * Run: bun run seed:templates
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "#/db";
import {
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
} from "#/db/schema";
import { CONTEST_TEMPLATE, type TemplateSeed } from "#/lib/contest-template";

export async function seedTemplate(seed: TemplateSeed): Promise<string> {
	return db.transaction(async (tx) => {
		const [existing] = await tx
			.select({ id: meetingTemplates.id })
			.from(meetingTemplates)
			.where(
				and(
					eq(meetingTemplates.key, seed.key),
					isNull(meetingTemplates.clubId),
				),
			)
			.limit(1);

		let templateId = existing?.id;
		if (templateId) {
			await tx
				.update(meetingTemplates)
				.set({
					name: seed.name,
					description: seed.description,
					defaultLengthMinutes: seed.defaultLengthMinutes,
				})
				.where(eq(meetingTemplates.id, templateId));
			await tx
				.delete(meetingTemplateBeats)
				.where(eq(meetingTemplateBeats.templateId, templateId));
			await tx
				.delete(meetingTemplateRoles)
				.where(eq(meetingTemplateRoles.templateId, templateId));
		} else {
			const [row] = await tx
				.insert(meetingTemplates)
				.values({
					clubId: null,
					key: seed.key,
					name: seed.name,
					description: seed.description,
					defaultLengthMinutes: seed.defaultLengthMinutes,
				})
				.returning({ id: meetingTemplates.id });
			if (!row) throw new Error(`Failed to insert template ${seed.key}`);
			templateId = row.id;
		}

		const id = templateId;
		await tx.insert(meetingTemplateRoles).values(
			seed.roles.map((r) => ({
				templateId: id,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: r.sortOrder,
				isSpeakerRole: r.isSpeakerRole,
				description: r.description,
			})),
		);
		await tx
			.insert(meetingTemplateBeats)
			.values(seed.beats.map((b) => ({ ...b, templateId: id })));
		return id;
	});
}

/** Every global template this app ships. */
export async function seedGlobalTemplates(): Promise<void> {
	for (const seed of [CONTEST_TEMPLATE]) {
		await seedTemplate(seed);
		console.log(`seeded template: ${seed.key}`);
	}
}

// Self-executing only when run directly, so the dev seed can import
// `seedGlobalTemplates` without triggering a second run.
if (import.meta.main) {
	await seedGlobalTemplates();
	process.exit(0);
}
