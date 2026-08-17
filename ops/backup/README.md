# Nightly Postgres backup (cron service)

Railway's managed volume backups / PITR are **Pro-plan only** ($20/mo vs Hobby's $5). This is the
Hobby-plan substitute: a cron service that takes a logical `pg_dump` of the production database over
the private network, verifies it, and keeps the newest 14.

A dump is also the more *portable* artifact. A Railway volume backup restores only to a Railway
volume; a `pg_dump` restores anywhere — locally, into `tm_test`, or onto another provider. That
portability is what made the 2026-08-17 Neon → Railway migration possible at all.

## Files

| File | Purpose |
| --- | --- |
| `backup.sh` | dump → verify → keep → prune |
| `Dockerfile` | `postgres:18-alpine` for the PG 18 client, entrypoint cleared |
| `railway.json` | `DOCKERFILE` builder, `restartPolicyType: NEVER`, `cronSchedule` |

## Wiring on Railway

One service in the `tm-scheduler` project, alongside `gavelup` and `Postgres`:

- **Root directory**: `ops/backup` — this is what makes Railway read *this* `railway.json` instead
  of the repo-root one, which sets `healthcheckPath: /api/health`. A cron job serves no HTTP and
  exits immediately, so inheriting that healthcheck would fail every run.
- **Volume**: mounted at `/backups`.
- **Variable**: `DATABASE_URL` = `${{ Postgres.DATABASE_URL }}` — a reference, so it resolves to
  the private network host and survives a Postgres credential rotation.
- **Cron**: `17 9 * * *` (daily, 09:17 UTC ≈ 02:17 Pacific). Off the `:00` mark deliberately.
  Railway's minimum interval is 5 minutes and firing time can drift by several minutes.

`restartPolicyType: NEVER` matters: a cron task exits 0 on success, and `ON_FAILURE`/`ALWAYS` would
fight that.

### Tuning

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKUP_DIR` | `/backups` | where archives land (the volume mount) |
| `BACKUP_KEEP` | `14` | archives retained; older ones pruned |
| `BACKUP_MIN_TABLES` | `30` | verification floor, see below |

## Why it verifies, and why the floor is an absolute number

`pg_dump` exits 0 and writes a structurally valid custom-format archive for an **empty** database.
So "the cron job ran and exited 0" is indistinguishable from "we have been writing useless files for
six weeks" — and you find out during a restore, which is the worst possible moment. `backup.sh`
therefore counts `TABLE DATA` entries via `pg_restore --list` and refuses to keep an archive below
`BACKUP_MIN_TABLES`.

The floor is a **fixed** number (30) rather than anything derived from the archive being checked. A
threshold computed from the thing it is verifying passes for every possible value, including zero —
the same trap `CLAUDE.md` documents for tests stated relative to the constant they guard. The schema
had 39 `TABLE DATA` entries on 2026-08-17; raise the floor if that grows a lot, and expect to touch
it if tables are ever removed.

Writes go to `<name>.partial` and are renamed only after verification passes, so an interrupted or
rejected run leaves no `.dump` behind that could later be mistaken for a backup.

Verified on 2026-08-17 against the dev database: 39 tables → exit 0; an empty database → 0 tables,
exit 1, archive discarded; `BACKUP_KEEP=2` over three runs → oldest pruned, two retained.

## Restoring

```bash
pg_restore -d "<target-url>" --no-owner --no-acl --clean --if-exists < gavelup-<stamp>.dump
```

`--no-owner --no-acl` is not optional across environments — role names differ between hosts (Neon's
`neondb_owner` vs Railway's `postgres`), and without them the restore fails on nearly every object.

Inspect an archive without restoring it:

```bash
pg_restore --list gavelup-<stamp>.dump | grep -c 'TABLE DATA'   # expect ~39
```

## Known rough edge: getting a file off the volume

A cron service is not running between executions, so `railway ssh` has nothing to attach to for
~86,399 seconds of the day. To retrieve an archive you have to temporarily give the service a
long-lived start command (e.g. override it to `sleep 3600`), redeploy, `railway ssh` in, copy the
file out, then revert.

That is clumsy, and it is the one thing worth improving here. The fix is to upload each archive to a
Railway bucket (S3-compatible, downloadable from anywhere) instead of — or as well as — the volume;
that needs `aws-cli` in the image and four bucket credentials as variables.

## What this does and does not protect against

- **Covered**: a bad migration, an accidental delete, a logical corruption — recover from last
  night's dump.
- **Not covered**: losing the Railway project itself. The volume lives in the same project as the
  database. For genuinely offsite copies, either add bucket upload with an external provider, or
  keep pulling a dump to a laptop periodically (see the tunnel procedure in the migration notes).
- **Not covered**: point-in-time recovery. Worst case you lose up to 24 hours of writes. Take a
  manual dump before any migration-bearing deploy.

A backup is only proven by a restore. Restoring last night's archive into a scratch database
occasionally is the only thing that actually tests this, and it costs about a minute.
