/**
 * The preview→apply mechanism's ONE canonicalizer and hash (#773, design D5).
 *
 * An MCP write tool whose write is DEFERRED plans first and returns
 * `{plan, planHash}`; the caller shows the plan to a human and the apply
 * re-plans inside its transaction and refuses when the hash no longer matches.
 * That makes the hash a correctness surface, not a convenience: an UNSTABLE
 * field anywhere in a plan — a timestamp, a `Date`, a set iterated in database
 * order — makes every apply fail as `PLAN_STALE`, which reads from the outside
 * exactly like a database race and is close to undebuggable from a transcript.
 *
 * So there is one canonicalizer, here, in a module with no database import. It also
 * holds the MCP server's per-tool contract lists and instructions text (#1657),
 * which name tools but import none. Tools sharing it is the only way a later one inherits a
 * mechanism that is already proven rather than re-deriving a subtly different
 * one. No tool hashes for itself.
 *
 * ## `assign_roles`, `set_awards` and the four meeting-status tools are the exemptions, and it is deliberate
 *
 * This header used to say EVERY write tool returns `{plan, planHash}`, which
 * was true when only `record_guest_book` existed and stopped being true at
 * #809. `assign_roles` returns a plan and no hash: it plans and applies in ONE
 * call, inside one transaction that already holds a `FOR UPDATE` row lock on
 * every slot it names, so there is no window between the plan and the write
 * for a hash to detect. Its plan is the ACCOUNT of what happened rather than
 * something a human approves first.
 *
 * `set_awards` (#1172) is the second exemption, for the same reasons: at most
 * three rows, every id from `get_agenda` or `find_people`, one transaction under
 * the meeting's row lock, and a wrong winner is one tap to fix in the minutes.
 *
 * `cancel_meeting`, `restore_meeting`, `complete_meeting` and `reopen_meeting`
 * (#1657) apply on the first call too, by the maintainer's decision: one row,
 * one tap to undo (completing's closed ballots excepted, and its description
 * says so). The exemptions are the exported `IMMEDIATE_APPLY_TOOLS` below, and
 * the server instructions are generated from it.
 *
 * The rule that decides which shape a tool gets is stated in
 * `src/server/mcp/tools/assign-roles.ts`: a confirm page — and therefore a
 * stored plan and a hash — when the write is hard to see or hard to undo. A
 * hash on a same-call apply would be ceremony that proves nothing, and a
 * reader finding one would reasonably assume a preview step exists.
 *
 * ## `edit_agenda` hashes without a page
 *
 * The third shape (#966). `edit_agenda` previews and applies in TWO calls in
 * the same conversation: the first returns `{plan, planHash}` and writes
 * nothing, the second passes the hash back, and the apply re-plans under the
 * meeting's row lock and refuses as `PLAN_STALE` on a mismatch. There IS a
 * window between the two calls — a human reads the plan in it — so the hash
 * detects something real; there is no stored plan and no
 * confirm page, because a run sheet is neither hard to see nor hard to undo.
 * Its plan carries every row's before-and-after start time, stored minutes
 * and note (what an apply writes, so what the hash must cover), which is why an
 * unrelated agenda edit (or a new speaker lengthening the speeches) makes it
 * stale: those change what the human was shown.
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
 * Write tools that APPLY ON THE FIRST CALL: no preview, no `planHash`. The one
 * source of truth for the server instructions and the guard test (#1657).
 */
export const IMMEDIATE_APPLY_TOOLS = [
	"assign_roles",
	"set_awards",
	"cancel_meeting",
	"restore_meeting",
	"complete_meeting",
	"reopen_meeting",
] as const;

/** Write tools that return a `confirmUrl`; the user confirms in the app. */
export const CONFIRM_PAGE_TOOLS = [
	"upsert_agendas",
	"record_guest_book",
] as const;

/** The sentence every immediate-apply tool's description must START with. */
export const IMMEDIATE_APPLY_PREFIX =
	"APPLIES IMMEDIATELY, in the same call, with no preview and no planHash: the call IS the write. State what you are about to do and get the user's yes BEFORE calling. ";

/** The text sent at MCP `initialize`; the tool lists are generated, not typed. */
export function buildMcpInstructions(): string {
	return `This server edits a real Toastmasters club's records. Write tools follow one of three contracts.

1. Preview, then apply (every write tool not named in 2 or 3):
   a. Call it WITHOUT planHash. Nothing is written; you get back a plan, a planHash, and a list of blocking items.
   b. Show the plan to the user in full and get an explicit yes. Do not summarise away what it will change.
   c. Call the tool again with the SAME input plus that planHash.

2. Confirm in the app: ${CONFIRM_PAGE_TOOLS.join(", ")}. These return a confirmUrl and write nothing. Give the user the link; they confirm on that page.

3. APPLIES ON THE FIRST CALL: ${IMMEDIATE_APPLY_TOOLS.join(", ")}. There is NO preview and no planHash: the call itself is the write. State what you are about to do and get the user's explicit yes BEFORE calling.

Never resolve an entry the plan marks 'ambiguous' on your own — ask the user which person it is, or whether it is someone new. Guessing merges two real people's records or splits one person's into two.

If an apply returns PLAN_STALE, the club changed since the preview. Show the fresh plan it returns and ask again; do not retry automatically.

Start with whoami to get a clubId.`;
}

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

/**
 * `sha256(canonicalize(value))`, lowercase hex: a stable fingerprint of one
 * piece of content (a template's stored rows) for a plan to carry. The ONE
 * place hashing lives; a tool never builds its own (#1628).
 */
export function digest(value: unknown): string {
	return sha256Hex(canonicalize(value));
}

function sha256Hex(canonical: string): string {
	return createHash("sha256").update(canonical).digest("hex");
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
	return digest({
		tool: input.tool,
		clubId: input.clubId,
		userId: input.userId,
		plan: input.plan,
	});
}
