# Changelog

Notable changes to GavelUp, newest first. Versions are `MAJOR.MINOR.PATCH.MICRO` and match the `VERSION` file; `/ship` writes an entry per release.

## [1.4.0.0] - 2026-08-03

### Added

- **A club can put its own logo on the printed agenda.** An admin uploads a PNG or JPEG on Club settings and it appears in the header of all four print layouts, for anyone who opens the agenda — signed in or not, online or off. Replacing it takes effect immediately; removing it leaves the page exactly as it printed before, with no gap or broken image. Clubs with no logo are entirely unaffected.

  The upload is deliberately club-supplied rather than something GavelUp ships. Toastmasters' Brand Manual authorises a *club* to put the mark on its own agenda and names the Club President as the responsible party, but that permission does not extend to a third party hosting the mark on the club's behalf. So the app renders whatever a club uploads and never bundles, seeds, or suggests an image of its own — the field is called "Club logo" and names no trademark anywhere. Uploading records who confirmed the club is authorised to use the image, and archiving a club now also pulls its logo from public view, so there is a working way to act on a complaint.

- Uploads are checked on the server, not just in the browser: PNG and JPEG only, 256 KB maximum, and the file's actual leading bytes must match what it claims to be — an SVG renamed to `.png` is rejected. The confirmation checkbox is re-checked server-side, so a disabled button is not the only thing standing between a mistake and the page.

- Setting or removing a club logo now appears in the club's activity log, so a change has a record even after the image itself is gone.

### Changed

- Logo images are served with a year-long cache only when the address names the current version. A stale or address-less request still returns the image — a cached agenda keeps rendering offline — but revalidates within minutes, so a replaced logo actually reaches everyone rather than being pinned in browser and proxy caches.

- A failure fetching the logo can no longer take down the printed agenda. The image is decorative; the page an officer needs on meeting morning now degrades to no-logo instead of erroring.

## [1.3.3.0] - 2026-07-31

### Added

- `bun run worktree:setup` bootstraps a fresh worktree in one command: dependencies, `.env.local` copied from the main checkout, `ref/` symlinked, and CodeLedger initialised (optionally with a task-scoped bundle). This repo requires a worktree per change, but a worktree shares git history and nothing else — so `db:*`, `dev` and the seed all failed until three things were remembered by hand, and CodeLedger silently returned empty bundles reporting 0% recall rather than erroring. Four releases shipped from worktrees today with it contributing nothing for exactly that reason. The script is idempotent and leaves the tree clean.

### Fixed

- **`ref/` was not fully ignored, and it holds member PII.** The rule carried a trailing slash, which matches directories only — a plain file or symlink named `ref` was tracked as normal. That mattered the moment the new bootstrap started symlinking it into every worktree, which would have left a Toastmasters membership CSV one `git add` away from being committed. The pattern is now `ref`, covering file, directory and symlink alike.

## [1.3.2.0] - 2026-07-31

### Fixed

- **A guest who shares a phone number with a member no longer converts onto that member's record.** A shared household or work number is ordinary in a guest book — a member brings their spouse, both write the same mobile — and the convert step matched on the digits alone, so the newcomer was filed as the person they came with. `members`, `speeches` and `path_enrollments` all hang off the Person, which means every speech that guest went on to deliver and their whole Pathways progress would have accrued to the wrong human, silently and across every club they belong to. Production already had one number shared by two people; nothing had tripped it only because neither had been converted from a guest row. Matching now leads with email, which identifies one human, and accepts a phone match only when the names also agree. When neither qualifies it creates a new Person rather than guessing: a missed match is visible and the superadmin merge tool fixes it, where a wrong match is neither. The same guard applies to the guest book itself, so two people on one number stay two prospects instead of merging their attendance. A shared *email* — a family address — no longer fuses either: ADR-0008 already required matching only when an email resolves to exactly one person, which the CSV importer honoured and this path did not. #488
- **A club can no longer end up with two roster rows for one person.** Several paths asserted one-membership-per-person-per-club in a comment and enforced it with a read followed by a write, so two admins converting guests at the same moment — or two overlapping CSV imports, which share no transaction at all — could both see "no membership" and both insert. That is the duplicate class the superadmin merge tool exists to unpick by hand. The database now enforces it, and the convert and import paths recover by reading the winning row instead of failing. Converting the same guest twice at once is also serialized now, which the constraint alone could not cover: a guest with neither email nor phone made each attempt mint its own Person, so the two rows never collided. #489

### Notes for this club

- A returning guest who writes their name differently enough will now be recorded as a new prospect rather than merged into the earlier row. Abbreviations are handled ("Jamie R." still matches "Jamie Rivera"), but nicknames deliberately are not — this codebase holds that "Bob" is not derivable from "Robert", which is why the *Goes by* field exists. Visit counts on the VP-Membership funnel may split for anyone who signs in inconsistently.

## [1.3.1.0] - 2026-07-31

### Fixed

- Several guard tests could be satisfied by a comment rather than by the code they exist to protect. They assert on raw file text, so a file that merely *mentioned* the required pattern in a comment passed exactly as well as one that implemented it — leaving the real code deletable with the guard still green. That was not hypothetical: it happened while adding the Word of the Day poster, where a comment naming `<PublicFooter />` kept the disclaimer guard passing after the element was removed. Seven guards now read their sources through a shared stripper that blanks comments while preserving line numbers and offsets. Each bypass was reproduced before the fix and confirmed to fail after it. Two guards that match in the opposite direction — where a comment can only cause a false failure, never a pass — deliberately keep reading raw source, and now say so. Nothing user-facing changes.

## [1.3.0.2] - 2026-07-31

### Changed

- Seed data can now express a meeting with **no** Word of the Day, and Harbor City Speakers gained three fixtures that reach the awkward shapes: no word, a long word, and an all-caps word. Nothing user-facing changes — this is so the poster, print layouts and projected deck can be checked in a browser without hand-editing the database, which is how the previous release had to be verified. `MeetingSpec.wordOfTheDay` became optional; the column was already nullable, so the insert needed no change. #492

## [1.3.0.1] - 2026-07-31

### Added

- `bun run fix` actually fixes what the lint gate flags. `check`, `lint` and `format` all only ever reported — there was no command that wrote anything, so a failing gate had no documented recovery and `bun run format` looked like one while changing nothing. `fix` runs `biome check --write`, which covers formatting, import organization, and lint rules that carry a safe fix. README and CLAUDE.md now say plainly which commands report and which one writes, and warn off the two ways it can bite: it writes the whole tree even when it exits non-zero (so not mid-merge), and `--unsafe` would rewrite `!` into `?.` across the codebase. #491

## [1.3.0.0] - 2026-07-31

### Added

- A **Word of the Day poster** you can print and tape to the wall. Open any meeting that has a word and hit **Word poster** — you get one letter-portrait page with the word in large type and its definition and example usage beneath, sized to be read from any seat in the room. Until now the word only appeared as a line in the agenda header, a slide in Present mode, or a note on a role sheet, so a club that doesn't project its agenda had no way to keep the word visible for the hour members are meant to be using it. The button only appears when the meeting actually has a word. Saving the page as a PDF names the file after the club and date, so it won't be mistaken for an agenda.
- The poster fits on one page for any real word, in any capitalisation. Font sizes are derived from real browser measurements of the brand typeface across the full system dictionary — capitals run about a quarter wider than lowercase, so `EPHEMERAL` gets its own smaller scale than `Ephemeral`, and nothing breaks mid-word. `scripts/measure-word-poster.ts` re-derives and re-checks those sizes on demand, reading the fonts and page geometry from the app itself so it can't drift.

### Fixed

- A stale or mistyped meeting link now shows a proper "not found" page instead of a generic error. Meeting URLs are keyed by date, so an old link that has aged out is the normal way to hit this. Applies to the print, present, and Word of the Day pages, matching what the meeting page already did.

## [1.2.0.0] - 2026-07-31

### Added

- Members and guests now have a **"Goes by"** field, on the member page and the VP-Membership guest editor. Leave it blank and nudge drafts greet people by their first name; fill it in when that's wrong. The Toastmasters export gives us one name string, so "Abdul-Rasheed Bustamam" who goes by Rasheed, or a Robert everyone calls Bob, had no way to be addressed properly. It follows the person between clubs: record it once and every club you belong to greets you the same way, unless that club records its own answer. #486

### Changed

- Nudge drafts open with a first name instead of the full roster name. "Hi Zabihullah Kogyani, just confirming you're our Speaker" read like a mail merge, which undercut a message whose whole point is that a human wrote it. Rosters stored family-name-first ("Khan, Mois") are handled too — you'll be greeted "Hi Mois", not "Hi Khan,". #486

### Fixed

- Tapping WhatsApp on a laptop no longer dead-ends. The link went through `wa.me`, which is a phone redirector: on a desktop it lands on an "open in app" page you can't get past without the WhatsApp desktop client, so the pre-written message had to be retyped by hand. Desktops now go straight to WhatsApp Web with the draft filled in; phones still hand off to the app as before. #485

## [1.1.7.1] - 2026-07-30

### Fixed

- Your Pathways panel no longer treats a project as finished just because you gave one speech for it. Level 1's "Evaluation and Feedback" takes three assignments — speak, evaluate someone else, then speak again applying the feedback — and delivering the first made it disappear from what's left. If your club has never done a full Base Camp sync, the panel now shows the speeches you have delivered and stops guessing at what remains, rather than guessing wrong. Clubs with a full sync are unaffected: Base Camp knows the real completion rule. #456

## [1.1.7.0] - 2026-07-30

### Fixed

- If your club renamed General Evaluator or Table Topics Master, the agenda no longer contradicts itself. The hand-off rows said "Introduces the General Evaluator" two lines above a row already labelled "Chief Evaluator"; both the printed sheet and the projected slide now use your club's name. Group hand-offs ("the speakers", "the speech evaluators") stay as-is — they name a set of people, not a role. #462

## [1.1.6.0] - 2026-07-30

### Changed

- Three role sheets now describe what the agenda actually asks. The Timer's sheet said the report goes to the General Evaluator "at the end of the meeting", which describes the closing summary and misses the timings called for before each vote; it now says a report is presented whenever the meeting leader calls for one. The General Evaluator's mentions introducing the speech evaluators, and the Table Topics Master's mentions handing the meeting back at the end of the segment. Existing clubs are updated too — but only where the text is still exactly as seeded, so anything a club wrote for itself is kept. #444

## [1.1.5.0] - 2026-07-30

### Fixed

- Clubs on the MCF variant that run no functionaries no longer see "Introduces the General Evaluator" on the agenda. The room was handed to the General Evaluator and taken straight back, for introductions that never happened — and at a club with nothing scheduled in between, the line printed twice in a row with the same start time. #449, #458
- A club with no Toastmaster of the Day no longer prints "returns control to the Toastmaster" at the end of the general evaluation. There was nobody to return control to, and no club has a role by that name. The projected slide already said something different. #449

## [1.1.4.3] - 2026-07-30

Test coverage only; no behaviour change.

### Changed

- The agenda parity suite can now catch a mistake that appears identically on the printed run sheet AND the projected deck. It previously only checked that the two matched each other, so a defect present in both passed — which is how a missing functionary introduction shipped. It also covers guest role-holders for the first time. #450

## [1.1.4.2] - 2026-07-30

### Fixed

- If your name ended up on a club's roster twice, whether the app treated you as an admin could change from one page load to the next. It now consistently uses your strongest current standing in that club — an active membership over a lapsed one, an admin role over a plain one, and an open officer term over neither. #471

## [1.1.4.1] - 2026-07-30

Performance only; no behaviour change.

### Changed

- Added a database index behind the lookup that turns your sign-in into your member record. Every signed-in page does it, and on a growing members table it was scanning the whole table each time. #474

## [1.1.4.0] - 2026-07-30

### Fixed

- Your speech log and your upcoming roles now cover **every club you belong to**. If you are a member of two clubs, both pages promised a cross-club view and quietly showed you one club's rows — and which club could change between page loads.
- Both lists now name the club on every row, so two "Timer" bookings a week apart are no longer told apart by date alone. On the dashboard, clicking an upcoming role opens that role's own meeting instead of whichever meeting was next in the club you happened to have selected.
- Clicking **unsubscribe** in a reminder email now stops reminders for good. Reminder mail is addressed to your account, so if your name appeared on more than one club roster the link switched off only one of them and mail kept arriving at the same inbox.
- The reminder-emails switch on **Me** now reflects your whole account rather than one record picked at random, and no longer counts records that could never have emailed you — so it stops flipping itself back on after an admin adds you to a roster.

### Changed

- Speech history deliberately includes clubs you have left. Leaving a club does not un-give the speeches you gave there, even though the club switcher stops listing it.

## [1.1.3.1] - 2026-07-30

Documentation only; no behaviour change.

### Changed

- Dropped the "Known" note from v1.1.3.0 about renamed roles losing self-serve editing. It described a state no club is in: nothing was ever renamed before role identity was introduced, and every rename since keeps its identity, so the case cannot arise. #466, filed to backfill those rows, is closed as unnecessary.

## [1.1.3.0] - 2026-07-30

### Fixed

- **Renaming a role no longer takes away what that role can do.** Two roles carry a permission as well as a name: the Toastmaster of the Day can edit the agenda without being a club admin, and the Grammarian can edit the Word of the Day. Both were recognised by their name, so a club that renamed "Toastmaster of the Day" to "MC" quietly lost the self-serve editing, and one that renamed "Grammarian" lost the Word-of-the-Day edit. Both are recognised by the role itself now, so a rename keeps the permission with it.
- **A role that merely sounds like the Toastmaster no longer gets the Toastmaster's powers.** Any role whose name began with "Toastmaster" — an assistant, a trainee, a second evaluator your club invented — handed whoever held it the ability to edit the whole meeting agenda, and the server allowed the change rather than just showing the button. Only the actual Toastmaster of the Day role does now. The same applied to roles beginning with "Grammarian" and the Word of the Day.
- **The answer no longer depends on which order the roles come back in.** A club with two roles that both looked like the Toastmaster could get a different answer on different page loads, and the page could disagree with what the server would allow.

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
