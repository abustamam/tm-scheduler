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

/** A set that writes a NON-null assignee: a fill or a re-point, not a clear.
 *  `(?=\S)` pins the value's first character: without it `\s*` backtracks to
 *  zero and `(?!null)` then sees the space, so a `null` value would match. */
const WRITES_ASSIGNEE = /assigned(?:Member|Guest)Id:\s*(?=\S)(?!null\b)/;

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
		closes: 0,
		why: "link, unlink and convert re-point slots a guest or member already holds",
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
			const count = roleSlotSets(readSource(file)).filter((s) =>
				WRITES_ASSIGNEE.test(s),
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

	it("each closing site calls closeCoverRequest AFTER its UPDATE, and the count matches", () => {
		// protects=the four closers (claim, reassign, guest assign, attach speech) keep closing,
		//   in order: a close before the conditional UPDATE would close on a refusal
		// fails_when=a closer's call is deleted, or moves above the UPDATE
		// no_claim=behaviour; `cover-logic.integration.test.ts` runs them
		let closers = 0;
		for (const [file, known] of Object.entries(KNOWN)) {
			const source = readSource(join(SERVER, file));
			const calls = [...source.matchAll(/closeCoverRequest\(/g)].length;
			expect(calls, `${file}: ${known.why}`).toBe(known.closes);
			closers += calls;
		}
		expect(closers).toBe(4);

		const slots = readSource(join(SERVER, "slots-logic.ts"));
		for (const name of ["claimSlotCore", "reassignSlotCore"]) {
			const start = slots.indexOf(`export async function ${name}`);
			expect(start, `${name} not found`).toBeGreaterThan(-1);
			const end = slots.indexOf("\nexport ", start + 1);
			const body = slots.slice(start, end === -1 ? slots.length : end);
			const update = body.indexOf(".update(roleSlots)");
			const close = body.indexOf("closeCoverRequest(");
			expect(update, `${name}: UPDATE`).toBeGreaterThan(-1);
			expect(close, `${name}: close`).toBeGreaterThan(update);
		}
		const guestsSource = readSource(join(SERVER, "guests-logic.ts"));
		const g = guestsSource.indexOf(
			"export async function applyAssignGuestToSlot",
		);
		const gEnd = guestsSource.indexOf("\nexport ", g + 1);
		const gBody = guestsSource.slice(g, gEnd === -1 ? undefined : gEnd);
		expect(gBody.indexOf("closeCoverRequest(")).toBeGreaterThan(
			gBody.indexOf(".update(roleSlots)"),
		);
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
