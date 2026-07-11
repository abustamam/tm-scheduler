/**
 * The 8 standard Toastmasters meeting roles seeded into a brand-new club's
 * `role_definitions` — a club is non-functional without them. Kept as a pure,
 * db-free constant so it can be shared by BOTH the dev seed (`src/db/seed.ts`)
 * and the superadmin onboarding console (`onboarding-logic.ts`, #182) without
 * duplicating role strings or pulling the self-executing seed script into the
 * server bundle.
 */
export type RoleSeed = {
	name: string;
	category: "leadership" | "speaker" | "evaluator" | "functionary";
	defaultCount: number;
	sortOrder: number;
	isSpeakerRole: boolean;
	description: string;
};

export const ROLE_TEMPLATE: RoleSeed[] = [
	{
		name: "Toastmaster of the Day",
		category: "leadership",
		defaultCount: 1,
		sortOrder: 10,
		isSpeakerRole: false,
		description:
			"Hosts the meeting: sets the theme, introduces each speaker and segment, and keeps energy and timing on track. Prep: review the agenda beforehand.",
	},
	{
		name: "Table Topics Master",
		category: "leadership",
		defaultCount: 1,
		sortOrder: 20,
		isSpeakerRole: false,
		description:
			"Leads the impromptu speaking segment by preparing 8–10 questions or scenarios and calling on members or guests to respond on the spot.",
	},
	{
		name: "Speaker",
		category: "speaker",
		defaultCount: 3,
		sortOrder: 30,
		isSpeakerRole: true,
		description:
			"Delivers a prepared speech from your Pathways project; coordinate with your evaluator on the project objectives and time target before the meeting.",
	},
	{
		name: "Evaluator",
		category: "evaluator",
		defaultCount: 3,
		sortOrder: 40,
		isSpeakerRole: false,
		description:
			"Provides structured written and verbal feedback on your assigned speaker's delivery, language, and achievement of their project goals.",
	},
	{
		name: "General Evaluator",
		category: "evaluator",
		defaultCount: 1,
		sortOrder: 50,
		isSpeakerRole: false,
		description:
			"Oversees meeting quality by evaluating all roles (except speakers) and summarizing feedback from the Timer, Ah-Counter, and Grammarian.",
	},
	{
		name: "Timer",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 60,
		isSpeakerRole: false,
		description:
			"Tracks and displays time signals for every speaker and evaluator, then reports any overtime violations to the General Evaluator at the end of the meeting.",
	},
	{
		name: "Ah-Counter",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 70,
		isSpeakerRole: false,
		description:
			"Tallies filler words (um, ah, so, you know, like) for each speaker during the meeting and reports the counts in the evaluation segment.",
	},
	{
		name: "Grammarian",
		category: "functionary",
		defaultCount: 1,
		sortOrder: 80,
		isSpeakerRole: false,
		description:
			"Introduces a Word of the Day, monitors language use throughout the meeting, and commends creative phrasing while noting grammatical slips in the evaluation segment.",
	},
];
