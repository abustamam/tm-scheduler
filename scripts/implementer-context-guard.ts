/**
 * PreToolUse hook (#1103): an `implementer` subagent that has reached the
 * context cap may only commit, push and hand back (docs/agents/token-usage.md).
 * Review findings and every handback then go to a FRESH implementer, never a
 * SendMessage to this one, which would re-read its whole history on each call.
 *
 * Hook input [MEASURED 2026-10-06]: a call inside a subagent carries `agent_id`
 * and `agent_type`; a main-thread call carries neither. `transcript_path` is
 * the PARENT session's, and the subagent's own transcript is
 * `<transcript_path minus .jsonl>/subagents/agent-<agent_id>.jsonl`.
 *
 * Over the cap, allowed: plain git (add|commit|push|status|diff|log, optionally
 * after `-C <path>`) with no UNQUOTED shell metacharacter and no option that
 * runs a command or writes a file (judged on the words after quote removal), and `SubagentHandback`, the tool a subagent returns
 * its result with. Everything else is denied.
 *
 * Fails open, like scripts/agent-model-guard.ts: malformed input, a missing or
 * empty transcript, no usage line, or a thrown error exits 0 with empty stdout
 * and one stderr line. Known limit: it counts the last assistant turn's usage,
 * so it fires one turn after the cap is crossed, not before.
 */
import {
	closeSync,
	fstatSync,
	openSync,
	readFileSync,
	readSync,
} from "node:fs";
import { join } from "node:path";

export type HookInput = {
	tool_name?: string;
	tool_input?: { command?: unknown };
	transcript_path?: unknown;
	agent_id?: unknown;
	agent_type?: unknown;
};
export type Decision = { allow: true } | { allow: false; reason: string };

export const DEFAULT_CAP = 250_000;
/** Bytes read from the end of a transcript; enough for the last usage line. */
export const TAIL_BYTES = 512 * 1024;

const GIT_SUBCOMMANDS = new Set([
	"add",
	"commit",
	"push",
	"status",
	"diff",
	"log",
]);
/**
 * Long options that run a command or write a file, plus `--no-verify`. git
 * accepts any prefix of a long option, so a token is refused when its name is a
 * prefix of one of these (`--outp`), or extends one (`--output=f`).
 */
const DANGEROUS_OPTS = [
	"output",
	"no-index",
	"receive-pack",
	"upload-pack",
	"exec",
	"no-verify",
];

export function denyReason(context: number, cap: number): string {
	return `Context cap: ${Math.floor(context / 1000)}k >= ${Math.floor(cap / 1000)}k. Commit and push with git, then stop and return your handoff (Branch, Done with real test counts, Next, Gotchas) with the SubagentHandback tool. A fresh implementer continues from it.`;
}

/**
 * Split a command into its words the way a POSIX shell would (single quotes,
 * double quotes, backslashes), or null when it contains anything that could run
 * a second command or expand into other words: an UNQUOTED `; & | < > ( ) { }`
 * or newline, a backtick or `$` anywhere but inside single quotes, or an
 * unterminated quote. Quoted text is data, so `-m 'a; b <c@d>'` is fine.
 */
export function shellWords(command: string): string[] | null {
	const words: string[] = [];
	let cur = "";
	let inWord = false;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote === "'") {
			if (c === "'") quote = null;
			else cur += c;
			continue;
		}
		if (c === "$" || c === "`") return null;
		if (quote === '"') {
			if (c === '"') quote = null;
			else if (c === "\\" && '"\\'.includes(command[i + 1] ?? "")) {
				cur += command[++i];
			} else cur += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (c === "\\") {
			const n = command[i + 1];
			if (n === undefined || n === "\n" || n === "\r") return null;
			cur += n;
			i++;
			inWord = true;
		} else if (/[;&|<>(){}\n\r]/.test(c)) {
			return null;
		} else if (c === " " || c === "\t") {
			if (inWord) words.push(cur);
			cur = "";
			inWord = false;
		} else {
			cur += c;
			inWord = true;
		}
	}
	if (quote !== null) return null;
	if (inWord) words.push(cur);
	return words;
}

function isDangerousOption(word: string): boolean {
	if (!word.startsWith("--")) return false;
	const name = word.slice(2).split("=")[0];
	if (name === "") return false; // a bare `--`
	return DANGEROUS_OPTS.some((o) => o.startsWith(name) || name.startsWith(o));
}

/**
 * Plain git on the allowlist (see the file header), judged on the command's
 * words after quote removal, so `'--output=f'` and `"--no-index"` are caught.
 */
export function isAllowedGit(command: string): boolean {
	const words = shellWords(command);
	if (words === null || words[0] !== "git") return false;
	const sub = words[1] === "-C" ? words[3] : words[1];
	if (sub === undefined || !GIT_SUBCOMMANDS.has(sub)) return false;
	return !words.some(isDangerousOption);
}

/** The subagent's own transcript, or null when the input cannot name one. */
export function subagentTranscriptPath(input: HookInput): string | null {
	const p = input.transcript_path;
	const id = input.agent_id;
	if (typeof p !== "string" || !p.endsWith(".jsonl")) return null;
	if (typeof id !== "string" || id === "") return null;
	return join(p.slice(0, -".jsonl".length), "subagents", `agent-${id}.jsonl`);
}

export function decide(
	input: HookInput,
	readCtx: (path: string) => number | null,
	cap: number = DEFAULT_CAP,
): Decision {
	if (input.agent_type !== "implementer") return { allow: true };
	const path = subagentTranscriptPath(input);
	if (path === null) return { allow: true };
	const context = readCtx(path);
	if (context === null || context < cap) return { allow: true };
	if (input.tool_name === "SubagentHandback") return { allow: true };
	if (
		input.tool_name === "Bash" &&
		typeof input.tool_input?.command === "string" &&
		isAllowedGit(input.tool_input.command)
	) {
		return { allow: true };
	}
	return { allow: false, reason: denyReason(context, cap) };
}

type UsageLine = {
	type?: unknown;
	message?: {
		usage?: {
			input_tokens?: unknown;
			cache_creation_input_tokens?: unknown;
			cache_read_input_tokens?: unknown;
		};
	};
};

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

/**
 * Context of the LAST complete assistant line carrying `message.usage`
 * (input + cache creation + cache read), or null when there is none. Reads at
 * most the last TAIL_BYTES; a truncated final line, and the partial first line
 * of a tail read, fail to parse and are skipped. Throws when the file cannot be
 * opened.
 */
export function readContext(path: string): number | null {
	const fd = openSync(path, "r");
	let text: string;
	try {
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - TAIL_BYTES);
		const buf = Buffer.alloc(size - start);
		let off = 0;
		while (off < buf.length) {
			const n = readSync(fd, buf, off, buf.length - off, start + off);
			if (n === 0) break;
			off += n;
		}
		text = buf.subarray(0, off).toString("utf8");
	} finally {
		closeSync(fd);
	}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line === "") continue;
		let parsed: UsageLine;
		try {
			parsed = JSON.parse(line) as UsageLine;
		} catch {
			continue; // truncated (or foreign) line
		}
		const usage = parsed?.type === "assistant" ? parsed.message?.usage : null;
		if (!usage) continue;
		return (
			num(usage.input_tokens) +
			num(usage.cache_creation_input_tokens) +
			num(usage.cache_read_input_tokens)
		);
	}
	return null;
}

function main(): void {
	try {
		const raw = readFileSync(0, "utf8");
		const input = JSON.parse(raw) as HookInput;
		const d = decide(input, (p) => {
			const c = readContext(p);
			if (c === null) {
				process.stderr.write(
					"implementer-context-guard: failing open (no usage line)\n",
				);
			}
			return c;
		});
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
		process.stderr.write(
			`implementer-context-guard: failing open (${String(e)})\n`,
		);
	}
}

if (import.meta.main) main();
