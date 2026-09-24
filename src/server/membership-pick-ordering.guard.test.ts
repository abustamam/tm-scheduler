/**
 * A FIFTH membership pick must not arrive unordered (#804), and every pick
 * orders by the ONE shared definition (#838).
 *
 * `people.user_id` carries only a plain non-unique index (`people_user_idx`),
 * so one human reachable through two Person rows in one club is representable
 * and a single-row pick off that column is arbitrary unless it is ordered.
 * #471 fixed `getMembership`; #804 found the same defect in
 * `resolveAdminGrant`, written after it, and fixed it by COPYING the order —
 * deliberately, because routing the hot path through the guard resolver would
 * change its cost and its returned shape. #822 then found two more and copied
 * it again, for its own reason (`guards.ts` imports Better-Auth, which the
 * Pathways modules cannot pull in). #838 replaced the four copies with one
 * import, `membershipPickOrder()` (`membership-pick-order.ts`), so the order can
 * no longer drift between authorization and attribution. A FIFTH pick arriving
 * silently is how #804 happened in the first place, and the gap was four months.
 *
 * So this sweeps for the SHAPE rather than for a name: any statement that
 * resolves `people.user_id` to a `members` row and keeps ONE of them must
 * carry an `ORDER BY`, and that `ORDER BY` must be the shared one. Which keys
 * the shared one holds is the business rule the two integration suites assert
 * against real rows, and `membership-pick-order.test.ts` pins in SQL.
 *
 * The two rules are separate on purpose. "Ordered" still keys on `.orderBy(`
 * being present at all, so dropping a site's order is reported as an UNORDERED
 * pick (the #804 defect) rather than folded into "not the shared order" — the
 * second rule is what refuses a hand-written copy, which is how drift would
 * come back.
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
 * `viewerMaySeeProgress` and `selfMemberIdInClub`.
 *
 * An empty list is why the two rules over it are FUNCTIONS —
 * `miscoveredWaivers` and `staleWaivers` below — rather than loops written
 * inside their own tests. A loop over an empty map executes zero `expect()`
 * calls, so a rule spelled that way passes whatever it says, and the next entry
 * filed is the first time anyone finds out whether it still works. Both tests
 * run their rule over THIS list and over a synthetic sweep that carries real
 * entries, so the code that would judge a future waiver is the code exercised
 * today.
 */
const FILED: Record<string, string> = {};

/**
 * Ordered picks that deliberately do NOT use the shared membership order, each
 * with its reason. Not debt, unlike `FILED`: these pick a membership only as a
 * route to a Person-level value, and order by the PERSON so they agree with
 * `resolveUserPersonId` rather than with the authorization pick.
 *
 * Kept honest the same way as `FILED`: an entry the sweep no longer finds, one
 * that now uses the shared order, or one on an unordered pick is reported
 * (`staleOwnOrders`).
 */
const OWN_ORDER: Record<string, string> = {
	"src/server/auth-context-person-logic.ts:loadPersonDisplayName":
		"a display NAME, not a membership: tie-broken on people.createdAt/id to match resolveUserPersonId (#707)",
};

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
	/** Orders by the shared `membershipPickOrder()` (#838), not a local copy. */
	shared: boolean;
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
 * row" is `.limit(1)` OR an array destructure (`const [m] = await …`), and the
 * destructure arm is not redundant: a chain can keep one row without ever
 * saying `.limit(1)`. `selfMemberIdInClub` did exactly that until #822 ordered
 * it — no limit, no ordering, just the first row of an unordered result, which
 * is the same arbitrary pick by a quieter spelling. It carries both now, so a
 * limit-only detector would find it today; it would have MISSED it on the
 * revision this guard exists to have caught, which is why the arm stays.
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
				shared: /\.orderBy\(\s*\.\.\.membershipPickOrder\(\)\s*\)/.test(stmt),
			});
		}
		i = src.indexOf("eq(people.userId", i + 1);
	}
	return found;
}

/**
 * Waivers that do not cover exactly ONE statement.
 *
 * The leak, closed independently of attribution: even if the walk above
 * credited a newly-added statement to a waived function, the waiver stops
 * covering it the moment it covers two — which is the observable the injected
 * `leakyNewPick` produced and the empty offender list hid. Zero is reported for
 * the same reason it is in `staleWaivers`: a waiver the sweep cannot place is
 * covering nothing.
 */
function miscoveredWaivers(
	picks: Pick[],
	filed: Record<string, string>,
): string[] {
	const out: string[] = [];
	for (const [key, issue] of Object.entries(filed)) {
		const under = picks.filter((p) => p.key === key);
		if (under.length !== 1) {
			out.push(
				`${key} is waived for ONE statement (${issue}), and the sweep found ${under.length}`,
			);
		}
	}
	return out;
}

/**
 * Waivers that no longer describe filed debt. Three directions:
 *
 *  · an issue reference that is not `#<digits>` — a waiver nobody can trace is
 *    a comment, not a filing;
 *  · a key the sweep no longer finds, which is stale and must go;
 *  · a pick that is now ORDERED, which is a fix that landed without the debt
 *    being closed — how a waiver list turns into decoration.
 */
function staleWaivers(picks: Pick[], filed: Record<string, string>): string[] {
	const out: string[] = [];
	for (const [key, issue] of Object.entries(filed)) {
		if (!/^#\d+$/.test(issue)) {
			out.push(`${key} names ${issue}, which is not an issue number`);
		}
		const pick = picks.find((p) => p.key === key);
		if (!pick) {
			out.push(`FILED names ${key}, which the sweep no longer finds`);
		} else if (pick.ordered) {
			out.push(`${key} is ordered now — drop it from FILED and close ${issue}`);
		}
	}
	return out;
}

/** `OWN_ORDER` entries that no longer describe a deliberate, different order. */
function staleOwnOrders(
	picks: Pick[],
	ownOrder: Record<string, string>,
): string[] {
	const out: string[] = [];
	for (const key of Object.keys(ownOrder)) {
		const pick = picks.find((p) => p.key === key);
		if (!pick) {
			out.push(`OWN_ORDER names ${key}, which the sweep no longer finds`);
		} else if (pick.shared) {
			out.push(`${key} uses the shared order now — drop it from OWN_ORDER`);
		} else if (!pick.ordered) {
			out.push(
				`${key} is not ordered at all — OWN_ORDER is for a deliberate different order`,
			);
		}
	}
	return out;
}

/**
 * One `unorderedPicks`-visible statement, for the synthetic sweeps the tests
 * below run their rules over. Shaped like the real picks: destructured,
 * selecting out of `members`, resolving `people.user_id`.
 *
 * `limit: false` is not decoration — it is the only thing here that reaches the
 * detector's destructure arm. All four real pick sites carry `.limit(1)` today,
 * so a helper that always emits one leaves that arm unexercised and a
 * limit-only detector green on the whole tree. See `finds a destructure that
 * never says .limit(1)`.
 */
function pickStatement(opts: {
	binding: string;
	/** `true` for a local order, `"shared"` for the #838 spread. */
	ordered?: boolean | "shared";
	/** `false` for the pre-#822 shape: one row kept with no `.limit(1)` at all. */
	limit?: boolean;
}): string {
	const chain = [
		"\t\t.select({ id: members.id })",
		"\t\t.from(members)",
		"\t\t.where(and(eq(people.userId, userId)))",
	];
	if (opts.ordered === "shared") {
		chain.push("\t\t.orderBy(...membershipPickOrder())");
	} else if (opts.ordered) {
		chain.push("\t\t.orderBy(members.createdAt, members.id)");
	}
	if (opts.limit ?? true) chain.push("\t\t.limit(1)");
	// The `;` goes on whatever the last link is: a drizzle chain carries no
	// terminator of its own, and the detector slices to the first one.
	return `${[`\tconst [${opts.binding}] = await db`, ...chain].join("\n")};`;
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
			`These keep ONE membership row out of a people.user_id lookup with no ORDER BY, so which row they get is arbitrary — the defect #471 fixed in getMembership and #804 fixed in resolveAdminGrant. Order by membershipPickOrder() from membership-pick-order.ts (active, admin, open officer terms, oldest, id), or add "<file>:<fn>" to FILED with the issue that owns it.`,
		).toEqual([]);
	});

	it("every ordered pick uses the SHARED order, not a copy of it (#838)", () => {
		// No waiver list: a pick that is ordered but not by the shared definition
		// is the drift #838 removed, and there is no reason to file one.
		const copies = picks
			.filter((p) => p.ordered && !p.shared && !OWN_ORDER[p.key])
			.map((p) => p.where);
		expect(
			copies,
			"These order a people.user_id membership pick by something other than `.orderBy(...membershipPickOrder())`. Four copies of one order were how authorization and attribution could drift apart; import it from membership-pick-order.ts.",
		).toEqual([]);
		expect(
			staleOwnOrders(picks, OWN_ORDER),
			"An OWN_ORDER entry must still be found, and still order by something other than the shared definition.",
		).toEqual([]);
		// Non-vacuous on the real tree: the four named sites are found AND shared.
		expect(picks.filter((p) => p.shared).map((p) => p.key)).toEqual(
			expect.arrayContaining([
				"src/server/guards.ts:getMembership",
				"src/server/meeting-authz-logic.ts:resolveAdminGrant",
				"src/server/project-picker-logic.ts:viewerMaySeeProgress",
				"src/server/progress-marks-logic.ts:selfMemberIdInClub",
			]),
		);

		// The rule itself, on a synthetic sweep carrying all three shapes: a local
		// copy (reported), the shared spread (clean), and no order at all — which
		// is NOT this rule's to report, because the unordered rule above owns it.
		const src = [
			"export async function localCopy(userId: string) {",
			pickStatement({ binding: "m", ordered: true }),
			"\treturn m?.id ?? null;",
			"}",
			"",
			"export async function sharedOrder(userId: string) {",
			pickStatement({ binding: "n", ordered: "shared" }),
			"\treturn n?.id ?? null;",
			"}",
			"",
			"export async function noOrder(userId: string) {",
			pickStatement({ binding: "o" }),
			"\treturn o?.id ?? null;",
			"}",
		].join("\n");
		const got = unorderedPicks(src, "src/server/synthetic.ts");
		expect(got.map((p) => [p.key, p.ordered, p.shared])).toEqual([
			["src/server/synthetic.ts:localCopy", true, false],
			["src/server/synthetic.ts:sharedOrder", true, true],
			["src/server/synthetic.ts:noOrder", false, false],
		]);
		// ...and the OWN_ORDER staleness rule over the same sweep: a live entry is
		// clean; one now on the shared order, one the sweep cannot find, and one
		// on an UNORDERED pick are each reported.
		expect(
			staleOwnOrders(got, { "src/server/synthetic.ts:localCopy": "why" }),
		).toEqual([]);
		expect(
			staleOwnOrders(got, {
				"src/server/synthetic.ts:sharedOrder": "why",
				"src/server/synthetic.ts:gone": "why",
				"src/server/synthetic.ts:noOrder": "why",
			}),
		).toEqual([
			"src/server/synthetic.ts:sharedOrder uses the shared order now — drop it from OWN_ORDER",
			"OWN_ORDER names src/server/synthetic.ts:gone, which the sweep no longer finds",
			"src/server/synthetic.ts:noOrder is not ordered at all — OWN_ORDER is for a deliberate different order",
		]);
	});

	it("a waiver covers ONE pick, so a new one cannot inherit it", () => {
		expect(
			miscoveredWaivers(picks, FILED),
			"A second pick under a waived name is new work, not covered debt — order it, or give it its own issue.",
		).toEqual([]);

		// FILED is empty, so the line above says nothing about the RULE — it is
		// the real list passing vacuously, which is what it should do. The rule
		// itself is exercised here, on the leak spelled as a fixture: two picks
		// inside ONE waived function, found whatever the attribution walk thinks.
		const twoUnderOne = [
			"export async function waivedPick(userId: string) {",
			pickStatement({ binding: "m" }),
			pickStatement({ binding: "n" }),
			"\treturn m?.id ?? n?.id ?? null;",
			"}",
		].join("\n");
		const both = unorderedPicks(twoUnderOne, "src/server/synthetic.ts");
		expect(both.map((p) => p.key)).toEqual([
			"src/server/synthetic.ts:waivedPick",
			"src/server/synthetic.ts:waivedPick",
		]);
		expect(
			miscoveredWaivers(both, { "src/server/synthetic.ts:waivedPick": "#822" }),
		).toEqual([
			"src/server/synthetic.ts:waivedPick is waived for ONE statement (#822), and the sweep found 2",
		]);

		// ZERO, the other side of `!== 1` and the half the docblock claims. A
		// waiver whose key the sweep cannot place is covering nothing, so it is
		// reported too. Without this the rule could be written `> 1` — the natural
		// way to spell "no inheriting" — and every other assertion here passes.
		expect(
			miscoveredWaivers(both, { "src/server/synthetic.ts:noSuchPick": "#804" }),
		).toEqual([
			"src/server/synthetic.ts:noSuchPick is waived for ONE statement (#804), and the sweep found 0",
		]);

		// The control, without which the rule could be "report every waiver" and
		// the cases above would not notice: ONE pick under the same key is clean.
		const oneUnderOne = [
			"export async function waivedPick(userId: string) {",
			pickStatement({ binding: "m" }),
			"\treturn m?.id ?? null;",
			"}",
		].join("\n");
		expect(
			miscoveredWaivers(
				unorderedPicks(oneUnderOne, "src/server/synthetic.ts"),
				{
					"src/server/synthetic.ts:waivedPick": "#822",
				},
			),
		).toEqual([]);
	});

	it("a filed waiver names an issue, and is not a way to hide a fix", () => {
		expect(
			staleWaivers(picks, FILED),
			"A FILED entry names a traceable issue, is still found by the sweep, and is still unordered.",
		).toEqual([]);

		// Empty list again, so the rule runs over a synthetic sweep carrying both
		// shapes: a pick still unordered, and one that has since been fixed.
		const src = [
			"export async function stillUnordered(userId: string) {",
			pickStatement({ binding: "m" }),
			"\treturn m?.id ?? null;",
			"}",
			"",
			"export async function nowOrdered(userId: string) {",
			pickStatement({ binding: "n", ordered: true }),
			"\treturn n?.id ?? null;",
			"}",
		].join("\n");
		const got = unorderedPicks(src, "src/server/synthetic.ts");
		expect(got.map((p) => [p.key, p.ordered])).toEqual([
			["src/server/synthetic.ts:stillUnordered", false],
			["src/server/synthetic.ts:nowOrdered", true],
		]);

		// The shape a live waiver has: traceable, found, still unordered.
		expect(
			staleWaivers(got, { "src/server/synthetic.ts:stillUnordered": "#822" }),
		).toEqual([]);
		// A fix that landed without the debt closing — the direction that turns a
		// waiver list into decoration.
		expect(
			staleWaivers(got, { "src/server/synthetic.ts:nowOrdered": "#822" }),
		).toEqual([
			"src/server/synthetic.ts:nowOrdered is ordered now — drop it from FILED and close #822",
		]);
		// A waiver whose function the sweep no longer finds.
		expect(
			staleWaivers(got, { "src/server/synthetic.ts:deletedPick": "#804" }),
		).toEqual([
			"FILED names src/server/synthetic.ts:deletedPick, which the sweep no longer finds",
		]);
		// ...and one that traces to nothing, which is a comment, not a filing.
		expect(
			staleWaivers(got, {
				"src/server/synthetic.ts:stillUnordered": "see the ticket",
			}),
		).toEqual([
			"src/server/synthetic.ts:stillUnordered names see the ticket, which is not an issue number",
		]);
	});

	// The detector's SECOND arm, which no real source file can exercise any more:
	// all four pick sites carry `.limit(1)` today, so deleting the destructure
	// clause from `unorderedPicks` leaves every other case in this file green. The
	// shape below is `selfMemberIdInClub` as #822 found it — one row kept off an
	// unordered result with no limit anywhere — which is the revision this guard
	// exists to have caught, and the claim its docblock makes.
	it("finds a destructure that never says .limit(1) (the pre-#822 shape)", () => {
		const unlimited = [
			"export async function selfMemberIdInClub(userId: string) {",
			pickStatement({ binding: "m", limit: false }),
			"\treturn m?.id ?? null;",
			"}",
		].join("\n");
		// The fixture has to BE limit-free or it exercises the other arm and this
		// case quietly stops being about anything. MEASURED: make `pickStatement`
		// ignore `limit: false` and every assertion below stays green without this
		// line — the same vacuity this test exists to close, one level down.
		expect(unlimited).not.toContain(".limit(");

		const got = unorderedPicks(unlimited, "src/server/synthetic.ts");
		expect(got.map((p) => p.where)).toEqual([
			"src/server/synthetic.ts:2 (selfMemberIdInClub)",
		]);
		expect(got[0]?.ordered).toBe(false);

		// ...and the same unlimited shape WITH an ordering is not an offender, so
		// the arm reports a missing ORDER BY rather than reporting every
		// destructure it meets.
		const fixed = [
			"export async function selfMemberIdInClub(userId: string) {",
			pickStatement({ binding: "m", limit: false, ordered: true }),
			"\treturn m?.id ?? null;",
			"}",
		].join("\n");
		expect(fixed).not.toContain(".limit(");
		expect(
			unorderedPicks(fixed, "src/server/synthetic.ts").map((p) => p.ordered),
		).toEqual([true]);
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
