#!/bin/sh
# Nightly logical backup of the production Postgres. See README.md in this dir.
#
# Runs as a Railway cron service: dumps over the private network, VERIFIES the
# archive, and only then keeps it. Prunes to the newest $BACKUP_KEEP archives.
#
# The verification is the whole point of this script. `pg_dump` exits 0 and
# writes a structurally valid custom-format archive for an EMPTY database, so
# "the cron job ran and exited 0" is not evidence that a usable backup exists —
# it is exactly what a silently-broken backup looks like. A restore is the only
# moment you find out, and that is the worst moment to find out. So we count
# TABLE DATA entries in the archive and refuse to keep anything under a floor.
set -eu

: "${DATABASE_URL:?DATABASE_URL is not set}"

DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP:-14}"
# Absolute floor, NOT derived from the archive we just wrote — a threshold
# computed from the thing it is checking passes for every possible value.
# The schema had 39 TABLE DATA entries as of 2026-08-17; 30 leaves room for
# tables to come and go while still catching a catastrophically empty dump.
MIN_TABLES="${BACKUP_MIN_TABLES:-30}"

mkdir -p "$DIR"

STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
OUT="$DIR/gavelup-$STAMP.dump"
TMP="$OUT.partial"

# Any failure below leaves no ".dump" behind, so a half-written archive can
# never be mistaken for a backup. Cleared once the rename succeeds.
trap 'rm -f "$TMP"' EXIT

echo "[backup] $STAMP starting"

# --file, not a shell redirect, so pg_dump's own exit status is authoritative
# rather than the redirect's.
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-acl --file="$TMP"

tables="$(pg_restore --list "$TMP" | grep -c 'TABLE DATA')" || tables=0
if [ "$tables" -lt "$MIN_TABLES" ]; then
	echo "[backup] FAILED: archive has $tables TABLE DATA entries, floor is $MIN_TABLES" >&2
	echo "[backup] discarding it -- refusing to keep a backup we cannot vouch for" >&2
	exit 1
fi

size="$(wc -c < "$TMP" | tr -d ' ')"
mv "$TMP" "$OUT"
trap - EXIT
echo "[backup] ok: $OUT ($size bytes, $tables tables)"

total="$(find "$DIR" -maxdepth 1 -name 'gavelup-*.dump' | wc -l | tr -d ' ')"
if [ "$total" -gt "$KEEP" ]; then
	ls -1t "$DIR"/gavelup-*.dump | tail -n "+$((KEEP + 1))" | while IFS= read -r old; do
		echo "[backup] pruning $old"
		rm -f "$old"
	done
fi

echo "[backup] done: $(find "$DIR" -maxdepth 1 -name 'gavelup-*.dump' | wc -l | tr -d ' ') archives retained"
