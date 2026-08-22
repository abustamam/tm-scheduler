/**
 * Per-meeting agenda editing (configurable agendas, Phase 2).
 *
 * A templated meeting owns a PRIVATE `meeting_templates` row (`meeting_id` non
 * null, created by `copyTemplateForMeeting`), so editing an agenda is editing
 * that copy and reaches no other meeting.
 *
 * A `*-logic.ts` module for the two reasons this repo documents: a top-level
 * db-touching export in a server-fn module drags `#/db` → `pg` → `Buffer` into
 * the client bundle, and a query living only inside a `createServerFn` handler
 * is unreachable from vitest — which for a module of gates is the whole ball
 * game.
 */
import { and, asc, eq } from "drizzle-orm";
import { db as database } from "#/db";
import {
	meetings,
	meetingTemplateBeats,
	meetingTemplateRoles,
	meetingTemplates,
} from "#/db/schema";
import { isMeetingLocked } from "#/lib/meeting-lifecycle";

export type AgendaDraftRow = {
	id: string;
	sortOrder: number;
	kind: "section" | "role" | "event";
	label: string;
	detail: string | null;
	minutes: number;
	roleKey: string | null;
	repeatsRoleKey: string | null;
	markGreen: number | null;
	markYellow: number | null;
	markRed: number | null;
};

export type AgendaDraftRole = {
	key: string;
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	isSpeakerRole: boolean;
};

export type AgendaDraft = {
	templateId: string;
	templateName: string;
	/** False once the meeting is locked. The rows still load — an agenda is
	 *  worth reading after the night, it just stops being writable. */
	editable: boolean;
	rows: AgendaDraftRow[];
	roles: AgendaDraftRole[];
};

/**
 * This meeting's editable agenda, or null when it has none.
 *
 * Null means STANDARD: a meeting with `template_id IS NULL` renders the
 * code-derived `RUN_OF_SHOW`, which this editor deliberately does not touch.
 */
export async function loadAgendaDraft(
	meetingId: string,
): Promise<AgendaDraft | null> {
	const [meeting] = await database
		.select({ templateId: meetings.templateId, status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!meeting?.templateId) return null;

	const [tpl] = await database
		.select({ id: meetingTemplates.id, name: meetingTemplates.name })
		.from(meetingTemplates)
		.where(
			and(
				eq(meetingTemplates.id, meeting.templateId),
				eq(meetingTemplates.meetingId, meetingId),
			),
		)
		.limit(1);
	// Not the meeting's OWN copy: a meeting converted before this feature still
	// points at a shared template, and editing that would rewrite it for every
	// club. Treated as not-yet-editable rather than silently editing the shared
	// row; `ensureAgendaDraft` (Task 7) upgrades it on first write.
	if (!tpl) return null;

	const [rows, roles] = await Promise.all([
		database
			.select({
				id: meetingTemplateBeats.id,
				sortOrder: meetingTemplateBeats.sortOrder,
				kind: meetingTemplateBeats.kind,
				label: meetingTemplateBeats.label,
				detail: meetingTemplateBeats.detail,
				minutes: meetingTemplateBeats.minutes,
				roleKey: meetingTemplateBeats.roleKey,
				repeatsRoleKey: meetingTemplateBeats.repeatsRoleKey,
				markGreen: meetingTemplateBeats.markGreen,
				markYellow: meetingTemplateBeats.markYellow,
				markRed: meetingTemplateBeats.markRed,
			})
			.from(meetingTemplateBeats)
			.where(eq(meetingTemplateBeats.templateId, tpl.id))
			.orderBy(asc(meetingTemplateBeats.sortOrder)),
		database
			.select({
				key: meetingTemplateRoles.key,
				name: meetingTemplateRoles.name,
				category: meetingTemplateRoles.category,
				defaultCount: meetingTemplateRoles.defaultCount,
				isSpeakerRole: meetingTemplateRoles.isSpeakerRole,
			})
			.from(meetingTemplateRoles)
			.where(eq(meetingTemplateRoles.templateId, tpl.id))
			.orderBy(asc(meetingTemplateRoles.sortOrder)),
	]);

	return {
		templateId: tpl.id,
		templateName: tpl.name,
		editable: !isMeetingLocked(meeting.status),
		rows,
		roles,
	};
}
