#!/usr/bin/env bash
#
# Bootstrap a fresh git worktree so it can actually run.
#
# This repo mandates a dedicated worktree for every change (see "Git worktree
# isolation" in CLAUDE.md), but a worktree shares git history and nothing else.
# Everything a working checkout needs that git does not track is absent:
#
#   node_modules   deps are per-directory
#   .env.local     gitignored; without it db:*, dev and the seed all fail
#   ref/           gitignored reference CSVs/PDFs the import scripts read
#   CodeLedger     session state is per-directory, and .codeledger/ runtime
#                  files are gitignored, so a fresh worktree has the binary
#                  but no index or ledger
#
# That last one is the quiet failure. CodeLedger does not error in an
# uninitialised worktree — it just returns empty bundles and reports 0% recall,
# so the tool looks worthless when it was simply never initialised. Four
# releases shipped from worktrees on 2026-07-31 with it contributing nothing
# for exactly this reason.
#
# Every step is a no-op when already done, so re-running is safe and cheap.
#
#   bun run worktree:setup
#   bun run worktree:setup "what you are building"   # also activates a bundle
#
set -euo pipefail

TASK="${1:-}"

GIT_DIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
HERE=$(git rev-parse --show-toplevel)

if [ "$GIT_DIR" = "$GIT_COMMON" ]; then
	echo "Not a linked worktree — this is the main checkout, which needs no bootstrap."
	echo "Run this from inside a worktree created with 'git worktree add'."
	exit 0
fi

MAIN=$(cd "$GIT_COMMON/.." && pwd -P)
echo "Bootstrapping worktree"
echo "  worktree: $HERE"
echo "  main:     $MAIN"
echo

# 1. Dependencies. Bun is fast and install is idempotent, so run unconditionally
#    rather than guessing from node_modules/ being present but half-populated.
echo "→ bun install"
bun install

# 2. Env. Never clobber an existing file — a worktree may be deliberately
#    pointed at a different database than the main checkout.
if [ -f "$HERE/.env.local" ]; then
	echo "→ .env.local already present, leaving it alone"
elif [ -f "$MAIN/.env.local" ]; then
	cp "$MAIN/.env.local" "$HERE/.env.local"
	echo "→ .env.local copied from the main checkout"
else
	echo "→ WARNING: no .env.local in the main checkout either."
	echo "  db:migrate, db:seed and dev will fail until one exists."
	echo "  Required: DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL."
fi

# 3. Reference data. Symlink rather than copy: it holds multi-MB PDFs and the
#    membership CSV, it is read-only input to the import scripts, and a copy
#    per worktree would drift from whatever the main checkout has.
if [ -e "$HERE/ref" ]; then
	echo "→ ref/ already present, leaving it alone"
elif [ -d "$MAIN/ref" ]; then
	ln -s "$MAIN/ref" "$HERE/ref"
	echo "→ ref/ symlinked to the main checkout"
else
	echo "→ ref/ absent from the main checkout, skipping (only import scripts need it)"
fi

# 4. CodeLedger. Guarded end to end: this is an optional productivity tool and a
#    broken or missing install must never block a worktree from being usable.
#
#    `init` is NOT tree-clean. It appends a fixed
#    `<!-- CODELEDGER:AGENT-ONBOARDING:BEGIN -->` block to two TRACKED,
#    hand-curated agent-rule files. That block used to be committed, which is why
#    the comment here previously claimed init left the tree clean — 6197f4b
#    removed it deliberately: it duplicates the guidance those files already
#    carry, and contradicts it on which binary to invoke (the block says the
#    self-upgrading wrapper, the curated rules say the pinned standalone, and
#    only the standalone is reproducible). `init` has no --no-onboarding flag, so
#    the block is discarded here instead.
#
#    Scoped to exactly those two paths so nothing else init writes is lost. If a
#    future release makes init edit them for a real reason, this will silently
#    drop it — acceptable while the only edit is that one fixed block.
CL="$HERE/.codeledger/bin/codeledger"
ONBOARDING_FILES=(.cursor/rules/codeledger.mdc .kiro/steering/codeledger.md)
if [ ! -x "$CL" ]; then
	echo "→ CodeLedger wrapper not found, skipping"
elif ! "$CL" init >/dev/null 2>&1; then
	echo "→ WARNING: 'codeledger init' failed. Continuing — the worktree is still usable."
	echo "  Bundles from here will be empty until it is initialised."
else
	echo "→ codeledger init"
	for f in "${ONBOARDING_FILES[@]}"; do
		[ -e "$f" ] && git checkout -- "$f" 2>/dev/null || true
	done
	if [ -n "$TASK" ]; then
		if "$CL" activate --task "$TASK" >/dev/null 2>&1; then
			echo "→ codeledger activate --task \"$TASK\""
		else
			echo "→ WARNING: 'codeledger activate' failed; bundle not built."
		fi
	else
		echo "  No task given. For a task-scoped bundle, re-run with one:"
		echo "    bun run worktree:setup \"what you are building\""
	fi
fi

echo
echo "Done. Verify with: git status --porcelain   (expect no output)"
