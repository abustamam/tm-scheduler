#!/usr/bin/env bash
#
# Mutation-testing harness: prove a test can actually FAIL.
#
# Usage:
#   bun run mutate <file> --literal <old> <new> <label> [vitest-path...]
#   bun run mutate <file> <perl-expr> <label> [vitest-path...]
#
#   bun run mutate src/lib/agenda-runsheet.ts \
#     --literal 'desc(meetings.scheduledAt)' 'asc(meetings.scheduledAt)' \
#     'M1 flip speech-log order' \
#     src/lib/agenda-parity.test.ts
#
# Prefer --literal: <old> must occur EXACTLY once in <file> or this aborts, and
# neither string is ever parsed as a regex or as perl. The perl form is for a
# mutation one literal cannot express.
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
#   4. A file with uncommitted edits is ALLOWED. This used to refuse one, on
#      the theory that a restore could not tell the mutation from the work in
#      progress — but guard 1 restores from a copy taken AFTER that work, so it
#      can. The refusal bit exactly when mutation-checking matters most, a
#      review fix round with edits still unstaged, and the improvised
#      `git checkout` people fell back to wiped a fix on #831. The baseline run
#      below already proves the tree, edits and all, is green before mutating.
#
#   5. Paths are made absolute before the script moves to the repo root, so it
#      can be run from a subdirectory without mutating or testing the wrong file.
# ---------------------------------------------------------------------------
set -euo pipefail

die() { printf '\033[31mmutate: %s\033[0m\n' "$*" >&2; exit 1; }

USAGE="usage: mutate.sh <file> --literal <old> <new> <label> [vitest-path...]
       mutate.sh <file> <perl-expr> <label> [vitest-path...]"
[ $# -ge 3 ] || die "$USAGE"

FILE="$1"; shift
if [ "$1" = "--literal" ]; then
	[ $# -ge 4 ] || die "$USAGE"
	MODE=literal; OLD="$2"; NEW="$3"; LABEL="$4"; shift 4
else
	MODE=perl; EXPR="$1"; LABEL="$2"; shift 2
fi

[ -f "$FILE" ] || die "no such file: $FILE"
command -v perl >/dev/null || die "perl not found"

# Guard 5 — absolute paths, so the cd below cannot retarget them.
abspath() { printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"; }
FILE="$(abspath "$FILE")"
TARGETS=()
for t in "$@"; do
	[ -e "$t" ] || die "no such test path: $t"
	TARGETS+=("$(abspath "$t")")
done

cd "$(git rev-parse --show-toplevel)" || die "not in a git repo"

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
if [ "$MODE" = literal ]; then
	# Both strings travel through the environment, so neither is parsed as perl;
	# \Q…\E quotes <old>, and <new> is interpolated once, as plain text.
	OLD="$OLD" NEW="$NEW" perl -0pi -e '
		my ($o, $n) = ($ENV{OLD}, $ENV{NEW});
		my $c = () = /\Q$o\E/g;
		die "mutate: --literal <old> occurs $c times; it must occur exactly once\n"
			unless $c == 1;
		s/\Q$o\E/$n/;
	' "$FILE" || die "mutation not applied"
else
	perl -0pi -e "$EXPR" "$FILE"
fi
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
