/**
 * A THIRD copy of the membership pick must not arrive unordered (#804).
 *
 * `people.user_id` carries only a plain non-unique index (`people_user_idx`),
 * so one human reachable through two Person rows in one club is representable
 * and a single-row pick off that column is arbitrary unless it is ordered.
 * #471 fixed `getMembership`; #804 found the same defect in
 * `resolveAdminGrant`, written after it, and fixed it by COPYING the order —
 * deliberately, because routing the hot path through the guard resolver would
 * change its cost and its returned shape. #822 then found two more and copied
 * it again, for its own reason (`guards.ts` imports Better-Auth, which the
 * Pathways modules cannot pull in). Four sites carrying one order is a
 * decision; a FIFTH arriving silently is how #804 happened in the first place,
 * and the gap was four months.
 *
 * So this sweeps for the SHAPE rather than for a name: any statement that
 * resolves `people.user_id` to a `members` row and keeps ONE of them must
 * carry an `ORDER BY`. That is the property — not which keys, which is the
 * business rule the two integration suites assert against real rows.
 *
 * Deliberately narrow, to stay honest rather than large. It says nothing about
 * queries that fan out over every linked Person (`userPersonIds`,
 * `setReminderOptOutForUser` — where the fan-out is the feature, #437), and
 * nothing about whether an ordering is the RIGHT one. A guard that flagged
 * those would need a waiver list longer than the rule.
 */
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROOT = resolve(__dirname, "../..");
const SERVER = resolve(ROOT, "src/server");

/**
 * Known-unordered picks, each pointing at the issue that owns it. An entry here
 * is a debt that is FILED, which is the honest form — deleting the case to get
 * green, or leaving the sweep unwritten because it would go red, are the two
 * ways this guard stops being worth having.
 *
 * Keyed `<file>:<fn>`, not by bare function name. A bare name is not an
 * identity: it collides across files, and — the failure a reviewer injected —
 * it lets a waiver LEAK to whatever the attribution walk happens to credit to
 * the same name. Each key also covers exactly ONE statement (see `a waiver
 * covers ONE pick`), so a second pick landing under a waived name fails even if
 * the attribution below is wrong about which function it sits in.
 *
 * EMPTY as of #822, which ordered the two this list was created holding —
 * `viewerMaySeeProgress` and `selfMemberIdInClub`. The mechanism stays: `a
 * filed waiver names an issue` is what forces an entry OUT when its pick
 * becomes ordered, and it is the reason this went empty in the same change
 * rather than aging into decoration.
 */
const FILED: Record<string, string> = {};

/** Every `*.ts` under `src/server`, recursively, excluding tests. */
function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(full));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out.sort();
}

interface Pick {
	/** `<file>:<fn>` — what a waiver is keyed by. */
	key: string;
	where: string;
	ordered: boolean;
}

/**
 * Every NAMED declaration in a file, with its offset.
 *
 * BOTH forms, because covering only `function` is the leak: a reviewer injected
 * an unordered pick written as `export const leakyNewPick = async (…) => {…}`
 * directly after the waived `viewerMaySeeProgress`, and a
 * `lastIndexOf("function ")` walk credited it to the waived function, inherited
 * its #822 waiver, and reported an empty offender list — on exactly the event
 * this guard exists to catch. `attributes an arrow-fn pick to itself` below is
 * that case, and it failed before this function existed.
 *
 * Deliberately NOT matching class/object methods: `src/server` has none holding
 * a query, and the patterns that would match one (`\n\tname(args) {`) also match
 * `if (…) {`, which would mis-anchor a pick onto a keyword and report a false
 * offender. The cost of that gap is bounded by the one-pick-per-waiver rule,
 * which does not depend on attribution being right at all.
 */
function declarations(src: string): { at: number; name: string }[] {
	const out: { at: number; name: string }[] = [];
	const patterns = [
		/(?:^|\n)[\t ]*(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
		/(?:^|\n)[\t ]*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=\n]*)?=\s*(?:async\s*)?(?:function\b|\(|<)/g,
	];
	for (const re of patterns) {
		for (const m of src.matchAll(re)) {
			out.push({ at: m.index ?? 0, name: m[1] as string });
		}
	}
	return out.sort((a, b) => a.at - b.at);
}

/**
 * Statements that resolve `people.user_id` and keep a SINGLE membership row.
 *
 * Sliced from the line the chain's `await` sits on to the `;` that ends it — a
 * drizzle builder chain carries no statement terminator of its own. "Single
 * row" is `.limit(1)` OR an array destructure (`const [m] = await …`), because
 * `selfMemberIdInClub` has neither a limit nor an ordering and takes the first
 * row of an unordered result, which is the same arbitrary pick.
 *
 * Attribution FAILS CLOSED: a statement with no preceding declaration reports
 * `?`, which is in no waiver.
 */
function unorderedPicks(src: string, rel: string): Pick[] {
	const decls = declarations(src);
	const found: Pick[] = [];
	for (let i = src.indexOf("eq(people.userId"); i !== -1; ) {
		const awaitAt = src.lastIndexOf("await ", i);
		const lineStart = src.lastIndexOf("\n", awaitAt) + 1;
		const end = src.indexOf(";", i);
		const stmt = src.slice(lineStart, end);
		const single =
			/^\s*(?:const|let)\s*\[/.test(stmt) || stmt.includes(".limit(1)");
		// A membership pick, not a person-level read: it selects out of `members`.
		const membership = stmt.includes("from(members)");
		if (single && membership) {
			const enclosing = decls.filter((d) => d.at < lineStart).pop();
			const fn = enclosing?.name ?? "?";
			const line = src.slice(0, lineStart).split("\n").length;
			found.push({
				key: `${rel}:${fn}`,
				where: `${rel}:${line} (${fn})`,
				ordered: stmt.includes(".orderBy("),
			});
		}
		i = src.indexOf("eq(people.userId", i + 1);
	}
	return found;
}

describe("single-row membership picks are ordered (#804)", () => {
	const picks = sourceFiles(SERVER).flatMap((abs) =>
		// `readSource` is comment-BLIND, and `guard-source.ts` says an offender-list
		// guard like this one must normally read RAW, because stripping can only
		// make a real offender invisible. The exception is load-bearing here and
		// runs the other way: the slice ends at the first `;` after the match, and
		// `resolveAdminGrant`'s own ordering comment contains semicolons BETWEEN
		// `.where(` and `.orderBy(`. MEASURED, not assumed — swapping this for
		// `readFileSync` reports `meeting-authz-logic.ts:106 (resolveAdminGrant)`
		// as an offender, which is a false FAILURE on correct code, the direction
		// stripping is safe in. Stripping cannot hide a missing `.orderBy(`:
		// blanking only deletes text, and `.orderBy(` is what must be PRESENT.
		unorderedPicks(readSource(abs), relative(ROOT, abs)),
	);

	it("the sweep finds the picks it is about", () => {
		// Vacuity floor. Every assertion below is a no-op over an empty list, and
		// this detector is string surgery over a builder chain — a formatting
		// change or a rename could empty it silently, in the direction that lets
		// an unordered pick through. Named, not counted: a bare count erodes.
		const keys = picks.map((p) => p.key);
		expect(keys).toContain(
			"src/server/meeting-authz-logic.ts:resolveAdminGrant",
		);
		expect(keys).toContain("src/server/guards.ts:getMembership");
		expect(keys).toContain(
			"src/server/project-picker-logic.ts:viewerMaySeeProgress",
		);
		expect(keys).toContain(
			"src/server/progress-marks-logic.ts:selfMemberIdInClub",
		);
	});

	it("no UNFILED pick resolves people.user_id without an ORDER BY", () => {
		const offenders = picks
			.filter((p) => !p.ordered && !FILED[p.key])
			.map((p) => p.where);
		expect(
			offenders,
			`These keep ONE membership row out of a people.user_id lookup with no ORDER BY, so which row they get is arbitrary — the defect #471 fixed in getMembership and #804 fixed in resolveAdminGrant. Copy the five-key order from guards.ts (active, admin, open officer terms, oldest, id), or add "<file>:<fn>" to FILED with the issue that owns it.`,
		).toEqual([]);
	});

	it("a waiver covers ONE pick, so a new one cannot inherit it", () => {
		// The leak, closed independently of attribution. Even if the walk above
		// credited a newly-added statement to a waived function, the waiver stops
		// covering it the moment it covers two — which is the observable the
		// injected `leakyNewPick` produced and the empty offender list hid.
		for (const key of Object.keys(FILED)) {
			const under = picks.filter((p) => p.key === key);
			expect(
				under.map((p) => p.where),
				`${key} is waived for ONE statement (${FILED[key]}), and the sweep found ${under.length}. A second pick in the same function is new work, not covered debt — order it, or give it its own issue.`,
			).toHaveLength(1);
		}
	});

	it("a filed waiver names an issue, and is not a way to hide a fix", () => {
		// Two directions. A waiver whose fn no longer exists is stale and must go;
		// a waiver on a pick that is now ORDERED is a fix that landed without the
		// debt being closed, which is how a waiver list turns into decoration.
		for (const [key, issue] of Object.entries(FILED)) {
			expect(issue).toMatch(/^#\d+$/);
			const pick = picks.find((p) => p.key === key);
			expect(
				pick,
				`FILED names ${key}, which the sweep no longer finds`,
			).toBeDefined();
			expect(
				pick?.ordered,
				`${key} is ordered now — drop it from FILED and close ${issue}`,
			).toBe(false);
		}
	});

	// A guard's own bug is invisible to a green sweep, and this one HAD one that a
	// green sweep hid. Same reason `mcp-authz.guard.test.ts` self-tests its import
	// parser rather than trusting a clean tree to exercise it.
	it("attributes an arrow-fn pick to itself, not the waived fn above it", () => {
		const synthetic = [
			"export async function viewerMaySeeProgress(input: X) {",
			"\tconst [membership] = await db",
			"\t\t.select({ clubRole: members.clubRole })",
			"\t\t.from(members)",
			"\t\t.where(and(eq(people.userId, input.userId)))",
			"\t\t.limit(1);",
			"\treturn membership?.clubRole === 'admin';",
			"}",
			"",
			"export const leakyNewPick = async (userId: string) => {",
			"\tconst [m] = await db",
			"\t\t.select({ id: members.id })",
			"\t\t.from(members)",
			"\t\t.where(and(eq(people.userId, userId)))",
			"\t\t.limit(1);",
			"\treturn m?.id ?? null;",
			"};",
		].join("\n");

		const got = unorderedPicks(synthetic, "src/server/synthetic.ts");
		// Both found, and the second is credited to its OWN declaration.
		expect(got.map((p) => p.key)).toEqual([
			"src/server/synthetic.ts:viewerMaySeeProgress",
			"src/server/synthetic.ts:leakyNewPick",
		]);
		// So a waiver on the first does not cover the second: it is reported.
		const waived = { "src/server/synthetic.ts:viewerMaySeeProgress": "#822" };
		expect(
			got.filter((p) => !p.ordered && !(p.key in waived)).map((p) => p.where),
		).toEqual(["src/server/synthetic.ts:11 (leakyNewPick)"]);
	});
});
