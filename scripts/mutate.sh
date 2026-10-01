#!/usr/bin/env bash
#
# Mutation-testing harness: prove a test can actually FAIL.
#
# Usage:
#   bun run mutate <file> --literal <old> <new> <label> <vitest-path...>
#   bun run mutate <file> <perl-expr> <label> <vitest-path...>
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
# To DELETE <old> (an empty <new>), call the script directly where you can:
#
#   bash scripts/mutate.sh <file> --literal '<old>' '' '<label>' <vitest-path...>
#
# Some Bun versions (1.3.x, measured on 1.3.14) silently drop an empty-string
# argument under `bun run`, so the '' vanishes and every later argument shifts
# left; 1.4.2 keeps it. Guard 6 refuses the shifted shape; a non-empty
# replacement (a comment, `undefined`) avoids the question entirely.
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
#   5. Paths are made absolute before the script moves to the repo root, so
#      `scripts/mutate.sh` run from a subdirectory does not mutate or test the
#      wrong file. `bun run mutate` cannot get this: Bun starts the script in
#      the package root and passes no INIT_CWD, so the caller's directory is
#      gone before this line runs. Through Bun, paths are repo-root-relative,
#      and a miss says so rather than just "no such file".
#
#   6. At least one vitest path is REQUIRED. `bun run` on Bun 1.3.x dropped an
#      empty <new>, so a deletion arrived shifted: the label was spliced into the source as the
#      replacement, the test path became the label, no paths remained, and the
#      fallback ran the WHOLE suite against the mutated file — ten minutes of
#      hang on #972 with a label string sitting in the source the whole time.
#      A whole-suite baseline is never what a mutation check means, so there is
#      no fallback: no paths is an error (checked again inside run_suite, so a
#      regression here cannot start a recursive whole-suite run), and so is a
#      label that is an existing *.test.ts(x) file, which is the same shift with
#      two or more test paths given.
#
#   7. The test database follows src/test/setup-env.ts: an exported
#      TEST_DATABASE_URL, else the worktree's own database from
#      .env.test.local, else the shared tm_test. This used to default straight
#      to tm_test, which overrode the worktree's database (#1001): on #765 the
#      suite passed 106/106 under vitest and every mutation run aborted with
#      "baseline is already RED", because tm_test lacked the branch's new
#      column. The database name is now printed with the baseline and with
#      that error, and an unreadable .env.test.local is refused rather than
#      quietly falling back.
# ---------------------------------------------------------------------------
set -euo pipefail

die() { printf '\033[31mmutate: %s\033[0m\n' "$*" >&2; exit 1; }

USAGE="usage: mutate.sh <file> --literal <old> <new> <label> <vitest-path...>
       mutate.sh <file> <perl-expr> <label> <vitest-path...>"
[ $# -ge 3 ] || die "$USAGE"

FILE="$1"; shift
if [ "$1" = "--literal" ]; then
	[ $# -ge 4 ] || die "$USAGE"
	MODE=literal; OLD="$2"; NEW="$3"; LABEL="$4"; shift 4
else
	MODE=perl; EXPR="$1"; LABEL="$2"; shift 2
fi

VIA_BUN=""
[ -n "${npm_lifecycle_event:-}" ] && VIA_BUN="
     (under \`bun run\` paths are relative to the repo root, whatever directory
     you ran it from; run scripts/mutate.sh directly to use relative paths)"

# Guard 6 — refuse the shape an empty <new> leaves behind when `bun run`
# drops it, before anything touches the file. Only blame Bun under Bun.
SHIFTED=""
[ -n "${npm_lifecycle_event:-}" ] && SHIFTED="
     If <new> was meant to be empty, some Bun versions (1.3.x) drop a ''
     under \`bun run\` and shift every later argument left. Call the script
     directly instead:
       bash scripts/mutate.sh <file> --literal '<old>' '' '<label>' <vitest-path...>
     or give <new> a non-empty replacement."
[ $# -ge 1 ] || die "no vitest path given; a mutation check runs named tests, never the whole suite.$SHIFTED
$USAGE"
case "$LABEL" in
*.test.ts | *.test.tsx)
	[ ! -e "$LABEL" ] || die "the label '$LABEL' is an existing test file, so the arguments look shifted.
     Arguments are <file> --literal <old> <new> <label> <vitest-path...>.$SHIFTED" ;;
esac

[ -f "$FILE" ] || die "no such file: $FILE$VIA_BUN"
command -v perl >/dev/null || die "perl not found"

# Guard 5 — absolute paths, so the cd below cannot retarget them.
abspath() { printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"; }
FILE="$(abspath "$FILE")"
TARGETS=()
for t in "$@"; do
	[ -e "$t" ] || die "no such test path: $t$VIA_BUN"
	TARGETS+=("$(abspath "$t")")
done

cd "$(git rev-parse --show-toplevel)" || die "not in a git repo"

# Guard 7 — the test database. Precedence matches src/test/setup-env.ts:
# an exported TEST_DATABASE_URL wins, then the worktree's own database in
# .env.test.local (written by `bun run worktree:setup`, #980), and only then
# the shared tm_test. Defaulting straight to tm_test (#1001) moved every
# worktree's mutation run onto the shared database: on a branch with a schema
# change the baseline read RED for no visible reason, and without one the
# run silently collided with parallel worktrees again.
TEST_DB_FILE=".env.test.local"
TEST_DB_MARKER='# Written by `bun run worktree:setup` (#980). Dropped by `bun run worktree:teardown`.'
if [ -z "${TEST_DATABASE_URL+set}" ] && [ -f "$TEST_DB_FILE" ]; then
	# Same acceptance as parseTestDbFile: the marker on line 1, a URL line, and
	# a database name setup could have created. Anything else is refused rather
	# than falling back to tm_test, which is the silent shape this guards.
	WT_URL=""
	if [ "$(head -n 1 "$TEST_DB_FILE")" = "$TEST_DB_MARKER" ]; then
		WT_URL="$(grep -m 1 '^TEST_DATABASE_URL=' "$TEST_DB_FILE" | cut -d= -f2- | tr -d '[:space:]' || true)"
	fi
	WT_NAME="${WT_URL##*/}"
	WT_NAME="${WT_NAME%%\?*}"
	printf '%s' "$WT_NAME" | grep -qE '^tm_test_wt_[a-z0-9_]+$' \
		|| die "$TEST_DB_FILE exists but names no worktree test database; re-run \`bun run worktree:setup\`."
	TEST_DATABASE_URL="$WT_URL"
fi
: "${TEST_DATABASE_URL:=postgresql://dev:dev@localhost:5432/tm_test}"
export TEST_DATABASE_URL   # or ~630 integration tests silently skip and read green
TEST_DB_NAME="${TEST_DATABASE_URL##*/}"
TEST_DB_NAME="${TEST_DB_NAME%%\?*}"
# The summary parse below greps plain text; an ANSI code between "Tests" and
# the count would read as "collected NO tests". Vitest 4 does not colour that
# line today, even under CI=true or FORCE_COLOR=1, but nothing promises it.
export NO_COLOR=1
unset FORCE_COLOR

run_suite() {
	# Guard 6 again — never fall through to a whole-suite run.
	[ ${#TARGETS[@]} -gt 0 ] || die "internal: run_suite called with no vitest path"
	bunx vitest run "${TARGETS[@]}" 2>&1
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
	|| die "baseline is already RED against test database $TEST_DB_NAME; fix that before mutating."
printf 'baseline: %s tests pass (test database %s)\n' "$BASE_TOTAL" "$TEST_DB_NAME"

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
