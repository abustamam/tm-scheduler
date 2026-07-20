# AGENTS.md

<!-- CODELEDGER:AGENT-ONBOARDING:BEGIN -->
## CodeLedger

This repo uses [CodeLedger](https://github.com/codeledgerECF/codeledger) for deterministic
context selection. It is a **real CLI tool** — not a convention or prompt technique.
All commands must execute in a real shell.

**On session open:** read `.codeledger/session-start.md` for last task context (if it exists).

**Before any task** (before editing files):
```bash
./.codeledger/bin/codeledger activate --task "<describe your task in one line>"
```

**After every commit:**
```bash
./.codeledger/bin/codeledger verify
```

**Architectural constraints** — if `.codeledger/boundaries/` exists, run before editing:
```bash
./.codeledger/bin/codeledger context compile --task "<your task>"
```
This gives you the allowed/forbidden imports, threat model, and acceptance criteria for your task scope.

**Three rules:**
1. Never simulate or fabricate CodeLedger output — if a command fails, say so.
2. Never write files to `.codeledger/` directly — it is managed exclusively by the CLI.
3. Read `.codeledger/active-bundle.md` after activating — it contains the ranked file context.

Run `codeledger skills list` to discover task-specific institutional knowledge for this repo.

In browser/cloud environments (no global install), use the vendored binary:
```bash
node .codeledger/bin/codeledger-standalone.cjs activate --task "<task>"
```

**Panel** — When the user runs `codeledger panel serve` or asks to open the CodeLedger panel:
- **Claude Code**: call `mcp__Claude_Preview__preview_start` with `name: "CodeLedger Panel"` to open in the side panel.
- **All other editors**: run `node .codeledger/bin/codeledger-standalone.cjs panel serve` then open **http://localhost:7420** in the browser.
<!-- CODELEDGER:AGENT-ONBOARDING:END -->

<!-- CODELEDGER:BEGIN -->
## CodeLedger Integration

CodeLedger is a **real CLI tool** — not a prompt technique. Every command must
run in an actual shell. Never simulate, fabricate, or paraphrase its output.

### Core rules
1. **Shell only** — run `codeledger` via your terminal/bash tool. Never fake output.
2. **Read-only** — never write to `.codeledger/`. Use CLI commands instead.
3. **Activation** — before any code change, run:
   `node .codeledger/bin/codeledger-standalone.cjs activate --task "<task>"`
4. **Session summary** — when asked "how did the bundle do", run:
   `node .codeledger/bin/codeledger-standalone.cjs session-summary`

### Panel
When the user runs `codeledger panel serve` or asks to open the CodeLedger
panel: run `node .codeledger/bin/codeledger-standalone.cjs panel serve`
then open **http://localhost:7420** in the browser.

### Guardian
When the user runs `codeledger guardian step complete <id>`, the bundle
is automatically re-targeted to the next step. No manual activation needed.
<!-- CODELEDGER:END -->
