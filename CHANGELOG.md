# Changelog

Notable changes to GavelUp, newest first. Versions are `MAJOR.MINOR.PATCH.MICRO` and match the `VERSION` file; `/ship` writes an entry per release.

## [1.1.3.0] - 2026-07-30

### Fixed

- **Renaming a role no longer takes away what that role can do.** Two roles carry a permission as well as a name: the Toastmaster of the Day can edit the agenda without being a club admin, and the Grammarian can edit the Word of the Day. Both were recognised by their name, so a club that renamed "Toastmaster of the Day" to "MC" quietly lost the self-serve editing, and one that renamed "Grammarian" lost the Word-of-the-Day edit. Both are recognised by the role itself now, so a rename keeps the permission with it.
- **A role that merely sounds like the Toastmaster no longer gets the Toastmaster's powers.** Any role whose name began with "Toastmaster" — an assistant, a trainee, a second evaluator your club invented — handed whoever held it the ability to edit the whole meeting agenda, and the server allowed the change rather than just showing the button. Only the actual Toastmaster of the Day role does now. The same applied to roles beginning with "Grammarian" and the Word of the Day.
- **The answer no longer depends on which order the roles come back in.** A club with two roles that both looked like the Toastmaster could get a different answer on different page loads, and the page could disagree with what the server would allow.

### Known

- A club whose Toastmaster or Grammarian role was renamed *before* role identity was introduced, to something that still starts with the original word ("Toastmaster of the Evening"), loses the self-serve editing until its role identity is filled in. An admin can still edit the meeting, and renaming the role back restores it. Tracked as #466.

## [1.1.2.0] - 2026-07-30

### Fixed

- **The printed agenda calls a role what your club calls it.** If you renamed a role, the agenda showed your name in the roles table at the top and ours on every row that role owned — a club that renamed "General Evaluator" to "Chief Evaluator" read Chief Evaluator in the table and General Evaluator on all six of its rows. On one club with seven roles renamed, seventeen rows on a single page. Every one of them now reads the club's name, matching the table it sits under.
- **"Calls for the Timer's report" uses your name for the Timer too.** The three voting rows named the Timer directly, so a club that calls that role Timekeeper had a page reading "Timekeeper" in the roles table and "Calls for the Timer's report" three rows later. Renaming a role has always been safe for who gets which job; it is now safe for what the page says as well.
- **The colour coding survives a rename.** Each row's coloured spine is picked by which role owns it rather than by matching the role's name, so a club that renames Speaker keeps the teal speech rows and the highlighted speech block.

### Known

- The projected deck and the .pptx export still use our names in a few places where the printed page now uses yours, and hand-off rows still read "Introduces the Table Topics Master" rather than your name for it. Tracked as #462.

## [1.1.1.0] - 2026-07-29

### Fixed

- **The Best-Evaluator vote slide says what it is.** On the projected deck it was titled "Speech Evaluation" — the same title the individual evaluations carry — while its own body asked the room to vote. It now reads "Vote for Best Evaluator", matching how the Best Speaker and Best Table Topic votes already read. The corrected title carries into the exported .pptx as well.
- **The vote is findable in the jump-to-slide grid.** Because that grid names each slide by its title, a meeting with three evaluators put four cells in a row all reading "Speech Evaluation", and the one that was actually the vote could only be found by counting. It now names itself. The three evaluation cells still read alike, one per evaluator, since they are the same segment.

### Changed

- **A slide's title cannot silently collide with another kind of slide's again.** The deck now checks, for every kind of slide it can project, that no two kinds answer to the same name — so this class of mix-up fails a test rather than turning up mid-meeting. Titles that legitimately repeat, like one evaluation per evaluator, are unaffected.

## [1.1.0.0] - 2026-07-29

The agenda now tells the room who hands off to whom. Running a meeting off it, nobody had to guess whose cue it was.

### Added

- **Hand-off rows.** Four new rows name who introduces whom, each with the holder's name on it: the Toastmaster introduces the speakers and the Table Topics Master, the Table Topics Master hands over to the General Evaluator, and the General Evaluator introduces the speech evaluators. A fifth appears at clubs where the General Evaluator opens the meeting. They cost no clock time, because the time was always inside the segment either side of them. Three more transitions read as a clause on the row that owns them: the Sergeant-at-Arms introduces the President, the General Evaluator returns control to the Toastmaster, and the Toastmaster hands over to the President.
- **Hand-offs on the projected deck.** Each hand-off has a matching slide, so whoever is on deck sees their cue on the wall at the moment they need it. The jump-to-slide grid labels them by target rather than as identical rows.
- **Cover for a missing General Evaluator.** A club that runs no General Evaluator now has the Toastmaster of the Day take the whole role: introducing the functionaries, introducing the speech evaluators, calling for the Timer's report, evaluating the evaluators, calling for the functionary reports, and giving the overall evaluation. Before this, a club with functionaries but no General Evaluator never called for the functionary reports at all, so the Timer, Ah-Counter and Grammarian were never cued to report.

### Changed

- **The segment leader calls for the vote, not the Timer.** Every "call for the Timer's report and open voting" row now belongs to whoever is running that segment, with their name on it. It used to name the Timer, so the person who actually had to ask for the report got no cue.
- **The awards row names who presents them.** It was an unattributed "Toastmaster", a role that does not exist under that name.
- **Wording.** The Call to Order no longer mentions exits, the President's closing reads "announcements" rather than "elections" because clubs hold no elections at a regular meeting, and vote rows read "opens voting for Best Speaker" to match the third-person narration of every other row.
- **The evaluator evaluation needs evaluators.** "Evaluates the evaluators" no longer prints for a club that runs none. This reverses an earlier decision that gated it on the General Evaluator instead.
- **Print layout.** Hand-offs render as a compact transition band rather than a full row, so the agenda gains the cues without gaining a page. On the grid layout the sheet now scales to about 95% to fit.

### Fixed

- A club whose role name contained certain punctuation could corrupt the surrounding text on the printed agenda.

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
