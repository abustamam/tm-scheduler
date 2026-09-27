/**
 * Groups open issues into waves that parallel agents can take without
 * colliding.
 *
 * Ported from the `metadata` repo (`app/util/issue-batching.ts`), where the
 * motivating failure was two sessions independently building the same fix
 * because the batches had been grouped by THEME. Theme correlates almost
 * perfectly with files, which is the worst property for parallel work.
 *
 * The unit that makes a batch reviewable is not the unit that makes it
 * parallelisable. This computes the second one, from the file paths the issue
 * bodies already cite. MEASURED here 2026-08-31: 9 of the 10 open
 * `ready-for-agent` issues cite at least one path and 22 of 23 cited paths
 * exist, so the input signal this needs is already present in the backlog
 * without changing how issues are written.
 *
 * Pure: `scripts/batch-issues.ts` supplies the issues and the fan-in map.
 * Nothing here imports `#/db` — a constant in a module that loads the db
 * client is unassertable from vitest (CLAUDE.md, Test Coverage), and the whole
 * point of this file is that its numbers are testable.
 */

import { join, normalize } from "node:path";

export type IssueFiles = {
	number: number;
	/** Repo-relative paths the issue body names. */
	paths: string[];
	/**
	 * Issue numbers that must land before this one, from `extractDependencies`.
	 * File-disjointness cannot see these: two issues can touch entirely
	 * different files and still be order-dependent.
	 */
	blockedBy?: number[];
	/**
	 * True when landing this issue writes a Drizzle migration, from
	 * `isMigrationBearing`. Forces it serial regardless of fan-in — see
	 * `planBatches`.
	 */
	migration?: boolean;
	/**
	 * True when the maintainer has marked this issue as going first, from
	 * `isPriority`. A tie-break on ORDER only — it never moves an issue between
	 * the serial section and a wave, and never overrides a dependency. See
	 * `planBatches`.
	 */
	priority?: boolean;
};

/** A dependency the plan could not honour. Reported, never silently reordered. */
export type DependencyWarning = {
	/** The issue that is scheduled too early. */
	issue: number;
	/** The issue it says must land first. */
	blocker: number;
	/**
	 * `before` — scheduled strictly earlier than its blocker.
	 * `parallel` — same wave, so two agents would work it simultaneously.
	 * `cycle` — the two claim to block each other; neither was reordered.
	 */
	kind: "before" | "parallel" | "cycle";
};

export type BatchPlan = {
	/**
	 * Run these first, one at a time, merging between: each touches a file that
	 * much of the repo imports, so its blast radius is not confined to its own
	 * diff.
	 */
	serial: number[];
	/** Each inner array is one wave of agents. No two share a file. */
	batches: number[][];
	/**
	 * Cited no files, so disjointness cannot be established. Held back rather
	 * than guessed at — and worth reading as "these issues need a path".
	 */
	unknown: number[];
	/**
	 * Dependencies the plan could not satisfy by reordering. Empty is the
	 * normal case; a non-empty list means the printed order is wrong and a
	 * human has to sequence those by hand.
	 */
	warnings: DependencyWarning[];
};

export type BatchOptions = {
	/**
	 * Imports-from-elsewhere count above which a file counts as shared
	 * infrastructure. 10 is deliberately low. MEASURED here 2026-08-31:
	 * `src/db/schema.ts` has 188 importers, `src/test/db.ts` 102,
	 * `src/server/guards.ts` 49 — and at threshold 10 exactly four of the ten
	 * open `ready-for-agent` issues land in serial, which is a plausible split
	 * rather than a degenerate one.
	 */
	fanInThreshold?: number;
	/** Cap on agents per wave. */
	maxBatchSize?: number;
};

/**
 * The two tuning numbers, exported so the CLI does not restate them.
 *
 * They were duplicated as bare literals in `scripts/batch-issues.ts`'s flag
 * defaults, which is the exact shape CLAUDE.md's coverage-traps section warns
 * about: a constant that lives in two files drifts silently, and the symptom
 * here would be the CLI serialising a different set than the library's own
 * default would. The CLI now passes a flag's value only when the flag was
 * given, so these stay the single source of truth.
 */
export const DEFAULT_FAN_IN_THRESHOLD = 10;
export const DEFAULT_MAX_BATCH_SIZE = 4;

/**
 * Top-level directories a cited path may live under.
 *
 * `scripts/batch-issues.ts` walks exactly these to decide whether a cited path
 * still exists, so a root missing here is a root whose citations are silently
 * discarded rather than rejected.
 *
 * `docs` is here because documentation is a conflict surface like any other:
 * two agents editing `docs/agents/domain.md` at once collide exactly like two
 * editing a component. It is safe to widen because the fan-in graph is
 * filtered separately — `scripts/batch-issues.ts` builds it from
 * `IMPORT_SOURCE_RE` only, so a `.md` path joins the citable set without
 * joining the import graph.
 *
 * `drizzle` is the migrations directory and is what `isMigrationBearing` reads.
 * `extension` is the WXT sub-package: it has its own vitest and its own
 * `working-directory` in CI, but it is still one checkout and two agents
 * editing it collide normally.
 *
 * `.claude`, `.github`, `.githooks` and `public` were missing until #973, and a
 * cited path under a missing root is not rejected but DROPPED: #967's
 * `## Files` named `.claude/skills/dispatching-issue-waves/SKILL.md` and the
 * plan printed its other three paths with no sign the fourth existed. Each is a
 * place parallel agents really do collide — the project skills, `ci.yml`, the
 * git hooks, and `public/sw.js`, which CLAUDE.md lists as a review risk
 * category. `content` (the in-app resource articles) and the `pdf` extension
 * came with them because the live backlog on 2026-09-26 cited
 * `content/resources/what-is-pathways.md` and `public/role-sheets/grammarian.pdf`
 * in `## Files` sections and lost both the same way. A dotted root cannot use the `\b` the others lead with (a `.` is
 * not a word character), so `CITED_UNDER_ROOT` bounds those separately.
 */
export const CITED_ROOTS = [
	"src",
	"scripts",
	"docs",
	"drizzle",
	"extension",
	"public",
	"content",
	".claude",
	".github",
	".githooks",
] as const;

/**
 * Directories under a root the walk must NOT descend into, and whose files are
 * never citable.
 *
 * `.claude/worktrees/` holds every parallel agent's full checkout. Walking it
 * would not merely be slow: each copy's `src/**` passes the extension filter
 * and joins the FAN-IN graph, so every file's importer count is multiplied by
 * the number of live worktrees and ordinary files cross the shared-helper
 * threshold into SERIAL. Rejected in `isCitablePath` as well as pruned from the
 * walk, so the two halves still cannot disagree.
 */
export const UNCITABLE_DIRS = [".claude/worktrees"] as const;

/**
 * Extensions a cited path may end in.
 *
 * Longest-first, and it matters: the alternation is tried in order, so `ts`
 * ahead of `tsx` would consume the first two characters of `.tsx` and then
 * fail its trailing word boundary. `sql` and `sh` share a first character but
 * neither prefixes the other, so their order is free. The constraint is pinned
 * by a test rather than by memory, because the symptom of breaking it is a
 * silently unbatchable issue and not an error. `json` ahead of `js` is the live
 * case of it.
 *
 * `json`, `js`, `yaml` and `yml` arrived with the roots that need them (#973):
 * `.github/workflows/ci.yml`, `public/sw.js`, `.claude/skills/…` alongside
 * `extension/package.json`. A root whose files no extension matches is a root
 * in name only.
 */
export const CITED_EXTENSIONS = [
	"tsx",
	"ts",
	"sql",
	"sh",
	"css",
	"md",
	"json",
	"js",
	"yaml",
	"yml",
	"pdf",
] as const;

/**
 * Files at the repo root that a cited path may name.
 *
 * The root-and-extension model above cannot express "a specific file at the
 * repo root": every path it matches begins with a directory and a slash, so
 * `CLAUDE.md` would match nothing and be invisible to the conflict graph. That
 * is the worst file in this repo to be blind to — it is the highest-traffic
 * non-source file here, it is edited constantly by exactly the parallel agents
 * this tool exists to keep apart, and it is long enough that two concurrent
 * edits to different sections still conflict.
 *
 * An allowlist rather than a bare `name.ext` pattern at the root. A pattern
 * rejects nothing, so "see package.json" in an issue that merely mentions it
 * becomes a citation, and a phantom path costs a wave.
 *
 * `CHANGELOG.md` and `VERSION` are deliberately NOT here. Both have been frozen
 * at 1.32.0.0 since 2026-09-04 (CLAUDE.md, "Skill routing"), so they are not a
 * change surface at all; and while `/ship` still wrote them on every release,
 * listing them would have made every issue collide with every other and
 * serialised the whole backlog. `TODOS.md` was listed until the same date and
 * had the opposite problem — it was in every diff — which is why it became one
 * `TODOS/<branch>.md` per branch, a shape no issue cites as a change set.
 *
 * `.github/workflows/ci.yml` is not here because it needs no allowlisting:
 * `.github` is a root in `CITED_ROOTS` (#973), and the walk descends into each
 * root by name, so its leading-`.` skip only applies to entries INSIDE a root.
 */
export const CITED_ROOT_FILES = [
	"CLAUDE.md",
	"CONTEXT.md",
	"CODING_STANDARDS.md",
	"README.md",
	"package.json",
	"biome.json",
	"vitest.config.ts",
] as const;

const escapeLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What `\b` means ahead of a word character, for a pattern that starts with a
 * `.`: the previous character is not a word character. `\b` itself cannot say
 * it there, because between a space and a `.` there is no word boundary at
 * all, so `\b.claude/…` matches nothing in ordinary prose.
 */
const NOT_AFTER_WORD = "(?<![A-Za-z0-9_])";

/**
 * The end of a cited path: no further path character, and no dot that starts
 * another extension. A plain `\b` stopped at the dot, so `src/foo.js.map`
 * was read as `src/foo.js` once `js` was citable — a citation of a DIFFERENT
 * file. A dot followed by a space or the end is a full stop and is allowed, so
 * "edit `.githooks/pre-commit`." keeps its cite.
 */
const ENDS_PATH = "(?![A-Za-z0-9_/$-]|\\.[A-Za-z0-9])";

/**
 * A root directory, then anything under it: `src/lib/dcp.ts`.
 *
 * `$` is in the character class and is NOT optional here, though it is absent
 * from the upstream this was ported from. TanStack Start encodes route params
 * in the FILENAME, so this repo has 24 route files like
 * `src/routes/club.$clubId.meeting.$meetingId.tsx` — including some of the
 * highest-traffic files in the tree.
 *
 * Without it the failure is silent and doubled. `extractPaths` cannot read a
 * route path out of an issue body, so an issue whose whole change set is one
 * route cites nothing and is never planned; and the walk in
 * `scripts/batch-issues.ts` filters through `isCitablePath`, so every one of
 * those 24 files drops out of the FAN-IN graph too and stops counting as an
 * importer. MEASURED 2026-08-31: that under-counted
 * `src/server/club-logo.ts` from 10 importers to 3 and moved #504 out of
 * SERIAL into a wave — a file crossing the shared-infrastructure threshold
 * while reported as not crossing it.
 *
 * Literal inside a character class, so it needs no escape; the trailing `-`
 * stays last so it stays literal too.
 */
const WORD_ROOTS = CITED_ROOTS.filter((r) => !r.startsWith("."));
const DOT_ROOTS = CITED_ROOTS.filter((r) => r.startsWith("."));
const CITED_UNDER_ROOT =
	`(?:\\b(?:${WORD_ROOTS.join("|")})` +
	`|${NOT_AFTER_WORD}(?:${DOT_ROOTS.map(escapeLiteral).join("|")}))` +
	`/[A-Za-z0-9_./$-]+` +
	`\\.(?:${CITED_EXTENSIONS.join("|")})${ENDS_PATH}`;

/**
 * A git hook: `.githooks/pre-commit`. Hooks have no extension, so the
 * root-and-extension shape above cannot name one, and `.githooks` would be a
 * root whose every real file is invisible.
 *
 * `ENDS_PATH` refuses a dot only when an extension-ish character follows it —
 * `.githooks/pre-commit.sh` belongs to the branch above, while the full stop
 * ending "edit `.githooks/pre-commit`." must not cost the cite.
 */
const HOOKS_ROOT: (typeof CITED_ROOTS)[number] = ".githooks";
const CITED_HOOK =
	`${NOT_AFTER_WORD}${escapeLiteral(HOOKS_ROOT)}/[a-z]+(?:-[a-z]+)*` +
	ENDS_PATH;

/**
 * One of the allowlisted root files and nothing else: `CLAUDE.md`.
 *
 * Bounded by explicit lookarounds rather than by `\b`, because `\b` is
 * satisfied by a `/`. With word boundaries this branch would read `CLAUDE.md`
 * out of `.github/CLAUDE.md` and `README.md` out of `docs/README.md` —
 * promoting a string that names a *different* file into a citation of the root
 * one.
 *
 * That is the more dangerous half. An invented path is dropped by
 * `splitCitations` because the tree does not have it, so an issue whose only
 * citation was invented is not merely mis-batched: it is reported under CITED
 * PATHS ARE MISSING HERE and told to `git pull`, and never planned at all.
 */
const CITED_ROOT_FILE =
	`(?<![A-Za-z0-9_./-])` +
	`(?:${CITED_ROOT_FILES.map(escapeLiteral).join("|")})` +
	`(?![A-Za-z0-9_/-])`;

/**
 * The two shapes, as one alternation.
 *
 * Wrapped in a group, which is load-bearing: `|` binds looser than everything
 * around it, so an unwrapped alternation would attach the `^` of `CITED_WHOLE`
 * to the first branch only and its `$` to the last — and `isCitablePath` would
 * start accepting `some junk CLAUDE.md`, which the walk feeds straight into
 * the existence check.
 */
const CITED_PATH = `(?:${CITED_UNDER_ROOT}|${CITED_HOOK}|${CITED_ROOT_FILE})`;

/** Anywhere in prose, bounded on both sides. */
const CITED_IN_PROSE = new RegExp(CITED_PATH, "g");
/** The whole string and nothing else. */
const CITED_WHOLE = new RegExp(`^${CITED_PATH}$`);

/** A `## Files` heading, at any level. Its body is the issue's change set. */
const FILES_HEADING = /^[ \t]*(#{1,6})[ \t]+Files[ \t]*$/;
/** Any ATX heading, captured so its level can be compared. */
const ANY_HEADING = /^[ \t]*(#{1,6})[ \t]+\S/;
/**
 * A fence opener, per CommonMark: indented 0-3 spaces, three or more of one
 * character. Four spaces is an indented code line, not a fence.
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * A line-by-line fenced-block tracker. Headings inside a fence are not
 * headings, and dependency phrases inside one are quoted text.
 *
 * Tracks the opener's CHARACTER and LENGTH, because CommonMark closes a fence
 * only with the same character, at least as long, and nothing after it but
 * whitespace. A toggle on any fence-shaped line — what this replaced — flipped
 * on a `~~~` line INSIDE a ``` block and read everything after the block as
 * fenced: a real dependency below it vanished.
 *
 * `step` returns true when the line is fence content or a delimiter, i.e. not
 * prose. An unclosed fence runs to the end of the body, as GitHub renders it.
 */
function fenceTracker(): { step: (line: string) => boolean } {
	let open: { char: string; length: number } | null = null;
	return {
		step(line) {
			if (open !== null) {
				const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
				const run = close?.[1];
				if (run?.[0] === open.char && run.length >= open.length) open = null;
				return true;
			}
			const m = line.match(FENCE_OPEN);
			const run = m?.[1];
			if (!run) return false;
			// A backtick fence's info string may not contain a backtick — that
			// line is an inline code span, not a fence.
			if (run[0] === "`" && (m?.[2] ?? "").includes("`")) return false;
			open = { char: run[0] as string, length: run.length };
			return true;
		},
	};
}

/**
 * The lines under a `## Files` heading, or `null` if the body has none.
 *
 * Ends at the next heading of the same level or higher, so a `###` subsection
 * stays inside a `##` section. Fenced blocks are tracked because a `#` opening
 * a shell comment is not a heading, and treating one as a section boundary
 * would silently truncate the change set.
 */
function filesSection(body: string): string | null {
	const lines = body.split("\n");
	const fence = fenceTracker();
	let start = -1;
	let level = 0;

	for (const [i, line] of lines.entries()) {
		if (fence.step(line)) continue;

		if (start === -1) {
			const heading = line.match(FILES_HEADING);
			if (heading?.[1]) {
				start = i + 1;
				level = heading[1].length;
			}
			continue;
		}

		const next = line.match(ANY_HEADING);
		if (next?.[1] && next[1].length <= level)
			return lines.slice(start, i).join("\n");
	}

	return start === -1 ? null : lines.slice(start).join("\n");
}

/**
 * Repo-relative source paths an issue says it will change.
 *
 * Read from the issue's `## Files` section when it has one, and from the whole
 * body — code fences included — when it does not.
 *
 * The section is preferred because a body-wide read cannot tell a file an
 * issue *changes* from one it merely *mentions*. Upstream measured both
 * failure directions: an issue naming two files under a heading reading "Not
 * in scope" was serialised on both, and another serialised on a component it
 * only imports while the component it actually edits was absent from its path
 * set entirely — and a missing path is the dangerous half, since it lets two
 * issues that edit one file land in the same wave.
 *
 * A section naming no path yields to the body rather than returning nothing.
 * Honouring an empty section would drop the issue from the plan and report it
 * as citing no files, which is worse than the phantom paths this removes.
 */
export function extractPaths(body: string): string[] {
	const section = filesSection(body);
	// `isUncitableDir` filtered here as well as in `isCitablePath`, so the
	// extractor cannot emit a path the walk refuses to produce.
	const cited = (text: string) => [
		...new Set(
			(text.match(CITED_IN_PROSE) ?? []).filter((p) => !isUncitableDir(p)),
		),
	];

	const fromSection = section === null ? [] : cited(section);
	return (fromSection.length > 0 ? fromSection : cited(body)).sort();
}

/** Characters that wrap a path in Markdown or prose rather than belong to it. */
const PATH_WRAPPING = /^[`*_"'([<-]+|[`*_"')\]>,;:.!?]+$/g;
/** `dir/file`, `dir/`, or a file with a letters-only extension of 2-5. */
const PATH_SHAPED =
	/^(?:[A-Za-z0-9_.$-]*\/[A-Za-z0-9_./$-]*|[A-Za-z0-9_$-]{2,}(?:\.[A-Za-z0-9_$-]+)*\.[A-Za-z]{2,5})$/;

/**
 * Path-shaped entries in an issue's `## Files` section that `extractPaths`
 * did not read, so the batcher is not batching on them.
 *
 * `## Files` is the issue's own statement of its change set, so a path there
 * that the citation pattern cannot name is a conflict surface lost without a
 * word — #973 found `.claude/skills/…/SKILL.md` dropped exactly that way, from
 * a plan that printed the other three paths as if they were all of them.
 * Widening `CITED_ROOTS` fixed that root; this is what makes the NEXT one
 * visible (`Dockerfile.dev`, `tsconfig.json`, a directory named instead of a
 * file) rather than another silent drop.
 *
 * Only the `## Files` section is read. Across the whole body a path-shaped
 * token is as likely to be prose as a change target, and flagging prose is the
 * noise that teaches a reader to skip the line. An entry that CONTAINS a path
 * `extractPaths` did read (`./src/x.ts`, `src/x.ts:12`) is covered by it and
 * not reported, and neither is a URL. Two more shapes are skipped because
 * MEASURED against the open backlog (2026-09-26) they were all noise: a bare
 * filename that names a cited path's last segment ("`agenda.ts` is read, not
 * edited"), and a directory (`drizzle/` for "a new migration"), which cannot
 * be batched on whatever the pattern accepts and which the `migration` label
 * already covers.
 */
export function unrecognisedFilesEntries(body: string): string[] {
	const section = filesSection(body);
	if (section === null) return [];
	const cited = extractPaths(body);
	const out = new Set<string>();
	for (const raw of section.split(/\s+/)) {
		const token = raw.replace(PATH_WRAPPING, "");
		if (token === "" || token.includes("://")) continue;
		if (!PATH_SHAPED.test(token) || token.endsWith("/")) continue;
		if (cited.some((c) => token.includes(c) || c.endsWith(`/${token}`)))
			continue;
		out.add(token);
	}
	return [...out].sort();
}

/**
 * Whether a repo-relative path is one `extractPaths` could have produced —
 * the walk filter behind the batcher's "does this path still exist" check.
 *
 * It shares `CITED_ROOTS`, `CITED_EXTENSIONS` and `CITED_ROOT_FILES` with
 * `extractPaths` on purpose, and the walk collects the root files by name for
 * the same reason it walks the roots: neither half may be able to name a path
 * the other cannot. Upstream let the two hold independent definitions and they
 * disagreed — the extractor accepted extensions the walk did not, and every
 * issue citing only those was dropped from the plan while being reported as
 * citing no files at all, which sends you off to add paths that are already
 * there.
 */
export function isCitablePath(path: string): boolean {
	return CITED_WHOLE.test(path) && !isUncitableDir(path);
}

/** Whether `path` is, or sits under, one of `UNCITABLE_DIRS`. */
export function isUncitableDir(path: string): boolean {
	return UNCITABLE_DIRS.some((d) => path === d || path.startsWith(`${d}/`));
}

/** An issue's cited paths, split by whether this working tree has them. */
export type Citations = {
	/** Present here. The only paths disjointness may be computed from. */
	present: string[];
	/** Cited, citable, and absent from this checkout. */
	missing: string[];
};

/**
 * Splits cited paths into the ones this checkout has and the ones it does not.
 *
 * Dropping a path the tree lacks is correct — an issue can name a file that
 * has since been renamed, and a stale path would fake disjointness. Forgetting
 * that it was dropped is not: an issue whose every citation is missing then
 * prints identically to one that cited nothing, and "cite the files in the
 * body" is the wrong instruction when the body already does.
 *
 * Two different causes produce a missing path here and they want opposite
 * responses, which is why `scripts/batch-issues.ts` splits them in the report.
 * The checkout may be behind (`git pull --ff-only`), or the issue may be
 * PROPOSING a file that does not exist yet — MEASURED here 2026-08-31, #504
 * cites `src/lib/club-logo-limits.ts` as a file it will create.
 *
 * `exists` is injected rather than read here because this module is pure —
 * `scripts/batch-issues.ts` owns the filesystem walk.
 */
export function splitCitations(
	cited: readonly string[],
	exists: (path: string) => boolean,
): Citations {
	const present: string[] = [];
	const missing: string[] = [];
	for (const path of cited) (exists(path) ? present : missing).push(path);
	return { present, missing };
}

/**
 * Phrasings that mean "this issue must wait for #N".
 *
 * `\bblocks` deliberately does NOT match "unblocks": the preceding character
 * is a word character there, so the boundary fails.
 */
const BLOCKED_BY_PATTERNS = [
	/\b(?:blocked\s+by|depends\s+on|requires)\s+#(\d+)/gi,
	/\bland\s+#(\d+)\s+first/gi,
];
const BLOCKS_PATTERNS = [/\bblocks\s+#(\d+)/gi];

/** A blockquote line (0-3 spaces, then `>`): usually someone else's text. */
const BLOCKQUOTE = /^ {0,3}>/;
/**
 * The first line of a GitHub alert block. An alert is the AUTHOR's own
 * emphasis — `> [!IMPORTANT]` then `> Blocked by #940` is the most emphatic way
 * this repo can state a dependency — so it and its `>` continuation lines are
 * read as prose, never as a quote.
 */
const ALERT_OPEN = /^ {0,3}>[ \t]*\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;
/**
 * An inline code span, CommonMark-shaped: a backtick run closed by a run of
 * EXACTLY the same length. The lookarounds stop a lone backtick from pairing
 * with one half of a longer run, which is what let an unbalanced backtick
 * swallow the rest of its line.
 */
const CODE_SPAN = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;

/** Where a skipped dependency phrase was quoted. */
export type QuotedIn = "a fenced block" | "a blockquote" | "a code span";

/** A dependency phrase the body QUOTES, and so was not read as its own. */
export type IgnoredDependency = {
	/** The phrase as written, whitespace collapsed: `Blocked by #940`. */
	phrase: string;
	/** The number it names. */
	issue: number;
	direction: "blockedBy" | "blocks";
	quotedIn: QuotedIn;
};

/**
 * A body split into the text it STATES and the spans it QUOTES: fenced blocks,
 * blockquote lines that are not GitHub alerts, and inline code spans.
 *
 * Deliberately NOT double-quoted prose. Straight quotes appear unpaired here
 * constantly (`a 12" print`), and a line quoted for emphasis is still the
 * author's own statement; stripping those dropped real dependencies — the
 * dangerous direction, since a dropped blocker is how #942 got dispatched
 * early (#967).
 */
export function splitQuotedText(body: string): {
	stated: string;
	quoted: { text: string; quotedIn: QuotedIn }[];
} {
	const fence = fenceTracker();
	const stated: string[] = [];
	const quoted: { text: string; quotedIn: QuotedIn }[] = [];
	let inAlert = false;

	for (const line of body.split("\n")) {
		if (fence.step(line)) {
			inAlert = false;
			quoted.push({ text: line, quotedIn: "a fenced block" });
			continue;
		}
		if (ALERT_OPEN.test(line)) inAlert = true;
		else if (!BLOCKQUOTE.test(line)) inAlert = false;

		if (BLOCKQUOTE.test(line) && !inAlert) {
			quoted.push({ text: line, quotedIn: "a blockquote" });
			continue;
		}
		stated.push(
			line.replace(CODE_SPAN, (span) => {
				quoted.push({ text: span, quotedIn: "a code span" });
				return " ";
			}),
		);
	}
	return { stated: stated.join("\n"), quoted };
}

/** Every `(phrase, number)` a set of patterns matches in `text`. */
const matchPhrases = (text: string, patterns: RegExp[]) =>
	patterns.flatMap((re) =>
		[...text.matchAll(re)].map((m) => ({
			phrase: m[0].replace(/\s+/g, " "),
			issue: Number(m[1]),
		})),
	);

/**
 * The ordering constraints an issue body states in prose.
 *
 * Returns both directions because both are written: `blockedBy` is "I must
 * wait for these", `blocks` is "these must wait for me". A caller assembling
 * the graph needs to invert the second — see `scripts/batch-issues.ts`.
 *
 * Deliberately narrow. A bare `#630` anywhere in a body is a cross-reference,
 * not a dependency, and treating it as one would make almost every issue in
 * this repo look blocked by almost every other — the bodies here cite issue
 * numbers constantly.
 *
 * A phrase inside quoted text (see `splitQuotedText`) is not this issue's own:
 * #967's body had to be reworded because quoting #942's blocker line made
 * #967 read as blocked too. But skipping one can be WRONG — an author who
 * writes their own dependency in a blockquote, or leaves a fence unclosed
 * above it — and a dropped blocker is the dangerous direction. So every
 * skipped phrase whose number did not also parse from the stated text comes
 * back in `ignored`, and the CLI prints it. A suppression is never silent.
 *
 * What remains unseen: a dependency REPORTED in plain prose ("#942 is blocked
 * by #940") still reads as this issue's own. Put the report in a code span or
 * blockquote, or drop the `#`.
 */
export function extractDependencies(body: string): {
	blockedBy: number[];
	blocks: number[];
	ignored: IgnoredDependency[];
} {
	const { stated, quoted } = splitQuotedText(body);
	const sorted = (ns: number[]) => [...new Set(ns)].sort((a, b) => a - b);
	const blockedBy = sorted(
		matchPhrases(stated, BLOCKED_BY_PATTERNS).map((m) => m.issue),
	);
	const blocks = sorted(
		matchPhrases(stated, BLOCKS_PATTERNS).map((m) => m.issue),
	);

	const ignored: IgnoredDependency[] = [];
	const seen = new Set<string>();
	for (const { text, quotedIn } of quoted) {
		for (const [direction, patterns, parsed] of [
			["blockedBy", BLOCKED_BY_PATTERNS, blockedBy],
			["blocks", BLOCKS_PATTERNS, blocks],
		] as const) {
			for (const m of matchPhrases(text, patterns)) {
				if (parsed.includes(m.issue)) continue; // read anyway; nothing lost
				const key = `${direction}:${m.issue}:${quotedIn}`;
				if (seen.has(key)) continue;
				seen.add(key);
				ignored.push({ ...m, direction, quotedIn });
			}
		}
	}
	return { blockedBy, blocks, ignored };
}

/** The inline tag for an issue's ignored quoted phrases, or `""`. */
export function ignoredTag(ignored: readonly IgnoredDependency[]): string {
	if (ignored.length === 0) return "";
	const ns = [...new Set(ignored.map((d) => `#${d.issue}`))];
	return `[QUOTED DEPENDENCY IGNORED: ${ns.join(", ")}]`;
}

// ---- open blockers -----------------------------------------------------------

/**
 * Whether an issue has landed, as far as the planner can tell.
 *
 * `unreadable` is its own state rather than folding into either side: printing
 * one as open could report a closed blocker, and treating it as closed hides
 * a real one. It is tagged on its own.
 */
export type IssueState = "open" | "closed" | "unreadable";

/** What GitHub answered, per number. A number it did not answer is absent. */
export type IssueStateMap = Map<number, "open" | "closed">;

/** An issue's blockers, split by what the planner can say about them. */
export type BlockerStatus = {
	/** Still OPEN ON GITHUB. */
	open: number[];
	/** GitHub could not be asked, or did not answer, for these. */
	unreadable: number[];
};

/**
 * Every issue's blockers classified once, keyed by issue, omitting issues with
 * nothing to report. The one source both the per-line tags and the wave
 * warnings read, so the two cannot disagree.
 *
 * "Open" means OPEN ON GITHUB, not "in this plan": a blocker can be open while
 * sitting outside the planned set entirely — still `needs-triage`, carrying a
 * different label, or held back because someone is working it — and that is
 * precisely the blocker the plan's ordering cannot protect you from. A closed
 * blocker has landed (or been dropped) and is never reported.
 */
export function classifyBlockers(
	blockedBy: ReadonlyMap<number, readonly number[]>,
	stateOf: (issue: number) => IssueState,
): Map<number, BlockerStatus> {
	const out = new Map<number, BlockerStatus>();
	for (const [issue, blockers] of blockedBy) {
		const open = blockers.filter((b) => stateOf(b) === "open");
		const unreadable = blockers.filter((b) => stateOf(b) === "unreadable");
		if (open.length > 0 || unreadable.length > 0)
			out.set(issue, { open, unreadable });
	}
	return out;
}

/**
 * The inline tags for an issue's blockers, or `[]` when it has none to report.
 *
 * Printed on the issue's own line beside `[PRIORITY]` / `[MIGRATION — run
 * alone]`, because the line is what a dispatcher copies into a brief. #942
 * printed alone in a wave with nothing on its line, was paired with the first
 * SERIAL issue because they shared no files, and its two blockers were both
 * still in SERIAL (#967).
 */
export function blockerTags(status: BlockerStatus | undefined): string[] {
	if (!status) return [];
	const list = (ns: number[]) => ns.map((n) => `#${n}`).join(", ");
	return [
		status.open.length > 0 ? `[BLOCKED BY ${list(status.open)} — open]` : "",
		status.unreadable.length > 0
			? `[BLOCKER STATE UNKNOWN ${list(status.unreadable)}]`
			: "",
	].filter(Boolean);
}

/** Where an issue sits relative to the printed plan, in the report's words. */
export type PlanLocation =
	| "SERIAL"
	| `WAVE ${number}`
	| "already being worked"
	| "not batched"
	| "not in this plan";

export function locateInPlan(
	issue: number,
	plan: Pick<BatchPlan, "serial" | "batches" | "unknown">,
	heldBack: ReadonlySet<number>,
): PlanLocation {
	if (plan.serial.includes(issue)) return "SERIAL";
	const wave = plan.batches.findIndex((b) => b.includes(issue));
	if (wave !== -1) return `WAVE ${wave + 1}`;
	if (heldBack.has(issue)) return "already being worked";
	if (plan.unknown.includes(issue)) return "not batched";
	return "not in this plan";
}

/** One wave issue that cannot start yet, and what it is waiting on. */
export type WaitingIssue = {
	issue: number;
	blockers: { issue: number; where: PlanLocation }[];
};

/** A wave with something to say about its blockers. */
export type WaveBlockers = {
	/** 1-based, matching the printed `=== WAVE n` header. */
	wave: number;
	/** Issues with an OPEN blocker. Non-empty ⇒ not dispatchable now. */
	waiting: WaitingIssue[];
	/** Issues with a blocker whose state could not be read. Check by hand. */
	unreadable: { issue: number; blockers: number[] }[];
};

/**
 * Per wave, the issues that cannot start now (an open blocker) and the ones
 * nobody can vouch for (a blocker whose state is unreadable). Waves with
 * neither are omitted.
 *
 * The rule is deliberately the plain one — any open blocker, wherever it sits.
 * A blocker in SERIAL is the case that shipped (#967): the plan's ORDER was
 * right, SERIAL runs before wave 1, but nothing on the wave said so, and a wave
 * issue sharing no files with the first SERIAL issue looked safe to pair with
 * it. A blocker in an earlier wave, held back by someone else's worktree, or
 * outside the plan altogether is equally unlanded, and the last is worse: no
 * amount of following the plan's order will land it. A blocker in the SAME or
 * a LATER wave is already a `DependencyWarning`, and listed here too.
 */
export function waveBlockers(
	plan: Pick<BatchPlan, "serial" | "batches" | "unknown">,
	status: ReadonlyMap<number, BlockerStatus>,
	heldBack: ReadonlySet<number>,
): WaveBlockers[] {
	const out: WaveBlockers[] = [];
	plan.batches.forEach((batch, i) => {
		const waiting: WaitingIssue[] = [];
		const unreadable: WaveBlockers["unreadable"] = [];
		for (const issue of batch) {
			const s = status.get(issue);
			if (!s) continue;
			if (s.open.length > 0)
				waiting.push({
					issue,
					blockers: s.open.map((b) => ({
						issue: b,
						where: locateInPlan(b, plan, heldBack),
					})),
				});
			if (s.unreadable.length > 0)
				unreadable.push({ issue, blockers: s.unreadable });
		}
		if (waiting.length > 0 || unreadable.length > 0)
			out.push({ wave: i + 1, waiting, unreadable });
	});
	return out;
}

/**
 * One GraphQL query reading the state of every listed issue or PR.
 *
 * `issueOrPullRequest` rather than `issue`: "blocked by #N" is written about
 * PRs too, and `gh issue list` omits them — a blocker that is an open PR would
 * read as closed and vanish from the report. Aliased `n<number>` so the answer
 * can be keyed back without relying on field order. `{owner}` / `{repo}` are
 * `gh api`'s own placeholders, passed as the two variables.
 */
export function issueStateQuery(numbers: readonly number[]): string {
	const fields = numbers
		.map(
			(n) =>
				`n${n}: issueOrPullRequest(number: ${n}) { ... on Issue { state } ... on PullRequest { state } }`,
		)
		.join(" ");
	return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
}

/**
 * The states `issueStateQuery`'s response carries, keyed by number.
 *
 * A number the response does not resolve — nonexistent, a transfer, a partial
 * error — is ABSENT from the map, which the caller reads as `unreadable`.
 * GraphQL answers a missing number with `null` plus an `errors` entry, and
 * `gh` exits non-zero while still printing the rest of the data, so this is
 * fed that output too rather than discarding a mostly-good answer.
 *
 * `MERGED` is closed: a merged PR has landed.
 */
export function parseIssueStates(
	response: unknown,
	numbers: readonly number[],
): IssueStateMap {
	const repo = (response as { data?: { repository?: Record<string, unknown> } })
		?.data?.repository;
	const states: IssueStateMap = new Map();
	if (!repo || typeof repo !== "object") return states;
	for (const n of numbers) {
		const state = (repo[`n${n}`] as { state?: unknown } | null | undefined)
			?.state;
		if (state === "OPEN") states.set(n, "open");
		else if (state === "CLOSED" || state === "MERGED") states.set(n, "closed");
	}
	return states;
}

/** An issue someone is already working, and the thing that says so. */
export type IssueClaim = {
	/** The issue number being claimed. */
	issue: number;
	/** Human-readable, printed in the report: `PR #649`, `worktree fix-646`. */
	source: string;
};

/** Everything up to the last `/` or `+` — a `docs/` or `fix/` type prefix. */
const REF_PREFIX = /^.*[/+]/;

/**
 * Issue numbers a branch or worktree name claims, by this repo's
 * `<slug>-<issue>` SUFFIX convention.
 *
 * This is the one place the port inverts upstream. `metadata` names branches
 * `fix/<issue>-<slug>` and reads LEADING numeric tokens; this repo's branches
 * already put the number last — `worktree-layer-text-link-646`,
 * `bench-flake-641`, `worktree-dialog-close-sticky-627` — so the tokens are
 * read from the END instead. See CLAUDE.md's "Branch naming" rule, which
 * exists to make this reading reliable.
 *
 * Every trailing token must be digits end to end, and reading stops at the
 * first that is not, so `worktree-editable-ordinary-meetings-622a` claims
 * nothing rather than claiming #622. Several are allowed because one branch
 * may close several issues — `worktree-convert-guard-617-618` claims both.
 *
 * A thematic name must claim NOTHING. Upstream's collision happened precisely
 * because both branches were named thematically and neither carried a number,
 * and the fix is the convention, not a guess: inventing a number for a
 * thematic name would hold back an issue nobody is working, which is a worse
 * failure than the one this prevents.
 *
 * The known false-positive shape is a slug whose last token is incidentally
 * numeric (`...-utf-8` would claim #8). It is tolerated rather than
 * heuristically excluded: `partitionClaimedIssues` ignores a claim on an issue
 * that is not being planned, so the blast radius is one issue that is both
 * open and labelled, and the failure direction is "held back", which is the
 * safe one. A digit-count floor was considered and rejected — it would encode
 * this repo's current issue numbering into a parser.
 *
 * The `+` in `REF_PREFIX` is not decoration: `.claude/worktrees/` cannot hold
 * a `/`, so a worktree directory carries the branch name with it substituted.
 */
export function extractIssueNumbersFromRef(ref: string): number[] {
	const tokens = ref.replace(REF_PREFIX, "").split("-");
	const out: number[] = [];
	for (let i = tokens.length - 1; i >= 0; i--) {
		const token = tokens[i];
		if (token === undefined || !/^\d+$/.test(token)) break;
		out.unshift(Number(token));
	}
	return out;
}

/**
 * Split the issues being planned into those free to dispatch and those someone
 * already holds.
 *
 * Claims are collected rather than deduplicated to a single winner: a worktree
 * claim appears before any push and the PR arrives later, so the same issue
 * legitimately carries both. Showing both is what tells a reader whether the
 * work is merely started or already up for review.
 *
 * A claim naming an issue that is not being planned is ignored — most claims
 * are, since the claim sources cover the whole repo and the plan covers one
 * label.
 */
export function partitionClaimedIssues<T extends { number: number }>(
	issues: readonly T[],
	claims: readonly IssueClaim[],
): { unclaimed: T[]; claimed: { issue: T; sources: string[] }[] } {
	const sourcesByIssue = new Map<number, string[]>();
	for (const { issue, source } of claims) {
		const list = sourcesByIssue.get(issue) ?? [];
		if (!list.includes(source)) list.push(source);
		sourcesByIssue.set(issue, list);
	}

	const unclaimed: T[] = [];
	const claimed: { issue: T; sources: string[] }[] = [];
	for (const issue of issues) {
		const sources = sourcesByIssue.get(issue.number);
		if (sources !== undefined && sources.length > 0) {
			claimed.push({ issue, sources });
		} else {
			unclaimed.push(issue);
		}
	}
	return { unclaimed, claimed };
}

/**
 * The ordered candidate paths an import specifier could resolve to, or `[]`
 * for a bare package specifier that names no file in this repo.
 *
 * Lifted out of `scripts/batch-issues.ts` and given an injected filesystem for
 * the same reason `splitCitations` has one: this is the function the port broke
 * TWICE, both times silently. Upstream matched `from '...'` (single quotes)
 * where this repo writes 3,236 double-quoted imports to 54, and resolved `~/`
 * and `@/` where this repo's alias is `#/` — 1,464 imports. Either bug alone
 * empties the fan-in map, which deletes the SERIAL section from the plan while
 * the report still looks clean. A function with that history does not belong in
 * a module vitest cannot reach.
 *
 * `#/*` and `@/*` both map to `src/*` (package.json `imports`, and
 * components.json for the shadcn half). Extension order matters: an
 * extensionless specifier must try the exact path before `.ts`, and `index.*`
 * last, so a directory containing both `foo.ts` and `foo/index.ts` resolves the
 * way the bundler does.
 *
 * Pure path math — no I/O here, so the caller owns the filesystem.
 */
export function importCandidates(fromDir: string, spec: string): string[] {
	let base: string;
	if (spec.startsWith("#/") || spec.startsWith("@/")) {
		base = join("src", spec.slice(2));
	} else if (spec.startsWith(".")) {
		base = normalize(join(fromDir, spec));
	} else {
		return []; // a package, not a file in this repo
	}

	// Containment. `join`/`normalize` collapse `..`, so BOTH branches can climb
	// above the repo root — `#/../../../../etc/passwd` escapes just as a deep
	// relative specifier does, which makes the "maps to src/*" claim above false
	// without this line. Nothing outside the tree is ever a real import target,
	// and letting one through would put a `statSync` on a path outside the repo
	// and a phantom key in the fan-in map.
	if (base.startsWith("..")) return [];

	return [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.css`,
		join(base, "index.ts"),
		join(base, "index.tsx"),
	];
}

/** Label marking an issue whose branch will carry a Drizzle migration. */
export const MIGRATION_LABEL = "migration";

/** The migrations directory. A file here means the migration already exists. */
const MIGRATION_DIR = "drizzle/";

/**
 * Whether landing this issue writes a Drizzle migration.
 *
 * This is NOT a file-conflict question and cannot be answered by
 * disjointness. Migrations here run against shared databases — `db:migrate`
 * against the local `tm_scheduler`, and `db:push` against the `tm_test` that
 * every parallel vitest run shares — so a migration puts every other
 * concurrent worktree into drift, including agents in the same wave that share
 * no files with it at all. The conflict is outside the repo, which is why it
 * needs its own signal.
 *
 * This repo has already been bitten by exactly that: a subagent's `db:push`
 * reverting `tm_test` mid-run and faking dozens of failures in suites that
 * touched none of its files.
 *
 * ## Why this reads a label and not the body
 *
 * Upstream tried three signals against a real backlog and only out-of-band
 * ones survived. Citing the schema is not enough — an issue can be *about* the
 * schema and change no models. The word "migration" in the prose is worse, and
 * failed on its first real run: the issue *requesting* this feature discussed
 * migrations at length and was flagged as performing one. A body marker fails
 * the same way, since any literal string can appear inside a quotation of
 * another issue.
 *
 * A label cannot be quoted. It is stated by whoever triages the issue, exactly
 * like `ready-for-agent`.
 *
 * `src/db/schema.ts` is deliberately NOT a signal here, for upstream's reason
 * and one local one: an issue can cite the schema while changing no models,
 * and in this repo `schema.ts` carries 188 importers, so a real schema change
 * is already serialised by fan-in. Adding it here would only change the label
 * printed, not the placement.
 *
 * The `drizzle/` path stays as a second signal for the case where the
 * migration already exists in the branch and the label was forgotten. An issue
 * *proposing* a migration cannot cite one, which is why the label carries the
 * weight.
 *
 * NOTE: `migration` EXISTS in this repo's tracker and is listed in
 * `docs/agents/triage-labels.md`, so both signals are live. It did not exist
 * when this function was written, which is the whole reason the path signal
 * came first — an earlier version of this comment said the label half was
 * inert, and that stopped being true without anything here noticing.
 * `scripts/batch-issues.ts` still reports when no OPEN issue carries the label,
 * which is a different statement (a backlog with no migrations in it) and
 * remains worth printing.
 *
 * Erring toward serialising costs one wave. Erring the other way costs every
 * concurrent agent a drift failure in files they never touched.
 */
export function isMigrationBearing({
	labels = [],
	paths = [],
}: {
	labels?: readonly string[];
	paths?: readonly string[];
}): boolean {
	if (labels.includes(MIGRATION_LABEL)) return true;
	return paths.some((p) => p.startsWith(MIGRATION_DIR));
}

/** Label marking an issue the planner should order ahead of its arrival slot. */
export const PRIORITY_LABEL = "priority";

/**
 * Whether the maintainer has marked this issue as going first.
 *
 * ## Why a label and not a heuristic
 *
 * The same argument as `isMigrationBearing`, for a different reason. Urgency
 * is not a property of the diff: an issue on the revenue path and an issue
 * nobody is waiting on can cite identical files, so nothing this module can
 * compute distinguishes them. It is a statement about the world outside the
 * repo, and the only person who holds it is the maintainer.
 *
 * MEASURED on 2026-09-08: the planner ordered by arrival, which put #716 —
 * the one issue on the revenue path — in wave 2 behind four polish items, and
 * the maintainer ranked 21 issues by hand rather than trust the plan. A plan
 * that has to be re-sorted before it is used is not a plan.
 *
 * ## Why it is a tie-break and not a promotion
 *
 * `priority` reorders; it never reclassifies. A priority issue that touches a
 * widely-imported file is still serial, a priority migration still runs alone,
 * and a priority issue blocked by a non-priority one still lands after its
 * blocker — because the alternative is a label that quietly defeats the three
 * mechanisms the plan exists to enforce. Going first and going alone are
 * different questions; only the maintainer's label answers the first.
 *
 * Deliberately a boolean, not a P0-P3 ladder. One bit is the smallest thing
 * that fixes the measured failure; a ladder buys precision the backlog has not
 * yet asked for, and every rung is a judgement call at triage time.
 */
export function isPriority(labels: readonly string[] = []): boolean {
	return labels.includes(PRIORITY_LABEL);
}

/**
 * Order `serial` so a blocker precedes everything it blocks.
 *
 * Free to do here and nowhere else: the serial section already runs one issue
 * at a time, merging between, so its array order *is* its run order and
 * permuting it costs nothing. Waves are not reordered — moving an issue
 * between waves would cascade through the packing.
 *
 * Kahn's algorithm with the original index as a stable tie-break, so an
 * unconstrained list comes back untouched. A cycle leaves its members in
 * their original relative order and is reported rather than resolved.
 *
 * That tie-break is where `priority` reaches the serial section: `planBatches`
 * builds `serial` from a list already sorted priority-first, so the index
 * carries it and no rule here needs to know the label exists. A dependency
 * still wins — a blocker is not "ready" while its dependent is waiting, whoever
 * is labelled.
 */
function orderByDependency(
	serial: readonly number[],
	blockedBy: ReadonlyMap<number, number[]>,
): { ordered: number[]; cycles: DependencyWarning[] } {
	const inSerial = new Set(serial);
	const rank = new Map(serial.map((n, i) => [n, i]));
	const deps = new Map(
		serial.map((n) => [
			n,
			new Set((blockedBy.get(n) ?? []).filter((b) => inSerial.has(b))),
		]),
	);

	const ordered: number[] = [];
	const remaining = new Set(serial);

	while (remaining.size > 0) {
		const ready = [...remaining]
			.filter((n) => [...(deps.get(n) ?? [])].every((d) => !remaining.has(d)))
			.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));

		if (ready.length === 0) break; // cycle; handled below

		for (const n of ready) {
			ordered.push(n);
			remaining.delete(n);
		}
	}

	const cycles: DependencyWarning[] = [];
	if (remaining.size > 0) {
		for (const n of serial) {
			if (!remaining.has(n)) continue;
			for (const b of deps.get(n) ?? []) {
				if (remaining.has(b))
					cycles.push({ issue: n, blocker: b, kind: "cycle" });
			}
			ordered.push(n);
		}
	}

	return { ordered, cycles };
}

export function planBatches(
	issues: readonly IssueFiles[],
	fanIn: ReadonlyMap<string, number>,
	{
		fanInThreshold = DEFAULT_FAN_IN_THRESHOLD,
		maxBatchSize = DEFAULT_MAX_BATCH_SIZE,
	}: BatchOptions = {},
): BatchPlan {
	// The one place `priority` acts, and the only ORDERED read of it is the
	// classification loop below — the two `blockedBy` Maps further down are keyed
	// lookups, so they read this list for uniformity (nothing below should reach
	// past the sort) rather than for any behaviour of their own.
	//
	// Every rule downstream — the fan-in test, migration serialisation, the
	// dependency promotion, the greedy packing — is otherwise untouched, so
	// priority can only change WHERE an issue lands in the order, never WHICH
	// section it lands in.
	//
	// `sort` is stable (ES2019 onward), so arrival order survives inside each
	// group and a backlog with no priority labels sorts to itself. That is what
	// makes this safe to run unconditionally.
	const prioritised = [...issues].sort(
		(a, b) => Number(b.priority ?? false) - Number(a.priority ?? false),
	);

	const serial: number[] = [];
	const unknown: number[] = [];
	const batchable: IssueFiles[] = [];

	for (const issue of prioritised) {
		if (issue.paths.length === 0) {
			unknown.push(issue.number);
			continue;
		}
		const touchesSharedInfra = issue.paths.some(
			(p) => (fanIn.get(p) ?? 0) >= fanInThreshold,
		);
		// A migration serialises for a reason unrelated to fan-in: it writes to
		// a shared database, so it collides with agents it shares no file with.
		// See `isMigrationBearing`.
		if (touchesSharedInfra || issue.migration) serial.push(issue.number);
		else batchable.push(issue);
	}

	// A blocker that packed into a wave would run AFTER the issue it blocks:
	// the plan's stages are the whole serial section, then wave 1, then wave 2.
	// So lift it into serial, where `orderByDependency` below can sequence it.
	//
	// This is not the reordering that function's docstring rules out. Moving an
	// issue BETWEEN waves cascades through the greedy packing; removing one
	// BEFORE the packing runs does not — the packing never sees it. Transitive,
	// because a blocker's own blockers have to precede it too.
	const blockersOf = new Map(
		prioritised.map((i) => [i.number, i.blockedBy ?? []] as const),
	);
	const mustPrecedeSerial = new Set<number>();
	// Set lookups rather than `serial.includes` / `batchable.some` inside the
	// per-edge loop: both were O(n) scans, making the walk O(E*(|serial|+
	// |batchable|)). Inert at today's `gh issue list --limit 200` ceiling, but
	// the sets cost one pass and remove the reason to think about it again.
	const serialSet = new Set(serial);
	const batchableNumbers = new Set(batchable.map((b) => b.number));
	const pending = [...serial];
	// Terminates even on a dependency cycle: a blocker is pushed only when it is
	// newly added to `mustPrecedeSerial`, so each issue enters `pending` at most
	// once.
	while (pending.length > 0) {
		const n = pending.pop();
		for (const blocker of blockersOf.get(n as number) ?? []) {
			if (serialSet.has(blocker) || mustPrecedeSerial.has(blocker)) continue;
			// Only issues in this plan, and only ones actually packed into a wave.
			// A blocker citing no files constrains nothing, and one absent from the
			// plan entirely is someone else's problem — `findViolations` already
			// says nothing about either.
			if (!batchableNumbers.has(blocker)) continue;
			mustPrecedeSerial.add(blocker);
			pending.push(blocker);
		}
	}

	if (mustPrecedeSerial.size > 0) {
		for (let i = batchable.length - 1; i >= 0; i--) {
			const promoted = batchable[i];
			if (!promoted || !mustPrecedeSerial.has(promoted.number)) continue;
			batchable.splice(i, 1);
			// Prepended, not appended: it has to reach `orderByDependency` ahead of
			// its dependent, and that sort is stable on the incoming order.
			serial.unshift(promoted.number);
		}
	}

	// Greedy first-fit: walk the issues in order and drop each into the earliest
	// wave that shares none of its files and has room. Optimal packing is graph
	// colouring and not worth it — the input is dozens of issues, and a slightly
	// wider plan costs nothing but an extra wave.
	const waves: { issues: number[]; files: Set<string> }[] = [];

	for (const issue of batchable) {
		const wave = waves.find(
			(w) =>
				w.issues.length < maxBatchSize &&
				issue.paths.every((p) => !w.files.has(p)),
		);
		if (wave) {
			wave.issues.push(issue.number);
			for (const p of issue.paths) wave.files.add(p);
		} else {
			waves.push({ issues: [issue.number], files: new Set(issue.paths) });
		}
	}

	const blockedBy = new Map(
		prioritised.map((i) => [i.number, i.blockedBy ?? []] as const),
	);
	const { ordered, cycles } = orderByDependency(serial, blockedBy);
	const batches = waves.map((w) => w.issues);

	// An edge already reported as a cycle must not ALSO be reported as
	// mis-ordered. `orderByDependency` gives up on a cycle and leaves its
	// members in their original relative order; `findViolations` then reads that
	// arbitrary order back and derives a "before" verdict from it, knowing
	// nothing about the cycle. MEASURED before this filter: a two-issue cycle
	// emitted THREE warnings — `1->2 cycle`, `2->1 cycle`, and a redundant
	// `1->2 before` — and the report renders the two kinds as unrelated
	// sentences ("each claim to block the other" vs "is scheduled BEFORE #2"),
	// so one problem read as two contradictory ones.
	const cycleEdges = new Set(cycles.map((c) => `${c.issue}->${c.blocker}`));

	return {
		serial: ordered,
		batches,
		unknown,
		warnings: [
			...cycles,
			...findViolations(ordered, batches, blockedBy).filter(
				(w) => !cycleEdges.has(`${w.issue}->${w.blocker}`),
			),
		],
	};
}

/**
 * Dependencies still unsatisfied after `orderByDependency` has done what it
 * can — i.e. every case that spans the serial/wave boundary or sits inside
 * the waves, where reordering is not free.
 *
 * Positions are compared on a single scale: serial runs first and in order,
 * then wave 1, wave 2, and so on. An issue in `unknown` has no position and
 * is skipped — it cites no files, so it can run anywhere and constrains
 * nothing.
 */
function findViolations(
	serial: readonly number[],
	batches: readonly (readonly number[])[],
	blockedBy: ReadonlyMap<number, number[]>,
): DependencyWarning[] {
	const position = new Map<number, { stage: number; slot: number }>();
	serial.forEach((n, i) => {
		position.set(n, { stage: 0, slot: i });
	});
	batches.forEach((wave, w) => {
		for (const n of wave) position.set(n, { stage: w + 1, slot: 0 });
	});

	const warnings: DependencyWarning[] = [];
	for (const [issue, blockers] of blockedBy) {
		const here = position.get(issue);
		if (!here) continue;
		for (const blocker of blockers) {
			const there = position.get(blocker);
			if (!there) continue; // not in this plan; nothing to say about it
			if (
				here.stage < there.stage ||
				(here.stage === 0 && here.slot < there.slot)
			) {
				warnings.push({ issue, blocker, kind: "before" });
			} else if (here.stage === there.stage && here.stage > 0) {
				// Same wave: two agents would work these at the same time, which for
				// a dependency is as wrong as the wrong order.
				warnings.push({ issue, blocker, kind: "parallel" });
			}
		}
	}
	return warnings;
}
