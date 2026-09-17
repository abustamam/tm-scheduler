/**
 * The preview→apply mechanism's ONE canonicalizer and hash (#773, design D5).
 *
 * Every MCP write tool plans first and returns `{plan, planHash}`; the caller
 * shows the plan to a human and calls again with that hash, and apply re-plans
 * inside its transaction and refuses when the hash no longer matches. That
 * makes the hash a correctness surface, not a convenience: an UNSTABLE field
 * anywhere in a plan — a timestamp, a `Date`, a set iterated in database order
 * — makes every apply fail as `PLAN_STALE`, which reads from the outside
 * exactly like a database race and is close to undebuggable from a transcript.
 *
 * So there is one canonicalizer, here, in a module with no database import and
 * no tool knowledge. Three tools sharing it (PR1's `record_guest_book`, then
 * `upsert_agendas` and `assign_roles`) is the only way the later two inherit a
 * mechanism that is already proven rather than re-deriving a subtly different
 * one. No tool hashes for itself.
 *
 * Canonical form, and why each rule:
 *   - Object keys SORTED. A plan is assembled from database rows and literal
 *     objects; the key order of neither is a fact about the plan.
 *   - Array order PRESERVED. Entries are identified by their input index, so
 *     order IS the identity — reordering a page of guest-book entries really is
 *     a different plan.
 *   - `undefined` dropped from objects, `null` kept. `JSON.stringify` already
 *     does this and the distinction is meaningful: null is a value the plan
 *     asserts, undefined is a field it does not carry.
 *   - No timestamps. Not enforceable here — it is a rule about what callers put
 *     IN a plan — but `Date` is at least serialised to its ISO string rather
 *     than the `{}` a naive manual walk produces, so two different instants can
 *     never collide silently if one slips in.
 *
 * A plan contains only the rows it would touch, so an unrelated write elsewhere
 * in the club does not make it stale.
 */
import { createHash } from "node:crypto";

/**
 * Deterministic JSON for a plain JSON-ish value: object keys sorted at every
 * depth, array order untouched.
 *
 * Written as an explicit walk rather than `JSON.stringify(value, replacer)`
 * because the replacer form is applied to the value AFTER `toJSON()` has run
 * and does not give a stable ordering hook for nested objects in every engine —
 * and this function's whole job is to be boring and identical everywhere.
 */
export function canonicalize(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	// Dates would otherwise serialise as `{}` through the object branch below,
	// collapsing every instant onto one string.
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(sortDeep);
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		const v = (value as Record<string, unknown>)[key];
		// Match `JSON.stringify`: an undefined property is absent, not null.
		if (v === undefined) continue;
		out[key] = sortDeep(v);
	}
	return out;
}

/** What a plan hash is taken over: the plan, plus who is applying it and where. */
export interface PlanHashInput {
	/** The MCP tool name, so a hash is not portable between tools. */
	tool: string;
	clubId: string;
	/** The token owner. A plan previewed by one admin cannot be applied by another. */
	userId: string;
	plan: unknown;
}

/**
 * `sha256(canonical({tool, clubId, userId, plan}))`, lowercase hex.
 *
 * NOT a credential and not a secret: every call is authorized on its own, and
 * the hash only answers "is the state you were shown still the state I see".
 */
export function planHash(input: PlanHashInput): string {
	return createHash("sha256")
		.update(
			canonicalize({
				tool: input.tool,
				clubId: input.clubId,
				userId: input.userId,
				plan: input.plan,
			}),
		)
		.digest("hex");
}
