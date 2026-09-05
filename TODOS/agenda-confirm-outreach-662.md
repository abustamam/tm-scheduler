# agenda-confirm-outreach-662

- **Two client paths record the same "asked", with different behaviour.** The rail's confirm nudge
  (`MeetingAttendancePanel`'s `onContacted={markAsked}`) goes through the route's `writeRung`: an
  optimistic `rungOverride` first, plus a client-side short-circuit that returns early when the
  member has already answered. The agenda's confirm nudge — the one #662 just wired — reaches
  `setContacted` directly and then `router.invalidate()`, with no optimistic step. The recorded
  result is the same (the server's `demoteFrom: ["reached_out"]` floor is what actually protects a
  real answer, and it holds on both paths), but the officer sees the rail move instantly from one
  surface and only after a round trip from the other, on a phone on club wifi. Worth collapsing to
  one path. Deliberately NOT done here: `markAsked`/`writeRung` and the panel call site are owned by
  #663 and #667, which land after this, and widening into them breaks that sequencing.
  **Priority:** P3

- **`MeetingAgenda`'s `onContacted` has no error surface of its own.** The route's handler toasts on
  failure, so a failed `setContacted` is visible — but the agenda card fires it from an anchor's
  `onClick` that also navigates (`wa.me` / `mailto:`), so the toast lands on a page the officer has
  just left focus from. Same shape as the rail, so not a regression this change introduced, and not
  worth a UI of its own until someone reports missing a failure.
  **Priority:** P4
