# Changelog

Notable changes to GavelUp, newest first. Versions are `MAJOR.MINOR.PATCH.MICRO` and match the `VERSION` file; `/ship` writes an entry per release.

## [1.0.0.0] - 2026-07-28

The first tracked version. GavelUp has been live with real clubs since June 2026 — this entry describes what it does today rather than replaying the ~440 pull requests that got it here, which stay in git history. Everything after this line is a change against this baseline.

### Added

- **Meetings and agendas.** Per-club role definitions and slots, a schedule builder, batch meeting creation, and a printable agenda whose run of show adapts to the roles a club actually runs. Table Topics flexes to absorb over- and under-runs so the printed clock matches the room.
- **Present mode.** A projected slide deck built from the same meeting data as the agenda, plus PowerPoint export, and four print layouts including grid and one-page timing sheets.
- **Public club pages.** Read-only by default, with a shared sign-up sheet guests and members can claim roles on without an account, a "can't go" decline chip, and a guest book.
- **Members and roster.** One Person per human across clubs, separate from per-club Membership, with CSV import, dedupe on write, and cross-club merge tools for superadmins.
- **Pathways.** Path enrollment, level and project progress, and a browser extension that syncs Base Camp progress into the app through per-club tokens.
- **Minutes.** Meeting minutes derived from the agenda and what actually happened, with per-meeting announcements.
- **Officer tools.** VPE and VP Membership dashboards, dues tracking, Distinguished Club Program tracking, an activity log, and a club switcher for people who serve more than one club.
- **Accounts.** Magic-link sign-in only, a superadmin allowlist reconciled on every sign-in, and read-write impersonation so a superadmin can act as a club admin.
- **Offline support.** A service worker keeps print and present views usable when the room's wifi is not.
