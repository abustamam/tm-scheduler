/**
 * A past speech (#1656, `speeches.delivered_off_schedule`) is never schedulable,
 * and a new writer that puts an existing speech id on a slot fails here.
 *
 * The refusal used to be a hand-kept list of three sites (the unscheduled
 * list, `attachSpeechToOpenSlot`, the speech-request Schedule path). A hand-kept
 * list misses the writer nobody remembered (CODING_STANDARDS.md, "A status that
 * freezes writes is enforced over a derived set of writers"). So the set of
 * writers is DERIVED from source: every non-test `.ts` under `src/server` that
 * runs `.update(roleSlots).set(…)` with a `speechId` that is not literally
 * `null`, or `.insert(roleSlots).values(…)` carrying one.
 *
 * Each such file must either carry the refusal (an `if (…deliveredOffSchedule) throw new
 * Error(PAST_SPEECH_NOT_SCHEDULABLE_MESSAGE)` in it) or be listed in
 * `REVIEWED_EXEMPT` with the reason it cannot be handed a past speech's id.
 *
 * Proves: structural presence of the refusal in a writer's file, and that the
 * exemption list names no file that stopped being a writer. Does not prove: the
 * refusal runs before the write on every branch (the integration tests do), nor
 * a write through a variable holding the table or a dynamic `.set(obj)`; those
 * are reported as unreadable writers so they fail closed. Seeds and `scripts/`
 * are not swept.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname);

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) sourceFiles(p, out);
		else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
			out.push(p);
		}
	}
	return out;
}

/** Comments blanked (strings are not tracked: a stray `//` in a string only
 *  hides text, which can fail a good file but never pass a bad one). */
function strip(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The text of the balanced `(...)` argument starting at `open`. */
function balanced(src: string, open: number): string {
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "(") depth++;
		else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
	}
	return src.slice(open + 1);
}

function putsSpeechIdSomewhere(src: string): boolean {
	return [...src.matchAll(/\bspeechId\s*:\s*([^,}\n]+)/g)].some((x) => {
		const v = (x[1] ?? "").trim();
		return (
			v !== "null" &&
			!/^(roleSlots|speeches|t|z)\./.test(v) &&
			!/^(string|uuid)\b/.test(v)
		);
	});
}

type Finding = { writer: boolean; unreadable: boolean };

/** Does this file attach an existing speech id to a role slot? */
function scanSlotSpeechWriter(raw: string): Finding {
	const src = strip(raw);
	let writer = false;
	let unreadable = false;
	const re = /\.(update|insert)\(\s*roleSlots\s*\)\s*\.(set|values)\(/g;
	let m: RegExpExecArray | null = re.exec(src);
	while (m) {
		const arg = balanced(src, m.index + m[0].length - 1).trim();
		if (!arg.startsWith("{") && !arg.startsWith("[")) {
			// `.set(someVariable)`: the object is built elsewhere. Unreadable
			// only if this file puts a non-null speech id into any object at all
			// (a select map `speechId: roleSlots.speechId` is a read).
			if (putsSpeechIdSomewhere(src)) unreadable = true;
		} else if (/\bspeechId\b/.test(arg)) {
			const nonNull = [
				...arg.matchAll(/\bspeechId\s*(?::\s*([^,}\n]+))?/g),
			].some((x) => (x[1] ?? "").trim() !== "null");
			if (nonNull) writer = true;
		}
		m = re.exec(src);
	}
	if (/(?:update|insert\s+into)\s+role_slots/i.test(src)) unreadable = true;
	return { writer, unreadable };
}

/**
 * Writers that attach a speech id to a slot and need no off-schedule refusal of
 * their own. Each reason is checked by reading the code, not by this test.
 */
const REVIEWED_EXEMPT: Record<string, string> = {
	"history-import-logic.ts":
		"the id is one the same import created for that source row (`io.refOf`), " +
		"or an earlier import's ref; past speeches are only ever created by " +
		"`addPastSpeech` and are never recorded in an import ref",
	"slots-logic.ts":
		"the only existing-looking id it writes is `speechId: row.id`, the id of " +
		"a speech row the same function just inserted for that slot, which is " +
		"never off-schedule",
	"cover-logic.ts":
		"restores the slot's own prior speech id from its cover request, which " +
		"was on the slot, and the attach writer refuses a past speech",
};

/** `if (<row>.deliveredOffSchedule) throw new Error(PAST_SPEECH_NOT_SCHEDULABLE_MESSAGE)`
 *  in either brace style. The condition AND the throw, so removing the check
 *  while leaving the constant behind does not satisfy it. */
const REFUSAL =
	/if\s*\(\s*[\w.]+\.deliveredOffSchedule\s*\)\s*\{?\s*throw\s+new\s+Error\(\s*PAST_SPEECH_NOT_SCHEDULABLE_MESSAGE/;

const files = sourceFiles(ROOT).map((p) => ({
	rel: p.slice(ROOT.length + 1),
	raw: readFileSync(p, "utf8"),
}));

describe("a past speech is never schedulable (#1656)", () => {
	// protects=a slot never holds a speech given outside a meeting
	// fails_when=a writer that attaches an existing speech id lacks the refusal
	// no_claim=the refusal runs first on every path; see the integration tests
	it("every writer that attaches an existing speech id to a slot refuses it", () => {
		const missing: string[] = [];
		for (const f of files) {
			const { writer, unreadable } = scanSlotSpeechWriter(f.raw);
			if (!writer && !unreadable) continue;
			if (f.rel in REVIEWED_EXEMPT) continue;
			if (!REFUSAL.test(strip(f.raw))) {
				missing.push(
					`${f.rel}${unreadable ? " (unreadable write to role_slots)" : ""}`,
				);
			}
		}
		expect(
			missing,
			"these files attach a speech id to a slot without refusing a past speech: add the refusal, or list the file in REVIEWED_EXEMPT with a reason",
		).toEqual([]);
	});

	it("the derived set is non-empty and holds the known writer", () => {
		const derived = files
			.filter((f) => scanSlotSpeechWriter(f.raw).writer)
			.map((f) => f.rel);
		expect(derived).toContain("speeches-logic.ts");
		expect(derived).toContain("history-import-logic.ts");
	});

	it("REVIEWED_EXEMPT names only files that still write a speech id to a slot", () => {
		const derived = new Set(
			files
				.filter((f) => {
					const r = scanSlotSpeechWriter(f.raw);
					return r.writer || r.unreadable;
				})
				.map((f) => f.rel),
		);
		for (const name of Object.keys(REVIEWED_EXEMPT)) {
			expect(derived.has(name), `${name} is no longer a writer`).toBe(true);
		}
	});

	// The detector itself, on fixtures: a guard that cannot see a writer passes
	// for the wrong reason.
	describe("the scanner", () => {
		it("sees a set with an existing id, an insert, and a dynamic set", () => {
			expect(
				scanSlotSpeechWriter(
					"await tx.update(roleSlots).set({ status: 'claimed', speechId: id }).where(x)",
				).writer,
			).toBe(true);
			expect(
				scanSlotSpeechWriter(
					"await tx.update(roleSlots).set({ speechId }).where(x)",
				).writer,
			).toBe(true);
			expect(
				scanSlotSpeechWriter(
					"await tx.insert(roleSlots).values({ meetingId, speechId: s.id })",
				).writer,
			).toBe(true);
			expect(
				scanSlotSpeechWriter(
					"const p = { speechId: id }; await tx.update(roleSlots).set(patch)",
				).unreadable,
			).toBe(true);
		});
		it("ignores an unlink, a write with no speech id, and a commented one", () => {
			const none = (s: string) => {
				const r = scanSlotSpeechWriter(s);
				return !r.writer && !r.unreadable;
			};
			expect(none("tx.update(roleSlots).set({ speechId: null })")).toBe(true);
			expect(none("tx.update(roleSlots).set({ status: 'open' })")).toBe(true);
			expect(
				none("// tx.update(roleSlots).set({ speechId: id })\nconst a = 1;"),
			).toBe(true);
		});
	});
});
