import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_NOTIFY_PHRASES } from "./role-duty-copy";

const ROOTS = ["src/components", "src/routes", "src/hooks", "src/lib"];

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(p);
	}
	return out;
}

/** Lowercase and collapse whitespace so a phrase Biome wrapped across lines still matches. */
function forbiddenIn(source: string): string[] {
	const text = source.toLowerCase().replace(/\s+/g, " ");
	return FORBIDDEN_NOTIFY_PHRASES.filter((phrase) => text.includes(phrase));
}

describe("role-duty copy guard", () => {
	// protects=no client source tells a member GavelUp notified someone or that an officer will find cover; fails_when=a forbidden phrase appears in any non-test source file under components/routes/hooks/lib, or the walk finds fewer than 100 files (today 464); no_claim=scans source text (comments included), not rendered output, only the listed directories, and not strings built by concatenation
	it("no client source says GavelUp notifies anyone", () => {
		const files = ROOTS.flatMap((root) => walk(root)).filter(
			(f) => !f.endsWith("src/lib/role-duty-copy.ts"),
		);
		expect(files.length).toBeGreaterThan(100);
		const hits: string[] = [];
		for (const file of files) {
			for (const phrase of forbiddenIn(readFileSync(file, "utf8"))) {
				hits.push(`${file}: "${phrase}"`);
			}
		}
		expect(hits).toEqual([]);
	});

	// protects=the matcher catches a forbidden phrase that formatting wrapped across lines or indentation; fails_when=whitespace is not collapsed, so "let the team\n\t\tknow" slips through; no_claim=runs over a literal fixture, not real source
	it("catches a phrase wrapped across lines", () => {
		expect(forbiddenIn("<p>We will let the team\n\t\t\tknow soon</p>")).toEqual(
			["let the team know"],
		);
		expect(forbiddenIn("an officer will\n  find cover")).toContain(
			"find cover",
		);
		expect(forbiddenIn("nothing to see here")).toEqual([]);
	});
});
