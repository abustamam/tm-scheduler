import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	decide,
	denyReason,
	type HookInput,
	isAllowedGit,
	readContext,
	subagentTranscriptPath,
	TAIL_BYTES,
} from "./implementer-context-guard";

const SCRIPT = resolve(__dirname, "implementer-context-guard.ts");
const tmp = mkdtempSync(join(tmpdir(), "icg test "));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const usageLine = (ctx: number) =>
	JSON.stringify({
		type: "assistant",
		message: {
			usage: {
				input_tokens: 10,
				cache_creation_input_tokens: ctx - 10 - 1000,
				cache_read_input_tokens: 1000,
				output_tokens: 5,
			},
		},
	});

const write = (name: string, content: string): string => {
	const p = join(tmp, name);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, content);
	return p;
};

const implementer = (
	tool_name: string,
	command?: string,
	extra: HookInput = {},
): HookInput => ({
	tool_name,
	tool_input: command === undefined ? {} : { command },
	transcript_path: "/x/session.jsonl",
	agent_id: "abc",
	agent_type: "implementer",
	...extra,
});
const at = (n: number) => () => n;

describe("decide: who is capped", () => {
	it("allows a main-thread call (no agent_type)", () => {
		const i = implementer("Read");
		delete i.agent_type;
		expect(decide(i, at(999_999))).toEqual({ allow: true });
	});
	it("allows another agent type", () => {
		expect(
			decide(implementer("Read", undefined, { agent_type: "explorer" }), at(999_999)),
		).toEqual({ allow: true });
	});
	it.each([
		["absent", undefined],
		["empty", ""],
	])("allows an implementer whose agent_id is %s", (_n, id) => {
		expect(
			decide(implementer("Read", undefined, { agent_id: id }), at(999_999)),
		).toEqual({ allow: true });
	});
	it("allows when the transcript path cannot be derived", () => {
		expect(
			decide(
				implementer("Read", undefined, { transcript_path: undefined }),
				at(999_999),
			),
		).toEqual({ allow: true });
	});
	it("reads the subagent's transcript, not the parent's", () => {
		let seen = "";
		decide(implementer("Read"), (p) => {
			seen = p;
			return 0;
		});
		expect(seen).toBe(join("/x/session", "subagents", "agent-abc.jsonl"));
	});
	it("allows when readCtx finds no usage (null)", () => {
		expect(decide(implementer("Read"), () => null)).toEqual({ allow: true });
	});
});

describe("decide: the cap", () => {
	it("allows an implementer at 249,999", () => {
		expect(decide(implementer("Read"), at(249_999))).toEqual({ allow: true });
	});
	it.each([
		["Read", implementer("Read")],
		["Edit", implementer("Edit")],
		["Bash: bun run test", implementer("Bash", "bun run test")],
	])("denies %s at 250,000", (_n, input) => {
		const d = decide(input, at(250_000));
		expect(d).toEqual({ allow: false, reason: denyReason(250_000, 250_000) });
	});
	it("honours an explicit cap", () => {
		expect(decide(implementer("Read"), at(20_000), 20_000).allow).toBe(false);
		expect(decide(implementer("Read"), at(19_999), 20_000).allow).toBe(true);
	});
	it("names SubagentHandback and the handoff in the deny reason", () => {
		const r = denyReason(267_400, 250_000);
		expect(r).toContain("SubagentHandback");
		expect(r).toContain("267k >= 250k");
		expect(r).toContain("Branch, Done");
	});
	it("allows SubagentHandback over the cap", () => {
		expect(decide(implementer("SubagentHandback"), at(300_000))).toEqual({
			allow: true,
		});
	});
	it("denies a Bash call with no string command", () => {
		const i = implementer("Bash");
		expect(decide(i, at(300_000)).allow).toBe(false);
	});
});

describe("git allowlist over the cap", () => {
	it.each([
		'git commit -m "x"',
		"git push origin HEAD",
		"git status",
		"git -C some/dir status",
		"git add -A",
		"git diff --stat",
		"git log --oneline -5",
		"  git status",
	])("allows %s", (c) => {
		expect(decide(implementer("Bash", c), at(260_000))).toEqual({ allow: true });
	});
	it.each([
		"git commit -m x && rm -rf y",
		"git push; ls",
		"git log | head",
		'git commit -m "$(cat f)"',
		"git commit -m `cat f`",
		"git status\nrm -rf y",
		"git log > out.txt",
		"git log < in.txt",
		"git diff --no-index <(echo a) b",
		"git diff --no-index a b",
		"git diff =(echo a) b",
		"git push --receive-pack=x",
		"git push --upload-pack x",
		"git diff --output=f",
		"git log --exec=x",
		"git -C dir -c core.pager=x log",
		"git checkout main",
		"gitk",
		"bun run test",
		"echo git status",
	])("denies %s", (c) => {
		expect(decide(implementer("Bash", c), at(260_000)).allow).toBe(false);
	});
	it("isAllowedGit agrees with decide", () => {
		expect(isAllowedGit("git status")).toBe(true);
		expect(isAllowedGit("git status; ls")).toBe(false);
	});
});

describe("subagentTranscriptPath", () => {
	it("is null for a path that is not a .jsonl", () => {
		expect(
			subagentTranscriptPath({ transcript_path: "/x/s", agent_id: "a" }),
		).toBeNull();
	});
});

describe("readContext", () => {
	it("returns the LAST usage line's context (100k then 260k -> 260k)", () => {
		const p = write("last.jsonl", `${usageLine(100_000)}\n${usageLine(260_000)}\n`);
		expect(readContext(p)).toBe(260_000);
	});
	it("ignores a truncated final line", () => {
		const p = write(
			"trunc.jsonl",
			`${usageLine(100_000)}\n${usageLine(260_000).slice(0, 40)}`,
		);
		expect(readContext(p)).toBe(100_000);
	});
	it("reads a final line with no trailing newline", () => {
		const p = write("nonl.jsonl", `${usageLine(100_000)}\n${usageLine(260_000)}`);
		expect(readContext(p)).toBe(260_000);
	});
	it("skips non-assistant and usage-less lines after the usage line", () => {
		const p = write(
			"mixed.jsonl",
			[
				usageLine(120_000),
				JSON.stringify({ type: "user", message: { usage: { input_tokens: 9e6 } } }),
				JSON.stringify({ type: "assistant", message: { content: [] } }),
				"",
			].join("\n"),
		);
		expect(readContext(p)).toBe(120_000);
	});
	it("sums the three input counters and treats a missing one as zero", () => {
		const p = write(
			"sum.jsonl",
			`${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 7 } } })}\n`,
		);
		expect(readContext(p)).toBe(12);
	});
	it("returns null for an empty file and for no usage lines", () => {
		expect(readContext(write("empty.jsonl", ""))).toBeNull();
		expect(readContext(write("none.jsonl", '{"type":"user"}\nnot json\n'))).toBeNull();
	});
	it("throws for a missing file", () => {
		expect(() => readContext(join(tmp, "missing.jsonl"))).toThrow();
	});
	it("reads only the tail of a large file and never reaches the head", () => {
		const filler = `${JSON.stringify({ type: "user", text: "x".repeat(1000) })}\n`;
		const body = filler.repeat(Math.ceil((TAIL_BYTES * 2) / filler.length));
		// the old usage line sits before the tail window; the new one is inside it
		const p = write("big.jsonl", `${usageLine(400_000)}\n${body}${usageLine(111_000)}\n`);
		expect(readContext(p)).toBe(111_000);
		// with no usage line in the tail at all, the old one is not found
		const q = write("big2.jsonl", `${usageLine(400_000)}\n${body}`);
		expect(readContext(q)).toBeNull();
	});
});

describe("spawned hook", () => {
	const run = (stdin: string, env: Record<string, string> = {}) =>
		spawnSync("bun", [SCRIPT], {
			input: stdin,
			cwd: tmp,
			encoding: "utf8",
			env: { ...process.env, CONTEXT_CAP_TOKENS: "", ...env },
		});
	const input = (sessionName: string, extra: HookInput = {}) =>
		JSON.stringify(
			implementer("Read", undefined, {
				transcript_path: join(tmp, `${sessionName}.jsonl`),
				...extra,
			}),
		);
	const transcript = (sessionName: string, content: string) =>
		write(join(sessionName, "subagents", "agent-abc.jsonl"), content);

	it("denies with the hookSpecificOutput JSON", () => {
		transcript("deny", `${usageLine(260_000)}\n`);
		const r = run(input("deny"));
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: denyReason(260_000, 250_000),
			},
		});
	});
	it("allows silently below the cap", () => {
		transcript("below", `${usageLine(100_000)}\n`);
		const r = run(input("below"));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("");
	});
	it("CONTEXT_CAP_TOKENS overrides the cap; a bad value falls back to 250k", () => {
		transcript("env", `${usageLine(30_000)}\n`);
		expect(run(input("env"), { CONTEXT_CAP_TOKENS: "20000" }).stdout).not.toBe("");
		expect(run(input("env"), { CONTEXT_CAP_TOKENS: "abc" }).stdout).toBe("");
	});
	it("allows SubagentHandback over the cap", () => {
		transcript("handback", `${usageLine(260_000)}\n`);
		const r = run(input("handback", { tool_name: "SubagentHandback" }));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});
	it.each([
		["a missing file", () => input("nonexistent")],
		["an empty file", () => (transcript("emptyf", ""), input("emptyf"))],
		["no usage lines", () => (transcript("nousage", '{"type":"user"}\n'), input("nousage"))],
		["malformed stdin", () => "{not json"],
		["empty stdin", () => ""],
	])("fails open for %s: exit 0, empty stdout, one stderr line", (_n, make) => {
		const r = run(make());
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr.trim().split("\n")).toHaveLength(1);
		expect(r.stderr).toContain("implementer-context-guard: failing open");
	});
});
