/**
 * Mock resource library data. Static reference content in the real app; the
 * category filter is client-side.
 */

export type ResourceCategory = "Pathways" | "Roles" | "Meeting" | "Officer";

export type ResourceIcon = "book" | "clock" | "list" | "users" | "doc" | "star";

/** Icon-tile gradient tone, chosen by category. */
export type ResourceTone = "lagoon" | "palm" | "ink";

export interface Resource {
	cat: ResourceCategory;
	icon: ResourceIcon;
	tone: ResourceTone;
	title: string;
	desc: string;
}

export function resourceToneGradient(tone: ResourceTone): string {
	switch (tone) {
		case "palm":
			return "linear-gradient(150deg, var(--palm), #245238)";
		case "ink":
			return "linear-gradient(150deg, var(--sea-ink-soft), var(--sea-ink))";
		default:
			return "linear-gradient(150deg, var(--lagoon), var(--lagoon-deep))";
	}
}

export const resourceCategories: Array<"all" | ResourceCategory> = [
	"all",
	"Pathways",
	"Roles",
	"Meeting",
	"Officer",
];

export const resources: Resource[] = [
	{
		cat: "Pathways",
		icon: "book",
		tone: "lagoon",
		title: "Pathways project library",
		desc: "Every project across all 11 paths, with objectives and the speeches required to advance.",
	},
	{
		cat: "Pathways",
		icon: "star",
		tone: "lagoon",
		title: "Path picker & assessment",
		desc: "The questionnaire that recommends a learning path based on a member's goals.",
	},
	{
		cat: "Pathways",
		icon: "list",
		tone: "lagoon",
		title: "Level completion checklist",
		desc: "What's required to finish each of the five levels and request your award.",
	},
	{
		cat: "Roles",
		icon: "users",
		tone: "palm",
		title: "Evaluation guide (CRC)",
		desc: "How to give a Commend–Recommend–Commend evaluation that actually helps.",
	},
	{
		cat: "Roles",
		icon: "clock",
		tone: "palm",
		title: "Timer & color cards",
		desc: "Green / amber / red timing windows for every speech and Table Topics.",
	},
	{
		cat: "Roles",
		icon: "doc",
		tone: "palm",
		title: "Grammarian & Ah-Counter sheet",
		desc: "Printable tracking sheet plus tips for the language roles.",
	},
	{
		cat: "Meeting",
		icon: "list",
		tone: "ink",
		title: "Agenda template",
		desc: "The standard running order Harborlight uses, ready to duplicate each week.",
	},
	{
		cat: "Meeting",
		icon: "doc",
		tone: "ink",
		title: "Speech contest rulebook",
		desc: "Rules and eligibility for the International, Humorous and Evaluation contests.",
	},
	{
		cat: "Officer",
		icon: "star",
		tone: "ink",
		title: "Officer handbook & club plan",
		desc: "Roles, responsibilities and the Distinguished Club Program goals for the year.",
	},
];
