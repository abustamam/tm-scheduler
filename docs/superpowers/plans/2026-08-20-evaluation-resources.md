# Evaluation Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link every Pathways project to its official Toastmasters evaluation resource PDF, surface it where the member and their evaluator already stand, and put all 64 on one searchable public page.

**Architecture:** A pinned data module in `src/lib/` maps catalog project names to TI URLs (no hosting, links only), with one pure resolver function that both UI call sites use. The evaluator's commitment gains the *speaker's* project via an existing `role_slots.evaluatesSlotId` self-join. A new public `/resources/evaluation-resources` route lists all 64 with client-side filtering.

**Tech Stack:** TanStack Start (React 19), Drizzle ORM on Postgres, Vitest, Tailwind v4 + shadcn/ui, Biome (tabs, double quotes).

**Spec:** `docs/superpowers/specs/2026-08-20-evaluation-resources-design.md` — read it before Task 1. It documents where the data came from, the four conflicts in TI's own library, and why the mapping is pinned rather than derived.

## Global Constraints

- **Import alias:** `#/*` → `src/*`. Use `#/`, not `@/`.
- **Biome:** tabs for indentation, double quotes, import organization on. Run `bun run fix` to apply; never `--unsafe`.
- **Typecheck is the only type gate:** `bun run typecheck`. `bun run build` and `bun run test` transpile without checking types.
- **Tests:** `bun run test` (Vitest, never `bun test`). Single file: `bunx vitest run <path>`.
- **Integration suites need a DB.** On this machine: `export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"` before `bun run test`, or ~630 tests silently SKIP and the run still reads green.
- **Lint gate:** read it with `bunx biome check --diagnostic-level=error`. `src/db/seed.ts` carries ~118 pre-existing warnings that bury real errors.
- **No hosting of TI files.** Links only — never download, mirror, cache, proxy, or commit a TI PDF.
- **Server-module rule:** a `src/server/*.ts` module that defines a `createServerFn` exports only server fns and types. DB logic goes in a sibling `*-logic.ts`.
- **Exactly 64 entries** in `EVALUATION_RESOURCES`, covering all **60** distinct project names in `PATHWAYS_CATALOG`. These numbers are asserted absolutely, not relatively.
- **Never invent a TI item code.** Two entries have `itemCode: null` because TI's page exposes none. Leave them null.
- **Component tests need a jsdom docblock.** `vitest.config.ts` sets `environment: "node"`. Any test that renders React must have `// @vitest-environment jsdom` as its **first line**, before the file's own comment block. See `src/components/ui/dropdown-menu.test.tsx`.
- **There is no `@testing-library/jest-dom` in this repo.** `toBeInTheDocument`, `toHaveAttribute`, `toBeDisabled` and friends DO NOT EXIST. Assert with native DOM instead: `expect(el).toBeTruthy()`, `expect(el.getAttribute("target")).toBe("_blank")`, `expect(container.textContent).toContain("…")`. `src/routes/_authed/admin/club-settings.test.tsx` records the convention.
- **Nothing importable by a unit test may reach `#/db`.** `src/db/index.ts` throws `DATABASE_URL is not set` at import, and unit tests get only `BETTER_AUTH_*` from `src/test/setup-env.ts`. So a route module — which imports `getAuthContext` → `#/db` — is unreachable from vitest. Testable logic goes in `src/lib/`, never exported from a route file.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/evaluation-resources.ts` | **Create.** The 64 pinned entries, `resourcesForProject`, and `resolveEvaluationResources` (the resolution policy). Pure — no `#/db` import, so vitest can assert on it. |
| `src/lib/evaluation-resources.test.ts` | **Create.** Mapping correctness against `PATHWAYS_CATALOG` + absolute structural guard. |
| `src/components/pathways/evaluation-resource-link.tsx` | **Create.** The one link component both the picker and the commitment card render, so the "current edition" and generic-fallback wording exists once. |
| `src/components/pathways/evaluation-resource-link.test.tsx` | **Create.** Link attributes, multi-part labelling, fallback and legacy wording. |
| `src/components/pathways/project-picker.tsx` | **Modify.** A resource link on each project row and on the selected-project summary. |
| `src/components/pathways/project-picker.test.tsx` | **Modify** (create if absent). The picker renders the link for the selected project. |
| `src/server/my-activity-logic.ts` | **Modify.** `loadMyCommitments` gains the evaluator self-join and returns the evaluated project name. |
| `src/server/my-activity.integration.test.ts` | **Modify.** Coverage for the evaluator arm. |
| `src/server/my-commitments-query.integration.test.ts` | **Create.** Query-count guard: the join must not become an N+1. |
| `src/routes/_authed/me.tsx` | **Modify.** Render the resource link on a commitment card. |
| `src/routes/_authed/dashboard.tsx` | **Modify.** Same link on the dashboard's commitment list. |
| `src/routes/commitment-eval-resource.guard.test.ts` | **Create.** Comment-blind source guard on the two route wirings (routes cannot be mounted in vitest). |
| `src/routes/resources.evaluation-resources.tsx` | **Create.** The public index route with its filter. |
| `content/resources/evaluation-resources.md` | **Create.** Intro article — required by `resources.guard.test.ts`. |
| `src/data/resources.ts` | **Modify.** Register the new resource card. |
| `scripts/check-evaluation-resource-links.ts` | **Create.** Network liveness check. Deliberately a script, not a test. |

---

## Task 1: The data module

The whole feature rests on this table being right. Everything else is wiring.

**Files:**
- Create: `src/lib/evaluation-resources.ts`
- Test: `src/lib/evaluation-resources.test.ts`

**Interfaces:**
- Consumes: `PATHWAYS_CATALOG` from `#/lib/pathways-catalog` (test only — the data module itself must NOT import it, to keep the two independently auditable).
- Produces:
  - `interface EvaluationResource { key: string; itemCode: string | null; title: string; url: string; project: string | null; part?: string }`
  - `const EVALUATION_RESOURCES: readonly EvaluationResource[]` — 64 entries
  - `const GENERIC_EVALUATION_RESOURCE: EvaluationResource` — item `8053`
  - `function resourcesForProject(name: string | null | undefined): readonly EvaluationResource[]`
  - `interface ResolvedEvaluationResources { resources: readonly EvaluationResource[]; currentEditionNote: boolean; isGenericFallback: boolean }`
  - `function resolveEvaluationResources(name: string | null | undefined): ResolvedEvaluationResources`
  - `function filterEvaluationResources(query: string): readonly EvaluationResource[]` — the index page's search, which lives here rather than in the route because a route module imports `#/db` and is unreachable from vitest (see Global Constraints).

- [ ] **Step 1: Write the failing test**

Create `src/lib/evaluation-resources.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	EVALUATION_RESOURCES,
	filterEvaluationResources,
	GENERIC_EVALUATION_RESOURCE,
	resolveEvaluationResources,
	resourcesForProject,
} from "#/lib/evaluation-resources";
import { PATHWAYS_CATALOG } from "#/lib/pathways-catalog";

/** Distinct project names across all 11 paths, "(Legacy)" stripped. */
const catalogProjects = (): string[] => {
	const s = new Set<string>();
	for (const path of PATHWAYS_CATALOG)
		for (const p of path.projects)
			s.add(p.name.replace(/\s*\(Legacy\)\s*$/, ""));
	return [...s];
};

describe("evaluation resource mapping", () => {
	// The assertion that catches TI's four title/description conflicts. Naive
	// title matching resolves 59/60; naive description matching 57/60. Only the
	// hand-audited table reaches 60/60, so this fails the moment someone
	// "simplifies" the table into a derivation.
	it("covers every catalog project", () => {
		const missing = catalogProjects().filter(
			(name) => resourcesForProject(name).length === 0,
		);
		expect(missing).toEqual([]);
	});

	it("covers exactly 60 distinct projects", () => {
		expect(new Set(catalogProjects()).size).toBe(60);
	});

	it.each([
		["8103E", "Writing a Speech with Purpose"],
		["8409E", "Managing a Difficult Audience"],
		["8410E", undefined],
		["8207E", "Understanding Your Leadership Style"],
	])(
		"resolves TI conflict %s to the audited project",
		(code, expected) => {
			const found = EVALUATION_RESOURCES.find((r) => r.itemCode === code);
			expect(found?.project).toBe(expected);
		},
	);

	it("resolves a (Legacy) name to the current-edition resource", () => {
		const current = resourcesForProject("Active Listening");
		const legacy = resourcesForProject("Active Listening (Legacy)");
		expect(legacy).toEqual(current);
		expect(legacy.length).toBeGreaterThan(0);
	});

	it("is insensitive to case and punctuation drift from Base Camp", () => {
		expect(resourcesForProject("  question and answer session  ")).toEqual(
			resourcesForProject("Question-and-Answer Session"),
		);
	});

	it("returns [] for an unknown project, never the generic", () => {
		// Base Camp can name a project the catalog does not have (see #606).
		// The caller decides whether to fall back; the lookup must not decide.
		expect(resourcesForProject("Advanced Mentoring")).toEqual([]);
		expect(resourcesForProject(null)).toEqual([]);
		expect(resourcesForProject(undefined)).toEqual([]);
		expect(resourcesForProject("")).toEqual([]);
	});

	it("returns all three Evaluation and Feedback parts", () => {
		const rs = resourcesForProject("Evaluation and Feedback");
		expect(rs).toHaveLength(3);
		expect(rs.map((r) => r.part).sort()).toEqual([
			"Evaluator role",
			"First speech",
			"Second speech",
		]);
	});

	it("returns both Vocal Variety parts", () => {
		const rs = resourcesForProject(
			"Introduction to Vocal Variety and Body Language",
		);
		expect(rs).toHaveLength(2);
		expect(rs.map((r) => r.part).sort()).toEqual([
			"Evaluation resource",
			"Speech profile",
		]);
	});
});

describe("resolveEvaluationResources", () => {
	it("flags nothing special for a current-edition project", () => {
		const r = resolveEvaluationResources("Active Listening");
		expect(r.currentEditionNote).toBe(false);
		expect(r.isGenericFallback).toBe(false);
		expect(r.resources.length).toBeGreaterThan(0);
	});

	it("flags the current-edition note for a (Legacy) project", () => {
		const r = resolveEvaluationResources("Active Listening (Legacy)");
		expect(r.currentEditionNote).toBe(true);
		expect(r.isGenericFallback).toBe(false);
		expect(r.resources).toEqual(resourcesForProject("Active Listening"));
	});

	it("falls back to the generic resource for an unknown or absent project", () => {
		for (const input of [null, undefined, "", "Advanced Mentoring"]) {
			const r = resolveEvaluationResources(input);
			expect(r.isGenericFallback).toBe(true);
			expect(r.resources).toEqual([GENERIC_EVALUATION_RESOURCE]);
			expect(r.currentEditionNote).toBe(false);
		}
	});
});

describe("filterEvaluationResources", () => {
	it("returns everything for an empty query", () => {
		expect(filterEvaluationResources("")).toHaveLength(64);
		expect(filterEvaluationResources("   ")).toHaveLength(64);
	});

	it("matches on project name, case-insensitively", () => {
		const r = filterEvaluationResources("active listening");
		expect(r).toHaveLength(1);
		expect(r[0].project).toBe("Active Listening");
	});

	it("matches on TI item code, either case", () => {
		expect(filterEvaluationResources("8200E")[0]?.itemCode).toBe("8200E");
		expect(filterEvaluationResources("8200e")).toHaveLength(1);
	});

	it("ignores punctuation differences", () => {
		// A member types what they remember, not TI's hyphenation.
		expect(
			filterEvaluationResources("question and answer").length,
		).toBeGreaterThan(0);
	});

	it("returns nothing for a query that matches nothing", () => {
		expect(filterEvaluationResources("zzzzz")).toEqual([]);
	});

	it("finds the generic resource by name", () => {
		expect(
			filterEvaluationResources("generic").some((x) => x.itemCode === "8053"),
		).toBe(true);
	});

	it("finds a part by name", () => {
		const r = filterEvaluationResources("evaluator role");
		expect(r).toHaveLength(1);
		expect(r[0].part).toBe("Evaluator role");
	});
});

// Absolute, not relative. CLAUDE.md: a test stated relative to the constant it
// guards cannot fail — `toBeGreaterThan(0)` passes for a truncated table too.
describe("structural integrity", () => {
	it("has exactly 64 entries", () => {
		expect(EVALUATION_RESOURCES).toHaveLength(64);
	});

	it("has unique non-empty keys", () => {
		const keys = EVALUATION_RESOURCES.map((r) => r.key);
		expect(keys.every((k) => k.length > 0)).toBe(true);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("has unique item codes where present, and exactly two absent", () => {
		const codes = EVALUATION_RESOURCES.map((r) => r.itemCode);
		const present = codes.filter((c): c is string => c !== null);
		expect(codes.length - present.length).toBe(2);
		expect(new Set(present).size).toBe(present.length);
	});

	it("only ever links to Toastmasters over https", () => {
		for (const r of EVALUATION_RESOURCES) {
			const u = new URL(r.url);
			expect(u.protocol).toBe("https:");
			expect(
				u.hostname === "toastmasters.org" ||
					u.hostname.endsWith(".toastmasters.org"),
			).toBe(true);
		}
	});

	it("never points two entries at the same PDF", () => {
		// The shape a copy-paste slip in a hand-audited 64-row table would take.
		const urls = EVALUATION_RESOURCES.map((r) => r.url);
		expect(new Set(urls).size).toBe(urls.length);
	});

	it("has exactly one generic entry, and it is 8053", () => {
		const generic = EVALUATION_RESOURCES.filter((r) => r.project === null);
		expect(generic).toHaveLength(1);
		expect(generic[0].itemCode).toBe("8053");
		expect(generic[0]).toBe(GENERIC_EVALUATION_RESOURCE);
	});

	it("gives every multi-resource project distinct parts", () => {
		const byProject = new Map<string, string[]>();
		for (const r of EVALUATION_RESOURCES) {
			if (!r.project) continue;
			byProject.set(r.project, [
				...(byProject.get(r.project) ?? []),
				r.part ?? "",
			]);
		}
		for (const [project, parts] of byProject) {
			if (parts.length === 1) {
				expect(parts[0], `${project} should have no part`).toBe("");
				continue;
			}
			expect(new Set(parts).size, `${project} parts must differ`).toBe(
				parts.length,
			);
			expect(parts.every((p) => p !== ""), `${project} parts must be named`).toBe(
				true,
			);
		}
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/lib/evaluation-resources.test.ts`

Expected: FAIL — `Failed to resolve import "#/lib/evaluation-resources"`.

- [ ] **Step 3: Create the data module**

Create `src/lib/evaluation-resources.ts` with the header below, then the table, then the functions. **The table is data, not code — do not re-derive, reformat, reorder, or "clean up" any URL, code, or project string. `project` values are spelled exactly as `pathways-catalog.ts` spells them, including the lowercase "with" in "Writing a Speech with Purpose", which is Base Camp's spelling.**

```ts
/**
 * Official Toastmasters evaluation resources, linked to Pathways projects.
 *
 * We LINK to TI's PDFs. Nothing here is hosted, mirrored, cached or proxied.
 *
 * PROVENANCE: scraped 2026-08-20 from the Evaluation Resources category of TI's
 * resource library —
 * `https://www.toastmasters.org/resources/resource-library?c=%7B01B94FC3-FC65-4308-8CB2-6193718ED156%7D`
 * — 15 pages at `&page=N`, 73 items, matching the "1-5 of 73 items" the page
 * states. Server-rendered, so a plain GET returns the markup. Every one of the
 * 73 destination URLs was requested with `curl -L` and returned
 * `200 application/pdf` (all 73, not a sample).
 *
 * This header exists because `pathways-catalog.ts` carries a standing
 * correction: an earlier version of ITS header claimed a toastmasters.org
 * source for names that were LLM-generated. That correction was kept visible
 * "so nobody re-derives false confidence from it". So: the funnel below is how
 * these 64 rows were obtained, and the four conflicts are why the table is
 * PINNED rather than computed.
 *
 * FUNNEL: 73 scraped − 3 language variants (Arabic x1, Simplified Chinese x2)
 * = 70 English; 63 of those map to a `pathways-catalog.ts` project and cover
 * ALL 60 distinct project names; + `8053` Generic = 64 rows here.
 *
 * WHY PINNED, NOT DERIVED. Each item carries a description of the form 'This
 * evaluation resource is for the "X" project.' Across the 73: 64 agree with the
 * title, 3 have no parseable project (all non-project resources), and 6
 * disagree. Two of those 6 are harmless — Vocal Variety's two resources echo
 * their own full title inside the quotes, which is itself why the description
 * is not a trustworthy parser. The other FOUR are genuine conflicts in TI's own
 * library, and NEITHER field is right in all four:
 *
 *   8103E  title "Evaluation and Feedback-Writing a Speech With Purpose"
 *          desc  "Writing a Speech With Purpose"          → DESC trusted
 *   8409E  title "Managing a Difficult Audience"
 *          desc  "Manage Projects Successfully"           → TITLE trusted
 *   8410E  title "Mentoring"
 *          desc  "Manage Projects Successfully"           → TITLE trusted
 *   8207E  title "Understanding Your Leadership Style"
 *          desc  "Understanding Your Communication Style" → TITLE trusted
 *
 * 8409E/8410E/8207E are consecutive-code copy-paste errors in TI's
 * descriptions: 8408E is the real "Manage Projects Successfully" and 8206E the
 * real "Understanding Your Communication Style". 8103E is the reverse — its
 * TITLE carries a stray "Evaluation and Feedback-" prefix, while 8100E1/E2 are
 * the real Evaluation and Feedback resources.
 *
 * Consequence: title-only matching resolves 59/60 catalog projects,
 * description-only 57/60. Only this hand-audited table reaches 60/60. Replacing
 * it with a derivation silently loses projects — `evaluation-resources.test.ts`
 * fails if you try.
 *
 * TWO ROWS HAVE NO ITEM CODE. Evaluation and Feedback's second and third
 * resources use a generic thumbnail and an opaque `.ashx` URL, so nothing on the
 * page exposes their code. `8100E1` is confirmed for the first speech (from its
 * PDF filename); `8100E2` for the second would be an INFERENCE. Do not write
 * one. `itemCode` is null there and the test pins that it stays null for
 * exactly two rows.
 *
 * NOT IN THE CATALOG. Six English items map to no catalog project and are
 * deliberately absent: 8500E Advanced Mentoring, 8202E Cross-Cultural
 * Understanding, 8410E Mentoring, 8599E Distinguished Toastmaster, 490CO Club
 * Officer 360-Degree Evaluation, 490DL District Leader 360-Degree Evaluation.
 * The first three name REAL Pathways projects that `pathways-catalog.ts` does
 * not list — a catalog gap filed as #606, deliberately not fixed here because
 * adding a project changes what the picker offers and what the seed writes.
 *
 * TITLES ARE THE CATALOG'S, NOT TI'S. `title` mirrors `project` for every row
 * that has one, so this page reads the same as the project picker and the
 * agenda (both of which show Base Camp's name). TI's own titles are not usable
 * verbatim: 8103E's carries the stray prefix above, and two differ from the
 * catalog only in the casing of "with". The generic row is the one title that is
 * ours to choose.
 *
 * NO LANGUAGE FIELD. The three translations are dropped. Adding them later is
 * additive.
 *
 * DOES NOT IMPORT `pathways-catalog.ts`, on purpose: the two files are
 * cross-checked by a test, and a test is worth nothing if one input is derived
 * from the other.
 */

export interface EvaluationResource {
	/**
	 * Local stable identity, kebab-case. OURS, not TI's — two rows have no
	 * discoverable item code, so `itemCode` cannot carry identity.
	 */
	key: string;
	/** TI's item code where the page exposes one; null for exactly 2 of the 64. */
	itemCode: string | null;
	/** Display title, TI's "-Evaluation Resource" suffix removed. */
	title: string;
	/** Absolute https URL on a toastmasters.org host. */
	url: string;
	/**
	 * Canonical `pathways-catalog.ts` project name, spelled exactly as that file
	 * spells it. Null only for the generic resource.
	 */
	project: string | null;
	/** Distinguishes siblings on a multi-resource project. Absent when alone. */
	part?: string;
}

/**
 * Works for any speech, inside Pathways or outside it. The fallback whenever a
 * project is unknown, absent, or TBA — which is why it ships even though it
 * maps to no project.
 */
export const GENERIC_EVALUATION_RESOURCE: EvaluationResource = {
	key: "generic",
	itemCode: "8053",
	title: "Generic Evaluation Resource",
	url: "https://content.toastmasters.org/image/upload/8053-generic-evaluation-resource.pdf",
	project: null,
};

export const EVALUATION_RESOURCES: readonly EvaluationResource[] = [
	{
		key: "active-listening",
		itemCode: "8200E",
		title: "Active Listening",
		url: "https://www.toastmasters.org/resources/-/media/d97ff6e633ad44dbaca0ddac5a6c0fb8.ashx",
		project: "Active Listening",
	},
	{
		key: "building-a-social-media-presence",
		itemCode: "8400E",
		title: "Building a Social Media Presence",
		url: "https://www.toastmasters.org/resources/-/media/37dde033a23f4e75ac113786e840fb8e.ashx",
		project: "Building a Social Media Presence",
	},
	{
		key: "communicate-change",
		itemCode: "8401E",
		title: "Communicate Change",
		url: "https://www.toastmasters.org/resources/-/media/87df0196dec944ba80ab1451182a02c2.ashx",
		project: "Communicate Change",
	},
	{
		key: "connect-with-storytelling",
		itemCode: "8300E",
		title: "Connect with Storytelling",
		url: "https://ccdn.toastmasters.org/medias/files/department-documents/education-documents/evaluation-resources/english/8300e-evaluation-resource-ffe.pdf",
		project: "Connect with Storytelling",
	},
	{
		key: "connect-with-your-audience",
		itemCode: "8201E",
		title: "Connect with Your Audience",
		url: "https://www.toastmasters.org/resources/-/media/fc7df1a49bcf49968e90d07a550e282a.ashx",
		project: "Connect with Your Audience",
	},
	{
		key: "create-a-podcast",
		itemCode: "8402E",
		title: "Create a Podcast",
		url: "https://www.toastmasters.org/resources/-/media/c35bea8707c8428ebf760bdf2de6565d.ashx",
		project: "Create a Podcast",
	},
	{
		key: "creating-effective-visual-aids",
		itemCode: "8301E",
		title: "Creating Effective Visual Aids",
		url: "https://www.toastmasters.org/resources/-/media/d389e83787464044bd66639ef0e8113b.ashx",
		project: "Creating Effective Visual Aids",
	},
	{
		key: "deliver-social-speeches",
		itemCode: "8302E",
		title: "Deliver Social Speeches",
		url: "https://www.toastmasters.org/resources/-/media/438184926b484f51b4db267445f8b11c.ashx",
		project: "Deliver Social Speeches",
	},
	{
		key: "deliver-your-message-with-humor",
		itemCode: "8512E",
		title: "Deliver Your Message with Humor",
		url: "https://www.toastmasters.org/resources/-/media/40C19CFA8CF04210BB669D326D3B8763.ashx",
		project: "Deliver Your Message with Humor",
	},
	{
		key: "develop-a-communication-plan",
		itemCode: "8303E",
		title: "Develop a Communication Plan",
		url: "https://www.toastmasters.org/resources/-/media/9e466adea038434083f04f406a065801.ashx",
		project: "Develop a Communication Plan",
	},
	{
		key: "develop-your-vision",
		itemCode: "8501E",
		title: "Develop Your Vision",
		url: "https://www.toastmasters.org/resources/-/media/91202662629D422D80ED85C94ED958DA.ashx",
		project: "Develop Your Vision",
	},
	{
		key: "effective-body-language",
		itemCode: "8203E",
		title: "Effective Body Language",
		url: "https://www.toastmasters.org/resources/-/media/64608c0f628b43e68415a7f2ab7194d1.ashx",
		project: "Effective Body Language",
	},
	{
		key: "engage-your-audience-with-humor",
		itemCode: "8320E",
		title: "Engage Your Audience with Humor",
		url: "https://www.toastmasters.org/resources/-/media/28633B8177784BE28330D9A4A3DD44EF.ashx",
		project: "Engage Your Audience with Humor",
	},
	{
		key: "ethical-leadership",
		itemCode: "8502E",
		title: "Ethical Leadership",
		url: "https://www.toastmasters.org/resources/-/media/18DDDB2ABF0342CB8D035DD4591115C2.ashx",
		project: "Ethical Leadership",
	},
	{
		key: "evaluation-and-feedback-evaluator-role",
		itemCode: null,
		title: "Evaluation and Feedback",
		url: "https://www.toastmasters.org/resources/-/media/0c340954db12422d843d9ff47c40d02b.ashx",
		project: "Evaluation and Feedback",
		part: "Evaluator role",
	},
	{
		key: "evaluation-and-feedback-first-speech",
		itemCode: "8100E1",
		title: "Evaluation and Feedback",
		url: "https://ccdn.toastmasters.org/medias/files/department-documents/education-documents/evaluation-resources/english/8100e1-evaluation-resource-first-speech.pdf",
		project: "Evaluation and Feedback",
		part: "First speech",
	},
	{
		key: "evaluation-and-feedback-second-speech",
		itemCode: null,
		title: "Evaluation and Feedback",
		url: "https://www.toastmasters.org/resources/-/media/0B82133F45624042BD1A6D589FCB25FA.ashx",
		project: "Evaluation and Feedback",
		part: "Second speech",
	},
	{
		key: "focus-on-the-positive",
		itemCode: "8304E",
		title: "Focus on the Positive",
		url: "https://www.toastmasters.org/resources/-/media/a0918b5d8b504925a09c9f540d877bf0.ashx",
		project: "Focus on the Positive",
	},
	{
		key: "high-performance-leadership",
		itemCode: "8503E",
		title: "High Performance Leadership",
		url: "https://www.toastmasters.org/resources/-/media/AD5D85F559504A8ABB71CF6E0D8048AF.ashx",
		project: "High Performance Leadership",
	},
	{
		key: "ice-breaker",
		itemCode: "8101E",
		title: "Ice Breaker",
		url: "https://ccdn.toastmasters.org/medias/files/department-documents/education-documents/evaluation-resources/english/8101e-evaluation-resource.pdf",
		project: "Ice Breaker",
	},
	{
		key: "improvement-through-positive-coaching",
		itemCode: "8403E",
		title: "Improvement Through Positive Coaching",
		url: "https://www.toastmasters.org/resources/-/media/7ab9b454f2e9409b8a916c52da520274.ashx",
		project: "Improvement Through Positive Coaching",
	},
	{
		key: "inspire-your-audience",
		itemCode: "8305E",
		title: "Inspire Your Audience",
		url: "https://www.toastmasters.org/resources/-/media/c9e20cb3b0a64f478c6b847a1db292d8.ashx",
		project: "Inspire Your Audience",
	},
	{
		key: "introduction-to-toastmasters-mentoring",
		itemCode: "8204E",
		title: "Introduction to Toastmasters Mentoring",
		url: "https://www.toastmasters.org/resources/-/media/df2e2065fa984b529e4fda62787d2353.ashx",
		project: "Introduction to Toastmasters Mentoring",
	},
	{
		key: "introduction-to-vocal-variety-and-body-language-evaluation-resource",
		itemCode: "8104E1",
		title: "Introduction to Vocal Variety and Body Language",
		url: "https://content.toastmasters.org/image/upload/v1741989017/8104E1-evaluation-resource-ff.pdf",
		project: "Introduction to Vocal Variety and Body Language",
		part: "Evaluation resource",
	},
	{
		key: "introduction-to-vocal-variety-and-body-language-speech-profile",
		itemCode: "8104E2",
		title: "Introduction to Vocal Variety and Body Language",
		url: "https://ccdn.toastmasters.org/medias/files/department-documents/education-documents/evaluation-resources/english/8104e2-speech-profile-ff.pdf",
		project: "Introduction to Vocal Variety and Body Language",
		part: "Speech profile",
	},
	{
		key: "know-your-sense-of-humor",
		itemCode: "8208E",
		title: "Know Your Sense of Humor",
		url: "https://www.toastmasters.org/resources/-/media/AE85794F189346BC9799C741779E2DE3.ashx",
		project: "Know Your Sense of Humor",
	},
	{
		key: "lead-in-any-situation",
		itemCode: "8504E",
		title: "Lead in Any Situation",
		url: "https://www.toastmasters.org/resources/-/media/678FC18FC8BD4787BB1879E349B43894.ashx",
		project: "Lead in Any Situation",
	},
	{
		key: "leading-in-difficult-situations",
		itemCode: "8404E",
		title: "Leading in Difficult Situations",
		url: "https://www.toastmasters.org/resources/-/media/7ee191ee046a495290643305ae820c10.ashx",
		project: "Leading in Difficult Situations",
	},
	{
		key: "leading-in-your-volunteer-organization",
		itemCode: "8505E",
		title: "Leading in Your Volunteer Organization",
		url: "https://www.toastmasters.org/resources/-/media/7B49DCA2A7F44B81853647C7D02FDA86.ashx",
		project: "Leading in Your Volunteer Organization",
	},
	{
		key: "leading-your-team",
		itemCode: "8405E",
		title: "Leading Your Team",
		url: "https://www.toastmasters.org/resources/-/media/eb0435e414a44546bd585a92dc31beaf.ashx",
		project: "Leading Your Team",
	},
	{
		key: "lessons-learned",
		itemCode: "8506E",
		title: "Lessons Learned",
		url: "https://www.toastmasters.org/resources/-/media/592BAD67F5CC4445AB87F9EB79DA0C28.ashx",
		project: "Lessons Learned",
	},
	{
		key: "make-connections-through-networking",
		itemCode: "8306E",
		title: "Make Connections Through Networking",
		url: "https://www.toastmasters.org/resources/-/media/3476E4FFE94A47E390446346E0F275F3.ashx",
		project: "Make Connections Through Networking",
	},
	{
		key: "manage-change",
		itemCode: "8406E",
		title: "Manage Change",
		url: "https://www.toastmasters.org/resources/-/media/ff41100ad8124693aa6f5d79cecab550.ashx",
		project: "Manage Change",
	},
	{
		key: "manage-online-meetings",
		itemCode: "8407E",
		title: "Manage Online Meetings",
		url: "https://www.toastmasters.org/resources/-/media/76F5A0DFFC694F57939EA8A656F763BB.ashx",
		project: "Manage Online Meetings",
	},
	{
		key: "manage-projects-successfully",
		itemCode: "8408E",
		title: "Manage Projects Successfully",
		url: "https://www.toastmasters.org/resources/-/media/A6CDC57BC1344D06888B76C5830F4CF2.ashx",
		project: "Manage Projects Successfully",
	},
	{
		key: "manage-successful-events",
		itemCode: "8507E",
		title: "Manage Successful Events",
		url: "https://www.toastmasters.org/resources/-/media/DC4F94B05F2545F493699261AA95B8C7.ashx",
		project: "Manage Successful Events",
	},
	{
		key: "managing-a-difficult-audience",
		itemCode: "8409E",
		title: "Managing a Difficult Audience",
		url: "https://www.toastmasters.org/resources/-/media/937F8775C4AE42678999607972793762.ashx",
		project: "Managing a Difficult Audience",
	},
	{
		key: "managing-time",
		itemCode: "8205E",
		title: "Managing Time",
		url: "https://www.toastmasters.org/resources/-/media/60d8b49dfbf548faa9be863055a498db.ashx",
		project: "Managing Time",
	},
	{
		key: "moderate-a-panel-discussion",
		itemCode: "8508E",
		title: "Moderate a Panel Discussion",
		url: "https://www.toastmasters.org/resources/-/media/854D525911684FF8AEBD5D7A294D4F7A.ashx",
		project: "Moderate a Panel Discussion",
	},
	{
		key: "motivate-others",
		itemCode: "8411E",
		title: "Motivate Others",
		url: "https://www.toastmasters.org/resources/-/media/C6C4D2488F6A4A76BD3D480C877610CE.ashx",
		project: "Motivate Others",
	},
	{
		key: "negotiate-the-best-outcome",
		itemCode: "8307E",
		title: "Negotiate the Best Outcome",
		url: "https://www.toastmasters.org/resources/-/media/fcbb9cc048524519a1722a7228e35e9c.ashx",
		project: "Negotiate the Best Outcome",
	},
	{
		key: "persuasive-speaking",
		itemCode: "8308E",
		title: "Persuasive Speaking",
		url: "https://www.toastmasters.org/resources/-/media/6a1ef7aaed124b6d99eecd0b85271414.ashx",
		project: "Persuasive Speaking",
	},
	{
		key: "planning-and-implementing",
		itemCode: "8309E",
		title: "Planning and Implementing",
		url: "https://www.toastmasters.org/resources/-/media/2e789337f5374108a9a124a7f8872dee.ashx",
		project: "Planning and Implementing",
	},
	{
		key: "prepare-for-an-interview",
		itemCode: "8310E",
		title: "Prepare for an Interview",
		url: "https://www.toastmasters.org/resources/-/media/31ced8bd60ac47e092b45ca576afd934.ashx",
		project: "Prepare for an Interview",
	},
	{
		key: "prepare-to-speak-professionally",
		itemCode: "8509E",
		title: "Prepare to Speak Professionally",
		url: "https://www.toastmasters.org/resources/-/media/D4803317A848454595E628F9CA5AF414.ashx",
		project: "Prepare to Speak Professionally",
	},
	{
		key: "present-a-proposal",
		itemCode: "8312E",
		title: "Present a Proposal",
		url: "https://www.toastmasters.org/resources/-/media/75bed3e3eba245729664ab9f0a41fa5e.ashx",
		project: "Present a Proposal",
	},
	{
		key: "public-relations-strategies",
		itemCode: "8412E",
		title: "Public Relations Strategies",
		url: "https://www.toastmasters.org/resources/-/media/F3306DC62FA34425AEAF05AED1ADD857.ashx",
		project: "Public Relations Strategies",
	},
	{
		key: "question-and-answer-session",
		itemCode: "8413E",
		title: "Question-and-Answer Session",
		url: "https://content.toastmasters.org/image/upload/8413E-evaluation-resource-ff.pdf",
		project: "Question-and-Answer Session",
	},
	{
		key: "reaching-consensus",
		itemCode: "8313E",
		title: "Reaching Consensus",
		url: "https://www.toastmasters.org/resources/-/media/b5001c808e324998813489c5a0ca969e.ashx",
		project: "Reaching Consensus",
	},
	{
		key: "reflect-on-your-path",
		itemCode: "8510E",
		title: "Reflect on Your Path",
		url: "https://www.toastmasters.org/resources/-/media/F8FDA780555D41DC97C83FED8FD46155.ashx",
		project: "Reflect on Your Path",
	},
	{
		key: "researching-and-presenting",
		itemCode: "8102E",
		title: "Researching and Presenting",
		url: "https://www.toastmasters.org/resources/-/media/4a3f37e2cd0345068d5e3b7718fc7062.ashx",
		project: "Researching and Presenting",
	},
	{
		key: "successful-collaboration",
		itemCode: "8314E",
		title: "Successful Collaboration",
		url: "https://www.toastmasters.org/resources/-/media/42e078bf026a4ab08c1b5c1a9cc08f19.ashx",
		project: "Successful Collaboration",
	},
	{
		key: "team-building",
		itemCode: "8511E",
		title: "Team Building",
		url: "https://www.toastmasters.org/resources/-/media/160ABF0AFFEC4C7D982F00CAC2ECF59A.ashx",
		project: "Team Building",
	},
	{
		key: "the-power-of-humor-in-an-impromptu-speech",
		itemCode: "8415E",
		title: "The Power of Humor in an Impromptu Speech",
		url: "https://www.toastmasters.org/resources/-/media/E92A94438C344C799752A920A3805E6F.ashx",
		project: "The Power of Humor in an Impromptu Speech",
	},
	{
		key: "understanding-conflict-resolution",
		itemCode: "8315E",
		title: "Understanding Conflict Resolution",
		url: "https://www.toastmasters.org/resources/-/media/75485e2dfd1642eb8984b93b1ae2fc75.ashx",
		project: "Understanding Conflict Resolution",
	},
	{
		key: "understanding-emotional-intelligence",
		itemCode: "8316E",
		title: "Understanding Emotional Intelligence",
		url: "https://www.toastmasters.org/resources/-/media/86add2932d7e45e1814cb05ee2c3dd8b.ashx",
		project: "Understanding Emotional Intelligence",
	},
	{
		key: "understanding-vocal-variety",
		itemCode: "8317E",
		title: "Understanding Vocal Variety",
		url: "https://www.toastmasters.org/resources/-/media/b0725fa9cd6444c899ec03a89e788f4d.ashx",
		project: "Understanding Vocal Variety",
	},
	{
		key: "understanding-your-communication-style",
		itemCode: "8206E",
		title: "Understanding Your Communication Style",
		url: "https://www.toastmasters.org/resources/-/media/24dfeac928e64ed8b5226e445ab96c29.ashx",
		project: "Understanding Your Communication Style",
	},
	{
		key: "understanding-your-leadership-style",
		itemCode: "8207E",
		title: "Understanding Your Leadership Style",
		url: "https://www.toastmasters.org/resources/-/media/5a61dd1d0cef472cbbab7931a618b37d.ashx",
		project: "Understanding Your Leadership Style",
	},
	{
		key: "using-descriptive-language",
		itemCode: "8318E",
		title: "Using Descriptive Language",
		url: "https://www.toastmasters.org/resources/-/media/ed8a2a2b6e174fa2a246b1b8b6a34b84.ashx",
		project: "Using Descriptive Language",
	},
	{
		key: "using-presentation-software",
		itemCode: "8319E",
		title: "Using Presentation Software",
		url: "https://www.toastmasters.org/resources/-/media/4cdf344506554e609341ba7ef65faadc.ashx",
		project: "Using Presentation Software",
	},
	{
		key: "write-a-compelling-blog",
		itemCode: "8414E",
		title: "Write a Compelling Blog",
		url: "https://www.toastmasters.org/resources/-/media/7CCBD12EB1754A2F910CCEBE96AAAE02.ashx",
		project: "Write a Compelling Blog",
	},
	{
		key: "writing-a-speech-with-purpose",
		itemCode: "8103E",
		title: "Writing a Speech with Purpose",
		url: "https://content.toastmasters.org/image/upload/8103E-evaluation-resource-ff.pdf",
		project: "Writing a Speech with Purpose",
	},
	GENERIC_EVALUATION_RESOURCE,
];

/**
 * Lookup key: lowercased, non-alphanumerics collapsed, trailing "(Legacy)"
 * removed. Base Camp returns project names with its own punctuation and casing
 * ("Question-and-Answer Session" vs "question and answer session"), and legacy
 * paths carry a " (Legacy)" suffix on every project (see `pathways-catalog.ts`
 * `withLegacySuffix`) while TI publishes only the current edition.
 */
function lookupKey(name: string): string {
	return name
		.replace(/\s*\(Legacy\)\s*$/i, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

const BY_PROJECT: ReadonlyMap<string, readonly EvaluationResource[]> = (() => {
	const m = new Map<string, EvaluationResource[]>();
	for (const r of EVALUATION_RESOURCES) {
		if (!r.project) continue;
		const k = lookupKey(r.project);
		const list = m.get(k);
		if (list) list.push(r);
		else m.set(k, [r]);
	}
	return m;
})();

/**
 * Every resource for a project, or `[]` when the name is unknown.
 *
 * Deliberately does NOT fall back to the generic resource: a caller must be
 * able to tell "no match" from "matched the generic", and whether to fall back
 * is a call-site decision. Use `resolveEvaluationResources` for the policy.
 */
export function resourcesForProject(
	name: string | null | undefined,
): readonly EvaluationResource[] {
	if (!name) return [];
	return BY_PROJECT.get(lookupKey(name)) ?? [];
}

export interface ResolvedEvaluationResources {
	resources: readonly EvaluationResource[];
	/**
	 * True when the requested name carried "(Legacy)" and matched only after the
	 * suffix was stripped. The UI says so: a member evaluated against a
	 * superseded edition's criteria should know that is what happened.
	 */
	currentEditionNote: boolean;
	/** True when nothing matched and `resources` is the generic resource alone. */
	isGenericFallback: boolean;
}

/**
 * The whole resolution policy in one pure function, so both the project picker
 * and the commitment card share it. It lives here rather than inline in a route
 * because a route cannot be mounted in vitest — CLAUDE.md's props trap: a
 * component tested through its props cannot see a WRONG prop, and this is the
 * expression that computes them.
 */
export function resolveEvaluationResources(
	name: string | null | undefined,
): ResolvedEvaluationResources {
	const resources = resourcesForProject(name);
	if (resources.length === 0)
		return {
			resources: [GENERIC_EVALUATION_RESOURCE],
			currentEditionNote: false,
			isGenericFallback: true,
		};
	return {
		resources,
		currentEditionNote: /\(Legacy\)\s*$/i.test(name ?? ""),
		isGenericFallback: false,
	};
}

/**
 * The index page's search. Lives here, not in the route: a route module imports
 * `getAuthContext` → `#/db`, which throws `DATABASE_URL is not set` at import,
 * so anything exported from a route is unreachable from vitest.
 *
 * Normalizes punctuation on both sides — a member types "question and answer",
 * TI writes "Question-and-Answer Session".
 */
export function filterEvaluationResources(
	query: string,
): readonly EvaluationResource[] {
	const q = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	if (!q) return EVALUATION_RESOURCES;
	return EVALUATION_RESOURCES.filter((r) =>
		[r.title, r.project ?? "", r.itemCode ?? "", r.part ?? ""]
			.join(" ")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.includes(q),
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/lib/evaluation-resources.test.ts`

Expected: PASS, all assertions. If "covers every catalog project" fails, a `project` string does not match `pathways-catalog.ts` — fix the table, never the test.

- [ ] **Step 5: Typecheck and lint**

```bash
bun run typecheck
bunx biome check --diagnostic-level=error src/lib/evaluation-resources.ts src/lib/evaluation-resources.test.ts
```

Expected: both clean. `bun run fix` if formatting complains.

- [ ] **Step 6: Commit**

```bash
git add src/lib/evaluation-resources.ts src/lib/evaluation-resources.test.ts
git commit -m "feat(pathways): pin the official TI evaluation resource for every project"
```

---

## Task 2: The shared link component

One small component both the picker and the commitment card render, so the
"current edition" wording and the external-link attributes exist once.

**Files:**
- Create: `src/components/pathways/evaluation-resource-link.tsx`
- Test: `src/components/pathways/evaluation-resource-link.test.tsx`

**Interfaces:**
- Consumes: `resolveEvaluationResources`, `type EvaluationResource` from `#/lib/evaluation-resources` (Task 1).
- Produces: `<EvaluationResourceLinks projectName={string | null} variant?: "inline" | "block" />`.

Notes an implementer needs:

- These are **external** links, so `target="_blank" rel="noopener noreferrer"` is required.
- Per CLAUDE.md, `src/styles.css` styles bare `a` **outside** `@layer`, so the global text-link rule beats any Tailwind utility a component sets. Here link-teal is what we want — these really are outbound links — so **do not** add a `data-slot` exclusion and **do not** try to override the colour with a utility class; a layered class loses silently.
- `isGenericFallback` must be visible to the reader. A form labelled as the project's own when it is actually the generic one is worse than no link.

- [ ] **Step 1: Write the failing test**

Create `src/components/pathways/evaluation-resource-link.test.tsx`:

```tsx
// @vitest-environment jsdom
//
// No `@testing-library/jest-dom` in this repo, so every assertion below uses
// native DOM properties rather than `toBeInTheDocument` / `toHaveAttribute`.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvaluationResourceLinks } from "#/components/pathways/evaluation-resource-link";

describe("EvaluationResourceLinks", () => {
	it("links a known project to its TI resource, opening safely", () => {
		const { container } = render(
			<EvaluationResourceLinks projectName="Active Listening" />,
		);
		const link = container.querySelector("a");
		expect(link).toBeTruthy();
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toContain("noopener");
		expect(link?.getAttribute("href")).toMatch(
			/^https:\/\/[^/]*toastmasters\.org\//,
		);
	});

	it("names each part when a project has several resources", () => {
		const { container } = render(
			<EvaluationResourceLinks projectName="Evaluation and Feedback" />,
		);
		expect(container.querySelectorAll("a")).toHaveLength(3);
		const text = container.textContent ?? "";
		expect(text).toContain("First speech");
		expect(text).toContain("Second speech");
		expect(text).toContain("Evaluator role");
	});

	it("says so when it falls back to the generic resource", () => {
		// An unknown project must not be presented as if the form were its own.
		const { container } = render(
			<EvaluationResourceLinks projectName="Advanced Mentoring" />,
		);
		expect(container.textContent).toContain("Generic evaluation resource");
	});

	it("notes the current edition for a legacy-path project", () => {
		const { container } = render(
			<EvaluationResourceLinks projectName="Active Listening (Legacy)" />,
		);
		expect(container.textContent).toContain("current edition");
	});

	it("does not note the edition for a current-path project", () => {
		const { container } = render(
			<EvaluationResourceLinks projectName="Active Listening" />,
		);
		expect(container.textContent).not.toContain("current edition");
	});

	it("renders the same resource for a legacy project as its current twin", () => {
		const legacy = render(
			<EvaluationResourceLinks projectName="Active Listening (Legacy)" />,
		).container.querySelector("a")?.getAttribute("href");
		const current = render(
			<EvaluationResourceLinks projectName="Active Listening" />,
		).container.querySelector("a")?.getAttribute("href");
		expect(legacy).toBe(current);
		expect(legacy).toBeTruthy();
	});
});
```

`screen` is imported for parity with the repo's other component tests; if you do
not use it, drop it from the import — strict TS fails the build on an unused
symbol.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/components/pathways/evaluation-resource-link.test.tsx`

Expected: FAIL — cannot resolve `#/components/pathways/evaluation-resource-link`.

- [ ] **Step 3: Write the component**

Create `src/components/pathways/evaluation-resource-link.tsx`:

```tsx
import { FileText } from "lucide-react";
import { resolveEvaluationResources } from "#/lib/evaluation-resources";

/**
 * Links to the official TI evaluation resource(s) for a project (#606-adjacent;
 * spec 2026-08-20). External links to toastmasters.org — nothing is hosted here.
 *
 * The colour is deliberately left alone: `src/styles.css` styles bare `a`
 * outside `@layer`, so the global link-teal rule wins over any utility class.
 * These ARE outbound links, so that is the right colour, and a `text-*` utility
 * here would silently do nothing.
 */
export function EvaluationResourceLinks({
	projectName,
	variant = "inline",
}: {
	projectName: string | null | undefined;
	variant?: "inline" | "block";
}) {
	const { resources, currentEditionNote, isGenericFallback } =
		resolveEvaluationResources(projectName);

	return (
		<div
			className={
				variant === "block"
					? "mt-2 flex flex-col gap-1"
					: "mt-1 flex flex-wrap items-center gap-x-3 gap-y-1"
			}
		>
			{resources.map((r) => (
				<a
					key={r.key}
					href={r.url}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1.5 text-xs"
				>
					<FileText className="size-3.5 shrink-0" aria-hidden />
					<span>
						{isGenericFallback
							? "Generic evaluation resource"
							: r.part
								? `Evaluation resource — ${r.part}`
								: "Evaluation resource"}
					</span>
				</a>
			))}
			{currentEditionNote ? (
				<span className="text-[var(--sea-ink-soft)] text-xs">
					current edition
				</span>
			) : null}
		</div>
	);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run src/components/pathways/evaluation-resource-link.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/pathways/evaluation-resource-link.tsx src/components/pathways/evaluation-resource-link.test.tsx
git commit -m "feat(pathways): shared evaluation-resource link component"
```

---

## Task 3: Wire the link into the project picker

**Files:**
- Modify: `src/components/pathways/project-picker.tsx` — the selected-project summary (around line 90) and each project row in the level list (around line 240).
- Test: `src/components/pathways/project-picker.test.tsx` (create if absent; otherwise add cases).

**Interfaces:**
- Consumes: `EvaluationResourceLinks` from Task 2.
- Produces: nothing new.

Placement notes: the project rows are `<button>` elements inside `<li>`. **An anchor cannot go inside the button** — nested interactive elements break keyboard navigation and the click would toggle selection. Put the link as a sibling inside the `<li>`, after the `</button>`.

- [ ] **Step 1: Write the failing test**

Add to `src/components/pathways/project-picker.test.tsx`:

The file needs `// @vitest-environment jsdom` as its FIRST line if it does not
have one already. No jest-dom matchers.

`PickerPath` and `PickerProject` are defined in
`src/server/project-picker-logic.ts:29` and `:44` — these are the REAL shapes,
verified during pre-flight. Do not adjust the component's types to fit a
fixture; adjust the fixture.

```tsx
import type { PickerPath } from "#/server/project-picker";

const PATH: PickerPath = {
	pathId: "path-1",
	courseCode: "8701",
	name: "Presentation Mastery",
	status: "current",
	defaultLevel: 3,
	projects: [
		{
			id: "proj-1",
			level: 3,
			name: "Active Listening",
			isRequired: false,
			complete: false,
		},
	],
};

it("offers the evaluation resource for the selected project", () => {
	const { container } = render(
		<ProjectPicker
			paths={[PATH]}
			value="proj-1"
			onChange={() => {}}
			fallback={{ pathwayPath: null, projectName: null, projectLevel: null }}
		/>,
	);
	const link = container.querySelector('a[href*="toastmasters.org"]');
	expect(link).toBeTruthy();
});
```

`import type` keeps this a type-only import, so `#/server/project-picker` — which
imports `#/db` — is erased at compile time and never loaded at runtime. A plain
`import` here would throw `DATABASE_URL is not set`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bunx vitest run src/components/pathways/project-picker.test.tsx`

Expected: FAIL — no matching link.

- [ ] **Step 3: Add the link to the selected-project summary**

In the `selected ? (...)` block that renders `{selected.project.name}` and
`{selected.path.name} · {levelLabel(selected.project.level)}`, add the links
directly **after** the closing `</Button>` of the trigger row — not inside it,
since the trigger is a button:

```tsx
{selected ? (
	<EvaluationResourceLinks projectName={selected.project.name} />
) : null}
```

- [ ] **Step 4: Add the link to each project row**

In the level list, inside the `<li key={project.id}>`, after `</button>`:

```tsx
<div className="px-3 pb-2 pl-9">
	<EvaluationResourceLinks projectName={project.name} />
</div>
```

Add the import at the top:

```tsx
import { EvaluationResourceLinks } from "#/components/pathways/evaluation-resource-link";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx vitest run src/components/pathways/`

Expected: PASS, and no previously-passing picker test broken.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run typecheck
bunx biome check --diagnostic-level=error src/components/pathways/
git add src/components/pathways/
git commit -m "feat(pathways): link the evaluation resource from the project picker"
```

---

## Task 4: Give the evaluator the speaker's project

The member who needs the form is usually the **evaluator**, not the speaker.
`loadMyCommitments` currently left-joins `speeches` on the member's own
`roleSlots.speechId`, which is null for an evaluator.

**Files:**
- Modify: `src/server/my-activity-logic.ts` — `loadMyCommitments` (around line 126).
- Modify: `src/server/my-activity.integration.test.ts`
- Create: `src/server/my-commitments-query.integration.test.ts`

**Interfaces:**
- Consumes: `roleSlots.evaluatesSlotId`, `roleSlots.speechId`, `speeches.projectName`, `speeches.projectId`, `pathwaysProjects.name`.
- Produces: `loadMyCommitments` rows gain `evaluatedProjectName: string | null` and `ownProjectName: string | null`.

Why two fields rather than one: a General Evaluator and a speaker can both hold
a slot in the same meeting, and collapsing them would make the card unable to
say whose project it is showing.

Resolution order for `evaluatedProjectName`, per the spec: the catalog project
name via `speeches.projectId` first, then the free-text `speeches.projectName`.
`projectId` is authoritative because free text predates the catalog.

- [ ] **Step 1: Write the failing test**

Add to `src/server/my-activity.integration.test.ts`:

```ts
it("gives an evaluator the project of the speech they evaluate", async () => {
	// Full fixture: speaker slot carrying a speech with a catalog project, plus
	// an evaluator slot pointing at it via evaluates_slot_id.
	const { userId, memberId, meetingId, speakerSlotId } =
		await seedMeetingWithSpeaker({ projectName: "Active Listening" });
	const evaluatorSlotId = await addSlot({
		meetingId,
		roleName: "Evaluator",
		assignedMemberId: memberId,
		evaluatesSlotId: speakerSlotId,
	});

	const rows = await loadMyCommitments(userId);
	const row = rows.find((r) => r.slotId === evaluatorSlotId);
	expect(row?.evaluatedProjectName).toBe("Active Listening");
	// The evaluator has no speech of their own.
	expect(row?.ownProjectName).toBeNull();
});

it("prefers the catalog project name over stale free text", async () => {
	const { userId, memberId, meetingId, speakerSlotId } =
		await seedMeetingWithSpeaker({
			projectName: "typed by hand years ago",
			catalogProjectName: "Persuasive Speaking",
		});
	const evaluatorSlotId = await addSlot({
		meetingId,
		roleName: "Evaluator",
		assignedMemberId: memberId,
		evaluatesSlotId: speakerSlotId,
	});

	const rows = await loadMyCommitments(userId);
	expect(
		rows.find((r) => r.slotId === evaluatorSlotId)?.evaluatedProjectName,
	).toBe("Persuasive Speaking");
});

it("leaves the evaluated project null for a TBA speech", async () => {
	// An evaluator can be assigned before the speaker attaches a speech. The
	// card falls back to the generic resource; the loader must not invent a name.
	const { userId, memberId, meetingId, speakerSlotId } =
		await seedMeetingWithSpeaker({ speech: null });
	const evaluatorSlotId = await addSlot({
		meetingId,
		roleName: "Evaluator",
		assignedMemberId: memberId,
		evaluatesSlotId: speakerSlotId,
	});

	const rows = await loadMyCommitments(userId);
	expect(
		rows.find((r) => r.slotId === evaluatorSlotId)?.evaluatedProjectName,
	).toBeNull();
});

it("still gives a speaker their own project", async () => {
	const { userId, speakerSlotId } = await seedMeetingWithSpeaker({
		projectName: "Ice Breaker",
		assignToUser: true,
	});
	const rows = await loadMyCommitments(userId);
	const row = rows.find((r) => r.slotId === speakerSlotId);
	expect(row?.ownProjectName).toBe("Ice Breaker");
	expect(row?.evaluatedProjectName).toBeNull();
});
```

Use the fixture helpers already in this file. If `seedMeetingWithSpeaker` /
`addSlot` do not exist under those names, read the file's existing helpers and
use them; write new helpers only if none fit, and keep them local to this file.

- [ ] **Step 2: Run the test to verify it fails**

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"
bunx vitest run src/server/my-activity.integration.test.ts
```

Expected: FAIL on `evaluatedProjectName` being undefined. **If the suite reports
SKIPPED, `TEST_DATABASE_URL` is unset — a skipped run reads exactly like a pass.
Fix the env before continuing.**

- [ ] **Step 3: Add the self-join**

In `src/server/my-activity-logic.ts`, inside `loadMyCommitments`. Declare the
aliases above the query:

```ts
const speakerSlot = alias(roleSlots, "speaker_slot");
const evaluatedSpeech = alias(speeches, "evaluated_speech");
const evaluatedProject = alias(pathwaysProjects, "evaluated_project");
const ownProject = alias(pathwaysProjects, "own_project");
```

Add to the `.select({...})`:

```ts
			// The evaluator's target: this slot evaluates `speakerSlot`, whose
			// speech carries the project. `projectId` (catalog) wins over the
			// free-text `projectName`, which predates the catalog.
			evaluatedProjectName: sql<string | null>`
				coalesce(${evaluatedProject.name}, ${evaluatedSpeech.projectName})
			`,
			ownProjectName: sql<string | null>`
				coalesce(${ownProject.name}, ${speeches.projectName})
			`,
```

Add after the existing `.leftJoin(speeches, ...)`:

```ts
			.leftJoin(ownProject, eq(ownProject.id, speeches.projectId))
			.leftJoin(speakerSlot, eq(speakerSlot.id, roleSlots.evaluatesSlotId))
			.leftJoin(evaluatedSpeech, eq(evaluatedSpeech.id, speakerSlot.speechId))
			.leftJoin(
				evaluatedProject,
				eq(evaluatedProject.id, evaluatedSpeech.projectId),
			)
```

Imports — verified against the file during pre-flight:

- `alias` is **already imported** from `drizzle-orm/pg-core` (line 17). Do not
  re-add it.
- `eq` is already in the `drizzle-orm` import (line 16:
  `and, asc, desc, eq, gte, inArray, isNull, ne`). **`sql` is NOT** — add it to
  that existing import, alphabetically, rather than writing a second import
  statement (Biome's import organization will fight a duplicate).
- `pathwaysProjects` must be added to the existing `#/db/schema` import block
  (line 19), which is already a multi-line named import.

**All four joins go on the existing statement.** Do not issue a second query
and do not loop — Task 4 Step 6 asserts exactly that.

- [ ] **Step 4: Run the test to verify it passes**

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"
bunx vitest run src/server/my-activity.integration.test.ts
```

Expected: PASS. If the schema drifted, sync the test DB — this is the one
database `db:push` is for:

```bash
DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test" bun run db:push --force
```

- [ ] **Step 5: Write the query-count guard**

Create `src/server/my-commitments-query.integration.test.ts`:

```ts
/**
 * `loadMyCommitments` must stay ONE statement.
 *
 * The evaluator's project arrives through three extra left joins
 * (evaluates_slot_id → speaker slot → speech → catalog project). The obvious
 * wrong implementation resolves it per row, which is an N+1 over every upcoming
 * commitment a member holds across every club — and the RESULT is byte-identical
 * either way, so no assertion on the payload can fail. The observable is the
 * QUERY, so count at the driver.
 *
 * Counting at `db.$client` rather than spying a named loader is deliberate: a
 * spy on a helper goes green the moment someone inlines it, which is exactly the
 * refactor this test polices (see `src/test/query-spy.ts`).
 */
import { describe, expect, it } from "vitest";
import { loadMyCommitments } from "#/server/my-activity-logic";
import { readsOf, statementsDuring } from "#/test/query-spy";

describe("loadMyCommitments query shape", () => {
	it("reads role_slots once regardless of how many commitments exist", async () => {
		const { userId } = await seedMemberWithCommitments({ count: 5 });

		const statements = await statementsDuring(() => loadMyCommitments(userId));

		// Non-empty first: an empty list makes every count below trivially pass,
		// which is how a broken spy reads as success.
		expect(statements.length).toBeGreaterThan(0);
		expect(readsOf(statements, "role_slots")).toHaveLength(1);
	});
});
```

Reuse whatever seeding helper the neighbouring integration tests use for a
member with several upcoming slots; if none exists, seed five slots inline.

- [ ] **Step 6: Run the guard**

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"
bunx vitest run src/server/my-commitments-query.integration.test.ts
```

Expected: PASS with exactly one `role_slots` read.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
bun run typecheck
bunx biome check --diagnostic-level=error src/server/
git add src/server/my-activity-logic.ts src/server/my-activity.integration.test.ts src/server/my-commitments-query.integration.test.ts
git commit -m "feat(pathways): resolve the evaluated speech's project for an evaluator"
```

---

## Task 5: Show the link on the commitment cards

**Files:**
- Modify: `src/routes/_authed/me.tsx` — the commitment `<li>` (around line 153-170).
- Modify: `src/routes/_authed/dashboard.tsx` — its commitment list.
- Create: `src/routes/commitment-eval-resource.guard.test.ts`

**Interfaces:**
- Consumes: `EvaluationResourceLinks` (Task 2); `evaluatedProjectName` / `ownProjectName` on commitment rows (Task 4).
- Produces: nothing new.

A route cannot be mounted in vitest, so the wiring gets a comment-blind source
guard — the repo's idiom for a layer no render test can reach. CLAUDE.md's props
trap is the reason: a component tested through its props cannot see a WRONG
prop, and `projectName={c.evaluatedProjectName ?? c.ownProjectName}` is exactly
such an expression. Passing the wrong one shows a speaker the form for someone
else's speech, and every component test stays green.

- [ ] **Step 1: Write the failing guard**

Create `src/routes/commitment-eval-resource.guard.test.ts`:

```ts
/**
 * The commitment-card evaluation-resource wiring.
 *
 * Comment-blind (`readSource`): both assertions are of the "this pattern must BE
 * present" form, where a comment merely NAMING the pattern would produce a false
 * PASS.
 *
 * What it pins: the card prefers the EVALUATED project over the member's own.
 * An evaluator's slot has no speech, so `ownProjectName` is null for them and
 * `evaluatedProjectName` is null for a plain speaker — the coalescing order is
 * what makes one expression serve both. Reversing it would silently show a
 * General Evaluator their own last project instead of the speech in front of
 * them, with every component test green.
 */
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES = ["src/routes/_authed/me.tsx", "src/routes/_authed/dashboard.tsx"];

describe("commitment cards link the evaluation resource", () => {
	for (const path of ROUTES) {
		it(`${path} renders EvaluationResourceLinks`, () => {
			expect(readSource(path)).toContain("EvaluationResourceLinks");
		});

		it(`${path} prefers the evaluated project over the member's own`, () => {
			const src = readSource(path).replace(/\s+/g, " ");
			expect(src).toContain(
				"projectName={c.evaluatedProjectName ?? c.ownProjectName}",
			);
		});
	}
});
```

- [ ] **Step 2: Run the guard to verify it fails**

Run: `bunx vitest run src/routes/commitment-eval-resource.guard.test.ts`

Expected: FAIL — neither route mentions `EvaluationResourceLinks`.

- [ ] **Step 3: Wire `me.tsx`**

Add the import:

```tsx
import { EvaluationResourceLinks } from "#/components/pathways/evaluation-resource-link";
```

Inside the commitment `<li>`, directly after the `{c.isSpeakerRole && c.speechTitle ? (...) : null}` block:

```tsx
<EvaluationResourceLinks
	projectName={c.evaluatedProjectName ?? c.ownProjectName}
/>
```

- [ ] **Step 4: Wire `dashboard.tsx`**

Add the same import and the same element to its commitment list item, matching
that file's existing markup and spacing. Read the surrounding JSX first — the
two routes render commitments with different wrappers, so copy the placement
logic, not the class names.

- [ ] **Step 5: Run the guard and the suite**

```bash
bunx vitest run src/routes/commitment-eval-resource.guard.test.ts
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"
bun run test
```

Expected: guard PASSES; full suite green with no new failures.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
bun run typecheck
bunx biome check --diagnostic-level=error src/routes/
git add src/routes/_authed/me.tsx src/routes/_authed/dashboard.tsx src/routes/commitment-eval-resource.guard.test.ts
git commit -m "feat(pathways): show the evaluation resource on commitment cards"
```

---

## Task 6: The searchable index page

**Files:**
- Create: `src/routes/resources.evaluation-resources.tsx`
- Create: `content/resources/evaluation-resources.md`
- Modify: `src/data/resources.ts`
- Test: none of its own — `filterEvaluationResources` is covered by Task 1; this route's gates are `src/data/resources.guard.test.ts` and a manual render check.

**Interfaces:**
- Consumes: `EVALUATION_RESOURCES` (Task 1), `ResourcesShell`, `getAuthContext`.
- Produces: a route at `/resources/evaluation-resources`.

Two constraints that will bite otherwise:

1. **`src/data/resources.guard.test.ts` asserts both directions** of the
   registry↔markdown relation: every registry entry needs
   `content/resources/<slug>.md`, and every markdown file needs a registry
   entry. So the markdown file is mandatory, not optional.
2. **Route-name collision.** `resources.$slug.tsx` already matches
   `/resources/anything`. TanStack's file-based routing gives the static
   segment (`resources.evaluation-resources.tsx`) priority over the dynamic
   one, so the new route wins — but the registry entry ALSO makes
   `/resources/evaluation-resources` resolvable through `$slug`. Verify the
   static route renders, not the article, after `bun run generate-routes`.

- [ ] **Step 1: Confirm the filter is already covered**

`filterEvaluationResources` lives in `src/lib/evaluation-resources.ts` and is
tested in Task 1, deliberately NOT exported from this route — a route module
imports `getAuthContext` → `#/db`, which throws `DATABASE_URL is not set` at
import, so anything exported from a route is unreachable from vitest.

Run: `bunx vitest run src/lib/evaluation-resources.test.ts -t filterEvaluationResources`

Expected: PASS (7 tests). If it does not, Task 1 is incomplete — stop and say so
rather than duplicating the filter here.

This route therefore has no separately testable logic. Its gates are the
registry guard (Step 5) and the manual render check (Step 6).

- [ ] **Step 3: Write the route**

Create `src/routes/resources.evaluation-resources.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { ResourcesShell } from "#/components/resources/resources-shell";
import { Input } from "#/components/ui/input";
import {
	EVALUATION_RESOURCES,
	filterEvaluationResources,
} from "#/lib/evaluation-resources";
import { getAuthContext } from "#/server/auth-context";

const TITLE = "Evaluation resources — GavelUp";
const DESCRIPTION =
	"Every official Toastmasters evaluation resource, searchable by project name or item number.";

export const Route = createFileRoute("/resources/evaluation-resources")({
	// Mirrors resources.index.tsx: a signed-in member with a club gets the app
	// shell, an anonymous visitor the light header.
	beforeLoad: async () => {
		const ctx = await getAuthContext();
		const shell = !!ctx.user && ctx.clubs.length > 0;
		return { shell, authCtx: shell ? ctx : null };
	},
	head: () => ({
		meta: [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
		],
	}),
	component: EvaluationResourcesIndex,
});

function EvaluationResourcesIndex() {
	const { shell, authCtx } = Route.useRouteContext();
	const [query, setQuery] = useState("");
	const results = useMemo(() => filterEvaluationResources(query), [query]);

	return (
		<ResourcesShell shell={shell} authCtx={authCtx}>
			<div className="mb-6 pt-2">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Evaluation resources
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					The official evaluation resource for every Pathways project, hosted by
					Toastmasters International. Search by project, item number, or the
					words you remember.
				</p>
			</div>

			<Input
				type="search"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Search projects, item numbers…"
				aria-label="Search evaluation resources"
				className="mb-4 max-w-md"
			/>

			<p className="mb-3 text-[var(--sea-ink-soft)] text-sm" aria-live="polite">
				{results.length} of {EVALUATION_RESOURCES.length}
			</p>

			{results.length === 0 ? (
				<p className="text-[var(--sea-ink-soft)] text-sm">
					Nothing matches “{query}”. Try a project name or an item number like
					8200E.
				</p>
			) : (
				<ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3.5">
					{results.map((r) => (
						<li
							key={r.key}
							className="rounded-xl border border-[var(--line)] bg-card p-3.5"
						>
							<a
								href={r.url}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-start gap-2 text-sm font-medium"
							>
								<FileText className="mt-0.5 size-4 shrink-0" aria-hidden />
								<span>
									{r.title}
									{r.part ? ` — ${r.part}` : ""}
								</span>
							</a>
							{r.itemCode ? (
								<p className="mt-1 pl-6 text-[var(--sea-ink-soft)] text-xs">
									Item {r.itemCode}
								</p>
							) : null}
						</li>
					))}
				</ul>
			)}
		</ResourcesShell>
	);
}
```

- [ ] **Step 4: Write the article and register the resource**

Create `content/resources/evaluation-resources.md`:

```markdown
An evaluation resource is the form your evaluator fills in for a specific
Pathways project. Each one lists what that project is actually teaching, so the
feedback you get is about the skill you were practising rather than a general
impression of the speech.

Toastmasters International publishes one for every project, plus a generic form
that works for any speech — inside Pathways or outside it.

## Finding the right one

Search by the project name your evaluator will see on the agenda, or by the item
number printed on the form (`8200E`, `8101E`). If your project is not listed,
use the generic evaluation resource.

## A note on editions

Some paths are ones Toastmasters has since retired, and members stay enrolled on
them. Toastmasters publishes only the current edition of each form, so on a
retired path you will see the current version, marked as such. The criteria may
read slightly differently from the project as your path presents it.

## Where these files come from

Every link on this page points at toastmasters.org. The files are Toastmasters
International's, and we link to them rather than hosting copies, so you always
get the current version.
```

Add to the `resources` array in `src/data/resources.ts`:

```ts
	{
		slug: "evaluation-resources",
		cat: "Pathways",
		icon: "doc",
		tone: "lagoon",
		title: "Evaluation resources",
		desc: "The official evaluation form for every Pathways project, searchable.",
	},
```

- [ ] **Step 5: Regenerate routes and run the tests**

```bash
bun run generate-routes
bunx vitest run src/data/resources.guard.test.ts src/lib/evaluation-resources.test.ts
```

Expected: both PASS. The registry guard confirms the markdown/registry pair.

- [ ] **Step 6: Verify the static route wins over `$slug`**

```bash
bun run dev
```

Visit `http://localhost:3000/resources/evaluation-resources`. Expected: the
searchable grid, **not** the markdown article. Type `8200e` and confirm the
count drops to 1. Then stop the server.

If the article renders instead, the dynamic route is winning — check
`src/routeTree.gen.ts` was regenerated and the filename is exactly
`resources.evaluation-resources.tsx`.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
bun run typecheck
bunx biome check --diagnostic-level=error src/routes/ src/data/
git add src/routes/resources.evaluation-resources.tsx content/resources/evaluation-resources.md src/data/resources.ts src/routeTree.gen.ts
git commit -m "feat(resources): searchable index of every official evaluation resource"
```

---

## Task 7: The link-liveness script

Deliberately a script, **not** a vitest test. It needs network, and a network
test that skips when offline reads exactly like a passing one — the failure
shape CLAUDE.md documents for the Chrome-backed print gates ("a silently absent
print gate reads exactly like a passing one"). As a script it is honest: you ran
it, or you did not.

**Files:**
- Create: `scripts/check-evaluation-resource-links.ts`

**Interfaces:**
- Consumes: `EVALUATION_RESOURCES` from `#/lib/evaluation-resources`.
- Produces: a CLI that exits non-zero if any URL is not a live PDF.

- [ ] **Step 1: Write the script**

Create `scripts/check-evaluation-resource-links.ts`:

```ts
/**
 * Verifies every evaluation-resource URL still serves a PDF.
 *
 * NOT a vitest test, on purpose. It needs the network, and a test that SKIPS
 * when offline is indistinguishable from one that passed — the same shape
 * CLAUDE.md records for the Chrome print gates. A script you either ran or did
 * not.
 *
 * Run it when TI reorganizes their resource library, or periodically:
 *   bunx tsx scripts/check-evaluation-resource-links.ts
 *
 * All 64 returned `200 application/pdf` when the table was built (2026-08-20).
 */
import { EVALUATION_RESOURCES } from "#/lib/evaluation-resources";

const CONCURRENCY = 8;
// TI's CDN rejects a default fetch agent on some paths.
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

interface Failure {
	key: string;
	itemCode: string | null;
	url: string;
	reason: string;
}

async function check(url: string): Promise<string | null> {
	try {
		// GET, not HEAD: several of these paths answer HEAD with 405.
		const res = await fetch(url, {
			headers: { "user-agent": UA },
			redirect: "follow",
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) return `HTTP ${res.status}`;
		const type = res.headers.get("content-type") ?? "";
		if (!type.includes("pdf")) return `content-type ${type || "(none)"}`;
		// Drain so the connection is released.
		await res.arrayBuffer();
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

async function main() {
	const queue = [...EVALUATION_RESOURCES];
	const failures: Failure[] = [];
	let done = 0;

	async function worker() {
		for (;;) {
			const r = queue.shift();
			if (!r) return;
			const reason = await check(r.url);
			done += 1;
			process.stdout.write(
				`\r  checked ${done}/${EVALUATION_RESOURCES.length}   `,
			);
			if (reason)
				failures.push({
					key: r.key,
					itemCode: r.itemCode,
					url: r.url,
					reason,
				});
		}
	}

	console.log(`Checking ${EVALUATION_RESOURCES.length} evaluation resources…`);
	await Promise.all(
		Array.from({ length: CONCURRENCY }, () => worker()),
	);
	process.stdout.write("\n");

	if (failures.length === 0) {
		console.log(`All ${EVALUATION_RESOURCES.length} links serve a PDF.`);
		return;
	}

	console.error(`\n${failures.length} link(s) failed:\n`);
	for (const f of failures)
		console.error(`  ${f.itemCode ?? f.key}  ${f.reason}\n    ${f.url}`);
	console.error(
		"\nTI moved or retired these. Re-scrape the category and update" +
			" src/lib/evaluation-resources.ts — do not delete a row to make this pass.",
	);
	process.exitCode = 1;
}

await main();
```

- [ ] **Step 2: Run it**

Run: `bunx tsx scripts/check-evaluation-resource-links.ts`

Expected: `All 64 links serve a PDF.` and exit 0.

If some fail with a network error rather than an HTTP status, you may be
offline — that is the script reporting honestly, not a defect.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-evaluation-resource-links.ts
git commit -m "chore(pathways): script to verify evaluation-resource links still resolve"
```

---

## Final verification

- [ ] **Step 1: Full gates, in the order CI runs them**

```bash
export TEST_DATABASE_URL="postgresql://dev:dev@localhost:5433/tm_test"
bun run typecheck
bun run test
bunx biome check --diagnostic-level=error
```

All three must be clean. A skipped integration suite is not a pass — confirm the
test count is in the thousands, not the hundreds.

- [ ] **Step 2: Revert the route-tree churn if `bun run build` was run**

`bun run build` appends a block to the tracked `src/routeTree.gen.ts`. If you
ran a build, check `git diff src/routeTree.gen.ts` and revert anything that is
not the legitimate new route registration.

- [ ] **Step 3: Confirm no TI file was committed**

```bash
git log --stat --oneline origin/main..HEAD | grep -iE "\.pdf|\.ashx" || echo "clean: no TI files committed"
```

Expected: `clean`. We link, we do not host.

- [ ] **Step 4: Hand off**

The diff spans ~10 files across data, server, two routes and a script, which is
past the 50-line threshold where `/ship` runs its specialists. Per this repo's
feature-pipeline note, run `/review` and ask for the **adversarial** pass before
`/ship` — it is the only whole-diff look, and running it late is what turned one
round into four on #519.
