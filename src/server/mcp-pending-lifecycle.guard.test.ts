/**
 * The pending-plan lifecycle has exactly one definition of each part (#812 AC5).
 *
 * #806 shipped the lifecycle for `record_guest_book`; #808 needed it again for
 * `upsert_agendas` and, as filed, would have built a second copy of the table,
 * the creator-only and archive checks, the expiry, the retention sweep and the
 * locked-apply skeleton. Two copies of a retention-and-authorization lifecycle
 * is how one copy gets a fix and the other does not — and this one holds
 * visitor names, emails and phone numbers.
 *
 * Extraction alone does not keep it extracted. The next tool's author reaches
 * for the shared module, finds it does not quite fit, and writes "just this one
 * check" beside it; nothing fails, and the copy is back. So the rules are
 * enforced on the SOURCE, because they cannot be enforced any other way: a
 * second `SELECT … FOR UPDATE` on this table in a new module is not a behaviour
 * a behavioural test can see — both copies work.
 *
 * ## The shape of every case here
 *
 * Sweep `src/**` for files that NAME the table, subtract the enrolled owners,
 * and assert the remainder is empty. Derived rather than listed, so a module
 * written tomorrow is covered on the day it is written — the opposite direction
 * from a waiver list, which only covers what someone remembered to add.
 *
 * Read per `src/test/guard-source.ts`'s two reader classes: COMMENT-BLIND for
 * "this call must BE present" (a comment naming `requireClubRole` is not a
 * call), RAW for "this construct must be ABSENT" (stripping only deletes text,
 * and could erase a real offender from view).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

const SCHEMA = "db/schema.ts";
const LIFECYCLE = "server/mcp-pending-logic.ts";
const APPLY = "server/mcp-pending-apply.ts";
const ARITHMETIC = "lib/pending-plan.ts";
const TOOL_INSERT = "server/mcp/tools/record-guest-book.ts";
const GUEST_BOOK_LOGIC = "server/guest-book-pending-logic.ts";
const GUEST_BOOK_APPLY = "server/guest-book-apply.ts";

/**
 * Every non-test `.ts`/`.tsx` under `src/`, as a `/`-joined path from `src/`.
 *
 * Tests are excluded on purpose: a suite naming the table is reading it to
 * assert on it, which is the point, and sweeping them in would make every case
 * below a list of test files.
 */
function sources(dir = SRC, prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...sources(join(dir, entry.name), rel));
			continue;
		}
		if (!/\.tsx?$/.test(entry.name)) continue;
		if (entry.name.includes(".test.")) continue;
		out.push(rel);
	}
	return out;
}

const ALL = sources();
/** Verbatim — for "the construct must be ABSENT" assertions. */
const raw = (rel: string) => readFileSync(join(SRC, rel), "utf8");
/** Comment-blind — for "the call must BE present" assertions. */
const stripped = (rel: string) => readSource(join(SRC, rel));

/** Files whose CODE (not prose) names the drizzle table object. */
function filesNaming(pattern: RegExp): string[] {
	return ALL.filter((rel) => pattern.test(stripped(rel)));
}

/**
 * The predicates every sweep below runs, hoisted so the mutation case can drive
 * THESE and not copies of them.
 *
 * Its first draft re-typed each regex as a fresh literal inside the mutation
 * case, which is the PROXY failure CLAUDE.md's coverage bullet describes: the
 * case proved that four strings match four other strings, and editing the real
 * predicate left it green. The real ones happened to stay covered by their own
 * `toEqual([owner])` positive assertions, so nothing was actually unguarded —
 * but a mutation case that cannot see the thing it names is worse than none,
 * because it reads like proof.
 */
const P = {
	/** The drizzle table object. Everything the lifecycle owns routes through it. */
	table: /\bmcpPendingPlans\b/,
	/** The creator comparison, which no guard function performs. */
	creator: /createdByUserId !== userId/,
	/** The retention window's declaration. */
	window: /export const PENDING_PLAN_(TTL|GRACE)_MS\s*=/,
	/** The sweep's DELETE. */
	sweepDelete: /\.delete\(\s*mcpPendingPlans\s*\)/,
	/** The claim that sets `applied_at`. */
	claim: /appliedAt:\s*new Date\(\)/,
	/** A caller of the club lock (its own declaration is excluded separately). */
	lockCall: /\blockClub\s*\(/,
	lockDecl: /export async function lockClub/,
	/** The locked read the `applied_at` check must be atomic with. */
	forUpdate: /\.for\("update"\)/,
} as const;

describe("the pending-plan lifecycle is extracted, and stays extracted (#812)", () => {
	it("sweeps the source tree at all", () => {
		// Vacuity floor, counting the STRUCTURE rather than a lexical proxy: a
		// walker that returned nothing would make every case below pass by having
		// nothing to check, in the direction that ships a second lifecycle.
		expect(ALL.length).toBeGreaterThanOrEqual(200);
		for (const owner of [
			SCHEMA,
			LIFECYCLE,
			APPLY,
			ARITHMETIC,
			TOOL_INSERT,
			GUEST_BOOK_LOGIC,
			GUEST_BOOK_APPLY,
		]) {
			expect(ALL, `${owner} is not in the sweep`).toContain(owner);
		}
	});

	it("only the enrolled modules touch mcp_pending_plans", () => {
		// The table object is the seam: everything the lifecycle owns is reached
		// through it, so a module that names it is a module doing lifecycle work.
		//
		// The guest-book logic module is enrolled for ONE statement — the PATCH,
		// whose `applied_at IS NULL` predicate is what stops an in-flight edit
		// writing contact details back over a tombstone. That predicate is about
		// this tool's own payload, not about the lifecycle, and the case below
		// pins it to that single use.
		const owners = new Set([
			SCHEMA,
			LIFECYCLE,
			APPLY,
			TOOL_INSERT,
			GUEST_BOOK_LOGIC,
		]);
		const offenders = filesNaming(P.table).filter((rel) => !owners.has(rel));
		expect(
			offenders,
			`${offenders.join(", ")} reads or writes mcp_pending_plans directly. The lifecycle owns that table: resolution and the sweep in ${LIFECYCLE}, the locked claim in ${APPLY}. A second reader is a second WHERE that can forget the tool discriminator, and a second writer is a second "has this already been applied".`,
		).toEqual([]);
		// Non-vacuity: the sweep really does find the owners.
		expect(filesNaming(P.table).sort()).toEqual([...owners].sort());
	});

	it("the four ordered resolution checks have one definition", () => {
		// The gates themselves are generic (`requireClubRole` gates every admin
		// surface in the app), so the claim is not "these calls appear once in
		// src/" — it is that no module doing PENDING-PLAN work calls them. The
		// pending-plan modules are exactly the ones swept above.
		const lifecycle = stripped(LIFECYCLE);
		for (const call of ["assertClubNotArchived(", "requireClubRole("]) {
			expect(
				lifecycle.includes(call),
				`${LIFECYCLE} no longer calls ${call} — every confirm page's gate is gone, not just one tool's.`,
			).toBe(true);
		}
		// The creator comparison, which no guard function performs.
		expect(
			P.creator.test(lifecycle),
			`${LIFECYCLE} no longer compares the creator — the page that shows a visitor's unmasked email is open to any admin of the club.`,
		).toBe(true);

		for (const rel of [GUEST_BOOK_LOGIC, GUEST_BOOK_APPLY, TOOL_INSERT]) {
			const src = raw(rel);
			for (const call of [
				"assertClubNotArchived(",
				"requireClubRole(",
				"createdByUserId !==",
			]) {
				expect(
					src.includes(call),
					`${rel} calls ${call}. The lifecycle owns that check (${LIFECYCLE}); a second copy is what #812 removed, and the copy that rots is the one nobody re-reads.`,
				).toBe(false);
			}
		}
	});

	it("the expiry and grace arithmetic has one definition", () => {
		const defines = ALL.filter((rel) => P.window.test(stripped(rel)));
		expect(
			defines,
			"the retention window is declared in more than one place — two numbers that merely agree today are two windows.",
		).toEqual([ARITHMETIC]);
		// And the guest-book module still RE-EXPORTS rather than redeclaring, so
		// its importers needed no edit (AC8). `pending-plan.test.ts` proves the
		// re-export is the same symbol; this proves it is spelled as one.
		expect(
			/export\s*{[\s\S]*?}\s*from\s*"\.\/pending-plan"/.test(
				stripped("lib/guest-book-pending.ts"),
			),
			"lib/guest-book-pending.ts no longer re-exports the arithmetic — every importer of it now has to be edited, which is what AC8 bought.",
		).toBe(true);
	});

	it("the sweep has one definition, and it is the only DELETE", () => {
		const sweeps = ALL.filter((rel) =>
			/export async function sweepExpiredPendingPlans/.test(stripped(rel)),
		);
		expect(sweeps).toEqual([LIFECYCLE]);
		// A second DELETE against the table is a second retention rule. Matched on
		// the drizzle call rather than on the function name, so an inline
		// `db.delete(mcpPendingPlans)` somewhere else is caught too.
		const deleters = ALL.filter((rel) => P.sweepDelete.test(stripped(rel)));
		expect(
			deleters,
			"something other than the lifecycle deletes pending plans. Retention is one rule, measured against the same cutoff the 'expired' page state uses — a second one opens a gap where a row is gone while the page still promises an explanation.",
		).toEqual([LIFECYCLE]);
	});

	it("the locked-apply skeleton has one definition", () => {
		// Three constructs, and each is a separate way to get a second skeleton.
		// CALLERS only — `server/mcp/lock.ts` names `lockClub` because it declares
		// it, and enrolling the declaration as an exception would make this case
		// pass for a file that merely contained the word.
		const lockers = ALL.filter(
			(rel) =>
				P.lockCall.test(stripped(rel)) && !P.lockDecl.test(stripped(rel)),
		);
		expect(
			lockers,
			`${lockers.join(", ")} takes the club lock for a pending-plan apply. One skeleton takes it (${APPLY}); a second would be a second place the applied_at guard could be forgotten.`,
		).toEqual([APPLY]);

		const claimers = ALL.filter((rel) => P.claim.test(stripped(rel)));
		expect(
			claimers,
			"something other than the shared skeleton claims a pending row. `applied_at` has exactly one writer, because a second copy of 'has this already been applied' is how a double-click records a page twice.",
		).toEqual([APPLY]);

		const lockReaders = ALL.filter((rel) => P.forUpdate.test(stripped(rel)));
		expect(
			lockReaders.filter((rel) => filesNaming(P.table).includes(rel)),
			"a pending row is read FOR UPDATE outside the shared skeleton, which is the read the applied_at check has to be atomic with.",
		).toEqual([APPLY]);
	});

	it("the guest book's own reads go through the lifecycle, not around it", () => {
		const logic = stripped(GUEST_BOOK_LOGIC);
		expect(
			logic.includes("resolvePending("),
			`${GUEST_BOOK_LOGIC} no longer calls resolvePending — its reads are no longer going through the four ordered checks.`,
		).toBe(true);
		expect(
			/applyPendingPlanLocked\s*[<(]/.test(stripped(GUEST_BOOK_APPLY)),
			`${GUEST_BOOK_APPLY} no longer calls applyPendingPlanLocked — it has grown its own lock and its own applied_at guard back.`,
		).toBe(true);
		// The ONE statement this module is enrolled for, stated as the set of
		// drizzle verbs it applies to the table rather than as a count of
		// mentions. A count would move on a whitespace change and fail on correct
		// code, which is how a guard gets deleted; the verb set is the rule.
		expect(
			logic.includes(".update(mcpPendingPlans)"),
			`${GUEST_BOOK_LOGIC} no longer PATCHes the row — the applied_at IS NULL predicate that stops an in-flight edit writing PII back over a tombstone is gone.`,
		).toBe(true);
		for (const verb of ["select", "insert", "delete"]) {
			expect(
				new RegExp(`\\.${verb}\\([^)]*mcpPendingPlans`).test(
					raw(GUEST_BOOK_LOGIC),
				),
				`${GUEST_BOOK_LOGIC} ${verb}s the pending table directly. Reads belong to resolvePending, where the tool discriminator lives; inserts belong to the tool; deletes belong to the sweep.`,
			).toBe(false);
		}
		// And nothing else reaches the table from a `from(...)` here either — the
		// verb sweep above cannot see a SELECT whose table is named on a later
		// line.
		expect(
			/\bfrom\(\s*mcpPendingPlans\s*\)/.test(raw(GUEST_BOOK_LOGIC)),
			`${GUEST_BOOK_LOGIC} selects from the pending table again.`,
		).toBe(false);
	});

	// Mutation verification, per the repo's convention. A source guard has no
	// other way to prove it can fail at all, and every false PASS this repo has
	// recorded was an empty or mis-anchored slice that no green run could see.
	// The predicates are exercised against synthetic offenders rather than by
	// breaking a real module.
	it("the predicates flag a second lifecycle", () => {
		// Drives `P` — the SAME objects every sweep above runs — against synthetic
		// offenders, rather than re-typed copies of them. Breaking a real regex
		// now turns this red as well as its own case.
		const secondReader = `
			const [row] = await db.select().from(mcpPendingPlans)
				.where(eq(mcpPendingPlans.id, id));
			if (row.createdByUserId !== userId) return null;
		`;
		const secondClaim = `
			await tx.update(mcpPendingPlans).set({ appliedAt: new Date() });
		`;
		const secondWindow = `export const PENDING_PLAN_TTL_MS = 48 * 60 * 60 * 1000;`;
		const secondSweep = `await db.delete(mcpPendingPlans).where(lt(x, y));`;
		const secondLock = `await lockClub(tx, clubId);`;
		const secondLocked = `const [r] = await tx.select().from(t).for("update");`;
		const compliant = `
			const resolved = await resolvePending(id, userId, "record_guest_book");
			return applyPendingPlanLocked({ tool: "record_guest_book" });
		`;

		expect(P.table.test(secondReader)).toBe(true);
		expect(P.creator.test(secondReader)).toBe(true);
		expect(P.claim.test(secondClaim)).toBe(true);
		expect(P.window.test(secondWindow)).toBe(true);
		expect(P.sweepDelete.test(secondSweep)).toBe(true);
		expect(P.lockCall.test(secondLock)).toBe(true);
		expect(P.lockDecl.test(secondLock)).toBe(false);
		expect(P.forUpdate.test(secondLocked)).toBe(true);

		// And the compliant shape trips none of them — a predicate that flagged
		// everything would fail on correct code, and a guard that always fails
		// gets deleted.
		expect(P.table.test(compliant)).toBe(false);
		expect(P.claim.test(compliant)).toBe(false);
		expect(P.sweepDelete.test(compliant)).toBe(false);
		expect(P.creator.test(compliant)).toBe(false);
	});

	it("the poller really calls the sweep, and logs the breakdown", () => {
		// `sweepTick` is private to a module that starts timers on import, so no
		// test can execute it — the pure `describePendingSweep` is well covered
		// and the WIRING to it was covered by nothing. This is the one place that
		// can see it at all.
		const poller = stripped("server/reminder-poller.ts");
		for (const call of ["sweepExpiredPendingPlans(", "describePendingSweep("]) {
			expect(
				poller.includes(call),
				`reminder-poller.ts no longer calls ${call} — the only thing in the system that deletes a pending plan, or the only thing that says which retention ran.`,
			).toBe(true);
		}
	});

	it("reads real files, not empty strings", () => {
		// The #565 trap, restated for this file: every case above asks whether a
		// source contains something, and an empty read answers "no" to every
		// absence question and "no" to every presence question — half of which
		// look like a pass.
		for (const rel of [LIFECYCLE, APPLY, ARITHMETIC, GUEST_BOOK_LOGIC]) {
			expect(stripped(rel).length, `${rel} read as empty`).toBeGreaterThan(500);
		}
		expect(relative(SRC, join(SRC, LIFECYCLE))).toBe(LIFECYCLE);
	});
});
