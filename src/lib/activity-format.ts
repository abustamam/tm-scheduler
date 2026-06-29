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
		case "claim":
			summary = `claimed ${role}`;
			break;
		case "release":
			summary = `released ${role}`;
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
		default:
			summary = entry.action;
	}

	return { actor, summary };
}
