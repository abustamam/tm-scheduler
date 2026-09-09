# Seasons as data (per-season membership and roster renewal)

We do not model seasons as a table with per-season membership rows.

## Why this is out of scope

Two things already cover renewal in practice. The membership status flag
(`active` / `inactive`, #55) means a member who does not renew goes inactive and
disappears from sign-up, rosters and pickers while their past roles stay on the
record. Dues periods as data (ADR-0017) carry the billing calendar a club
actually uses, which is the only "season boundary" a treasurer cares about.

Cross-season history is derivable today: `role_slots` joined to `meetings` by
date is the source of truth for who held what and when (ADR-0005). A `seasons`
table would make every roster read season-scoped and split "who is a member"
into two sources of truth for a question nobody has asked.

## Reopen only if

A club asks for cross-season reporting, for example roles held per member per
season, that cannot be answered by date-ranging `role_slots`. Even then the
shape is a report over existing data, not a membership rewrite.

## Prior requests

- #57 — "Full season modeling — per-season membership & roster renewal"
