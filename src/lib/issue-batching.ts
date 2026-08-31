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
 */
export const CITED_ROOTS = [
	"src",
	"scripts",
	"docs",
	"drizzle",
	"extension",
] as const;

/**
 * Extensions a cited path may end in.
 *
 * Longest-first, and it matters: the alternation is tried in order, so `ts`
 * ahead of `tsx` would consume the first two characters of `.tsx` and then
 * fail its trailing word boundary. `sql` and `sh` share a first character but
 * neither prefixes the other, so their order is free. The constraint is pinned
 * by a test rather than by memory, because the symptom of breaking it is a
 * silently unbatchable issue and not an error.
 */
export const CITED_EXTENSIONS = [
	"tsx",
	"ts",
	"sql",
	"sh",
	"css",
	"md",
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
 * `CHANGELOG.md` and `VERSION` are deliberately NOT here, and the reason is
 * specific to this repo: `/ship` writes both on every single release, so if
 * issues cited them they would collide with each other unconditionally and the
 * planner would serialise the entire backlog. They are a shared surface that
 * is genuinely append-only per PR, which is the one shape disjointness models
 * badly.
 *
 * `.github/workflows/ci.yml` has the same shape as these and is also NOT here:
 * the walk in `scripts/batch-issues.ts` skips every entry starting with `.`,
 * so it would be citable and then dropped as non-existent — worse than
 * invisible, because the issue would be reported as citing a path this
 * checkout lacks and told to `git pull`.
 */
export const CITED_ROOT_FILES = [
	"CLAUDE.md",
	"CONTEXT.md",
	"TODOS.md",
	"README.md",
	"package.json",
	"biome.json",
	"vitest.config.ts",
] as const;

const escapeLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
const CITED_UNDER_ROOT =
	`(?:${CITED_ROOTS.join("|")})/[A-Za-z0-9_./$-]+` +
	`\\.(?:${CITED_EXTENSIONS.join("|")})`;

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
const CITED_PATH = `(?:\\b${CITED_UNDER_ROOT}\\b|${CITED_ROOT_FILE})`;

/** Anywhere in prose, bounded on both sides. */
const CITED_IN_PROSE = new RegExp(CITED_PATH, "g");
/** The whole string and nothing else. */
const CITED_WHOLE = new RegExp(`^${CITED_PATH}$`);

/** A `## Files` heading, at any level. Its body is the issue's change set. */
const FILES_HEADING = /^[ \t]*(#{1,6})[ \t]+Files[ \t]*$/;
/** Any ATX heading, captured so its level can be compared. */
const ANY_HEADING = /^[ \t]*(#{1,6})[ \t]+\S/;
/** A fence open or close. Headings inside one are not headings. */
const FENCE = /^[ \t]*(?:```|~~~)/;

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
	let fenced = false;
	let start = -1;
	let level = 0;

	for (const [i, line] of lines.entries()) {
		if (FENCE.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

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
	const cited = (text: string) => [
		...new Set(text.match(CITED_IN_PROSE) ?? []),
	];

	const fromSection = section === null ? [] : cited(section);
	return (fromSection.length > 0 ? fromSection : cited(body)).sort();
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
	return CITED_WHOLE.test(path);
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

const matchAllNumbers = (body: string, patterns: RegExp[]): number[] =>
	patterns.flatMap((re) =>
		[...body.matchAll(re)].map(([, n]) => Number(n)).filter(Number.isFinite),
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
 */
export function extractDependencies(body: string): {
	blockedBy: number[];
	blocks: number[];
} {
	return {
		blockedBy: [...new Set(matchAllNumbers(body, BLOCKED_BY_PATTERNS))].sort(
			(a, b) => a - b,
		),
		blocks: [...new Set(matchAllNumbers(body, BLOCKS_PATTERNS))].sort(
			(a, b) => a - b,
		),
	};
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
 * NOTE: `migration` is not yet in this repo's canonical label vocabulary
 * (`docs/agents/triage-labels.md`). Until it is added, only the path signal
 * fires. That is a documented gap, not a silent one — `scripts/batch-issues.ts`
 * says so in its output when no issue carries the label.
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
	const serial: number[] = [];
	const unknown: number[] = [];
	const batchable: IssueFiles[] = [];

	for (const issue of issues) {
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
		issues.map((i) => [i.number, i.blockedBy ?? []] as const),
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
		issues.map((i) => [i.number, i.blockedBy ?? []] as const),
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
