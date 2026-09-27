#!/usr/bin/env bash
#
# Undo `bun run worktree:setup`: drop this worktree's own test database (#980)
# and remove the worktree. Run it from inside the worktree.
#
#   bun run worktree:teardown
#
# Refuses a dirty worktree BEFORE touching anything, on the same terms as
# `git worktree remove` (modified tracked files or untracked files; ignored
# files such as node_modules and .env.local do not count), so uncommitted work
# is never lost and a refused teardown leaves the database in place.
#
# It drops only the database named in .env.test.local, only when setup wrote
# that file, and only a `tm_test_wt_` name (scripts/worktree-test-db.ts), so
# it cannot reach tm_test, tm_scheduler or a hand-made tm_test_496.
#
# The branch is kept: delete it yourself once its PR has merged.
set -euo pipefail

GIT_DIR=$(cd "$(git rev-parse --git-dir)" && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
HERE=$(git rev-parse --show-toplevel)

if [ "$GIT_DIR" = "$GIT_COMMON" ]; then
	echo "Refusing: this is the main checkout, not a linked worktree." >&2
	exit 1
fi

MAIN=$(cd "$GIT_COMMON/.." && pwd -P)
BRANCH=$(git branch --show-current)

DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
	echo "Refusing: $HERE has uncommitted changes. Nothing was dropped or removed." >&2
	echo "$DIRTY" >&2
	exit 1
fi

echo "Tearing down worktree"
echo "  worktree: $HERE"
echo

echo "→ worktree test database"
bun "$HERE/scripts/worktree-test-db.ts" drop

echo "→ git worktree remove"
git -C "$MAIN" worktree remove "$HERE"

echo
echo "Done. Branch '${BRANCH:-<detached>}' is kept; delete it once merged:"
echo "  git -C \"$MAIN\" branch -D ${BRANCH:-<branch>}"
