import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

/**
 * Every writer that FILLS an open slot closes its cover request (#1438).
 *
 * `cover-logic.integration.test.ts` executes the three fill paths that exist
 * (claim, officer assign, guest assign). This guard covers the one thing a
 * behavioural test cannot: a NEW fill site. It enumerates every `UPDATE
 * role_slots SET assigned_*_id = <not null>` under `src/server`, and fails on
 * one it has not been told about, so the author has to decide, in this file,
 * whether the new site fills an open slot (and must call `closeCoverRequest`) or
 * re-points a slot that is already held.
 */
const SERVER = resolve(__dirname);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
	});
}

/** The text of every `.update(roleSlots).set(...)` call in a file. */
function roleSlotSets(source: string): string[] {
	return [
		...source.matchAll(
			/\.update\(roleSlots\)\s*\.set\(([\s\S]*?)\)\s*\.where/g,
		),
	].map((m) => m[1] ?? "");
}

/** A literal non-null assignee. `(?=\S)` pins the value's first character:
 *  without it `\s*` backtracks to zero and `(?!null)` then sees the space, so a
 *  `null` value would match. */
const LITERAL_ASSIGNEE = /assigned(?:Member|Guest)Id:\s*(?=\S)(?!null\b)/;

/** Variables a `.set(<name>)` may pass: a constant that only CLEARS the slot. */
const CLEARING_SETS = new Set(["FREE_SLOT"]);

/**
 * A set that may write a NON-null assignee: a fill or a re-point, not a clear.
 * Beyond the literal, a spread (`{ status, ...assignment }`) or a variable
 * (`.set(patch)`) hides what it writes, so it counts too: a fill that builds its
 * assignment elsewhere (history import did) must not slip past the guard. A
 * variable in {@link CLEARING_SETS} is the one exception.
 */
function writesAssignee(set: string): boolean {
	const text = set.trim();
	if (LITERAL_ASSIGNEE.test(text)) return true;
	if (!text.startsWith("{")) return !CLEARING_SETS.has(text);
	return /(^|[\s,{])\.\.\./.test(text);
}

/**
 * The files that write a non-null assignee, and the number of such statements.
 * `closes` is the count that fill an OPEN slot and so call `closeCoverRequest`;
 * the rest re-point a slot that is already held (nobody is finding cover for it)
 * or restore one.
 */
const KNOWN: Record<
	string,
	{ statements: number; closes: number; why: string }
> = {
	"slots-logic.ts": {
		statements: 2,
		closes: 2,
		why: "claimSlotCore and reassignSlotCore",
	},
	"guests-logic.ts": {
		statements: 1,
		closes: 1,
		why: "applyAssignGuestToSlot (O4)",
	},
	"cover-logic.ts": {
		statements: 1,
		closes: 0,
		why: "Undo restores the releaser; it deletes the request itself, in the same transaction",
	},
	"speeches-logic.ts": {
		statements: 1,
		closes: 1,
		why: "attachSpeechToOpenSlot fills an open speaker slot",
	},
	"membership-collapse-logic.ts": {
		statements: 1,
		closes: 0,
		why: "re-points held slots from one membership to the keeper",
	},
	"guest-pipeline-logic.ts": {
		statements: 4,
		closes: 1,
		why: "unlink restores the recorded slots to the guest and closes any open request on each; link and convert re-point slots already held",
	},
	"history-import-logic.ts": {
		statements: 1,
		closes: 1,
		why: "the import fills a still-empty slot (its assignment is spread in, so the literal check alone missed it)",
	},
};

describe("every fill of an open slot closes its cover request (#1438)", () => {
	const files = sourceFiles(SERVER);

	it("the set of files writing a non-null slot assignee is the known set", () => {
		// protects=a NEW fill site cannot land without someone deciding whether it
		//   must call `closeCoverRequest`
		// fails_when=a file starts writing `assigned_*_id` on role_slots and is not
		//   in KNOWN, or a known file's count changes
		// no_claim=that a known file's statements are the right ones (the next two
		//   cases read the closers)
		const found: Record<string, number> = {};
		for (const file of files) {
			const count = roleSlotSets(readSource(file)).filter(
				writesAssignee,
			).length;
			if (count > 0) found[relative(SERVER, file)] = count;
		}
		expect(Object.keys(found).length).toBeGreaterThan(0);
		expect(found).toEqual(
			Object.fromEntries(
				Object.entries(KNOWN).map(([f, k]) => [f, k.statements]),
			),
		);
	});

	it("every closeCoverRequest call comes AFTER an assignee-writing role_slots UPDATE in its function, and the count matches", () => {
		// protects=the closers (claim, reassign, guest assign, attach speech, guest
		//   unlink, history import) keep closing, and in order: a close before the
		//   conditional UPDATE would close the request on a refused fill
		// fails_when=a closer's call is deleted, or sits above the assignee-writing
		//   `.update(roleSlots)` of the function it is in, or that function has none
		// no_claim=behaviour (`cover-logic.integration.test.ts` runs the paths); that
		//   the UPDATE is the one that fills (the function is the unit checked)
		let closers = 0;
		for (const [file, known] of Object.entries(KNOWN)) {
			const source = readSource(join(SERVER, file));
			const calls = [...source.matchAll(/closeCoverRequest\(/g)];
			expect(calls.length, `${file}: ${known.why}`).toBe(known.closes);
			closers += calls.length;
			const starts = [
				...source.matchAll(/^(?:export )?(?:async )?function \w+/gm),
			].map((m) => m.index ?? 0);
			for (const call of calls) {
				const at = call.index ?? 0;
				const start = Math.max(...starts.filter((s) => s < at));
				const before = source.slice(start, at);
				expect(before.length, `${file}: empty slice`).toBeGreaterThan(0);
				// An UPDATE that writes the assignee, not just any role_slots UPDATE:
				// a function may clear or edit other columns of the row first.
				const fills = [
					...before.matchAll(
						/\.update\(roleSlots\)\s*\.set\(([\s\S]*?)\)\s*\.where/g,
					),
				].filter((m) => writesAssignee(m[1] ?? ""));
				expect(
					fills.length,
					`${file}: closeCoverRequest at ${at} has no assignee-writing role_slots UPDATE above it in its function`,
				).toBeGreaterThan(0);
			}
		}
		expect(closers).toBe(
			Object.values(KNOWN).reduce((n, k) => n + k.closes, 0),
		);
		expect(closers).toBe(6);
	});

	it("closeCoverRequest stays free of the modules that call it", () => {
		// protects=no import cycle: slots-logic and guests-logic import it, so it
		//   must not import them (a module-level `undefined` in the full suite)
		// fails_when=cover-close.ts imports slots-logic, guests-logic or cover-logic
		// no_claim=other cycles
		const source = readSource(join(SERVER, "cover-close.ts"));
		expect(source).not.toMatch(
			/from "\.\/(slots-logic|guests-logic|cover-logic)"/,
		);
	});
});
