/**
 * #1283. The `connector` proof (a token owner acting on their OWN row) is
 * admitted by the self-only seams and by NOTHING that rules on someone else.
 *
 * Card: protects=the session-only rulings stay session-only: ballot-session
 * voter, voting, minutes and the slot-confirm gate (`sessionIsHolder`) never
 * mention `connector`; fails_when=a later change lets `connector` into any of
 * them (the mutation check inserts the word into one) or one of the files or
 * the function is renamed away so the check scans nothing;
 * no_claim=a lexical grep: it does not prove those paths REFUSE a connector
 * proof at runtime (the confirm case does, in `set-my-attendance.integration`),
 * and a rename of the proof string would slip past it, which the exhaustive
 * `WriteProof` union in typecheck covers.
 *
 * Read COMMENT-BLIND ("must be absent" is the loosening direction for a
 * comment, so prose explaining why the word is absent must not trip it): see
 * `src/test/guard-source.ts`. Absence is asserted on the stripped source, and
 * the presence checks that the scanned text is real run on the same read.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const SERVER = resolve(fileURLToPath(import.meta.url), "..");

const WHOLE_FILES: { file: string; mustContain: string }[] = [
	{ file: "ballot-session-voter-logic.ts", mustContain: "session" },
	{ file: "voting-logic.ts", mustContain: "sessionIsVoter" },
	{ file: "minutes-logic.ts", mustContain: "session" },
];

/** The source of ONE top-level function: from its signature to the next
 *  top-level declaration. */
function functionSource(src: string, name: string): string {
	const start = src.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`${name} not found; re-point this guard`);
	const rest = src.slice(start);
	const next = rest
		.slice(1)
		.search(/\n(?:export )?(?:async )?function |\n\/\*\*/);
	return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("the connector proof stays out of session-only rulings (#1283)", () => {
	it.each(WHOLE_FILES)("$file never mentions connector", ({
		file,
		mustContain,
	}) => {
		const src = readSource(resolve(SERVER, file));
		expect(src, `${file} scanned nothing`).toContain(mustContain);
		expect(src).not.toMatch(/connector/i);
	});

	it("sessionIsHolder (the slot-confirm gate) never mentions connector", () => {
		const src = readSource(resolve(SERVER, "slots-logic.ts"));
		const body = functionSource(src, "sessionIsHolder");
		expect(body).toContain("resolveWriteActorWithProof");
		expect(body).not.toMatch(/connector/i);
	});

	it("claimSlotCore, the self-claim, is where slots-logic may use it", () => {
		const src = readSource(resolve(SERVER, "slots-logic.ts"));
		expect(functionSource(src, "claimSlotCore")).toMatch(/connector/);
	});
});
