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
			summary = "marked themselves unavailable";
			break;
		case "availability_clear":
			summary = "marked themselves available again";
			break;
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
				default:
					summary = "updated the meeting";
			}
			break;
		default:
			summary = entry.action;
	}

	return { actor, summary };
}
