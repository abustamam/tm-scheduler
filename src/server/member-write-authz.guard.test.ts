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
// writer of `members` cannot be anonymous by omission.
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
 * tree that made `listMembers` a false offender, because `addMember`'s comment
 * two lines below it says the word `applySelfAdd`. Caught on a clean run, which
 * is the safe direction for a raw-reading offender list, but a guard that always
 * fails is a guard nobody keeps.
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

describe("no anonymous write to the members table (#616)", () => {
	it("every createServerFn that writes members gates on a club role", () => {
		const offenders: string[] = [];
		for (const file of readdirSync(SERVER_DIR)) {
			if (!file.endsWith(".ts") || file.includes(".test.")) continue;
			const full = join(SERVER_DIR, file);
			const src = readFileSync(full, "utf8");
			const rel = relative(ROOT, full);
			if (rel in REVIEWED_UNGATED_MEMBER_WRITERS) continue;

			for (const fn of serverFns(src)) {
				// A write REACHED from this fn, either inline or through a seam whose
				// name says so. `applySelfAdd` / `applyBulkImport` are the seams that
				// actually insert; naming them here is what makes the guard see a
				// handler that delegates rather than inlines.
				const writes =
					/insert\(members\)|applySelfAdd|applyBulkImport|applyMemberEdit|applyMemberMerge|applyMemberRemove|applySetMemberStatus|applySetMemberRole/.test(
						fn.body,
					);
				if (!writes) continue;
				if (GATE.test(fn.body)) continue;
				offenders.push(`${rel}: ${fn.name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("can actually fail — the body splitter finds an ungated writer", () => {
		// Pins the splitter, not the tree. Without this the guard above passes on a
		// clean repo whether or not `serverFns` works at all, which is how a source
		// sweep rots into decoration.
		const synthetic = `
			export const gated = createServerFn({ method: "POST" })
				.handler(async ({ data }) => {
					const user = await requireUser();
					await requireClubRole(user.id, data.clubId, ["admin"]);
					return applySelfAdd(data);
				});
			export const sneaky = createServerFn({ method: "POST" })
				.handler(async ({ data }) => applySelfAdd(data));
		`;
		const fns = serverFns(synthetic);
		expect(fns.map((f) => f.name)).toEqual(["gated", "sneaky"]);
		// The gate on `gated` must NOT leak into `sneaky` — the miscrediting bug.
		expect(GATE.test(fns[0]?.body ?? "")).toBe(true);
		expect(GATE.test(fns[1]?.body ?? "")).toBe(false);
	});

	it("recognises addMember as gated", () => {
		const src = readFileSync(resolve(SERVER_DIR, "members.ts"), "utf8");
		const addMember = serverFns(src).find((f) => f.name === "addMember");
		expect(addMember, "addMember no longer exists in members.ts").toBeDefined();
		expect(GATE.test(addMember?.body ?? "")).toBe(true);
	});
});
