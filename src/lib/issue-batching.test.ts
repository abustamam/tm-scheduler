import { describe, expect, test } from "vitest";

import {
	CITED_EXTENSIONS,
	CITED_ROOT_FILES,
	CITED_ROOTS,
	extractDependencies,
	extractIssueNumbersFromRef,
	extractPaths,
	isCitablePath,
	isMigrationBearing,
	MIGRATION_LABEL,
	partitionClaimedIssues,
	planBatches,
	splitCitations,
} from "#/lib/issue-batching";

/**
 * Grouping open issues into waves that parallel agents can take without
 * colliding.
 *
 * Ported from the `metadata` repo, where the motivating failure was two
 * sessions independently building the same fix because the batches had been
 * grouped by THEME. Theme correlates with files, which is the worst property
 * for parallel work.
 *
 * The unit that makes a batch reviewable is not the unit that makes it
 * parallelisable. This computes the second one.
 */

describe("extractPaths", () => {
	test("pulls a repo path out of prose", () => {
		expect(extractPaths("see src/lib/dcp.ts for the DCP goals")).toEqual([
			"src/lib/dcp.ts",
		]);
	});

	test("strips a line-number suffix", () => {
		// Issue bodies cite `file.ts:67` constantly; the line is not part of the
		// conflict surface.
		expect(extractPaths("`src/lib/dcp.ts:67`")).toEqual(["src/lib/dcp.ts"]);
	});

	test("finds paths inside fenced code blocks", () => {
		const body = ["```", 'import { db } from "#/db"', "```"].join("\n");
		expect(extractPaths(`${body}\nsrc/db/index.ts`)).toEqual([
			"src/db/index.ts",
		]);
	});

	test("deduplicates and sorts", () => {
		const body = "src/b.ts then src/a.ts then src/b.ts again";
		expect(extractPaths(body)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("covers every source root this repo uses", () => {
		const body =
			"src/x.ts docs/adr/0008-person-identity-vs-membership.md scripts/z.ts " +
			"drizzle/0001_init.sql extension/entrypoints/background.ts";
		expect(extractPaths(body)).toEqual([
			"docs/adr/0008-person-identity-vs-membership.md",
			"drizzle/0001_init.sql",
			"extension/entrypoints/background.ts",
			"scripts/z.ts",
			"src/x.ts",
		]);
	});

	/**
	 * TanStack Start encodes route params in the FILENAME, so this repo has 24
	 * route files carrying a `$`. Upstream's character class has no `$` — it
	 * came from a repo whose routes are ordinary filenames — and porting it
	 * unchanged failed silently in two directions at once: an issue whose whole
	 * change set is one route cited nothing, and every one of those 24 files
	 * dropped out of the fan-in graph and stopped counting as an importer.
	 *
	 * MEASURED 2026-08-31: that under-counted `src/server/club-logo.ts` from 10
	 * importers to 3 and moved #504 out of SERIAL into a wave.
	 */
	test("reads a TanStack route path with $params in the filename", () => {
		expect(
			extractPaths(
				"the bug is in src/routes/club.$clubId.meeting.$meetingId.tsx",
			),
		).toEqual(["src/routes/club.$clubId.meeting.$meetingId.tsx"]);
	});

	test("reads a route path with a trailing-underscore segment", () => {
		expect(
			extractPaths("see src/routes/club.$clubId_.meeting.$meetingId.print.tsx"),
		).toEqual(["src/routes/club.$clubId_.meeting.$meetingId.print.tsx"]);
	});

	test("a $ route is citable, so the walk keeps it in the fan-in graph", () => {
		// The half that is invisible in the report: `isCitablePath` filters the
		// walk, so a route it rejects stops counting as an importer and every
		// file it imports is under-counted.
		expect(
			isCitablePath("src/routes/club.$clubId.meeting.$meetingId.tsx"),
		).toBe(true);
	});

	test("pulls a documentation path out of prose", () => {
		// Docs are a real conflict surface: two agents editing one ADR at once
		// collide exactly like two agents editing a component.
		expect(
			extractPaths("Record the decision in docs/agents/domain.md."),
		).toEqual(["docs/agents/domain.md"]);
	});

	test("reads a documentation path from a `## Files` section", () => {
		const body = [
			"## Remaining work",
			"",
			"Write it where someone editing the database will find it.",
			"",
			"## Files",
			"",
			"- `docs/agents/domain.md` — the direct-edit trap",
		].join("\n");

		expect(extractPaths(body)).toEqual(["docs/agents/domain.md"]);
	});

	/**
	 * `CLAUDE.md` is the highest-traffic non-source file in this repo — it is
	 * enormous, it is edited by nearly every PR, and it is edited by exactly the
	 * parallel agents this tool keeps apart. Without an allowlist entry an issue
	 * whose whole change set is a `CLAUDE.md` edit either sits in NEEDS A FILE
	 * PATH or — worse — batches on its other paths while two agents edit
	 * `CLAUDE.md` at once.
	 */
	test("pulls an allowlisted root file out of prose", () => {
		expect(extractPaths("see README.md and CLAUDE.md")).toEqual([
			"CLAUDE.md",
			"README.md",
		]);
	});

	test("every declared root file survives the alternation", () => {
		expect(extractPaths(CITED_ROOT_FILES.join(" "))).toEqual(
			[...CITED_ROOT_FILES].sort(),
		);
	});

	/**
	 * The allowlist is the whole safety property. Without it the rule regresses
	 * into matching any root-level `name.ext`.
	 *
	 * `CHANGELOG.md` is the port-specific case and it is deliberately excluded:
	 * `/ship` writes it on every single release, so if issues could cite it they
	 * would all collide with each other unconditionally and the planner would
	 * serialise the entire backlog. It is a shared surface that is genuinely
	 * append-only per PR — the one shape disjointness models badly.
	 */
	test("leaves a root file that is not on the allowlist alone", () => {
		expect(
			extractPaths("see CHANGELOG.md, notes.json and some-script.ts"),
		).toEqual([]);
	});

	test("VERSION is not citable — /ship writes it on every release", () => {
		expect(extractPaths("bump VERSION and CHANGELOG.md")).toEqual([]);
	});

	/**
	 * `\b` is satisfied by a `/`, so a root file matched inside a longer path
	 * would read as a citation of the root one — `.github/CLAUDE.md` is a
	 * different file and `docs/README.md` is a different file again.
	 *
	 * A path this tree does not have is dropped by `splitCitations`, so an
	 * invented one does not merely mis-batch its issue: it puts it in CITED
	 * PATHS ARE MISSING HERE and tells the reader to `git pull`, and the issue
	 * is never planned.
	 */
	test("does not read a root file out of a nested path", () => {
		expect(extractPaths(".github/CLAUDE.md and docs/README.md")).toEqual([
			"docs/README.md",
		]);
	});

	test("does not invent a path from a branch name", () => {
		// This repo's issue bodies quote branch names constantly, and a branch
		// name promoted to a path is a conflict edge against nothing.
		expect(
			extractPaths(
				"PR #649 sits on `worktree-layer-text-link-646` and edits CLAUDE.md",
			),
		).toEqual(["CLAUDE.md"]);
	});
});

/**
 * The alternation in `CITED_PATH` is tried left to right, so a shorter
 * extension placed ahead of a longer one it prefixes consumes the first
 * characters and then fails its trailing word boundary — `ts` ahead of `tsx`
 * would drop every `.tsx` citation on the floor.
 *
 * `sql` and `sh` collide with nothing in today's list, which is exactly why
 * the constraint needs pinning rather than remembering: the next extension
 * added may not be so lucky, and the symptom is a silently unbatchable issue
 * rather than an error.
 */
describe("CITED_EXTENSIONS ordering", () => {
	test("no extension is a prefix of a later one", () => {
		for (const [i, ext] of CITED_EXTENSIONS.entries()) {
			for (const later of CITED_EXTENSIONS.slice(i + 1)) {
				expect(
					later.startsWith(ext),
					`'${ext}' precedes '${later}', which it prefixes — put the longer one first`,
				).toBe(false);
			}
		}
	});

	test("every declared extension survives the alternation", () => {
		const cited = CITED_EXTENSIONS.map((ext) => `src/x.${ext}`);
		expect(extractPaths(cited.join(" "))).toEqual([...cited].sort());
	});

	test("every declared root survives the alternation", () => {
		const cited = CITED_ROOTS.map((root) => `${root}/x.ts`);
		expect(extractPaths(cited.join(" "))).toEqual([...cited].sort());
	});

	test("ignores a bare word that is not a path", () => {
		expect(
			extractPaths("the extension is broken and the docs are stale"),
		).toEqual([]);
	});

	test("returns nothing for a body that cites no files", () => {
		expect(
			extractPaths("Decide what converting a guest to a member should mean."),
		).toEqual([]);
	});

	/**
	 * A body-wide regex cannot tell a file an issue *changes* from one it merely
	 * *mentions*, so an issue can serialise on files it never touches — and,
	 * worse, omit the file it does touch and be packed into a wave beside
	 * something editing the same file.
	 *
	 * A `## Files` section, where present, is the issue's own statement of its
	 * change targets. Prefer it.
	 */
	describe("a `## Files` section is authoritative", () => {
		test("ignores paths outside the section", () => {
			const body = [
				"## Not in scope",
				"",
				"`src/lib/club-archive.ts` and `src/server/guards.ts` keep the old",
				"behaviour on purpose.",
				"",
				"## Files",
				"",
				"- `src/components/ui/dialog.tsx` — the only file this issue changes",
			].join("\n");

			expect(extractPaths(body)).toEqual(["src/components/ui/dialog.tsx"]);
		});

		test("ends at the next same-or-higher heading", () => {
			const body = [
				"## Files",
				"",
				"- src/lib/issue-batching.ts",
				"",
				"## Follow-on",
				"",
				"Once this lands, src/routes/club.$clubId.tsx can be tidied.",
			].join("\n");

			expect(extractPaths(body)).toEqual(["src/lib/issue-batching.ts"]);
		});

		test("keeps a deeper subsection inside the section", () => {
			const body = [
				"## Files",
				"",
				"- src/a.ts",
				"",
				"### Also",
				"",
				"- src/b.ts",
			].join("\n");

			expect(extractPaths(body)).toEqual(["src/a.ts", "src/b.ts"]);
		});

		test("is not truncated by a comment inside a fenced block", () => {
			// A `#` opening a shell comment is not a heading. Without fence
			// tracking this section would end at the comment and drop `src/b.ts`.
			const body = [
				"## Files",
				"",
				"- src/a.ts",
				"",
				"```bash",
				"# regenerate the plan",
				"bun run scripts/batch-issues.ts",
				"```",
				"",
				"- src/b.ts",
			].join("\n");

			expect(extractPaths(body)).toEqual([
				"scripts/batch-issues.ts",
				"src/a.ts",
				"src/b.ts",
			]);
		});

		test("accepts any heading level", () => {
			const body = [
				"### Files",
				"",
				"- src/a.ts",
				"",
				"## Elsewhere",
				"",
				"Also mentions src/b.ts",
			].join("\n");

			expect(extractPaths(body)).toEqual(["src/a.ts"]);
		});
	});

	describe("falling back to the whole body", () => {
		test("uses the whole body when there is no `## Files` section", () => {
			const body = "Fix src/lib/dcp.ts and cover it in src/lib/dcp.test.ts";
			expect(extractPaths(body)).toEqual([
				"src/lib/dcp.test.ts",
				"src/lib/dcp.ts",
			]);
		});

		/**
		 * Deliberately NOT strict here. A `## Files` section that names no path is
		 * a formatting accident, and honouring it would return zero paths for an
		 * issue whose files are named a paragraph higher — dropping it out of the
		 * plan entirely and reporting it as citing no files. That is a worse
		 * failure than the phantom paths this removes.
		 */
		test("yields to the body when the section names no path", () => {
			const body = [
				"The attendance seam needs the fix; see src/server/attendance-plan-logic.ts.",
				"",
				"## Files",
				"",
				"- the attendance seam",
			].join("\n");

			expect(extractPaths(body)).toEqual([
				"src/server/attendance-plan-logic.ts",
			]);
		});
	});
});

describe("isCitablePath", () => {
	/**
	 * The drift guard. `extractPaths` and the walk in `scripts/batch-issues.ts`
	 * must not carry independent notions of what counts as a source file: the
	 * walk feeds the "does this path still exist" filter, so a citation the walk
	 * cannot produce is silently dropped and its issue reported as citing no
	 * files at all.
	 *
	 * Both sides derive from the same lists, so this holds by construction. It
	 * is asserted anyway because the failure is invisible: nothing errors, the
	 * issue just quietly stops being scheduled.
	 */
	test("accepts every path extractPaths is willing to emit", () => {
		const body = [
			"src/components/agenda/print-theme.tsx",
			"src/styles.css",
			"docs/agents/domain.md",
			"drizzle/0001_init.sql",
			"scripts/setup-worktree.sh",
			"extension/entrypoints/background.ts",
			"src/lib/issue-batching.test.ts",
			// Root files are collected by `existingRootFiles()` in
			// `scripts/batch-issues.ts` rather than by the walk, which is a second
			// place for the two sides to drift apart.
			...CITED_ROOT_FILES,
		].join(" ");

		const cited = extractPaths(body);
		expect(cited).toHaveLength(7 + CITED_ROOT_FILES.length);
		for (const path of cited) {
			expect(isCitablePath(path), path).toBe(true);
		}
	});

	test("rejects a file the extractor would never produce", () => {
		expect(isCitablePath("src/lib/dcp.js")).toBe(false);
		expect(isCitablePath("docs/agents/domain.txt")).toBe(false);
		// A root file NOT on the allowlist stays uncitable — that is what keeps
		// the walk's filter from sweeping up every root-level file.
		expect(isCitablePath("CHANGELOG.md")).toBe(false);
		expect(isCitablePath("tsconfig.json")).toBe(false);
		// The walk skips any entry starting with `.`, so this one would be
		// citable and then dropped as absent. Left out deliberately.
		expect(isCitablePath(".github/workflows/ci.yml")).toBe(false);
	});

	test("accepts every allowlisted root file", () => {
		for (const path of CITED_ROOT_FILES) {
			expect(isCitablePath(path), path).toBe(true);
		}
	});

	/**
	 * `|` binds looser than anything around it, so an alternation spliced into
	 * `^…$` without a wrapping group anchors its first branch to the start and
	 * its last to the end and leaves the rest floating. The walk feeds this
	 * predicate, so the failure is not cosmetic — it decides which files exist.
	 */
	test("rejects a root file with anything around it", () => {
		expect(isCitablePath("some junk CLAUDE.md")).toBe(false);
		expect(isCitablePath("CLAUDE.md and more")).toBe(false);
		expect(isCitablePath("docs/CLAUDE.md")).toBe(true);
		expect(isCitablePath("my-README.md")).toBe(false);
	});
});

/**
 * The point of making a root file citable is that the planner treats it as a
 * conflict surface like any other.
 */
describe("root files as a conflict surface", () => {
	test("an issue citing only a root file is planned, not shelved", () => {
		const issue = {
			number: 1,
			paths: extractPaths("Rewrite the Git worktree section of CLAUDE.md."),
		};
		expect(issue.paths).toEqual(["CLAUDE.md"]);

		const plan = planBatches([issue], new Map());
		expect(plan.unknown).toEqual([]);
		expect(plan.batches).toEqual([[1]]);
	});

	test("two issues that both edit CLAUDE.md never share a wave", () => {
		const plan = planBatches(
			[
				{ number: 1, paths: extractPaths("Rewrite worktrees in CLAUDE.md") },
				{
					number: 2,
					paths: extractPaths("Add the batch command to CLAUDE.md"),
				},
			],
			new Map(),
		);
		expect(plan.unknown).toEqual([]);
		expect(plan.batches).toEqual([[1], [2]]);
	});
});

/**
 * A cited path the working tree does not have is dropped — a stale path would
 * fake disjointness — but it must not land in the same bucket as "cited
 * nothing", because the two print identically and want opposite responses.
 */
describe("splitCitations", () => {
	const exists = (p: string) => p === "src/lib/dcp.ts";

	test("keeps the paths this checkout has", () => {
		expect(splitCitations(["src/lib/dcp.ts"], exists)).toEqual({
			present: ["src/lib/dcp.ts"],
			missing: [],
		});
	});

	test("separates a cited path the checkout is missing", () => {
		expect(
			splitCitations(["src/lib/dcp.ts", "src/lib/club-logo-limits.ts"], exists),
		).toEqual({
			present: ["src/lib/dcp.ts"],
			missing: ["src/lib/club-logo-limits.ts"],
		});
	});

	test("a body citing nothing is not a stale checkout", () => {
		// The distinction the caller reports on: `missing` empty and `present`
		// empty means "add a path", not "pull".
		expect(splitCitations([], exists)).toEqual({ present: [], missing: [] });
	});

	test("every path missing leaves nothing to batch on but still names them", () => {
		// MEASURED here 2026-08-31: #504 cites `src/lib/club-logo-limits.ts`,
		// which does not exist because the issue PROPOSES creating it.
		expect(splitCitations(["src/lib/club-logo-limits.ts"], exists)).toEqual({
			present: [],
			missing: ["src/lib/club-logo-limits.ts"],
		});
	});
});

const issue = (number: number, paths: string[]) => ({ number, paths });

describe("planBatches — disjointness", () => {
	test("puts two issues with no shared file in the same batch", () => {
		const plan = planBatches(
			[issue(1, ["src/a.ts"]), issue(2, ["src/b.ts"])],
			new Map(),
		);

		expect(plan.batches).toEqual([[1, 2]]);
	});

	test("splits two issues that share a file", () => {
		// The real shape this exists for. MEASURED here 2026-08-31: #504 and
		// #518 both cite `src/server/club-logo-logic.ts`, and nothing in the
		// pipeline would have stopped them being dispatched together.
		const plan = planBatches(
			[
				issue(504, ["src/server/club-logo-logic.ts"]),
				issue(518, ["src/server/club-logo-logic.ts"]),
			],
			new Map(),
		);

		expect(plan.batches).toEqual([[504], [518]]);
	});

	test("splits on a partial overlap, not just an exact match", () => {
		const plan = planBatches(
			[
				issue(1, ["src/a.ts", "src/b.ts"]),
				issue(2, ["src/b.ts", "src/c.ts"]),
				issue(3, ["src/d.ts"]),
			],
			new Map(),
		);

		expect(plan.batches[0]).toEqual([1, 3]);
		expect(plan.batches[1]).toEqual([2]);
	});
});

describe("planBatches — shared helpers run first, alone", () => {
	// MEASURED here 2026-08-31 by walking the real import graph.
	const fanIn = new Map([["src/db/schema.ts", 188]]);

	test("an issue touching a widely imported file is serialised", () => {
		const plan = planBatches(
			[issue(1, ["src/db/schema.ts"]), issue(2, ["src/b.ts"])],
			fanIn,
		);

		expect(plan.serial).toEqual([1]);
		expect(plan.batches).toEqual([[2]]);
	});

	test("a low fan-in file is not serialised", () => {
		const plan = planBatches(
			[issue(1, ["src/db/schema.ts"])],
			new Map([["src/db/schema.ts", 2]]),
		);

		expect(plan.serial).toEqual([]);
		expect(plan.batches).toEqual([[1]]);
	});

	test("the threshold is configurable", () => {
		const plan = planBatches([issue(1, ["src/db/schema.ts"])], fanIn, {
			fanInThreshold: 200,
		});

		expect(plan.serial).toEqual([]);
	});
});

describe("planBatches — issues that cite no files", () => {
	test("are held back rather than guessed at", () => {
		// MEASURED here 2026-08-31: 1 of the 10 open ready-for-agent issues
		// (#630) cites no path — it names a symbol instead. It cannot be proven
		// disjoint from anything, so batching it would be a guess.
		const plan = planBatches(
			[issue(630, []), issue(2, ["src/a.ts"])],
			new Map(),
		);

		expect(plan.unknown).toEqual([630]);
		expect(plan.batches).toEqual([[2]]);
	});
});

describe("planBatches — batch size", () => {
	test("caps a batch so one wave does not fan out unboundedly", () => {
		const issues = [1, 2, 3, 4, 5].map((n) => issue(n, [`src/${n}.ts`]));
		const plan = planBatches(issues, new Map(), { maxBatchSize: 2 });

		expect(plan.batches).toEqual([[1, 2], [3, 4], [5]]);
	});
});

/**
 * Migrations serialise for a reason unrelated to fan-in: they write to shared
 * databases (`tm_scheduler` locally, and the `tm_test` every parallel vitest
 * run shares), so they collide with agents they share no file with. This repo
 * has already been bitten by a subagent's `db:push` reverting `tm_test`
 * mid-run and faking dozens of failures.
 */
describe("isMigrationBearing", () => {
	test("the label is enough on its own", () => {
		expect(isMigrationBearing({ labels: [MIGRATION_LABEL] })).toBe(true);
	});

	test("a cited migration file is enough on its own", () => {
		// The case where the migration already exists in the branch and the
		// label was forgotten.
		expect(isMigrationBearing({ paths: ["drizzle/0042_add_column.sql"] })).toBe(
			true,
		);
	});

	/**
	 * Citing the schema is NOT a migration signal, for upstream's reason and one
	 * local one. An issue can be *about* the schema and change no models; and
	 * `src/db/schema.ts` carries 188 importers here, so a real schema change is
	 * already serialised by fan-in. Adding it would only change the label
	 * printed, not the placement.
	 */
	test("citing the schema alone is not a migration", () => {
		expect(isMigrationBearing({ paths: ["src/db/schema.ts"] })).toBe(false);
	});

	test("prose about migrations is not a migration", () => {
		// The signal that failed on its first real run upstream: an issue
		// discussing migrations at length was flagged as performing one.
		expect(
			isMigrationBearing({ paths: ["docs/adr/0007-railway-managed-paas.md"] }),
		).toBe(false);
	});

	test("an unlabelled, unciting issue is not a migration", () => {
		expect(isMigrationBearing({})).toBe(false);
	});

	test("a migration is serialised even with a private file set", () => {
		const plan = planBatches(
			[
				{ number: 1, paths: ["src/only-mine.ts"], migration: true },
				{ number: 2, paths: ["src/b.ts"] },
			],
			new Map(),
		);

		expect(plan.serial).toEqual([1]);
		expect(plan.batches).toEqual([[2]]);
	});
});

/**
 * Reading a claim off a branch or worktree name.
 *
 * THIS IS THE ONE PLACE THE PORT INVERTS UPSTREAM. `metadata` names branches
 * `fix/<issue>-<slug>` and reads LEADING numeric tokens; this repo's branches
 * already put the number LAST — `worktree-layer-text-link-646`,
 * `bench-flake-641`, `worktree-dialog-close-sticky-627` — so the tokens are
 * read from the end. See CLAUDE.md's "Branch naming" rule.
 */
describe("extractIssueNumbersFromRef", () => {
	test("reads the issue number off the end of a branch name", () => {
		expect(extractIssueNumbersFromRef("worktree-layer-text-link-646")).toEqual([
			646,
		]);
	});

	test("reads a branch with no worktree- prefix", () => {
		expect(extractIssueNumbersFromRef("bench-flake-641")).toEqual([641]);
	});

	test("reads every issue a branch claims, in order", () => {
		// A real branch from this repo: one PR closing two issues.
		expect(
			extractIssueNumbersFromRef("worktree-convert-guard-617-618"),
		).toEqual([617, 618]);
	});

	test("reads the worktree directory form, where `/` became `+`", () => {
		// `.claude/worktrees/` cannot hold a `/`, so the directory carries the
		// branch name with it substituted. The pre-push claim lives in this form
		// and nowhere else, which is precisely the window duplicate work happens
		// in.
		expect(extractIssueNumbersFromRef("fix+dialog-scroll-619")).toEqual([619]);
	});

	test("a thematically-named branch claims nothing", () => {
		// Returning a number here would be worse than returning none: it would
		// hold back an issue nobody is working.
		expect(extractIssueNumbersFromRef("sw-prime-on-visit")).toEqual([]);
		expect(
			extractIssueNumbersFromRef("worktree-evaluator-reorder-positional"),
		).toEqual([]);
	});

	test("the default branch claims nothing", () => {
		expect(extractIssueNumbersFromRef("main")).toEqual([]);
	});

	test("a type-prefixed branch strips the prefix before reading", () => {
		expect(extractIssueNumbersFromRef("docs/link-color-followup-648")).toEqual([
			648,
		]);
	});

	test("a prefixed branch with a thematic slug still claims nothing", () => {
		expect(
			extractIssueNumbersFromRef("docs/link-color-followup-issues"),
		).toEqual([]);
	});

	test("stops at the first trailing token that is not purely a number", () => {
		// A real branch here: `622a` is a stage marker, not issue #622. Reading
		// it as a claim would hold back an issue nobody is on.
		expect(
			extractIssueNumbersFromRef("worktree-editable-ordinary-meetings-622a"),
		).toEqual([]);
	});

	test("a bare number is a claim", () => {
		expect(extractIssueNumbersFromRef("619")).toEqual([619]);
	});

	/**
	 * The two branch names `.claude/skills/dispatching-issue-waves/SKILL.md`
	 * uses to teach the convention, pinned verbatim so the skill's worked
	 * example cannot go stale against the parser it describes. If either of
	 * these flips, the skill is teaching the wrong thing.
	 */
	test("the skill's worked example holds: number last claims, mid-name does not", () => {
		expect(extractIssueNumbersFromRef("fix-dcp-training-531")).toEqual([531]);
		expect(extractIssueNumbersFromRef("issue-531-dcp")).toEqual([]);
	});
});

/**
 * Holding back work that is already claimed. The planner reads issues and
 * files; without this it never asks whether anyone is already on one.
 */
describe("partitionClaimedIssues", () => {
	test("holds back a claimed issue and keeps the rest", () => {
		const { unclaimed, claimed } = partitionClaimedIssues(
			[{ number: 1 }, { number: 2 }, { number: 3 }],
			[{ issue: 2, source: "PR #649" }],
		);
		expect(unclaimed.map((i) => i.number)).toEqual([1, 3]);
		expect(claimed).toEqual([{ issue: { number: 2 }, sources: ["PR #649"] }]);
	});

	test("collects every source that claims the same issue", () => {
		// A worktree claim appears before any push; the PR arrives later. Both
		// naming the same issue is the normal case, not a conflict.
		const { claimed } = partitionClaimedIssues(
			[{ number: 619 }],
			[
				{ issue: 619, source: "PR #649" },
				{ issue: 619, source: "worktree fix-dialog-scroll-619" },
			],
		);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.sources).toEqual([
			"PR #649",
			"worktree fix-dialog-scroll-619",
		]);
	});

	test("ignores a claim for an issue that is not being planned", () => {
		// This is also what bounds the known false-positive in
		// `extractIssueNumbersFromRef`: a slug ending in an incidental digit
		// claims an issue that is almost never in the plan.
		const { unclaimed, claimed } = partitionClaimedIssues(
			[{ number: 1 }],
			[{ issue: 999, source: "PR #12" }],
		);
		expect(unclaimed.map((i) => i.number)).toEqual([1]);
		expect(claimed).toEqual([]);
	});

	test("with no claims at all, nothing is held back", () => {
		// The degraded path: `gh` unreachable and no worktrees. The plan must be
		// exactly what it would be otherwise, not empty.
		const { unclaimed, claimed } = partitionClaimedIssues(
			[{ number: 1 }, { number: 2 }],
			[],
		);
		expect(unclaimed.map((i) => i.number)).toEqual([1, 2]);
		expect(claimed).toEqual([]);
	});
});

/**
 * Ordering constraints stated in prose. Deliberately narrow: a bare `#630`
 * anywhere in a body is a cross-reference, not a dependency, and this repo's
 * issue bodies cite issue numbers constantly.
 */
describe("extractDependencies", () => {
	test("reads the phrasings this repo writes", () => {
		expect(extractDependencies("Blocked by #619").blockedBy).toEqual([619]);
		expect(extractDependencies("Depends on #619").blockedBy).toEqual([619]);
		expect(extractDependencies("Requires #619").blockedBy).toEqual([619]);
		expect(extractDependencies("Land #619 first").blockedBy).toEqual([619]);
	});

	test("reads the inverse direction too", () => {
		expect(extractDependencies("Blocks #618").blocks).toEqual([618]);
	});

	test("does not read `unblocks` as `blocks`", () => {
		// "Unblocking progress: PR #649" is a sentence this repo writes.
		expect(extractDependencies("Unblocks #618").blocks).toEqual([]);
	});

	test("a bare cross-reference is not a dependency", () => {
		expect(extractDependencies("See #619 for context")).toEqual({
			blockedBy: [],
			blocks: [],
		});
	});
});
