import { MY_PATHWAYS_ANCHOR } from "#/lib/my-pathways-anchor";
import {
	CURRENT_PATH_GUIDE,
	type CurrentCourseCode,
	isCurrentCourseCode,
	PATHWAYS_CATALOG,
} from "#/lib/pathways-catalog";

/**
 * The path-selection quiz (#935): a short set of questions that SUGGESTS a
 * Pathways path. It never enrols anyone. The result pre-fills the existing
 * picker, and the member stays free to choose any path at all.
 *
 * ORIGINAL CONTENT (ADR-0024, #384). The questions, answers, weights and the
 * way they are combined were written for GavelUp from the path names and our
 * own `focus` lines (`CURRENT_PATH_GUIDE`), without reference to Toastmasters
 * International's own path assessment: not its questions, their order, its
 * answer scales, its categories or its path-to-answer mapping. Keep it that way
 * when editing: add a question by asking what a new member would want to get
 * better at, never by looking at TI's.
 *
 * Pure and client-safe: nothing here touches the server, and the quiz page
 * sends no answer anywhere. Only the path a member then adds is stored, through
 * the picker's existing `addMyPath`.
 */

/** Weight per current-path course code. */
export type PathWeights = Readonly<Partial<Record<CurrentCourseCode, number>>>;

export interface QuizOption {
	id: string;
	label: string;
	weights: PathWeights;
}

export interface QuizQuestion {
	id: string;
	prompt: string;
	options: readonly QuizOption[];
}

/** Question id → chosen option id. A question may be unanswered. */
export type QuizAnswers = Readonly<Record<string, string>>;

// Course codes, named so the weights below read as paths, not numbers.
const PRESENTATION: CurrentCourseCode = "8701";
const MOTIVATION: CurrentCourseCode = "8700";
const HUMOR: CurrentCourseCode = "8711";
const LEADERSHIP: CurrentCourseCode = "8706";
const VISION: CurrentCourseCode = "8704";
const PERSUASION: CurrentCourseCode = "8707";

export const PATH_QUIZ: readonly QuizQuestion[] = [
	{
		id: "six-months",
		prompt:
			"Picture yourself six months from now. Which of these would feel like the biggest win?",
		options: [
			{
				id: "steady-talk",
				label: "Giving a talk at work or school with steady hands",
				weights: { [PRESENTATION]: 3 },
			},
			{
				id: "go-to-lead",
				label:
					"Being the person a group turns to when it needs someone in charge",
				weights: { [LEADERSHIP]: 3 },
			},
			{
				id: "room-laughs",
				label: "Getting a room to laugh at something I said, on purpose",
				weights: { [HUMOR]: 3 },
			},
			{
				id: "won-round",
				label: "Bringing someone round to an idea they started out against",
				weights: { [PERSUASION]: 3 },
			},
		],
	},
	{
		id: "where",
		prompt: "Where do you expect to use what you learn most?",
		options: [
			{
				id: "pitches",
				label: "Presentations, pitches or interviews",
				weights: { [PRESENTATION]: 2, [PERSUASION]: 1 },
			},
			{
				id: "running-group",
				label: "Running a team, a project or a volunteer group",
				weights: { [LEADERSHIP]: 2, [MOTIVATION]: 1 },
			},
			{
				id: "social",
				label: "Toasts, stories and introductions at social occasions",
				weights: { [HUMOR]: 2, [PRESENTATION]: 1 },
			},
			{
				id: "future",
				label: "Planning where something I care about goes next",
				weights: { [VISION]: 2, [LEADERSHIP]: 1 },
			},
		],
	},
	{
		id: "stuck-group",
		prompt:
			"You're in a meeting that has stalled. What are you most likely to do?",
		options: [
			{
				id: "wait",
				label: "Stay quiet and hope somebody else speaks up",
				weights: { [PRESENTATION]: 2 },
			},
			{
				id: "lighten",
				label: "Crack a joke so everyone loosens up",
				weights: { [HUMOR]: 2 },
			},
			{
				id: "propose",
				label: "Propose a next step and get people moving",
				weights: { [LEADERSHIP]: 2 },
			},
			{
				id: "remind-why",
				label: "Remind everyone why the work matters in the first place",
				weights: { [MOTIVATION]: 2, [VISION]: 1 },
			},
		],
	},
	{
		id: "skill",
		prompt: "Which of these would you most like to get better at?",
		options: [
			{
				id: "structure",
				label: "Putting a talk together so it flows from start to finish",
				weights: { [PRESENTATION]: 2 },
			},
			{
				id: "encourage",
				label: "Lifting people up when they're losing steam",
				weights: { [MOTIVATION]: 3 },
			},
			{
				id: "explain-new",
				label:
					"Describing something that doesn't exist yet so others can see it",
				weights: { [VISION]: 3 },
			},
			{
				id: "pushback",
				label: "Handling pushback without getting flustered",
				weights: { [PERSUASION]: 3 },
			},
		],
	},
	{
		id: "funny",
		prompt: "How do you feel about being funny in front of people?",
		options: [
			{
				id: "want-funny",
				label: "I'd love to be better at it",
				weights: { [HUMOR]: 3 },
			},
			{
				id: "if-it-helps",
				label: "Happy to, if it helps the point land",
				weights: { [HUMOR]: 1, [MOTIVATION]: 1 },
			},
			{
				id: "straight",
				label: "I'd rather keep things straightforward",
				weights: { [PRESENTATION]: 1, [PERSUASION]: 1 },
			},
		],
	},
	{
		id: "audience",
		prompt: "Who do you most want to reach?",
		options: [
			{
				id: "listeners",
				label: "An audience I'm presenting to",
				weights: { [PRESENTATION]: 2 },
			},
			{
				id: "colleagues",
				label: "The people I work alongside every day",
				weights: { [MOTIVATION]: 2, [LEADERSHIP]: 1 },
			},
			{
				id: "undecided",
				label: "People who still need convincing",
				weights: { [PERSUASION]: 2 },
			},
			{
				id: "carriers",
				label: "People who'll carry an idea forward after I've shared it",
				weights: { [VISION]: 2 },
			},
		],
	},
	{
		id: "excites",
		prompt: "What kind of project gets you most excited?",
		options: [
			{
				id: "blank-page",
				label: "Starting something new from a blank page",
				weights: { [VISION]: 2 },
			},
			{
				id: "someone-grow",
				label: "Helping someone else grow",
				weights: { [MOTIVATION]: 2 },
			},
			{
				id: "own-result",
				label: "Taking responsibility for a result",
				weights: { [LEADERSHIP]: 2 },
			},
			{
				id: "win-vote",
				label: "Winning an argument or a vote",
				weights: { [PERSUASION]: 2 },
			},
		],
	},
];

/** The paths the quiz may suggest: current ones only, in catalog order. */
export const QUIZ_PATHS: readonly { courseCode: string; name: string }[] =
	PATHWAYS_CATALOG.filter((p) => p.status === "current").map((p) => ({
		courseCode: p.courseCode,
		name: p.name,
	}));

export interface PathSuggestion {
	courseCode: CurrentCourseCode;
	name: string;
	focus: string;
	tiUrl: string;
	score: number;
	/** The labels of the answers that pointed here, strongest first. */
	reasons: string[];
}

/** How many answer labels a "why" line quotes, at most. */
export const MAX_REASONS = 2;

/**
 * Score every current path against the answers. Each chosen option adds its
 * weight to the paths it names; an answer naming an unknown question or option
 * is ignored rather than trusted. Paths come back highest score first, ties in
 * catalog order, so the result is deterministic.
 */
export function scorePathQuiz(answers: QuizAnswers): PathSuggestion[] {
	const totals = new Map<string, number>();
	const reasons = new Map<string, { label: string; weight: number }[]>();
	for (const q of PATH_QUIZ) {
		const chosen = q.options.find((o) => o.id === answers[q.id]);
		if (!chosen) continue;
		for (const [code, weight] of Object.entries(chosen.weights)) {
			if (weight <= 0) continue;
			totals.set(code, (totals.get(code) ?? 0) + weight);
			const list = reasons.get(code) ?? [];
			list.push({ label: chosen.label, weight });
			reasons.set(code, list);
		}
	}

	return QUIZ_PATHS.flatMap((p, order) => {
		if (!isCurrentCourseCode(p.courseCode)) return [];
		const guide = CURRENT_PATH_GUIDE[p.courseCode];
		const why = [...(reasons.get(p.courseCode) ?? [])]
			// Stable sort: equal weights keep question order.
			.sort((a, b) => b.weight - a.weight)
			.slice(0, MAX_REASONS)
			.map((r) => r.label);
		return [
			{
				order,
				suggestion: {
					courseCode: p.courseCode,
					name: p.name,
					focus: guide.focus,
					tiUrl: guide.tiUrl,
					score: totals.get(p.courseCode) ?? 0,
					reasons: why,
				},
			},
		];
	})
		.sort(
			(a, b) => b.suggestion.score - a.suggestion.score || a.order - b.order,
		)
		.map((x) => x.suggestion);
}

/**
 * The one or two paths to show. The runner-up is shown only when it scored at
 * least half of the leader, so a distant second is not dressed up as a close
 * call. Nothing is suggested before any answer has scored.
 */
export function suggestPaths(answers: QuizAnswers): PathSuggestion[] {
	const [first, second] = scorePathQuiz(answers);
	if (!first || first.score <= 0) return [];
	if (second && second.score > 0 && second.score * 2 >= first.score) {
		return [first, second];
	}
	return [first];
}

/** True once every question has an answer. */
export function isQuizComplete(answers: QuizAnswers): boolean {
	return PATH_QUIZ.every((q) => q.options.some((o) => o.id === answers[q.id]));
}

/**
 * "Why" line, built from the member's own answers.
 */
export function suggestionWhy(s: PathSuggestion): string {
	const quoted = s.reasons.map((r) => `“${r}”`);
	if (quoted.length === 0) return "";
	return `You picked ${quoted.join(" and ")}.`;
}

/**
 * Handoff from the quiz page to the picker. "Use this path" stashes the chosen
 * course code in sessionStorage and goes to the dashboard, whose picker takes
 * it ONCE and opens itself with that path marked. sessionStorage rather than a
 * query parameter because the dashboard's `validateSearch` keeps only its own
 * keys, so an extra parameter would not survive the load. It never leaves the
 * browser, and a blocked storage just means the picker opens unmarked.
 */
export const QUIZ_HANDOFF_KEY = "gavelup.pathQuizSuggestion";
/** Where "Use this path" goes: the dashboard's My Pathways panel, whose
 *  picker is the one rendered with `acceptsQuizSuggestion`. */
export const QUIZ_HANDOFF_HREF = `/dashboard#${MY_PATHWAYS_ANCHOR}`;
/** The quiz page itself, linked from the picker and the Pathways explainer. */
export const PATH_QUIZ_HREF = "/resources/which-path";
/** The words every link to the quiz uses: the picker's and the checklist's. */
export const PATH_QUIZ_LINK_LABEL = "Take the quiz";

function sessionStore(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.sessionStorage;
	} catch {
		return null;
	}
}

export function stashQuizSuggestion(courseCode: CurrentCourseCode): void {
	try {
		sessionStore()?.setItem(QUIZ_HANDOFF_KEY, courseCode);
	} catch {
		// Storage blocked: the picker simply opens without a marked path.
	}
}

/** Read and clear the stashed suggestion. Only a current path is returned. */
export function takeQuizSuggestion(): CurrentCourseCode | null {
	try {
		const store = sessionStore();
		const code = store?.getItem(QUIZ_HANDOFF_KEY) ?? null;
		store?.removeItem(QUIZ_HANDOFF_KEY);
		return code && isCurrentCourseCode(code) ? code : null;
	} catch {
		return null;
	}
}
