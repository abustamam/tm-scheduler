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

// protects=no client source tells a member GavelUp notified someone or that an officer will find cover; fails_when=a forbidden phrase appears in any non-test source file under components/routes/hooks/lib; no_claim=scans source text (comments included), not rendered output, and only the listed directories
describe("role-duty copy guard", () => {
	it("no client source says GavelUp notifies anyone", () => {
		const hits: string[] = [];
		for (const root of ROOTS) {
			for (const file of walk(root)) {
				if (file.endsWith("src/lib/role-duty-copy.ts")) continue;
				const text = readFileSync(file, "utf8").toLowerCase();
				for (const phrase of FORBIDDEN_NOTIFY_PHRASES) {
					if (text.includes(phrase)) hits.push(`${file}: "${phrase}"`);
				}
			}
		}
		expect(hits).toEqual([]);
	});
});
