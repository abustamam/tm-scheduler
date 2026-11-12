# Folding the personal meeting page into the meeting page

We do not merge the personal meeting page (`/club/$clubId/meeting/$meetingId/me`)
into the meeting page, turn `/me` into a redirect, or move role nudges' `?as=`
links onto the public meeting page.

## Why this is out of scope

The goal was one durable page where a member acts on their roles, instead of a
page only a chat message leads to. That goal no longer matches the product:
#1453 added a third member-facing page, the one-tap RSVP page, with its own
identity handling ("Not you?") and its own attendance write. Merging two of
three pages does not produce one page.

What a member needed from the meeting page has shipped without the merge:

- The "Your jobs" card (#1376) lists the member's roles on the meeting page and
  links into `/me` and its editors.
- A member confirms their own role from the meeting page and the RSVP page
  (#1612, #1613), which was the behaviour gap the consolidation listed.
- Add to calendar sits on each held role (#1431).

What would remain is mostly moving code, and the risky part of it is identity.
The meeting page is public. Giving it `?as=` handling means a new "This link is
for <first name>. Is that you?" prompt, plus a rule that every control on the
page acts as one resolved member, on a page that today has no notion of a
link-seeded identity. ADR-0026 exists because an unverified identity on a shared
device is easy to get wrong; `/me` already handles it with `resolveAsSeed` and
its guard tests, so the work would carry that risk to a second page for little
member-facing gain.

The success measure #1377 was held on (theme and Word of the Day filled 24 hours
before the meeting, 8 weeks after #1376) measures the card, not the merge, so
waiting for it would not have decided this.

If members do get lost between the pages, the smaller change is to show each
held role's guide and resources inline on the "Your jobs" card, without moving
identity handling.

## Prior requests

- #1377: "fold the personal meeting page into the meeting page; role nudges
  link there" (closed wontfix 2026-11-12)
