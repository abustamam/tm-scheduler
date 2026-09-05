// No `createServerFn` may write the `members` table without a club-role gate (#616).
//
// ## Why this guard is the durable half of that fix
//
// `addMember` was PUBLIC for a long time and nobody noticed, because nothing
// asserted otherwise. #326 looked at it and added a rate limit — capping how
// FAST an anonymous caller could write the club's membership record rather than
// asking whether it should be able to at all. The gap survived a security-shaped
// review because the review's question was throughput.
//
// It cost a live incident: a guest tracked in the VP-Membership pipeline at
// `following_up` turned up in a real club's roster, because the vote page put
// "I'm new — add me" above its own "Visiting us today?" card and he took the
// first door. Two records for one human, nothing linking them, and an officer
// with no way to tell where the roster row came from.
//
// Re-gating the one function fixes today. This asserts the CLASS, so the next
// writer of `members` cannot be anonymous by omission. `addMember` itself is now
// gone (#630 — admin-gating it left a fn with zero call sites), and this guard
// outliving it is exactly the point: it was never about that one export.
//
// ## Why a source guard rather than a test that calls the function
//
// A `createServerFn` cannot be invoked from vitest — no session, no RPC layer —
// so "calling it without a session throws" is not a test that can be written at
// this layer. The handler body is unreachable, which is the same reason
// CLAUDE.md gives for lifting queries into `*-logic.ts` seams. What IS reachable
// is the source text, so that is what this checks.
//
// Reads RAW, not comment-blind: this asserts an OFFENDER LIST IS EMPTY. A
// comment mentioning `insert(members)` can only ever ADD a false offender, and
// blanking comments would LOOSEN the guard. Same rule as
// `no-tel-links.guard.test.ts`, stated at the read.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../..");
const SERVER_DIR = resolve(ROOT, "src/server");

/**
 * Server-fn modules that write `members` and are allowed to do so ungated, with
 * a reason. Empty, and it should stay that way: an anonymous write to a club's
 * membership record is what #616 exists to prevent.
 */
const REVIEWED_UNGATED_MEMBER_WRITERS: Record<string, string> = {};

/** A gate that establishes the caller may act on this club. */
const GATE = /require(User|ClubRole|Membership|ClubAdminView|Superadmin)\b/;

/**
 * Split a module into its `createServerFn` handler bodies, keyed by export name.
 *
 * The body is the balanced-paren contents of this fn's own `.handler(...)`, and
 * that precision is load-bearing rather than tidiness. The first version sliced
 * from one declaration to the NEXT one, which swept up whatever sat between them
 * — including the doc comment belonging to the following function. On this very
 * tree that made `listMembers` a false offender, because the `addMember` that
 * used to sit two lines below it named `applySelfAdd` in its comment. Caught on
 * a clean run, which is the safe direction for a raw-reading offender list, but
 * a guard that always fails is a guard nobody keeps. That exact pair is gone
 * (#630) and the hazard is not — `members.ts` still carries prose between its
 * declarations, and the sweep reads RAW — so the fixture below pins the splitter
 * rather than resting on today's tree happening not to trip it.
 *
 * Scanning only the handler also closes the miscrediting hazard in the other
 * direction: a `require*` call belonging to the fn ABOVE can never be counted as
 * this fn's gate. Same class of bug as the `\n});` terminator #565 fixed in the
 * sibling sweep.
 */
function serverFns(src: string): { name: string; body: string }[] {
	const decl = /export const (\w+) = createServerFn\b/g;
	const out: { name: string; body: string }[] = [];
	for (const m of src.matchAll(decl)) {
		const name = m[1] ?? "";
		const at = m.index ?? 0;
		const h = src.indexOf(".handler(", at);
		if (h === -1) {
			out.push({ name, body: "" });
			continue;
		}
		// Balanced-paren scan from the `(` of `.handler(`.
		let depth = 0;
		let end = src.length;
		for (let j = h + ".handler".length; j < src.length; j++) {
			const c = src[j];
			if (c === "(") depth++;
			else if (c === ")") {
				depth--;
				if (depth === 0) {
					end = j + 1;
					break;
				}
			}
		}
		out.push({ name, body: src.slice(h, end) });
	}
	return out;
}

/**
 * A write REACHED from a handler, either inline or through a seam whose name
 * says so. `applyBulkImport` / `applyConvertGuestToMember` / `createClubWithAdmin`
 * are the seams that actually insert; naming them here is what makes the guard
 * see a handler that delegates rather than inlines.
 *
 * This is a NAME LIST, which is the guard's one soft spot: a new seam with a new
 * name is invisible to it until someone adds the name. So the census below
 * asserts how many writers the sweep can currently SEE — a rename or a deleted
 * arm that quietly drops the sweep to nothing then fails here instead of passing
 * as an empty offender list. `applySelfAdd` was an arm until #630 deleted it.
 */
const WRITES =
	/insert\(members\)|applyBulkImport|applyMemberEdit|applyMemberMerge|applyMemberRemove|applySetMemberStatus|applySetMemberRole|applyConvertGuestToMember|createClubWithAdmin/;

/** Every `createServerFn` in `src/server` that this sweep reads as writing `members`. */
function memberWriters(): { rel: string; name: string; body: string }[] {
	const out: { rel: string; name: string; body: string }[] = [];
	for (const file of readdirSync(SERVER_DIR)) {
		if (!file.endsWith(".ts") || file.includes(".test.")) continue;
		const full = join(SERVER_DIR, file);
		const src = readFileSync(full, "utf8");
		const rel = relative(ROOT, full);
		if (rel in REVIEWED_UNGATED_MEMBER_WRITERS) continue;
		for (const fn of serverFns(src)) {
			if (!WRITES.test(fn.body)) continue;
			out.push({ rel, name: fn.name, body: fn.body });
		}
	}
	return out;
}

describe("no anonymous write to the members table (#616)", () => {
	it("every createServerFn that writes members gates on a club role", () => {
		const offenders = memberWriters()
			.filter((fn) => !GATE.test(fn.body))
			.map((fn) => `${fn.rel}: ${fn.name}`);
		expect(offenders).toEqual([]);
	});

	it("the sweep still SEES the member writers — an empty list would pass vacuously", () => {
		// Absolute, not relative to what the sweep happens to find today: with a
		// floor stated as `writers.length >= writers.length` this case could never
		// fail, which is the trap CODING_STANDARDS.md records for tests written
		// against the constant they guard. 8 is what `src/server` carries at #630
		// (six on `members.ts`, plus `convertGuestToMember` and `provisionClub`).
		// If a real removal lowers it, lower this DELIBERATELY, the way
		// `WRITE_GATES` moves its own count.
		const writers = memberWriters();
		expect(
			writers.length,
			`the members-write sweep found ${writers.length} writers: ${writers
				.map((w) => w.name)
				.join(
					", ",
				)}. If a seam was renamed, add the new name to WRITES rather than lowering this.`,
		).toBeGreaterThanOrEqual(8);
	});

	it("can actually fail — the body splitter finds an ungated writer", () => {
		// Pins the splitter, not the tree. Without this the guard above passes on a
		// clean repo whether or not `serverFns` works at all, which is how a source
		// sweep rots into decoration.
		const synthetic = `
			/** Prose BETWEEN declarations naming applyBulkImport — must not be read
			 *  as anyone's handler body. */
			export const gated = createServerFn({ method: "POST" })
				.handler(async ({ data }) => {
					const user = await requireUser();
					await requireClubRole(user.id, data.clubId, ["admin"]);
					return applyBulkImport(data);
				});
			export const sneaky = createServerFn({ method: "POST" })
				.handler(async ({ data }) => applyBulkImport(data));
		`;
		const fns = serverFns(synthetic);
		expect(fns.map((f) => f.name)).toEqual(["gated", "sneaky"]);
		// Both must READ as writers, or "no offenders" would be an artefact of the
		// splitter losing the body rather than of the tree being gated.
		expect(WRITES.test(fns[0]?.body ?? "")).toBe(true);
		expect(WRITES.test(fns[1]?.body ?? "")).toBe(true);
		// The gate on `gated` must NOT leak into `sneaky` — the miscrediting bug.
		expect(GATE.test(fns[0]?.body ?? "")).toBe(true);
		expect(GATE.test(fns[1]?.body ?? "")).toBe(false);
	});

	it("recognises bulkImportMembers as gated", () => {
		// The real-tree anchor, pinned to the fn that now mints roster rows for an
		// officer (Roster → "+ Add member"). It was `addMember` until #630 deleted
		// it; a source guard whose only concrete case names a deleted export stops
		// proving anything about this repo.
		const src = readFileSync(resolve(SERVER_DIR, "members.ts"), "utf8");
		const fn = serverFns(src).find((f) => f.name === "bulkImportMembers");
		expect(
			fn,
			"bulkImportMembers no longer exists in members.ts",
		).toBeDefined();
		expect(WRITES.test(fn?.body ?? "")).toBe(true);
		expect(GATE.test(fn?.body ?? "")).toBe(true);
	});
});
