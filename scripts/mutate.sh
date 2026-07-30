#!/usr/bin/env bash
#
# Mutation-testing harness: prove a test can actually FAIL.
#
# Usage:
#   scripts/mutate.sh <file> <perl-expr> <label> [vitest-path...]
#
#   scripts/mutate.sh src/lib/agenda-runsheet.ts \
#     's/desc\(meetings\.scheduledAt\)/asc(meetings.scheduledAt)/' \
#     'M1 flip speech-log order' \
#     src/lib/agenda-parity.test.ts
#
# Runs the suite once clean, applies the mutation, re-runs, reports KILLED or
# SURVIVED, and always restores the file.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS, rather than three lines of perl and `git checkout` inline.
#
# Every guard below is a mistake that actually shipped a false result in this
# repo, more than once each:
#
#   1. `git checkout <file>` to revert a mutation DESTROYS uncommitted work in
#      that file. Hit three times in one session, twice wiping a fix that had
#      just been written and once silently reverting a template edit, which made
#      an unrelated test failure look like a real defect. This restores from a
#      copy taken before the mutation, so it can only ever undo the mutation.
#
#   2. A mutation that does not APPLY reads exactly like a passing suite. A
#      backtick inside a double-quoted shell string got interpolated, the perl
#      never matched, and two survivors were reported as kills. The file must
#      change or this aborts.
#
#   3. This shell is zsh, which does NOT word-split unquoted variables, so
#      `bunx vitest run $FILES` with FILES="a b" becomes one bogus filter and
#      vitest reports "No test files found" — which greps as zero failures, i.e.
#      a clean pass. Hence bash, an array, and an explicit baseline assertion.
#
#   4. A dirty tree makes every result ambiguous: you cannot tell your mutation
#      from work in progress. Commit first — then a restore is always safe.
# ---------------------------------------------------------------------------
set -euo pipefail

die() { printf '\033[31mmutate: %s\033[0m\n' "$*" >&2; exit 1; }

[ $# -ge 3 ] || die "usage: mutate.sh <file> <perl-expr> <label> [vitest-path...]"

FILE="$1"; EXPR="$2"; LABEL="$3"; shift 3
TARGETS=("$@")

[ -f "$FILE" ] || die "no such file: $FILE"
command -v perl >/dev/null || die "perl not found"

cd "$(git rev-parse --show-toplevel)" || die "not in a git repo"

# Guard 4 — a dirty tree makes the result unattributable.
if [ -n "$(git status --porcelain -- "$FILE")" ]; then
	die "$FILE has uncommitted changes. Commit first, then mutate — otherwise a
     restore cannot tell your mutation from your work in progress."
fi

: "${TEST_DATABASE_URL:=postgresql://dev:dev@localhost:5432/tm_test}"
export TEST_DATABASE_URL   # or ~630 integration tests silently skip and read green

run_suite() {
	if [ ${#TARGETS[@]} -eq 0 ]; then
		bun run test 2>&1
	else
		bunx vitest run "${TARGETS[@]}" 2>&1
	fi
}

# "Tests  N failed | M passed (T)" → the failed count, empty when all passed.
#
# The `|| true` is load-bearing: grep exits 1 on no-match, and under
# `set -e -o pipefail` that killed the script inside the command substitution
# BEFORE the guard below could explain why. A silent `exit 1` is the same
# unhelpful shape as the false all-clears this script exists to prevent.
failed_count() {
	printf '%s' "$1" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' | head -1 || true
}
total_count() {
	printf '%s' "$1" | grep -oE 'Tests +[0-9]+' | grep -oE '[0-9]+' | head -1 || true
}

BASE_OUT="$(run_suite || true)"
BASE_TOTAL="$(total_count "$BASE_OUT")"
# Guard 3 — no tests collected reads as zero failures, i.e. a false all-clear.
[ -n "$BASE_TOTAL" ] && [ "$BASE_TOTAL" -gt 0 ] 2>/dev/null \
	|| die "baseline collected NO tests — check the paths. Output:
$(printf '%s' "$BASE_OUT" | tail -5)"
[ -z "$(failed_count "$BASE_OUT")" ] \
	|| die "baseline is already RED; fix that before mutating."
printf 'baseline: %s tests pass\n' "$BASE_TOTAL"

# Guard 1 — restore from a copy, never `git checkout`.
BACKUP="$(mktemp)"
cp "$FILE" "$BACKUP"
restore() { cp "$BACKUP" "$FILE"; rm -f "$BACKUP"; }
trap restore EXIT INT TERM

BEFORE="$(md5sum < "$FILE")"
perl -0pi -e "$EXPR" "$FILE"
# Guard 2 — an unapplied mutation is indistinguishable from a surviving one.
[ "$(md5sum < "$FILE")" != "$BEFORE" ] \
	|| die "mutation did not change $FILE — the expression matched nothing.
     A no-op mutation reports SURVIVED and looks like a coverage gap."

MUT_OUT="$(run_suite || true)"
FAILED="$(failed_count "$MUT_OUT")"

if [ -n "$FAILED" ]; then
	printf '\033[32m  %-46s KILLED (%s failed)\033[0m\n' "$LABEL" "$FAILED"
else
	printf '\033[33m  %-46s SURVIVED — no test covers this\033[0m\n' "$LABEL"
fi
# `restore` runs on EXIT.
