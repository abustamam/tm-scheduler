import { expect } from "vitest";

// Spelled out here on purpose: importing CLAIM_CLASS would make the check
// agree with whatever the source says (a mutation of the constant survived).
const CLAIM_TOKENS = [
	"border-warning",
	"bg-warning-soft",
	"text-warning-foreground",
	"hover:bg-warning",
	"hover:text-on-accent-fill",
];

/**
 * Exact-token check of a Claim button's className (#1308 AC 1). Whole tokens
 * only, so `border-warning/60`, `hover:border-warning` and
 * `border-warning-foreground` do not satisfy `border-warning`.
 */
export function expectAmberClaim(className: string) {
	const tokens = className.split(/\s+/).filter(Boolean);
	const claim = CLAIM_TOKENS;
	for (const t of claim) expect(tokens).toContain(t);
	// Every warning-family token on the button is one of the Claim tokens: a
	// modifier or a stray variant of the family would show up here.
	expect(tokens.filter((t) => t.includes("warning")).sort()).toEqual(
		claim.filter((t) => t.includes("warning")).sort(),
	);
	for (const prefix of ["bg-success", "text-success", "border-success"]) {
		expect(tokens.filter((t) => t.startsWith(prefix))).toEqual([]);
		expect(tokens.filter((t) => t.includes(`:${prefix}`))).toEqual([]);
	}
}
