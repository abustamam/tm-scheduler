/**
 * Reads and materialization for agenda templates.
 *
 * A `*-logic.ts` module rather than part of `meeting-templates.ts` for the two
 * independent reasons this repo already documents: a top-level db-touching
 * export inside a server-fn module drags `#/db` → `pg` → `Buffer` into the
 * client bundle, and a query living only inside a `createServerFn` handler is
 * unreachable from vitest.
 */
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { db } from "#/db";
import { db as database } from "#/db";
import {
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
	roleDefinitions,
} from "#/db/schema";
import type {
	TemplateBeatRow,
	TemplateRoleRow,
} from "#/lib/agenda-template-rows";
import type { MeetingSlotDefs } from "./meeting-create-logic";

type DbOrTx =
	| typeof db
	| Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** A template as the picker shows it. */
export type MeetingTemplateSummary = {
	id: string;
	key: string;
	name: string;
	description: string | null;
	defaultLengthMinutes: number | null;
};

/**
 * Templates this club may apply: every enabled GLOBAL template (`club_id IS
 * NULL`) plus its own.
 *
 * The tenant boundary lives in the QUERY, not in a `.filter()` a later
 * refactor can drop with every test still green. Phase 1 writes no club-scoped
 * rows, but writing the predicate now means Phase 2's editor cannot leak one
 * club's template to another — the same shape #544 and #560 had to be fixed for.
 */
export async function listAvailableTemplates(
	clubId: string,
): Promise<MeetingTemplateSummary[]> {
	return database
		.select({
			id: meetingTemplates.id,
			key: meetingTemplates.key,
			name: meetingTemplates.name,
			description: meetingTemplates.description,
			defaultLengthMinutes: meetingTemplates.defaultLengthMinutes,
		})
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.enabled, true),
				or(
					isNull(meetingTemplates.clubId),
					eq(meetingTemplates.clubId, clubId),
				),
			),
		)
		.orderBy(asc(meetingTemplates.sortOrder), asc(meetingTemplates.name));
}

async function loadTemplateBeats(
	templateId: string,
): Promise<TemplateBeatRow[]> {
	return database
		.select({
			sortOrder: meetingTemplateBeats.sortOrder,
			kind: meetingTemplateBeats.kind,
			label: meetingTemplateBeats.label,
			detail: meetingTemplateBeats.detail,
			minutes: meetingTemplateBeats.minutes,
			roleKey: meetingTemplateBeats.roleKey,
			repeatsRoleKey: meetingTemplateBeats.repeatsRoleKey,
			flex: meetingTemplateBeats.flex,
			markGreen: meetingTemplateBeats.markGreen,
			markYellow: meetingTemplateBeats.markYellow,
			markRed: meetingTemplateBeats.markRed,
		})
		.from(meetingTemplateBeats)
		.where(eq(meetingTemplateBeats.templateId, templateId))
		.orderBy(asc(meetingTemplateBeats.sortOrder));
}

async function loadTemplateRoles(
	templateId: string,
): Promise<TemplateRoleRow[]> {
	return database
		.select({
			key: meetingTemplateRoles.key,
			name: meetingTemplateRoles.name,
			isSpeakerRole: meetingTemplateRoles.isSpeakerRole,
		})
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId))
		.orderBy(asc(meetingTemplateRoles.sortOrder));
}

/**
 * A template's beats and roles. Null when it has neither — which, for a
 * `meetings.template_id` pointer, means corruption, since that FK is ON DELETE
 * RESTRICT and the template therefore cannot have been deleted.
 *
 * NO existence check, and the two selects run in PARALLEL. This is called from
 * `loadMeetingDetail`, which TODOS.md already flags as issuing ~15 sequential
 * round trips that every roll-mode write re-runs; three more sequential ones
 * would land on the exact path that hurts, on contest night. An existence
 * SELECT the foreign key already guarantees is not worth a round trip.
 */
export async function loadTemplateContent(
	templateId: string,
): Promise<{ beats: TemplateBeatRow[]; roles: TemplateRoleRow[] } | null> {
	const [beats, roles] = await Promise.all([
		loadTemplateBeats(templateId),
		loadTemplateRoles(templateId),
	]);
	// Both empty = no such template. A Phase 2 editor could create a template
	// with no beats AND no roles, which would read as missing here; give it at
	// least one row, or restore the existence check at that point.
	if (beats.length === 0 && roles.length === 0) return null;
	return { beats, roles };
}

/**
 * The ONE definition of "which role definitions does this meeting draw slots
 * from" — the club's ENABLED standard roles when there is no template, the
 * template's materialized roles when there is.
 *
 * Exported so every reader shares one predicate instead of each spelling it
 * out. Six modules select role definitions by club, and each is choosing a slot
 * source; leaving any of them unscoped puts the contest's Chief Judge and
 * Contestants on every standard meeting created afterwards.
 *
 * SCOPE ONLY — deliberately no `enabled` filter. `slots-logic`'s readers need
 * the unfiltered set: `clubRoles` computes `speakerEnabled` by looking up the
 * picked role's flag, and `applyAddRoleSlot` distinguishes "role not found"
 * from "this role is currently disabled". Filtering here would make the first
 * silently answer for the second and flip a user-visible error message.
 * `resolveMeetingRoleDefs` applies `enabled` itself, where it belongs.
 */
export function roleDefScope(clubId: string, templateId: string | null) {
	return and(eq(roleDefinitions.clubId, clubId), roleDefScopeOnly(templateId));
}

/** The template half of `roleDefScope`, for callers that already constrain the
 *  club themselves (`listRoleDefinitions` builds an array of predicates). */
export function roleDefScopeOnly(templateId: string | null) {
	return templateId === null
		? isNull(roleDefinitions.templateId)
		: eq(roleDefinitions.templateId, templateId);
}

/**
 * Copy a template's roles into this club's `role_definitions`, tagged with the
 * template. Idempotent on `(club_id, template_id, key)` via the partial unique
 * index, and `DO NOTHING` rather than `DO UPDATE` so a club's own rename of a
 * materialized role survives every later re-application — the club's name is
 * what every surface labels with (#445), and re-materializing must not undo it.
 *
 * Copy-once is the same contract `ROLE_TEMPLATE` already has: it seeds
 * `role_definitions` at club creation and editing the constant later reaches no
 * existing club. `scripts/resync-template-roles.ts` is the deliberate escape
 * hatch for pushing a seed change to clubs that already used the template.
 *
 * Required at all because `role_slots.role_definition_id` is NOT NULL and
 * restricting: a claimable contest role has to be a real `role_definitions` row.
 */
export async function materializeTemplateRoles(
	conn: DbOrTx,
	clubId: string,
	templateId: string,
): Promise<void> {
	const roles = await conn
		.select()
		.from(meetingTemplateRoles)
		.where(eq(meetingTemplateRoles.templateId, templateId))
		.orderBy(asc(meetingTemplateRoles.sortOrder));
	if (roles.length === 0) return;

	await conn
		.insert(roleDefinitions)
		.values(
			roles.map((r) => ({
				clubId,
				templateId,
				key: r.key,
				name: r.name,
				category: r.category,
				defaultCount: r.defaultCount,
				sortOrder: r.sortOrder,
				isSpeakerRole: r.isSpeakerRole,
				description: r.description,
			})),
		)
		.onConflictDoNothing();
}

/**
 * PURE READ. The role definitions a meeting's slots are generated from.
 *
 * Deliberately does NOT materialize. A function named `resolve…` that quietly
 * INSERTs is a surprise for the next caller, and it made the conversion preview
 * impossible to build on: showing an officer what a change would do must not
 * itself change anything, so a preview could not call a resolver that writes
 * and would have had to duplicate this predicate. One rule, two callers.
 *
 * For a template this club has never used the result is EMPTY — the caller must
 * call `materializeTemplateRoles` first, which `applyTemplateConversion` does as
 * its own explicit step.
 */
export async function resolveMeetingRoleDefs(
	conn: DbOrTx,
	clubId: string,
	templateId: string | null,
): Promise<MeetingSlotDefs[]> {
	return conn
		.select({
			id: roleDefinitions.id,
			defaultCount: roleDefinitions.defaultCount,
			enabled: roleDefinitions.enabled,
			category: roleDefinitions.category,
			isSpeakerRole: roleDefinitions.isSpeakerRole,
			sortOrder: roleDefinitions.sortOrder,
		})
		.from(roleDefinitions)
		.where(
			templateId === null
				? // A club's `enabled` flag is its skeleton-crew switch over its OWN
					// roles. A template's roles are the contest's fixed shape, not a
					// menu — honouring the flag there would silently drop a required
					// position from the run of show.
					and(roleDefScope(clubId, null), eq(roleDefinitions.enabled, true))
				: roleDefScope(clubId, templateId),
		)
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleDefinitions.name));
}
