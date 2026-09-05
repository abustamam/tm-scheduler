# table-topics-wording-460

- **Four private copies of the same award-label map.** `CATEGORY_LABELS` is declared
  independently in `src/components/club/ballot.tsx`, `src/components/club/vote-counter-panel.tsx`,
  `src/components/club/meeting-minutes.tsx` and `src/server/minutes-pdf-logic.ts` — same three
  keys, same three strings, four times — and the club role sheet
  (`src/server/role-sheet-layout.ts`) plus the run sheet (`src/lib/agenda-runsheet.ts`) hold two
  more literal copies beside them. None is exported, which is why #460 needed a source-text guard
  (`src/lib/award-wording.guard.test.ts`) instead of importing the maps and comparing them: there
  is nothing to import. Six copies of one display decision is what let the singular/plural split
  live in the repo unnoticed. One exported `AWARD_CATEGORY_LABELS` in `src/lib/` that all six read
  would make the next rename a one-line change and make the guard's positive half redundant.
  Deferred out of #460 deliberately — that issue was scoped "display strings only" and was the
  serial pre-req the rest of the wave was waiting on, so widening it to a cross-layer refactor
  would have held up four other agents.
  **Priority:** P3

- **The design template still says the singular, and it is what gets transcribed.**
  `templates/meeting-agenda/MeetingAgenda.dc.html` — the design source
  `src/components/agenda/meeting-agenda-print.tsx:4` names as the layout it transcribes — prints
  "Best Table Topic" at lines 132, 233, 373, 392, 526 and 542, the last two being ballot stubs.
  Nothing serves that file, so no member reads it and #460's acceptance criterion (scoped to
  `src/`) is not breached; `award-wording.guard.test.ts` deliberately does not scan outside `src/`
  either. The cost is that the next person transcribing a layout change out of the template
  reintroduces the singular into `meeting-agenda-print.tsx`, and the guard would then be the only
  thing that catches it. Either sync the template's six strings or note the divergence in it.
  **Priority:** P4
