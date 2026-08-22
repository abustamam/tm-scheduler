import type { ActivityEntry } from "#/server/activity-feed";

export interface FormattedActivity {
	actor: string;
	summary: string;
}

/**
 * Turn one enriched activity entry into a human sentence: `{ actor, summary }`.
 * Pure — no dates (the view formats `createdAt`/`meetingScheduledAt` separately)
 * and no React. Unknown/future actions fall back to the raw action string.
 */
export function formatActivity(entry: ActivityEntry): FormattedActivity {
	const actor = entry.actorName ?? "Someone";
	const role = entry.roleName ?? "a role";
	const to = entry.subjectName ?? "someone";
	const from = entry.fromName ?? "someone";

	let summary: string;
	switch (entry.action) {
		// An officer can claim/release on someone else's behalf; when the subject
		// isn't the actor, "claimed"/"released" would attribute the role to the
		// wrong person — say who it actually went to (or came off of).
		case "claim":
			summary =
				entry.subjectName && entry.subjectName !== actor
					? `assigned ${role} to ${entry.subjectName}`
					: `claimed ${role}`;
			break;
		case "release":
			summary =
				entry.fromName && entry.fromName !== actor
					? `removed ${entry.fromName} from ${role}`
					: `released ${role}`;
			break;
		case "reassign":
			summary = `reassigned ${role}: ${from} → ${to}`;
			break;
		case "availability_set":
			summary =
				entry.subjectName && entry.subjectName !== actor
					? `marked ${entry.subjectName} unavailable`
					: "marked themselves unavailable";
			break;
		case "availability_clear":
			summary =
				entry.subjectName && entry.subjectName !== actor
					? `marked ${entry.subjectName} available again`
					: "marked themselves available again";
			break;
		case "outreach_set":
			summary = `marked ${entry.subjectName ?? "someone"} contacted`;
			break;
		case "outreach_clear":
			summary = `marked ${entry.subjectName ?? "someone"} not contacted`;
			break;
		// One action for every rung of the ladder (D1, 2026-08-11); the rung
		// lives in `detail.status`/`entry.status`, not the action name. The four
		// legacy cases above still have their own cases because historical
		// activity_log rows still carry them.
		case "plan_set": {
			const isOfficerForOther =
				entry.subjectName && entry.subjectName !== actor;
			switch (entry.status) {
				case "coming":
					summary = isOfficerForOther
						? `marked ${entry.subjectName} as coming`
						: "said they're coming";
					break;
				case "not_coming":
					summary = isOfficerForOther
						? `marked ${entry.subjectName} as not coming`
						: "said they can't make it";
					break;
				case "reached_out":
					summary = `reached out to ${entry.subjectName ?? "someone"}`;
					break;
				case null:
					summary = isOfficerForOther
						? `cleared ${entry.subjectName}'s planned attendance`
						: "cleared their planned attendance";
					break;
				default:
					// Unrecognized rung (e.g. a future enum value not yet cased here) —
					// say something true rather than mis-describing it as a clear.
					summary = isOfficerForOther
						? `updated ${entry.subjectName}'s planned attendance`
						: "updated their planned attendance";
			}
			break;
		}
		case "member_add":
			summary = `added member "${entry.subjectName ?? "someone"}"`;
			break;
		case "member_edit":
			summary = "updated a member's details";
			break;
		case "member_merge":
			summary = "merged a duplicate member";
			break;
		case "member_remove":
			summary = "removed a member";
			break;
		case "meeting_create":
			summary = "created the meeting";
			break;
		case "meeting_edit":
			switch (entry.change) {
				case "speaker_added":
					summary = "added a speaker";
					break;
				case "speaker_removed":
					summary = "removed a speaker";
					break;
				case "speaker_reordered":
					summary = "reordered speakers";
					break;
				case "role_added":
					summary = "added a role";
					break;
				case "role_removed":
					summary = "removed a role";
					break;
				case "template_sync":
					summary = "updated upcoming meetings to match the standard set";
					break;
				case "role_disabled":
					summary = "disabled a role for upcoming meetings";
					break;
				case "role_enabled":
					summary = "enabled a role for upcoming meetings";
					break;
				default:
					summary = "updated the meeting";
			}
			break;
		// A meeting was switched to a template, or back to the club's standard
		// shape (#agenda-templates). Deliberately does NOT name the template:
		// `ActivityEntry` carries no template name, and inventing one from
		// `detail.templateId` would need a join for a line nobody reads twice.
		// Without this case the `default` below renders the raw enum string.
		case "meeting_template_set":
			summary = "changed the meeting type";
			break;
		// Club-level actions (#495) — the first `targetType: "club"` entries an
		// ordinary admin can produce. Without these cases the `default` below
		// renders the raw enum string ("club_logo_set") on the Activity page.
		case "club_logo_set":
			summary = "updated the club logo";
			break;
		case "club_logo_removed":
			summary = "removed the club logo";
			break;
		// A role was removed from a meeting's own agenda editor (Task 8,
		// #agenda-templates). Without this case the `default` below renders the
		// raw enum string ("meeting_agenda_role_removed") on the Activity page.
		case "meeting_agenda_role_removed":
			summary = "removed a role from the agenda";
			break;
		default:
			summary = entry.action;
	}

	return { actor, summary };
}
