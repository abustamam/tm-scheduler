# Automatic "roles are still open" nudges

We do not send automatic broadcast nudges when a meeting still has open roles.

## Why this is out of scope

The product principle, settled in July 2026: a human stays in the loop for asking
members to fill roles. Personal outreach from the VP Education is how clubs
actually fill a sign-up sheet. An automated "3 roles are still open for Saturday"
broadcast displaces that ask, and members learn to ignore it within a few weeks.
It is the same principle behind `projected-speech-timer.md`: automation must not
quietly replace a person's job at the meeting.

## What covers the need

- **Manual, officer-initiated nudges** on the meeting page and roster
  (`NudgeButtons`, `NudgeRecruitPicker`), driven by the same open-slot data an
  automatic producer would read. The officer decides who to ask; the app removes
  the friction of asking.
- **Per-holder reminders** for claimed and confirmed slots through the in-process
  poller (ADR-0023), gated by `clubs.reminder_enabled` and the member opt-out
  layer. Those remind a person of a commitment they made, which is a different
  thing from recruiting.
- **Duty-aware nudge drafts** (#667) sharpen the manual message so it names what
  the role still owes.

## Reopen only with

A human-in-the-loop or digest design: opt-in per club, admin-gated,
frequency-capped (a weekly digest, never a drip), and routing recipients back to
a person rather than to a broadcast. The preferences and unsubscribe layer
already exists to hang that on.

## Prior requests

- #273 — "[Deferred] Reminders: automatic open-role nudges as a meeting approaches"
- #7 — the reminders epic; every other child shipped in July 2026
