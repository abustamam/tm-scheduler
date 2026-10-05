# ADR-0028: Humans send every message

Status: Accepted

Supersedes in part: ADR-0023 (its reminder purpose; the poller mechanism stands).
Relates to: ADR-0030 (a member changes their own sign-in address), #902 (this change), #903 (the
minutes email became a draft), #898 / #899 (built draft-first under this rule), #271 / #272 / #274
(the reminders this removes).

## Context

Toastmasters is a communication organization. A role reminder, a guest invitation, a "you've been
released from this role" note: each is a small act of club leadership, and the member it reaches
should hear it from a person in their club, in that person's words, from that person's own app.

GavelUp had one place where it mailed members on its own: automated role reminders (#271 queue and
poller, #272 producer, #274 per-club settings, per-member opt-out and a one-click `/unsubscribe`).
Nobody used it (maintainer, 2026-09-25). The app-sent minutes email was the other, and #903 turned
it into a draft. Everything else the app says to a person already goes through a human: the nudge
drafts (`src/lib/nudge.ts`, "The app only ever DRAFTS; the human sends."), the lineup blast, the
guest invite drafts, the flyer.

## Decision

**GavelUp never delivers a message to a member, guest or prospect on its own.** It drafts and
templates; an officer reviews the words and sends them from their own app (WhatsApp, SMS, their
own email client). A feature that wants to tell someone something builds a draft and a send
button that opens the officer's app, never a sender.

Two classes of mail are outside the rule, and only these two:

1. **Account-security mail to the account's own address**, sent because that account's holder
   just asked for it. That is the magic-link sign-in email, and, from ADR-0030, the
   change-of-address verification link sent to the new address a member typed (including its
   "this address is already in use" variant) and the "your sign-in address was changed" notice
   sent to the old one. These are not club communication. No human could send them, since their
   whole job is to prove control of an inbox, and nobody but the account holder receives them.
2. **Operator alerts to the maintainer**, such as the request-access form's notifications and
   cap alerts (#866). They go to GavelUp's own operator, not to anyone in a club.

Neither class may be widened by analogy. "It's about the member's account", "it's transactional",
or "it's only a reminder" do not move a message into class 1. Class 1 means the account's own
address, prompted by the account holder's own action, about the security of that account. A new
exemption needs its own ADR.

What #902 removed under this rule: `role-reminders-logic.ts`, `notifications-logic.ts`,
`notification-prefs*.ts`, `src/lib/unsubscribe-token.ts`, the `notifications` table, the
`clubs.reminder_enabled` / `clubs.reminder_lead_time_days` and `people.reminder_opt_out` columns,
the club-settings "Role reminders" card and the `/account` opt-out toggle. `/unsubscribe` stays as
a static page so the links in reminder emails already sent do not 404.

## Consequences

- **The poller stays, with less to do.** ADR-0023's mechanism (Nitro-booted interval,
  claim-before-send, bounded retry) still runs the request-access delivery pass and the two
  retention sweeps. Its file names and `REMINDER_POLL_INTERVAL_MS` keep their names so a deployed
  env var still applies. The retry constants and the injectable transport moved to
  `src/server/mail-delivery.ts`.
- **A missed role is a club problem, solved by a person.** Nothing reminds a member of their role
  automatically. The meeting page's nudge drafts are the replacement, and the officer decides who
  gets one and what it says.
- **A released holder hears about it from an officer.** The template-conversion and role-removal
  flows already return released holders by name so the officer can send the nudge; that is now the
  only way they are told.
- **`meetings.reminders` is unrelated.** It is the Announcements field (#349), printed on the
  agenda and projected on the slides. Same word, never mailed.
- **Review rule.** A change that calls `sendEmail` (or any other transport) with a recipient who
  is not the account holder acting on their own account, and not the maintainer, contradicts this
  ADR and needs a new one first.
