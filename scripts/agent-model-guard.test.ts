import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	DENY_REASON,
	decide,
	parseAgentModel,
	readRepoAgentModel,
} from "./agent-model-guard";

const REPO = resolve(__dirname, "..");
const SCRIPT = join(REPO, "scripts", "agent-model-guard.ts");
const none = () => null;
const sonnet = () => "sonnet";
const dispatch = (tool_input: Record<string, unknown>) => ({
	tool_name: "Agent",
	tool_input,
});

describe("decide", () => {
	it("denies no subagent_type and no model with the exact reason", () => {
		expect(decide(dispatch({}), none)).toEqual({
			allow: false,
			reason: DENY_REASON,
		});
		expect(DENY_REASON).toBe(
			'Agent dispatch would inherit the main session\'s Opus (docs/agents/token-usage.md). Retry with subagent_type "implementer" (Sonnet) or "explorer" (Haiku), or pass model explicitly; use model: "opus" only for judgement work such as review.',
		);
	});
	it.each(["general-purpose", "Plan", "fork"])(
		"denies %s without model, allows with model",
		(t) => {
			expect(decide(dispatch({ subagent_type: t }), none).allow).toBe(false);
			expect(
				decide(dispatch({ subagent_type: t, model: "sonnet" }), none).allow,
			).toBe(true);
		},
	);
	it("treats empty or blank model as absent", () => {
		expect(decide(dispatch({ model: "" }), none).allow).toBe(false);
		expect(decide(dispatch({ model: "   " }), none).allow).toBe(false);
	});
	it("ignores a non-string model", () => {
		expect(decide(dispatch({ model: 5 }), none).allow).toBe(false);
	});
	it("allows a pinned agent without model", () => {
		expect(decide(dispatch({ subagent_type: "implementer" }), sonnet).allow).toBe(
			true,
		);
	});
	it("denies a pinned agent when the model is inherit (any case)", () => {
		for (const v of ["inherit", "Inherit", "INHERIT"]) {
			expect(decide(dispatch({ subagent_type: "x" }), () => v).allow).toBe(
				false,
			);
		}
	});
	it("denies when the agent file has no model (null) or an empty one", () => {
		expect(decide(dispatch({ subagent_type: "x" }), none).allow).toBe(false);
		expect(decide(dispatch({ subagent_type: "x" }), () => "").allow).toBe(false);
	});
	it("treats a subagent_type with a path as unpinned without reading", () => {
		let called = false;
		const read = () => {
			called = true;
			return "sonnet";
		};
		for (const t of ["../x", "a/b", "..", "a b", ""]) {
			expect(decide(dispatch({ subagent_type: t }), read).allow).toBe(false);
		}
		expect(called).toBe(false);
	});
});

describe("parseAgentModel and readRepoAgentModel", () => {
	it("reads the real agent files", () => {
		expect(readRepoAgentModel(REPO, "implementer")).toBe("sonnet");
		expect(readRepoAgentModel(REPO, "explorer")).toBe("haiku");
	});
	it("returns null for a missing file", () => {
		expect(readRepoAgentModel(REPO, "no-such-agent")).toBeNull();
	});
	it.each([
		["inherit comment", "---\nmodel: inherit # c\n---\n", "inherit"],
		["double quoted", '---\nmodel: "opus"\n---\n', "opus"],
		["single quoted", "---\nmodel: 'opus'\n---\n", "opus"],
		["empty quotes", '---\nmodel: ""\n---\n', null],
		["blank quotes", '---\nmodel: "   "\n---\n', null],
		["empty value", "---\nmodel:\n---\n", null],
		["no key", "---\nname: x\n---\n", null],
		["no frontmatter", "model: sonnet\n", null],
		["only below frontmatter", "---\nname: x\n---\nmodel: sonnet\n", null],
		["no closing line", "---\nmodel: sonnet\n", null],
		["first line not exactly ---", " ---\nmodel: sonnet\n---\n", null],
		["first model wins", "---\nmodel: a\nmodel: b\n---\n", "a"],
	])("%s", (_n, content, want) => {
		expect(parseAgentModel(content)).toBe(want);
	});
});

describe("spawned hook", () => {
	const tmp = mkdtempSync(join(tmpdir(), "amg test "));
	afterAll(() => rmSync(tmp, { recursive: true, force: true }));
	const run = (stdin: string, env: Record<string, string> = {}, cwd = tmp) =>
		spawnSync("bun", [SCRIPT], {
			input: stdin,
			cwd,
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...env },
		});

	it("denies with the hookSpecificOutput JSON", () => {
		const r = run(JSON.stringify(dispatch({ subagent_type: "general-purpose" })), {
			CLAUDE_PROJECT_DIR: REPO,
		});
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: DENY_REASON,
			},
		});
	});
	it("allows a pinned agent silently", () => {
		const r = run(JSON.stringify(dispatch({ subagent_type: "explorer" })), {
			CLAUDE_PROJECT_DIR: REPO,
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});
	it("fails open on empty stdin", () => {
		const r = run("");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});
	it("fails open on invalid JSON", () => {
		const r = run("{nope");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("agent-model-guard");
	});
	it("works from another cwd with a space in CLAUDE_PROJECT_DIR", () => {
		const proj = join(tmp, "proj with space");
		mkdirSync(join(proj, ".claude"), { recursive: true });
		cpSync(join(REPO, ".claude", "agents"), join(proj, ".claude", "agents"), {
			recursive: true,
		});
		writeFileSync(join(proj, ".claude", "agents", "inh.md"), "---\nmodel: inherit\n---\n");
		const env = { CLAUDE_PROJECT_DIR: proj };
		const ok = run(JSON.stringify(dispatch({ subagent_type: "implementer" })), env, "/");
		expect(ok.status).toBe(0);
		expect(ok.stdout).toBe("");
		const no = run(JSON.stringify(dispatch({ subagent_type: "inh" })), env, "/");
		expect(no.stdout).toContain('"permissionDecision":"deny"');
	});
});
