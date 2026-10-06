/**
 * PreToolUse hook (#1100): deny an Agent dispatch that would silently inherit
 * the main session's Opus (docs/agents/token-usage.md). A dispatch is allowed
 * when it names a `model`, or a `subagent_type` whose repo agent file pins one.
 *
 * Known limits, accepted: (a) the guard fails open on malformed input, a thrown
 * error, or if `bun` is missing; (b) it reads the repo's .claude/agents file, so
 * a same-named agent injected via `claude --agents` is judged by the repo file.
 * It targets dispatches that name nothing, not a deliberate bypass.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type HookInput = {
	tool_name?: string;
	tool_input?: { subagent_type?: unknown; model?: unknown };
};
export type Decision = { allow: true } | { allow: false; reason: string };

export const DENY_REASON =
	'Agent dispatch would inherit the main session\'s Opus (docs/agents/token-usage.md). Retry with subagent_type "implementer" (Sonnet) or "explorer" (Haiku), or pass model explicitly; use model: "opus" only for judgement work such as review.';

const TYPE_RE = /^[A-Za-z0-9_-]+$/;

/** Frontmatter `model:` value, or null when absent/empty. See #1100. */
export function parseAgentModel(content: string): string | null {
	const lines = content.split(/\r?\n/);
	if (lines[0] !== "---") return null;
	const end = lines.indexOf("---", 1);
	if (end === -1) return null;
	for (const line of lines.slice(1, end)) {
		const m = /^model:\s*(.*)$/.exec(line);
		if (!m) continue;
		let v = m[1].replace(/\s+#.*$/, "").trim();
		if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) {
			v = v.slice(1, -1);
		}
		v = v.trim();
		return v === "" ? null : v;
	}
	return null;
}

export function decide(
	input: HookInput,
	readAgentModel: (type: string) => string | null,
): Decision {
	const model = input.tool_input?.model;
	if (typeof model === "string" && model.trim() !== "") return { allow: true };
	const type = input.tool_input?.subagent_type;
	if (typeof type === "string" && TYPE_RE.test(type)) {
		const pinned = readAgentModel(type);
		if (
			pinned !== null &&
			pinned.trim() !== "" &&
			pinned.trim().toLowerCase() !== "inherit"
		) {
			return { allow: true };
		}
	}
	return { allow: false, reason: DENY_REASON };
}

export function readRepoAgentModel(
	root: string,
	type: string,
): string | null {
	try {
		return parseAgentModel(
			readFileSync(join(root, ".claude", "agents", `${type}.md`), "utf8"),
		);
	} catch {
		return null;
	}
}

function main(): void {
	try {
		const raw = readFileSync(0, "utf8");
		const input = JSON.parse(raw) as HookInput;
		const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
		const d = decide(input, (t) => readRepoAgentModel(root, t));
		if (!d.allow) {
			process.stdout.write(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: d.reason,
					},
				}),
			);
		}
	} catch (e) {
		process.stderr.write(`agent-model-guard: failing open (${String(e)})\n`);
	}
}

if (import.meta.main) main();
