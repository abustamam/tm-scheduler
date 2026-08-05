# Changelog

Notable changes to GavelUp, newest first. Versions are `MAJOR.MINOR.PATCH.MICRO` and match the `VERSION` file; `/ship` writes an entry per release.

## [1.7.0.0] - 2026-08-05

### Added

- **Club action items — a standing list that stays until somebody closes it.** The club already had a
  place to type "bring a guest" or "renew dues": the Announcements box on a meeting. What it lacked
  was everything that makes an action item an action item — an owner, a due date, a done/dropped
  state, and carry-forward — so those notes were retyped each meeting or quietly forgotten. Officers
  now keep a real list under **Manage › Action items**: add an item, optionally give it an owner and
  a target date, and close it as **done** or **dropped** when it is finished. Nothing expires on its
  own; that is the point. Announcements stay exactly as they are, which is still the right shape for
  a one-off notice like "no meeting next week". #529

  Every signed-in club member can read the list, and an open item now shows on the meeting page
  **before** the meeting rather than only after it is marked completed — which is when knowing what
  the club still owes itself actually helps.

  Each meeting's minutes show what was open **as of that meeting**, reconstructed from when items
  were raised and closed rather than from today's state, plus a short "closed since the last meeting"
  list. So March's minutes still read as March's, whether you print them in March or next year. The
  emailed copy deliberately leaves action items out: its recipient list includes guests who signed
  the guest book, and this is club-internal business.

  Only club admins can add, edit or close an item, enforced on the server rather than by hiding
  buttons. An item with no owner belongs to the club and is shown with no name against it — not a
  placeholder. A due date is stored as a calendar day, so it reads back as the day that was picked
  no matter what time zone the reader is in.

## [1.5.6.0] - 2026-08-05

### Fixed

- **The agenda now says which speaker each evaluator is evaluating.** It always could — the wording, the ordering and the member dashboard were all written for it — but nothing in the app ever recorded the pairing, so on every meeting created through the UI the link was empty and five separate features quietly fell back: the run sheet printed a generic "Evaluates a speaker", the speaker's introduction couldn't name their evaluator, evaluators were listed in slot order rather than speaker order, a member's own activity page never showed who evaluated them, and the paired speaker/evaluator row never rendered. The link is now written where the pair is created — both when a meeting is generated from the club's role template and when a speaker is added with the "+ Add speaker" button. #512

  Existing meetings are unaffected: this fills the link in going forward rather than backfilling, because a meeting that has been edited since can no longer be paired reliably by position.

- A roster test counted merge-audit rows across the whole test database instead of its own club, so it could read rows written concurrently by another test file. It passed only by timing luck; adding one unrelated test was enough to break it.

## [1.5.5.0] - 2026-08-05

### Fixed

- **The meeting theme, location, notes and announcements had no length limit.** The theme is the one that mattered: it can be saved by anyone holding the meeting's Toastmaster slot, which on a public club page needs no sign-in, and it prints into the minutes PDF that the server builds on the spot. Last release stopped an oversized theme reaching the printer; this stops it being saved at all, which also keeps it out of every other page that reads it. The other three are capped alongside it. Creating a meeting now rejects text over the limit and says which field; editing one shortens it instead, so a value saved before the limits existed can never leave someone unable to save the meeting's date.

- **The same fields were unlimited when creating a whole term of meetings at once.** That form writes up to 52 meetings in one go and its location field was missed by the first pass. Capped, along with the saved recurrence rule that copies a location into every meeting it creates.

- **A Pathways project name could get around the speech limits.** Picking a real project overwrites the typed path, project and level with the catalog's own text, and that happens after the limits are checked — so a long enough catalog entry went straight past them. The catalog is now shortened to the same limits on the way in, and on the public project picker, which was handing the same unlimited text to anyone browsing a club page.

- **A long Table Topics question could have frozen offline minutes.** Found while adding the limit above, before it shipped: rejecting an over-long question would have left it stuck at the front of the offline queue, blocking attendance, guests, awards and every later change to that meeting's minutes with no way to clear it. It shortens the question instead.

### Notes for this club

- Nothing you have entered is affected. The longest theme on record is 20 characters against a 200 limit, the longest location 30, and the longest announcements 62 against 2,000.

## [1.5.4.0] - 2026-08-04

### Changed

- The meeting now closes the way clubs actually close it: **announcements, then guest comments, then adjourn**. Previously the agenda invited guests to speak and then had the club talk amongst itself before ending — so the last thing visitors heard was internal business. The President's closing is now three rows instead of one bundled row, which also gives the adjournment its own line on the printed agenda. The projected deck was reordered to match. Total time is unchanged: the old three-minute closing became two plus one, with guest comments' two minutes sitting between them, so nothing downstream shifts. #442

## [1.5.3.0] - 2026-08-04

### Fixed

- **An emoji could get past the limits added last release, and stall the site anyway.** Those limits worked by counting characters, and the check that decided "this one is short enough, leave it alone" only ever looked at the beginning of the text. For ordinary writing that is the same thing. For text made entirely of emoji it is not, and the check waved the whole thing through no matter how long it was. A club name of twenty thousand emoji took nearly eight seconds of solid work on the public role-sheet link, against a sixth of a second for the same length of ordinary text. Fixed, with the emoji case now part of the tests.

- **Speech details had no limits at all.** Anyone who can sign up for a speaking slot — which on a public club page is anyone who picks their name — could save a speech title, introduction, pathway, project or slides link of unlimited length. Those fields are now bounded. Signing up for a slot rejects anything over the limit and says which field and by how much; editing an existing speech shortens it instead, so a value saved before the limits existed can never leave someone unable to fix the rest of the row. A slides link is the exception and is rejected rather than shortened, because a shortened link still looks like a link and simply does not work.

- **A speech could be booked for two million minutes.** The minimum and maximum minutes had no upper bound, which made the agenda's running times nonsense and, past a certain size, failed the save with an unexplained error instead of a message. Capped at ten hours, and an impossible window like "at least 700, at most 650 minutes" is now refused rather than quietly rewritten into something the speaker never asked for.

- **The minutes PDF had no limits of its own.** It is a smaller audience than the role sheets — you need to be signed in and a member of the club — but it is built the same way, in the same single process, and it printed the meeting theme, the Word of the Day, the club name, every attendee's name, the Table Topics list, the awards and the whole program with nothing bounding any of it. A meeting stuffed with entries took over a minute. Everything it prints is now bounded, and where a list is too long to print in full it says how many entries were left out rather than stopping silently.

- **Editing a Word of the Day could corrupt it.** Shortening text by cutting at a fixed character count can slice an emoji in half. The leftover half was written to the database, where it became a question-mark box, and it then printed as a blank tombstone on the role sheets. The same flaw was in the speech-detail limits above. Both now shorten whole characters at a time.

### Notes for this club

- Nothing you have entered is affected. The longest speech title on record is 23 characters against a 200 limit, the longest project name 38 against 120, and the longest speech booked is 7 minutes against a 600 limit.

- Minutes now print at most 60 program rows and 40 Table Topics speakers per meeting, with a "+N more not shown" line when there are more. No meeting on record comes close to either.

## [1.5.2.0] - 2026-08-04

### Fixed

- **A single anonymous request could stall the whole site.** The printed role sheets download as PDFs from a public link, and the server builds each one on the spot, in the one process that serves everything else. Nothing limited how much text it would lay out — so a Word of the Day definition pasted long enough took over three and a half seconds of solid work, and a meeting with hundreds of speaker rows took two. During either, nobody else's page loaded.

  Everything a club can type into those sheets is now bounded before it reaches the renderer: the club name, the date, each speaker line, how many speaker lines are pre-filled, and the Word of the Day with its definition. The limits are roughly ten times the longest values any club has actually entered, so nothing anyone would really write is affected. The worst request that used to take 3,596ms now takes 40ms.

  The Word of the Day fields are also capped when they are saved. Creating a meeting rejects text over the limit with a clear message; editing one trims it instead, so a value written before the limit existed can never leave someone unable to save the rest of the meeting. The Word-of-the-Day editor on its own rejects rather than trimming, because losing the end of a definition silently is worse than being told it is too long.

### Notes for this club

- Nothing you have entered is affected. The longest Word of the Day definition on record is 50 characters against a 500 limit, the longest club name 20 against 120, and no meeting has ever booked more than 3 speakers against a limit of 8.

- The Timer's log now pre-fills up to 8 speakers rather than 10. Past that the sheet ran onto a second page for any club using a logo, and these are meant to be one page in the hand. The Timer writes the rest of the meeting's items in as they happen, which is how the log already worked.

## [1.5.1.0] - 2026-08-04

### Added

- **The agenda now says what to say, not just who is next.** Three moments that everyone in the room knew but the page never stated. The functionary introduction cues the Word of the Day, so a first-time Grammarian reads that delivering it is their job right then — the code already knew this and only the page did not. The Table Topics Master asks the Timer to explain the timing as the segment opens, printed beside the green/yellow/red numbers being explained. And a new row before the evaluations has the General Evaluator ask the Timer to explain how an evaluation is timed, which is different from a speech and was never announced. Each cue appears only for a club that runs the role it names: no Grammarian, no Word-of-the-Day line; no Timer, no timing cue, and the row stays. A club that renamed a role sees its own name in the cue. #508

- **Every printed role sheet now carries the words to read aloud.** The Timer's, Grammarian's, Ah-Counter's, Ballot Counter's and General Evaluator's sheets each gained a "What to say" block: the moment, and the line. They were logs before — a grid to tally into, with nothing for the moment the holder is handed the floor, which is exactly what a first-timer does not already know. The Timer's spoken times come from the same table printed above them on the same sheet, so the two can never disagree, and the General Evaluator's ask for the evaluation timing is the same sentence the agenda prints in that officer's row. #509

### Changed

- **The Ah-Counter's sheet no longer arrives pre-filled with the booked speakers.** That role listens to everyone who takes the floor — Table Topics respondents, evaluators, the Toastmaster, the other functionaries — so three printed names invited three rows of tallies and quietly excluded most of the meeting. The column now asks "Who spoke" and the sheet says plainly that it covers everyone. The Timer's log keeps its pre-fill, because those rows are assignments with booked times to compare against, which is a different job.

### Fixed

- **Role sheets stay on one page.** Adding the script pushed three of the five onto a second sheet, and then a further two ways of spilling turned up: an ordinary club name of 34 characters ("Sunrise Speakers Toastmasters Club"), and five prepared speakers. These are handheld sheets, so one page each is the point. Each sheet now holds one page with a long club name, a full Word-of-the-Day note, and up to ten booked speakers. The Timer's log went from twelve rows to ten to pay for the script, which is the cheapest part of that sheet — the Timer writes the rest of the meeting's items in as they happen.

### Notes for this club

- Two of #508's five requests are **not** in this release, and could not be. They wanted the speaker introduction to name that speaker's evaluator, and the evaluator's row to read "Evaluate Dana" rather than "Evaluates a speaker". Both read a column that nothing in the app can set: evaluator-to-speaker pairing is written only by a one-off import script, so on any meeting created here it is empty and the wording would never appear. Tracked separately, along with a third thing it turned out to disable — the code that orders evaluators to match their speakers has never once run.

- If your club has moved a standard role out of its usual category, the Word-of-the-Day cue follows the category rather than the name. A Grammarian filed under Leadership is not introduced with the functionaries, so the cue does not appear in that row either — the page no longer names a role it just declined to introduce.
## [1.5.0.0] - 2026-08-04

### Added

- **Your club's logo now appears everywhere the agenda goes, not just on the printed page.** It shows on the projected deck's opening slide, in the downloadable PowerPoint, on the Word of the Day poster, and on the club role sheets — both the on-screen version and the five downloadable PDFs. Upload it once in club settings and every surface picks it up. #496

### Changed

- **The logo sits on a light backing wherever it appears.** The poster footer and the role-sheet header band are dark, so a dark logo on a transparent background — the most common thing a club has to hand — simply vanished on them, with no hint as to why. On the white printed pages the backing is invisible, so those look exactly as they did.
- **Uploads are now capped at 2000 pixels on each side, alongside the existing 256 KB limit.** File size alone does not bound what an image costs to draw: an 8000×8000 logo can compress to comfortably under the size limit and still expand to roughly a quarter of a gigabyte when a role-sheet PDF is generated. A handful of people downloading role sheets at once was enough to take the server down for every club.

### Fixed

- **A square club crest no longer comes out stretched in the PowerPoint export.** The exporter was asked to preserve the shape, but the setting had no effect the way it was being called, so a square logo was smeared to roughly 4.7:1 in the downloaded file while looking correct on the projected slide.
- **Archiving a club now removes its logo from the downloadable role sheets too.** Archiving is how a logo gets taken down, and it already worked everywhere else; the role-sheet PDF was reading the logo without that check.
- **The "Download .pptx" button can no longer get stuck.** If fetching the logo stalled, the button stayed disabled behind a spinner with no way back short of reloading the page. It now gives up after five seconds and exports without the logo.
- **Some valid JPEGs are no longer rejected as invalid images.** Encoders may pad a file with filler bytes before each internal marker, which is perfectly legal; the new size check misread those files and refused the upload.

### Notes for this club

- If you already uploaded a logo larger than 2000 pixels on a side, it will stop appearing on the role sheets until you replace it with a smaller one. The image itself is still stored, and every other surface is unaffected.

## [1.4.1.0] - 2026-08-03

### Fixed

- **The agenda now colour-codes evaluations and Table Topics, not just speeches.** Only speakers got the green/yellow/red trio, so an evaluator reading the run sheet saw a bare minute count and Table Topics showed nothing, even though the Timer signals all three off the same card. Evaluations print 2:00 / 2:30 / 3:00 and Table Topics 1:00 / 1:30 / 2:00 — the standard windows, and the same ones the Timer's own sheet has always published. A guard test now pins the two sources together, so a Timer signalling at 2:30 can no longer end up beside an agenda printing something else. #507
- **It is called yellow everywhere now, not amber.** The agenda's timing key and column header, the Timer's printed sheet, the public timing-card and meeting-roles articles, and the five downloadable role-sheet PDFs. The PDFs are committed artifacts rendered from the same layout as the live sheet, and nothing regenerates or checks them — they had been printing "Amber" while the live sheet said "Yellow". Tests now assert the printed words, not just the underlying data, on both surfaces.

### Notes for this club

- The Table Topics trio is the window for **one response**, not for the whole segment. On the spacious print layout that number was briefly shown where a row's own duration goes, which would have labelled a 20-minute segment "1:00–2:00"; it is suppressed there now. The other three layouts show it as signal marks, where it reads correctly.
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
