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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type HookInput = {
	tool_name?: string;
	tool_input?: { subagent_type?: unknown; model?: unknown };
};
export type Decision = { allow: true } | { allow: false; reason: string };

export const DENY_REASON =
	'Agent dispatch would inherit the main session\'s Opus (docs/agents/token-usage.md). Retry with subagent_type "implementer" (Sonnet) or "explorer" (Haiku), or pass model explicitly; use model: "opus" only for judgement work such as review.';

export const FORK_REASON =
	'subagent_type "fork" always inherits the main session\'s model and ignores model (docs/agents/token-usage.md). Use "implementer" or "explorer", or another subagent_type with model set.';

const TYPE_RE = /^[A-Za-z0-9_-]+$/;

/** Frontmatter lines, or null when there is no (closed) frontmatter. */
function frontmatterLines(content: string): string[] | null {
	const lines = content.split(/\r?\n/);
	if (lines[0] !== "---") return null;
	const end = lines.indexOf("---", 1);
	return end === -1 ? null : lines.slice(1, end);
}

/**
 * First `<key>:` value in the frontmatter, normalised: a trailing comment (one
 * that starts the value or follows whitespace) is stripped, one pair of
 * matching quotes removed, and empty / `null` / `~` / block-scalar (`|`, `>`)
 * values become null. See #1100.
 */
function frontmatterField(content: string, key: string): string | null {
	const lines = frontmatterLines(content);
	if (!lines) return null;
	const re = new RegExp(`^${key}:\\s*(.*)$`);
	for (const line of lines) {
		const m = re.exec(line);
		if (!m) continue;
		let v = m[1].replace(/(^|\s+)#.*$/, "").trim();
		if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) {
			v = v.slice(1, -1);
		}
		v = v.trim();
		// Allowlist a plain token (sonnet, claude-sonnet-5-5, opus[1m]); anything
		// else (YAML null in any case, ~, tags, anchors, block scalars) is unpinned.
		if (!/^[A-Za-z0-9][\w.:[\]-]*$/.test(v) || /^null$/i.test(v)) return null;
		return v;
	}
	return null;
}

/** Frontmatter `model:` value, or null when absent/empty/non-string YAML. */
export function parseAgentModel(content: string): string | null {
	return frontmatterField(content, "model");
}

export function decide(
	input: HookInput,
	readAgentModel: (type: string) => string | null,
): Decision {
	// `model` is ignored for a fork: it always inherits the parent's model.
	if (input.tool_input?.subagent_type === "fork") {
		return { allow: false, reason: FORK_REASON };
	}
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

/**
 * Claude Code registers an agent by its frontmatter `name:`, not its filename,
 * so scan every `.claude/agents/*.md` and return the model of the one whose
 * `name` equals `type`; no match -> null.
 */
export function readRepoAgentModel(
	root: string,
	type: string,
): string | null {
	try {
		const dir = join(root, ".claude", "agents");
		for (const f of readdirSync(dir)) {
			if (!f.endsWith(".md")) continue;
			let content: string;
			try {
				content = readFileSync(join(dir, f), "utf8");
			} catch {
				continue;
			}
			if (frontmatterField(content, "name") === type) {
				return parseAgentModel(content);
			}
		}
	} catch {
		return null;
	}
	return null;
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
