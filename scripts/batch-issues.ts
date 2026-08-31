// Group open issues into waves that parallel agents can take without colliding.
//
//   bun run batch:issues                        # ready-for-agent
//   bun run batch:issues --label bug            # a different label
//   bun run batch:issues --issues 619,618,504   # an explicit set
//   bun run batch:issues --max 3                # agents per wave
//
// Batching by THEME is what produced duplicate work upstream: theme correlates
// with files, and files are what actually conflict. This batches by
// file-disjointness instead, reading the paths straight out of the issue
// bodies (which cite them constantly here — MEASURED 2026-08-31, 9 of 10 open
// ready-for-agent issues cite at least one path).
//
// Output is a plan, not an action. Nothing is assigned, labelled or started.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import {
	CITED_ROOT_FILES,
	CITED_ROOTS,
	DEFAULT_FAN_IN_THRESHOLD,
	DEFAULT_MAX_BATCH_SIZE,
	extractDependencies,
	extractIssueNumbersFromRef,
	extractPaths,
	importCandidates,
	type IssueClaim,
	isCitablePath,
	isMigrationBearing,
	MIGRATION_LABEL,
	partitionClaimedIssues,
	planBatches,
	splitCitations,
} from "../src/lib/issue-batching";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i === -1 ? null : (args[i + 1] ?? null);
};

const label = flag("--label") ?? "ready-for-agent";
const explicit = flag("--issues")
	?.split(",")
	.map((n) => Number(n.trim()))
	.filter((n) => Number.isFinite(n));
// Passed through only when the flag was actually given, so the library's
// `DEFAULT_MAX_BATCH_SIZE` / `DEFAULT_FAN_IN_THRESHOLD` stay the single source
// of truth instead of being restated here as bare literals that can drift.
const maxFlag = flag("--max");
const fanInFlag = flag("--fan-in");
const batchOptions = {
	...(maxFlag === null ? {} : { maxBatchSize: Number(maxFlag) }),
	...(fanInFlag === null ? {} : { fanInThreshold: Number(fanInFlag) }),
};

// ---- the import graph --------------------------------------------------------

/**
 * Files that can carry a `from "..."` specifier. Deliberately narrower than
 * `isCitablePath`: an issue may legitimately cite `scripts/setup-worktree.sh`
 * or a `.md` plan, but a shell script imports nothing and is imported by
 * nothing, so it has no place in the fan-in graph. The walk collects the wider
 * set — what a body may cite — and the graph is filtered down from it.
 */
const IMPORT_SOURCE_RE = /\.(tsx?|css)$/;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (isCitablePath(full)) out.push(full);
	}
	return out;
}

/**
 * The allowlisted root files this checkout actually has.
 *
 * `walk` cannot reach these — it descends from `CITED_ROOTS`, and a root file
 * is under none of them — so without this half the extractor would emit
 * `CLAUDE.md` and the existence check would immediately drop it, reporting the
 * issue as citing paths this checkout lacks and never planning it.
 *
 * Stat'd rather than assumed present, for the same reason the walk exists at
 * all. A file the tree does not have must not contribute to disjointness.
 */
function existingRootFiles(): string[] {
	return CITED_ROOT_FILES.filter((f) => {
		try {
			return statSync(f).isFile();
		} catch {
			return false;
		}
	});
}

/**
 * Resolve one import specifier to a repo-relative path, or `null`.
 *
 * The candidate list and the alias mapping — the half that broke twice in the
 * port, both times silently — live in `importCandidates` in the library, where
 * vitest can reach them. This wrapper owns only the filesystem check.
 *
 * One `statSync` per candidate rather than `existsSync` then `statSync`:
 * `existsSync` is itself a stat, so the pair cost two syscalls per resolved
 * candidate across ~2,045 alias/relative specifiers in this repo.
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
	for (const c of importCandidates(dirname(fromFile), spec)) {
		try {
			if (statSync(c).isFile()) return c;
		} catch {
			// candidate does not exist; try the next
		}
	}
	return null;
}

/**
 * How many other files import each path. A high count means a change there is
 * not confined to its own diff.
 *
 * Throws on an empty result. An empty fan-in map is indistinguishable in the
 * printed plan from a backlog that genuinely touches no shared infrastructure,
 * and this repo has 719 source files with `src/db/schema.ts` at 188 importers,
 * so zero is never the truth — it means the resolver broke. Failing loudly
 * here is the whole reason this is not a looser regex.
 */
function buildFanIn(files: string[]): Map<string, number> {
	const fanIn = new Map<string, number>();
	// Both quote styles: Biome writes double here, but a stray single-quoted
	// import must not silently drop out of the graph.
	const importRe = /from\s+["']([^"']+)["']/g;

	for (const f of files) {
		const src = readFileSync(f, "utf8");
		const seen = new Set<string>();
		for (const [, spec] of src.matchAll(importRe)) {
			if (spec === undefined) continue;
			const target = resolveSpecifier(f, spec);
			if (target !== null && target !== f) seen.add(target);
		}
		for (const p of seen) fanIn.set(p, (fanIn.get(p) ?? 0) + 1);
	}

	if (fanIn.size === 0) {
		throw new Error(
			"fan-in graph is empty — the import resolver is broken, not the repo.\n" +
				"Every issue would be reported as batchable and the SERIAL section\n" +
				"would silently vanish. Check resolveSpecifier() against the current\n" +
				"import style and path aliases before trusting any plan.",
		);
	}
	return fanIn;
}

// ---- issues ------------------------------------------------------------------

/**
 * How many issues and PRs to fetch. Named rather than inlined so the cap check
 * below compares against the same number the request used — a drift between
 * those two is a truncation warning that can never fire.
 */
const ISSUE_FETCH_LIMIT = 200;

type RawIssue = {
	number: number;
	title: string;
	body: string;
	labels: { name: string }[];
};

function fetchIssues(): RawIssue[] {
	const base = [
		"issue",
		"list",
		"--state",
		"open",
		"--limit",
		String(ISSUE_FETCH_LIMIT),
		"--json",
		"number,title,body,labels",
	];
	const argv = explicit ? base : [...base, "--label", label];
	const out = execFileSync("gh", argv, {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	const all = JSON.parse(out) as RawIssue[];

	// The fetch cap is silent by default: `gh` returns exactly `--limit` rows and
	// says nothing, while the header below still prints a confident total. A
	// backlog at the cap is a plan missing whatever fell off the end.
	if (all.length >= ISSUE_FETCH_LIMIT) {
		console.log(
			`⚠️  Fetched exactly ${ISSUE_FETCH_LIMIT} issues — the cap. There are\n` +
				`    probably more, and they are NOT in the plan below. Narrow with\n` +
				`    --label, or raise the limit in fetchIssues().\n`,
		);
	}

	if (!explicit) return all;

	// An explicitly requested number that `gh` did not return lands nowhere in
	// the report otherwise — not even in NEEDS A FILE PATH — so a transposed
	// digit silently produces a plan one issue short.
	const found = new Set(all.map((i) => i.number));
	const absent = explicit.filter((n) => !found.has(n));
	if (absent.length > 0) {
		console.log(
			`⚠️  Requested but not found among open issues: ${absent.join(", ")}.\n` +
				`    Closed, mistyped, or beyond the fetch cap. They are not planned.\n`,
		);
	}
	return all.filter((i) => explicit.includes(i.number));
}

// ---- claims -----------------------------------------------------------------

/**
 * Issues an open PR holds.
 *
 * Two signals, and both are load-bearing. GitHub's own closing link is the
 * authoritative one, but it exists only when the PR body used a closing
 * keyword — MEASURED here 2026-08-31, only 3 of the last 10 merged PRs carry
 * one. Reading the branch name catches the rest; reading only the branch name
 * would miss a PR whose branch was named thematically but whose body does say
 * "Closes #N".
 */
function fetchPullRequestClaims(): IssueClaim[] {
	const out = execFileSync(
		"gh",
		[
			"pr",
			"list",
			"--state",
			"open",
			"--limit",
			String(ISSUE_FETCH_LIMIT),
			"--json",
			"number,headRefName,closingIssuesReferences",
		],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	const prs = JSON.parse(out) as {
		number: number;
		headRefName?: string;
		closingIssuesReferences?: { number: number }[];
	}[];

	return prs.flatMap((pr) => {
		const numbers = new Set<number>([
			...(pr.closingIssuesReferences ?? []).map((r) => r.number),
			...extractIssueNumbersFromRef(pr.headRefName ?? ""),
		]);
		return [...numbers].map((issue) => ({ issue, source: `PR #${pr.number}` }));
	});
}

/**
 * Issues a live worktree holds.
 *
 * This is the half that matters most, and it is the half this repo is set up
 * for: CLAUDE.md requires a dedicated worktree per issue, so a claim exists
 * from the first edit, before anything is pushed — which is the entire window
 * in which duplicate work happens.
 *
 * Read off the branch line rather than the directory name: both encode the
 * issue, but the branch is what the convention actually names.
 */
function fetchWorktreeClaims(): IssueClaim[] {
	const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
		encoding: "utf8",
	});

	return out
		.split("\n")
		.filter((l) => l.startsWith("branch "))
		.flatMap((l) => {
			const ref = l.slice("branch ".length).replace(/^refs\/heads\//, "");
			return extractIssueNumbersFromRef(ref).map((issue) => ({
				issue,
				source: `worktree ${ref}`,
			}));
		});
}

/**
 * Both claim sources, with either allowed to fail.
 *
 * Degrading to a claim-blind plan is the right failure mode — a planner that
 * refuses to plan because the network is down is worse than one that plans
 * without the PR half. But it degrades *loudly*: a silently skipped check
 * reproduces the exact bug this exists to prevent, and leaves the reader
 * unable to tell an unclaimed backlog from an unread one.
 */
function gatherClaims(): { claims: IssueClaim[]; skipped: string[] } {
	const claims: IssueClaim[] = [];
	const skipped: string[] = [];

	for (const [what, fetch] of [
		["open pull requests", fetchPullRequestClaims],
		["live worktrees", fetchWorktreeClaims],
	] as const) {
		try {
			claims.push(...fetch());
		} catch {
			skipped.push(what);
		}
	}
	return { claims, skipped };
}

// ---- plan --------------------------------------------------------------------

const citable = [
	...CITED_ROOTS.flatMap((r) => {
		// A root this checkout simply does not have is expected and fine.
		try {
			statSync(r);
		} catch {
			return [];
		}
		// It EXISTS, so any failure inside the walk is a broken graph rather than
		// an empty one, and must not degrade to `[]`. Swallowing it here would
		// defeat `buildFanIn`'s guard: that only fires when the map is TOTALLY
		// empty, so losing one root while another still populates the map leaves
		// a confident-looking plan whose SERIAL section was computed from a
		// crippled import graph — the exact silent-wrongness this tool exists to
		// prevent, and the shape CLAUDE.md documents throughout.
		return walk(r);
	}),
	...existingRootFiles(),
];
const fanIn = buildFanIn(citable.filter((f) => IMPORT_SOURCE_RE.test(f)));

const raw = fetchIssues();
const known = new Set(citable.map((f) => relative(process.cwd(), f)));

// Both directions of the dependency graph, assembled before planning. An
// issue writing "Blocks #533" states an edge that lives on #533, so the
// `blocks` half has to be inverted onto its target — which also means a
// blocker can name a dependency the dependent's own body never mentions.
const declaredBlockers = new Map<number, Set<number>>();
const addBlocker = (issue: number, blocker: number) => {
	if (issue === blocker) return;
	const set = declaredBlockers.get(issue) ?? new Set<number>();
	set.add(blocker);
	declaredBlockers.set(issue, set);
};
for (const i of raw) {
	const { blockedBy, blocks } = extractDependencies(i.body ?? "");
	for (const b of blockedBy) addBlocker(i.number, b);
	for (const b of blocks) addBlocker(b, i.number);
}

// Cited paths this checkout does not have, per issue. Dropped from the
// conflict surface — a renamed file would fake disjointness — but remembered,
// because an issue whose every citation was dropped is not an issue that cited
// nothing, and telling it to "cite the files in the body" when the body
// already does is the wrong instruction.
const missingByIssue = new Map<number, string[]>();

const issues = raw.map((i) => {
	const { present: paths, missing } = splitCitations(
		extractPaths(i.body ?? ""),
		(p) => known.has(p),
	);
	if (missing.length > 0) missingByIssue.set(i.number, missing);
	return {
		number: i.number,
		paths,
		blockedBy: [...(declaredBlockers.get(i.number) ?? [])].sort(
			(a, b) => a - b,
		),
		migration: isMigrationBearing({
			labels: (i.labels ?? []).map((l) => l.name),
			paths,
		}),
	};
});

/**
 * Issue titles, with C0/C1 control characters stripped.
 *
 * A title is free-form text any contributor can set, and it is the one field
 * here that is not regex-constrained — cited paths can only contain
 * `[A-Za-z0-9_./$-]`, so they carry no control bytes, but a title can carry raw
 * ESC/CSI/OSC sequences. This tool's entire output is a plan a human reads to
 * decide what to dispatch, so a crafted title that repositions the cursor could
 * hide the line above it: a DEPENDENCY VIOLATIONS warning, or an ALREADY BEING
 * WORKED notice. Spoofing the report is the whole attack; the process itself is
 * never at risk.
 */
const stripControl = (s: string) =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
	s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
const titles = new Map(raw.map((i) => [i.number, stripControl(i.title ?? "")]));
const pathsByIssue = new Map(issues.map((i) => [i.number, i.paths]));

// Held back BEFORE planning rather than filtered out of the plan afterwards.
// A claimed issue must not occupy a wave slot, and must not shift how the
// issues around it pack — a wave of four that loses one to a filter is a wave
// of three, not the wave of four the planner would have built without it.
const { claims, skipped: skippedClaimSources } = gatherClaims();
const { unclaimed, claimed } = partitionClaimedIssues(issues, claims);

const plan = planBatches(unclaimed, fanIn, batchOptions);
// Report the values actually in force, whether they came from a flag or from
// the library default — a header that restated the literals would go stale the
// moment a default changed.
const fanInThreshold = batchOptions.fanInThreshold ?? DEFAULT_FAN_IN_THRESHOLD;
const maxBatchSize = batchOptions.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;

const migrationIssues = new Set(
	issues.filter((i) => i.migration).map((i) => i.number),
);

/**
 * The file column: what this issue batches on, plus what was dropped.
 *
 * The dropped half is printed because it changes the reader's next move. A
 * path absent from this tree contributes nothing to disjointness, so the
 * issue may be packed alongside one it will in fact collide with.
 */
const filesOf = (n: number): string => {
	const paths = pathsByIssue.get(n) ?? [];
	const missing = missingByIssue.get(n) ?? [];

	if (missing.length === 0) {
		return paths.length > 0 ? paths.join(", ") : "(no files cited)";
	}

	const absent = missing.join(", ");
	if (paths.length === 0)
		return `(cited, but absent from this checkout: ${absent})`;
	return `${paths.join(", ")}\n      (also cited, absent from this checkout: ${absent})`;
};

const line = (n: number) => {
	// Flagged inline rather than only in a footnote: the reason this one is
	// serial is not its fan-in, and someone scanning the list will otherwise
	// assume it is and move it.
	const tag = migrationIssues.has(n) ? "  [MIGRATION — run alone]" : "";
	return `  #${n}${tag}  ${titles.get(n) ?? ""}\n      ${filesOf(n)}`;
};

const heldBack =
	claimed.length > 0 ? `, ${claimed.length} already claimed` : "";
console.log(
	`\n${raw.length} issues${explicit ? "" : ` labelled "${label}"`}${heldBack}, ` +
		`fan-in threshold ${fanInThreshold}, max ${maxBatchSize} per wave\n`,
);

// Before the plan, not after it: a reader who does not know the claim check
// was skipped will trust a plan that may contain work someone else is on.
if (skippedClaimSources.length > 0) {
	console.log(
		`⚠️  Could not read ${skippedClaimSources.join(" or ")} — issues ` +
			`claimed\n    there are NOT held back below. Check by hand before ` +
			`dispatching.\n`,
	);
}

if (plan.serial.length > 0) {
	console.log("=== SERIAL — run these first, one at a time, merge between ===");
	console.log("    (each touches a file much of the repo imports)\n");
	for (const n of plan.serial) console.log(line(n));
	console.log();
}

plan.batches.forEach((batch, i) => {
	console.log(`=== WAVE ${i + 1} — ${batch.length} agents in parallel ===\n`);
	for (const n of batch) console.log(line(n));
	console.log();
});

if (claimed.length > 0) {
	console.log("=== ALREADY BEING WORKED — held back ===");
	console.log(
		"    (an open PR or a live worktree already names these, so they were\n" +
			"     not placed in a wave. Re-run once they land.)\n",
	);
	for (const { issue, sources } of claimed) {
		console.log(`  #${issue.number}  ${titles.get(issue.number) ?? ""}`);
		console.log(`      claimed by ${sources.join(", ")}`);
	}
	console.log();
}

// `planBatches` cannot tell these apart — it only sees an empty path list —
// but the two want opposite responses from the reader, so the report splits
// them.
const staleCheckout = plan.unknown.filter(
	(n) => (missingByIssue.get(n) ?? []).length > 0,
);
const needsPath = plan.unknown.filter(
	(n) => (missingByIssue.get(n) ?? []).length === 0,
);

if (needsPath.length > 0) {
	console.log("=== NEEDS A FILE PATH — not batched ===");
	console.log("    (cite the files in the body, then re-run)\n");
	for (const n of needsPath) console.log(line(n));
	console.log();
}

if (staleCheckout.length > 0) {
	console.log("=== CITED PATHS ARE MISSING HERE — not batched ===");
	console.log(
		"    (these bodies DO cite files this checkout lacks. Either it is\n" +
			"     behind — `git pull --ff-only` and re-run — or the issue is\n" +
			"     PROPOSING a file that does not exist yet, in which case it needs\n" +
			"     one existing path too before it can be batched.)\n",
	);
	for (const n of staleCheckout) console.log(line(n));
	console.log();
}

if (plan.warnings.length > 0) {
	console.log("=== ⚠️  DEPENDENCY VIOLATIONS — the order above is wrong ===");
	console.log(
		"    (serial order is fixed automatically; these could not be, so\n" +
			"     sequence them by hand)\n",
	);
	for (const w of plan.warnings) {
		const how =
			w.kind === "parallel"
				? `is in the SAME WAVE as #${w.blocker}, so both would run at once`
				: w.kind === "cycle"
					? `and #${w.blocker} each claim to block the other — neither was reordered`
					: `is scheduled BEFORE #${w.blocker}`;
		console.log(`  #${w.issue} ${how}.`);
	}
	console.log();
}

// The migration signal is half-armed until the label exists. Said out loud,
// because a serialisation that never fires looks exactly like a backlog with
// no migrations in it.
const anyLabelled = raw.some((i) =>
	(i.labels ?? []).some((l) => l.name === MIGRATION_LABEL),
);
if (!anyLabelled) {
	console.log(
		`Note: no issue carries the "${MIGRATION_LABEL}" label, so migration\n` +
			`serialisation fired only on cited drizzle/ paths. An issue that will\n` +
			`write a migration but cites none is NOT held out of a wave — label it.\n`,
	);
}

console.log(
	`Plan only — nothing assigned or started. Each agent should name its ` +
		`worktree\nafter its issue with the number LAST (e.g. fix-dialog-scroll-619): ` +
		`that name\nis the claim, and this tool reads it back, so a worktree named for ` +
		`its issue\nkeeps the next run from handing the same work out twice.`,
);
