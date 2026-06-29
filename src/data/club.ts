/**
 * Presentation helpers for the GavelUp workspace + a deterministic Pathways
 * MOCK.
 *
 * Member identity, speeches, speech logs, roles served and meeting agendas are
 * wired to real data (see `src/server/club.ts` and `src/server/meetings.ts`).
 *
 * Pathways progress (path / level / % / project), member status and awards have
 * NO database model yet, so they are mocked here. `mockPathway(seed)` is keyed
 * off a stable seed (the user id) so a member always shows the same placeholder.
 * TODO(persistence): replace with a real Pathways model — see
 * docs/persistence-todo.md.
 */

export type MemberTone = "palm" | "lagoon" | "amber";
export type MemberStatus = "on" | "dtm" | "behind" | "new";

/** Avatar background gradient for a member "tone". */
export function avatarGradient(tone: MemberTone): string {
	switch (tone) {
		case "palm":
			return "linear-gradient(150deg, var(--palm), #245238)";
		case "amber":
			return "linear-gradient(150deg, #e0b357, #c2851a)";
		default:
			return "linear-gradient(150deg, var(--lagoon), var(--lagoon-deep))";
	}
}

export interface StatusMeta {
	/** CSS color for the status dot. */
	dot: string;
	label: string;
	/** Longer label used in the member-detail header. */
	longLabel: string;
}

export function statusMeta(status: MemberStatus): StatusMeta {
	switch (status) {
		case "on":
			return { dot: "var(--palm)", label: "On track", longLabel: "On track" };
		case "dtm":
			return {
				dot: "var(--lagoon-deep)",
				label: "DTM track",
				longLabel: "DTM track",
			};
		case "behind":
			return {
				dot: "var(--warning)",
				label: "Behind",
				longLabel: "Behind on goals",
			};
		default:
			return {
				dot: "var(--sea-ink-soft)",
				label: "New member",
				longLabel: "New member",
			};
	}
}

export interface RosterSegment {
	key: "all" | MemberStatus;
	label: string;
}

export const rosterSegments: RosterSegment[] = [
	{ key: "all", label: "All members" },
	{ key: "on", label: "On track" },
	{ key: "behind", label: "Needs attention" },
	{ key: "new", label: "New members" },
	{ key: "dtm", label: "DTM track" },
];

// --- Pathways MOCK (no DB model yet) -----------------------------------------

const PATHS = [
	"Presentation Mastery",
	"Leadership Development",
	"Visionary Communication",
	"Innovative Planning",
	"Persuasive Influence",
	"Dynamic Leadership",
	"Motivational Strategies",
	"Effective Coaching",
	"Engaging Humor",
	"Strategic Relationships",
	"Team Collaboration",
];

const PROJECTS = [
	"Ice Breaker",
	"Persuasive Speaking",
	"Manage Successful Events",
	"Negotiate the Best Outcome",
	"Understanding Your Leadership Style",
	"Effective Body Language",
	"Evaluation and Feedback",
	"Researching and Presenting",
	"Connect with Storytelling",
];

export interface MockPathway {
	path: string;
	project: string;
	level: number;
	pct: number;
	status: MemberStatus;
}

function hash(seed: string): number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		h = (h ^ seed.charCodeAt(i)) >>> 0;
		h = (h * 16777619) >>> 0;
	}
	return h;
}

/**
 * Deterministic placeholder Pathway for a member. TODO(persistence): replace
 * with the member's real Pathways enrollment + progress.
 */
export function mockPathway(seed: string): MockPathway {
	const h = hash(seed);
	const level = ((h >>> 3) % 5) + 1;
	const pct = (h >>> 7) % 100;
	const status: MemberStatus =
		level === 5 && pct > 85 ? "dtm" : pct < 40 ? "behind" : "on";
	return {
		path: PATHS[h % PATHS.length],
		project: PROJECTS[(h >>> 11) % PROJECTS.length],
		level,
		pct,
		status,
	};
}

// --- Member-detail derivations (MOCK Pathways visuals) -----------------------

export type LevelState = "done" | "current" | "locked";

export interface LevelStep {
	n: number;
	label: string;
	sub: string;
	mark: string;
	state: LevelState;
	/** True when the connector leading into this node should read as reached. */
	connectorReached: boolean;
}

export function levelSteps(level: number, pct: number): LevelStep[] {
	return [1, 2, 3, 4, 5].map((n) => {
		const state: LevelState =
			n < level ? "done" : n === level ? "current" : "locked";
		return {
			n,
			label: `Level ${n}`,
			sub:
				state === "done"
					? "Complete"
					: state === "current"
						? `${pct}% done`
						: "Locked",
			mark: state === "done" ? "✓" : String(n),
			state,
			connectorReached: n <= level,
		};
	});
}

export interface Award {
	title: string;
	date: string;
}

/** TODO(persistence): awards have no model — derived from the mock level/status. */
export function mockAwards(level: number, status: MemberStatus): Award[] {
	const awards: Award[] = [];
	for (let n = 1; n < level; n++) {
		awards.push({
			title: `Level ${n} completion`,
			date: "Earned in your Pathway",
		});
	}
	if (status === "dtm") {
		awards.push({
			title: "Distinguished Toastmaster — in progress",
			date: "Final project underway",
		});
	}
	if (awards.length === 0) {
		awards.push({
			title: "Ice Breaker delivered",
			date: "First speech milestone",
		});
	}
	return awards;
}
