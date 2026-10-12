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
	shellWords,
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

const ALLOWED_GIT: string[] = [
	"git log a#b",
	'git commit -m "a \"quoted\" b"',
	'git commit -m "back\\slash"',
	'git commit -m "keep \n literal"',
	"git commit -m 'a'\"b\"c",
	"git commit -m a\\ b",
	'git commit -m "it\'s"',
	"git log 'a\"b'",
	"git commit -m ''",
	"git commit -m 'multi\nline'",
	'git commit -m "x"',
	"git push origin HEAD",
	"git status",
	"git -C some/dir status",
	"git add -A",
	"git diff --stat",
	"git log --oneline -5",
	"  git status",
	`git commit -m 'feat: x' -m 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'`,
	`git commit -m "fix: a; b & c > d"`,
	"git commit -m 'it'\\''s'",
	"git log --oneline -n 5",
	"git diff -- src/a.ts",
	"git log -n 5",
	"git commit --amend --no-edit",
	"git -C -nope commit -m x",
	"git commit -m 'no n flag'",
	"git commit -mn",
	"git commit -am x",
	"git -C dir commit -m x",
];

const DENIED_GIT: string[] = [
	'git log -1 --format=format:changed "--out\\\nput=src/a.ts"',
	"git log -1 --format=x --out\\\nput=src/a.ts",
	"git log --out'put'\\\n=f",
	'git push "--receive-\\\npack=touch pwned" ../bare.git HEAD:x',
	"git push --receive-\\\npack=touch ../b HEAD",
	'git log "--out\\\rput=f"',
	"git log *.ts",
	"git log a?b",
	"git log [a]",
	"git add ~/x",
	"git status #c",
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
	"echo status",
	"git commit -n -m x",
	"git commit -an -m x",
	"git commit -nm x",
	"git commit -m x -n",
	"git -C dir commit -n -m x",
	"gitk status",
	"git log --exec-path",
	"git diff --output-indicator-new=+",
	"git log -1 --format='export const x = 1%x3b' '--output=src/a.ts'",
	"git push '--receive-pack=touch pwned3' ../bare.git HEAD:refs/heads/x",
	'git diff "--no-index" a b',
	"git diff --no-ind a b",
	"git log --outp=f",
	"git push --rec=x",
	"git push --e=x",
	"git log \\--output=f",
	"git log --out'put'=f",
	"git commit --no-verify -m x",
	"git commit --no-v -m x",
	"git commit -m 'unterminated",
	"git commit -m x \\",
	'git commit -m "$HOME"',
	'git commit -m "`id`"',
	'git commit -m "$(id)"',
	"git log {--output=f,}",
	"git log --oneline (ls)",
	"FOO=1 git status",
	"git commit -m x; ls",
	"git commit -m x & ls",
	"git commit -m x > f",
	"git commit -m x < f",
];

describe("decide: who is capped", () => {
	it("allows a main-thread call (no agent_type)", () => {
		const i = implementer("Read");
		delete i.agent_type;
		expect(decide(i, at(999_999))).toEqual({ allow: true });
	});
	it("allows another agent type", () => {
		expect(
			decide(
				implementer("Read", undefined, { agent_type: "explorer" }),
				at(999_999),
			),
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
	it.each(ALLOWED_GIT)("allows %s", (c) => {
		expect(decide(implementer("Bash", c), at(260_000))).toEqual({
			allow: true,
		});
	});
	it.each(DENIED_GIT)("denies %s", (c) => {
		expect(decide(implementer("Bash", c), at(260_000)).allow).toBe(false);
	});
	it("isAllowedGit agrees with decide", () => {
		expect(isAllowedGit("git status")).toBe(true);
		expect(isAllowedGit("git status; ls")).toBe(false);
	});
});

describe("shellWords", () => {
	it("splits like a shell and removes quotes", () => {
		expect(shellWords(`git commit -m 'a b' "c d" e\\ f g"h"`)).toEqual([
			"git",
			"commit",
			"-m",
			"a b",
			"c d",
			"e f",
			"gh",
		]);
	});
	it("keeps an empty quoted word", () => {
		expect(shellWords("git commit -m ''")).toEqual(["git", "commit", "-m", ""]);
	});
	it("treats metacharacters inside single quotes as data", () => {
		expect(shellWords("a '; & | < > $( ` ( ) { }'")).toEqual([
			"a",
			"; & | < > $( ` ( ) { }",
		]);
	});
	it("refuses an unquoted metacharacter", () => {
		for (const c of [
			";",
			"&",
			"|",
			"<",
			">",
			"(",
			")",
			"{",
			"}",
			"\n",
			"`",
			"$",
		]) {
			expect(shellWords(`a ${c} b`)).toBeNull();
		}
	});
});

describe("shellWords agrees with bash", () => {
	const bashOk = spawnSync("bash", ["--version"]).status === 0;
	if (!bashOk) {
		console.warn("bash not found: skipping the shellWords differential test");
	}
	const dir = mkdtempSync(join(tmpdir(), "icg bash "));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	// files for a glob to match, so an accepted glob would disagree with bash
	for (const f of ["x.ts", "a", "ab", "a1", "--output=x"]) {
		writeFileSync(join(dir, f), "");
	}
	/** bash's argv for `command`, via printf, from an empty directory. */
	const bashArgv = (command: string): string[] => {
		const r = spawnSync("bash", ["-c", `printf '%s\\0' ${command}`], {
			cwd: dir,
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", HOME: dir },
		});
		expect(r.status, command).toBe(0);
		const out = r.stdout.split("\0");
		out.pop(); // the text after the last NUL
		return out;
	};
	const agree = (command: string) => {
		const words = shellWords(command);
		if (words === null) return false;
		expect(words, JSON.stringify(command)).toEqual(bashArgv(command));
		return true;
	};

	it.skipIf(!bashOk)("agrees on every accepted corpus command", () => {
		const corpus = [...ALLOWED_GIT, ...DENIED_GIT];
		const accepted = corpus.filter(agree);
		// the corpus must keep exercising the tokenizer, not only its refusals
		expect(accepted.length).toBeGreaterThan(40);
	});

	it.skipIf(!bashOk)("agrees on seeded random strings", () => {
		const alphabet = [
			"a",
			"b",
			" ",
			"\t",
			"'",
			'"',
			"\\",
			"-",
			"=",
			"\n",
			"\r",
			"#",
			"~",
			":",
			"%",
		];
		let seed = 1103;
		const rand = (n: number) => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed % n;
		};
		let accepted = 0;
		for (let k = 0; k < 300; k++) {
			let c = "x ";
			for (let n = rand(10); n >= 0; n--) c += alphabet[rand(alphabet.length)];
			if (agree(c)) accepted++;
		}
		expect(accepted).toBeGreaterThan(25);
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
		const p = write(
			"last.jsonl",
			`${usageLine(100_000)}\n${usageLine(260_000)}\n`,
		);
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
		const p = write(
			"nonl.jsonl",
			`${usageLine(100_000)}\n${usageLine(260_000)}`,
		);
		expect(readContext(p)).toBe(260_000);
	});
	it("skips non-assistant and usage-less lines after the usage line", () => {
		const p = write(
			"mixed.jsonl",
			[
				usageLine(120_000),
				JSON.stringify({
					type: "user",
					message: { usage: { input_tokens: 9e6 } },
				}),
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
		expect(
			readContext(write("none.jsonl", '{"type":"user"}\nnot json\n')),
		).toBeNull();
	});
	it("throws for a missing file", () => {
		expect(() => readContext(join(tmp, "missing.jsonl"))).toThrow();
	});
	it("reads only the tail of a large file and never reaches the head", () => {
		const filler = `${JSON.stringify({ type: "user", text: "x".repeat(1000) })}\n`;
		const body = filler.repeat(Math.ceil((TAIL_BYTES * 2) / filler.length));
		// the old usage line sits before the tail window; the new one is inside it
		const p = write(
			"big.jsonl",
			`${usageLine(400_000)}\n${body}${usageLine(111_000)}\n`,
		);
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
			env: { ...process.env, ...env },
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
	it("allows SubagentHandback over the cap", () => {
		transcript("handback", `${usageLine(260_000)}\n`);
		const r = run(input("handback", { tool_name: "SubagentHandback" }));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});
	it.each([
		["a missing file", () => input("nonexistent")],
		["an empty file", () => (transcript("emptyf", ""), input("emptyf"))],
		[
			"no usage lines",
			() => (transcript("nousage", '{"type":"user"}\n'), input("nousage")),
		],
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
