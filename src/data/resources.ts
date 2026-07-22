/**
 * Registry of public resource articles (#310). Metadata lives here (typed);
 * the prose body of each article lives in `content/resources/<slug>.md` and is
 * loaded by `resource-content.ts`. Kept free of `#/db` so client routes import
 * it safely.
 */

export type ResourceCategory = "Pathways" | "Roles" | "Meeting";

export type ResourceIcon = "book" | "clock" | "list" | "users" | "doc" | "star";

/** Icon-tile gradient tone, chosen by category. */
export type ResourceTone = "lagoon" | "palm" | "ink";

/** A downloadable role sheet. `href` is served from `public/role-sheets/`. */
export interface RoleSheet {
	label: string;
	href: string;
}

export interface Resource {
	/** URL slug and markdown filename (`content/resources/<slug>.md`). */
	slug: string;
	cat: ResourceCategory;
	icon: ResourceIcon;
	tone: ResourceTone;
	title: string;
	/** Card blurb. */
	desc: string;
	/** Printable sheets shown on the article (only `meeting-roles` in v1). */
	downloads?: RoleSheet[];
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

export const resources: Resource[] = [
	{
		slug: "what-to-expect",
		cat: "Meeting",
		icon: "clock",
		tone: "ink",
		title: "What to expect at a meeting",
		desc: "The running order of a typical Toastmasters meeting, start to finish.",
	},
	{
		slug: "meeting-roles",
		cat: "Roles",
		icon: "users",
		tone: "palm",
		title: "Meeting roles",
		desc: "What each role does — plus printable sheets for the hands-on roles.",
		downloads: [
			{ label: "Timer's log", href: "/role-sheets/timer.pdf" },
			{ label: "Ah-Counter's log", href: "/role-sheets/ah-counter.pdf" },
			{ label: "Grammarian's log", href: "/role-sheets/grammarian.pdf" },
			{
				label: "Ballot / Vote Counter tally",
				href: "/role-sheets/ballot-counter.pdf",
			},
			{
				label: "General Evaluator notes",
				href: "/role-sheets/general-evaluator.pdf",
			},
		],
	},
	{
		slug: "evaluation-crc",
		cat: "Roles",
		icon: "star",
		tone: "palm",
		title: "How to give a great evaluation",
		desc: "The Commend–Recommend–Commend method for helpful, encouraging feedback.",
	},
	{
		slug: "table-topics",
		cat: "Meeting",
		icon: "list",
		tone: "ink",
		title: "Table Topics guide",
		desc: "How the impromptu-speaking segment works and how to answer with confidence.",
	},
	{
		slug: "guest-faq",
		cat: "Meeting",
		icon: "doc",
		tone: "ink",
		title: "First-time guest FAQ",
		desc: "Do I have to speak? What do I wear? Is it free? Your questions answered.",
	},
	{
		slug: "what-is-pathways",
		cat: "Pathways",
		icon: "book",
		tone: "lagoon",
		title: "What is Pathways?",
		desc: "A short intro to the Toastmasters learning experience.",
	},
	{
		slug: "officer-roles",
		cat: "Roles",
		icon: "users",
		tone: "palm",
		title: "Club officer roles",
		desc: "Who runs the club — President, VP Education, and the rest of the team.",
	},
	{
		slug: "speech-contests",
		cat: "Meeting",
		icon: "star",
		tone: "ink",
		title: "Speech contests",
		desc: "The contest types, who can compete, and how the judging works.",
	},
	{
		slug: "timing-card",
		cat: "Roles",
		icon: "clock",
		tone: "palm",
		title: "Timing color-card reference",
		desc: "What green, amber, and red mean — plus the usual timing windows.",
	},
	{
		slug: "glossary",
		cat: "Meeting",
		icon: "book",
		tone: "ink",
		title: "Glossary of Toastmasters terms",
		desc: "Plain-language definitions of the words you'll hear at your first meetings.",
	},
];

/** Look up a resource by its URL slug. */
export function resourceBySlug(slug: string): Resource | undefined {
	return resources.find((r) => r.slug === slug);
}
