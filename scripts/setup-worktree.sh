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
#
# Every step is a no-op when already done, so re-running is safe and cheap.
#
#   bun run worktree:setup
#   bun run worktree:setup "what you are building"   # the description is informational
#
# It also gives the worktree its own test database (step 4); undo all of this
# with `bun run worktree:teardown` (scripts/teardown-worktree.sh).
#
set -euo pipefail

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

# 1. Dependencies. Bun is fast and a frozen install is idempotent, so run it
#    unconditionally rather than guessing from node_modules/ being present but
#    half-populated.
#
#    --frozen-lockfile, like CI and the Dockerfile: a plain `bun install` lets
#    the local Bun rewrite bun.lock to its own format. Bun >= 1.3 adds a
#    `"configVersion": 0` line that an older Bun strips again (#846 did), so
#    every worktree started with a dirty tracked file. No silent fallback to a
#    writing install: a network blip would fail the frozen one too, and the
#    retry would bring the dirty lockfile back under a wrong explanation.
echo "→ bun install --frozen-lockfile"
if ! bun install --frozen-lockfile; then
	echo "  ! frozen install failed: bun.lock is behind package.json, or the registry is unreachable." >&2
	echo "    If this branch changed dependencies on purpose, run 'bun install' and commit bun.lock." >&2
	exit 1
fi

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

# 4. Test database (#980). Every worktree used to run its database-backed
#    suites against the one shared tm_test, so a wave of agents running full
#    suites at once failed in each other's files. Give this worktree its own:
#    created in the same server as DATABASE_URL, schema synced with
#    `db:push --force`, URL recorded in .env.test.local (gitignored by *.local),
#    which src/test/setup-env.ts reads when TEST_DATABASE_URL is not exported.
#    Re-running keeps the database and re-syncs the schema.
#    `bun run worktree:teardown` drops it and removes the worktree.
#
#    Guarded: a missing or stopped Postgres must not block the rest of the
#    bootstrap. Nothing is recorded then, so the DB-backed suites skip exactly
#    as they did before, and the warning says so.
echo "→ worktree test database"
if ! bun "$HERE/scripts/worktree-test-db.ts" ensure; then
	echo "  ! WARNING: no worktree test database. Database-backed suites will SKIP"
	echo "    unless TEST_DATABASE_URL is exported. Is the dev-postgres container up?"
fi

echo
echo "Done. Verify with: git status --porcelain   (expect no output)"
