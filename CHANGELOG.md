# Changelog

Notable changes to GavelUp, newest first. Versions are `MAJOR.MINOR.PATCH.MICRO` and match the `VERSION` file; `/ship` writes an entry per release.

## [1.20.0.0] - 2026-08-18

### Added

- **Take the roll from the same rail you chased people on.** On meeting day the attendance panel switches from "who says they're coming" to "who is actually here", and anyone who told you they were coming arrives pre-filled as a dashed `Present?` you confirm with one tap. Roll call is the one job done standing up with a phone in one hand, so the common case is a single tap per member — and the exceptions, the person who said yes and did not appear, are one tap away on the chip's own menu rather than something you have to undo afterwards.
- **Guests get counted where you are already standing.** Adding a visitor who walked in, or removing one who did not, now happens in the panel beside the members instead of in a separate card further down the page. A returning guest is picked from the club's own list rather than typed again, so they stay one person in your records instead of turning into three.
- **Chasing someone once the meeting has started asks a different question.** Tapping WhatsApp or Email beside a member during roll call now drafts "we've started our meeting — are you on your way?" instead of "are you able to make it?". The old wording was written for the week before; sending it from the room at 7:45pm asked someone whether they could attend a meeting that was already running.
- **Roll call works when the venue's wifi does not.** Every tap is saved on the device and syncs when the connection comes back, and the panel tells you how many changes are still waiting, whether it is syncing, and if something failed — with a Retry you can actually reach. Church halls and community centres are where this club software runs; a tap that vanishes because the router did is a member marked wrong in the minutes.

### Changed

- **Attendance is recorded in exactly one place.** The Minutes card no longer has its own attendance controls; it points at the panel and, for members who cannot edit, shows the record read-only with the counts and everyone's status. Two places to mark the same person is how a club ends up with someone present in one screen and absent in the other, and the emailed minutes disagreeing with both.
- **Attendance can still be corrected after a meeting is completed.** Minutes are often finished days later, and fixing a mis-marked member no longer means reopening the meeting first.
- **A member who has left the club still appears on a past meeting's roll.** If they were marked present in March and left in April, opening March in May shows their row and counts them — matching what the minutes PDF and the emailed minutes have always printed.

### Fixed

- **"You attended this meeting" now means you were actually marked present.** It used to be inferred from what you had said you *planned* to do, so anyone who never declared they could not come was told they attended whether or not they turned up. It now reads only the recorded answer, and says nothing at all when nobody recorded one — rather than guessing on your behalf. (#548)
- **A roll tap can no longer be silently dropped.** Recording someone while another save was still in flight used to do nothing at all, with no message: the controls now dim while a save is in progress, so the panel never looks ready when it is not.
- **A queued tap can no longer overwrite a later one.** If a save was waiting to sync and you then recorded a different answer for the same member, the older one could come back and win when the connection returned. The waiting queue is now the single path every save takes, so the last answer you gave is the one that sticks.
- **Moving a Table Topics speaker no longer shifts them twice** when the change had to be re-sent after a dropped connection, which quietly reordered the speaking list in the saved minutes.
- **Opening a different meeting no longer carries the previous one's unsaved roll with it.** A tap saved on the device for one meeting could be applied to whichever meeting you opened next.
- **A screen reader now hears the answer, not just the name.** Every status control announced only "<member> status", so the one thing the rail exists to convey — Present, Absent, Excused, Coming — reached nobody using assistive technology.

## [1.19.0.0] - 2026-08-18

### Added

- **Someone who has confirmed their role is counted as coming.** If a member accepted a slot on the meeting, the rail now reads that as attendance and stops listing them as unanswered. Chasing people who have already said yes to running a segment was the single biggest source of noise on a VPE's list — and their own answer still wins, so a confirmed Toastmaster who tells you on the night that they cannot make it shows as Not coming.
- **Messaging someone about their role, not just about the meeting.** Tapping WhatsApp or Email beside a member who holds a slot now drafts the same role confirmation the agenda's slot cards send — "just confirming you're our Toastmaster" — instead of a generic "are you able to make our meeting?". Asking whether someone is coming when you already put them on the programme wastes the ask. A member who has said they cannot come gets the plain question instead, never a message asserting they accepted.

### Changed

- **Full names, everywhere.** Long names used to be cut off with no way to read them. They now wrap and stay whole.
- **Roles show as the sign-up sheet's short code** — TD, GE, SP1 — with the full role name on hover and read aloud to a screen reader. A four-character badge leaves the name the room it needs in a 340px column.
- **WhatsApp and Email became icons.** Two words each were spending most of the column on saying what a glyph says. The agenda and the recruit picker keep their labels.
- **The unset state says "Ask" instead of an em dash**, which read like something had been deleted rather than like an invitation. Every row's three controls now share one right edge.
- **The rail scrolls on its own.** With a large roster the pinned sidebar used to run past the bottom of the screen with no way to reach the rest of it.

### Fixed

- **A screen reader now hears the answer.** On every row where someone had actually replied, the status control announced only "Ayesha Khan status" — the word Coming, Asked or Not coming never reached assistive tech. The rail's whole purpose is who is coming, and for those users that answer was missing.
- **Confirming a member's role no longer un-confirms them when you message them.** Tapping their draft recorded "I asked them", which outranked the confirmation and dropped them back out of the coming count.
- **A double-tap on a message draft records one thing, not four.** The status control already ignored repeat taps mid-save; the WhatsApp and Email links did not, so an impatient tap on a phone wrote the same "asked" several times and filled the activity log with duplicates.
- **A role name in a non-Latin script no longer shows a broken character on the badge.** The short code was cut at four UTF-16 units rather than four characters, so a club whose role name is written in emoji or an ideographic script could get a half-character on the end of its badge.
- **The role badge no longer implies a confirmation nobody gave.** A filled badge with a tick was marking exactly the rows where nobody had replied, while the control beside it was greyed to say the opposite.

## [1.18.0.1] - 2026-08-17

### Fixed

- **Nothing user-facing.** Repairs the one check a freshly-created worktree gets. `bun run worktree:setup` tells you to verify with `git status --porcelain` and expect no output, and it had stopped delivering that: `codeledger init` re-appends a fixed onboarding block to two tracked, hand-curated agent-rule files, so every bootstrap dirtied them by 42 lines each. The signal that the bootstrap behaved was reading red for a known cause, which is the fastest way to teach people to ignore it. The block is discarded after `init` runs, scoped to exactly those two files.

## [1.18.0.0] - 2026-08-17

### Added

- **Print the whole night in one file.** "Print & export → Print meeting packet…" builds a single PDF with the Word of the Day poster and whichever functionary logs you want. Printing for a meeting used to be six separate actions — five individual sheet downloads plus a browser print of the poster — and missing one meant a functionary sitting down with nothing in front of them.
- **You pick what goes in, and it starts on the right answer.** The boxes are ticked from what the meeting actually runs, so a club with no General Evaluator does not get GE notes, and a club using digital voting does not get the paper Ballot Counter tally — without configuring anything. Everything stays yours to change: tick the tally anyway if you want a spare.
- **Three copies of the Word of the Day by default**, for putting around the room, adjustable up or down.

## [1.17.0.0] - 2026-08-17

### Added

- **You can now vote for someone who isn't on the ballot.** Tap "Someone else…", type a name, done. The ballot could only ever offer people the app already knew about — whoever held a role slot, plus Table Topics speakers someone had recorded — and Table Topics respondents don't get recorded while the segment is running, because the people who would do it are the people running the meeting. So Best Table Topics, the award that most needs a vote, routinely opened with a short list or nobody on it at all.
- **A name someone types becomes a button for everyone after them.** The second person voting for the same speaker taps their name instead of typing it, so one person doesn't end up on the ballot twice as "bob smith" and "Bob Smith" splitting their own vote. Capitalisation and stray spaces are treated as the same person; the spelling the first voter used is the one everybody sees. Names that differ by more than that — "O'Brien" and "OBrien" — are left as two entries, because the app should not guess that two people are one.
- **A write-in can win.** The Ballot Counter can set one as the winner from the tally, and the name flows through to the minutes, the emailed minutes, the minutes PDF and the printed awards row like any other winner.

## [1.16.1.0] - 2026-08-17

Five fixes from the 2026-08-13 meeting (#578).

### Fixed

- **The projector no longer tells an evaluator they have three minutes while the Timer red-cards them at three.** The evaluation slide showed "Time: 3 minutes" — the slot the printed clock reserves for that beat — when what an evaluator is actually timed against is a 2–3 minute window, green at 2:00. The printed agenda and the Timer's own log already said 2–3; the wall was the last surface still saying otherwise. The slide now reads the same window they do, and the top of that range is still the beat's booked duration, so the projector and the printed clock cannot drift apart.
- **The Word of the Day now appears when the Grammarian actually gives it.** At clubs where the General Evaluator introduces the functionaries, the deck put the word, its definition and its example on screen before the Toastmaster had even handed over — so the room read the definition several beats before meeting the person presenting it. It now follows the functionary introductions, which is where the printed agenda has always said it happens.

### Changed

- **Introduction rows name the person, not just the role.** "Introduces the General Evaluator" is now "Introduces the General Evaluator: Riyaz" — on the printed agenda and on the projected slide. The one thing you have to say out loud at that moment was the one thing the row left out, and on a multi-page agenda it was on a different sheet. Open roles are unchanged: with nobody in the slot the row reads as it always did, rather than announcing "— open —". Guests keep their "· Guest" marker.
- The two rows that introduce a *group* — the speakers and the speech evaluators — deliberately do not list names. Those people's own rows are the very next thing on the page, naming them in larger type, so listing them again restated the line below while making the longest rows on the sheet longer still. Since the agenda scales to fit its page, that cost every word on it about 2% of its size for no new information.
- **"Calls for the functionary reports" now says who.** The row reads "Calls for the Timer, Grammarian & Ah-Counter to report", naming the reporting functionaries your club actually runs, under your club's own names for them. A club that renames a role or turns one off sees the change on the row automatically.

### Added

- **The Ah-Counter's log has a column for double clutches**, plus a line saying what one is — a restart, where the speaker begins a word or phrase, stops, and begins it again. The term is invisible to anyone who has not held the role, which is exactly who picks up that sheet. The spoken cue on the same sheet now names it too.

## [1.16.0.0] - 2026-08-17

### Added

- **The Toastmaster of the Day can now run planned attendance.** The panel was for club officers only, which left the person actually running the meeting able to hand someone a role without being able to see whether that person had said they were coming. Whoever holds the Toastmaster slot now gets the same list for their own meeting: every active member, one status each, set from the same dropdown.
- **Signing in unlocks the message drafts.** A Toastmaster who identified by picking their name from the roster sees the whole list and can set anyone's status, but the WhatsApp and Email buttons stay dark and each row reads "No contact on file". Sign in and they appear. Picking a name off a public list is not proof of who you are, and members' phone numbers and email addresses are not something that should rest on it.

### Changed

- The Toastmaster's access is scoped to the meeting they are running and ends when it does. Holding the slot on one meeting gives them nothing on another, and it lapses once that meeting is locked. Someone who leaves the club stops having it, even on meetings they ran before.
- Taking back an officer's "asked" mark is still an officer's job. A Toastmaster can mark anyone as asked, coming, or not coming, and can clear an answer a member gave themselves, but removing another officer's record of having chased someone needs an officer.
- Tapping a message draft can no longer overwrite an answer that has already come in, on either the automatic or the manual path.

## [1.15.0.0] - 2026-08-16

### Added

- **One place to see who is coming to the next meeting.** An officer opening an upcoming meeting now gets a Planned attendance panel — every active member, one status each: no answer, asked, coming, or not coming. It sorts the people nobody has spoken to yet at the top, so the list reads as a worklist rather than a roster, and a counts line ("3 coming · 2 not coming · 1 asked · 9 no answer") sits under the title. On a phone it starts collapsed to that counts line so it never pushes the agenda off screen; on a wide screen it sits in a rail beside the agenda and follows you down the page.
- **Tapping WhatsApp or Email marks someone as asked.** The draft opens in your own app the way it always has, and the row moves from "no answer" to "asked" on its own — so the panel keeps track of who you have chased without you telling it twice. It will not touch anyone who has already answered.
- **Members can now say they'll be there.** The meeting page previously only let a member say they *couldn't* make it. Both answers are now on the personal strip, either one can be taken back, and the answer survives a reload.

### Changed

- **The old Outreach panel and the "Not available this week" list are gone, absorbed into the new panel.** They answered two halves of the same question in two places, one of which could not express "yes". Everything they showed is in the one list now, with one change in when you see it: those two surfaces stayed up until a meeting was over, and the new panel is for planning, so it ends when the meeting day arrives. Taking attendance on the day is what Minutes is for.
- An officer's private record of having asked someone stays private. It is never sent to a member's browser or to a public visitor, and a member's own answer is the only thing the personal strip reads.

## [1.14.1.0] - 2026-08-15

### Fixed

- **Attendance can no longer be recorded for a meeting that hasn't happened.** The Minutes card offered Present / Excused / Absent on future meetings, under a heading calling itself the record of what happened — and the taps were saved. Those records feed the minutes PDF, the emailed minutes and the attendance reports, so a stray tap put a member on the record for a meeting weeks away. Attendance now opens on the day of the meeting, which is also when a meeting becomes completable. Guest sign-in already worked this way; officer marking now matches it.
- Before the meeting day the Minutes card says so, rather than showing nothing where the roster used to be.

## [1.14.0.0] - 2026-08-15

### Fixed

- **Marking someone "contacted" no longer erases the answer they already gave.** The club tracked "we asked them" and "they can't make it" as two unrelated notes, and this release merges them into one record of where each member got to. During that merge, ticking the contacted box for someone who had already declined wiped the decline — so they vanished from the meeting's Not Available list and lost the warning in the role picker, and a VP Education could hand a role to a member who had explicitly said they could not come. Ticking "contacted" now only ever records the ask, and never overwrites an answer.
- **Members who said they are coming are no longer on the list of people to chase.** Anyone who confirmed without holding a role fell through into "still to ask" on the outreach panel. They are now counted separately, so the chase list only contains people who have not answered.
- **A club's outreach notes are no longer editable by strangers.** Clearing someone's plan for a meeting is open to anyone with the sign-up sheet link, by design — but it could also delete an officer's private "I contacted them" record, which previously only a club admin could touch. Clearing now leaves officer notes alone; only an officer can remove one.
- **Unticking "contacted" removes only the ask.** It used to clear the member's own answer along with it.
- Archived clubs no longer accept availability changes through the sign-up sheet. Taking a club down now blocks those writes as it already blocked everything else.

### Changed

- **A member's plan for a meeting is now one record instead of two disconnected notes.** "We asked them", "they're coming" and "they can't make it" live in a single place per member per meeting, so silence and a positive answer are finally distinguishable — the old pair could not express "she replied, she's coming" at all. Existing availability and contacted notes carry over untouched: a decline stays a decline, and an ask with no reply stays an ask.
- **Claiming a role now records that you are coming**, instead of quietly deleting an earlier "can't make it". Taking several roles for one meeting still only records it once.
- Activity feed entries describe the new states in plain language ("said they're coming", "reached out to Alex", "cleared their planned attendance"). Older entries keep reading exactly as before.

## [1.13.2.0] - 2026-08-15

### Fixed

- **Removing someone's platform-support access now takes effect immediately.** If a support session was already open when their access was withdrawn, it kept working until it expired on its own — up to an hour. Withdrawing access now ends any open session on their next action. Restoring access brings it back; nothing about the club's own admins changes.

### Changed

- **Club pages load with one less database query each.** Checking whether a club has been removed used to be a separate lookup on every page a member opens, even though the information was already in hand from the check that ran immediately before it. On the VP Education dashboard, which loads three reports at once, that was nine lookups before any report data — now six.

## [1.13.1.1] - 2026-08-15

### Fixed

- **Nothing user-facing.** Repairs the internal check that is supposed to catch a page which forgets to hide a removed club. It was reporting a clean bill of health while skipping one page — the meeting minutes, which is exactly the page that turned out to be leaking in v1.13.1.0 and had to be found by hand. The check now reads each page's code correctly, and fails if it is ever fooled the same way again.

## [1.13.1.0] - 2026-08-14

### Fixed

- **Taking a club down now actually takes it down for its own members.** Archiving a club is how a club is removed from GavelUp, but its members could still open the roster and read every member's email and phone number, along with the minutes and their own upcoming commitments. The pages the public sees were closed in v1.11.1.0; the signed-in ones were not, and adding phone numbers to the roster in v1.12.0.0 widened what was on show. Every signed-in read of an archived club now comes back empty, including the minutes, the minutes PDF download, and the club's name and number in the club switcher.
- **A taken-down club no longer keeps serving its agenda from your device.** Meeting pages are saved for offline use, and once a club was archived the server refused to send a fresh copy — which meant the old one was never replaced either. Any device that had opened that meeting could keep showing the full agenda, with assignee names, speech titles and the Word of the Day, indefinitely. Those copies are now discarded as soon as the device sees the club is gone, along with the club's crest.
- **A member whose club was removed gets told what happened.** They used to land on "You're not in a club yet", with advice to check they had signed in with the email their club has on file — an account problem they could never fix, because the club was the thing that changed. The screen now says the club has been removed and points them at their club's officers.

### Changed

- **Everyone's saved offline meeting pages are cleared once, on the first visit after this release.** That is the only way to remove copies of a taken-down club that are already sitting on devices, and the worker cannot tell which saved page belongs to which club. Re-open any meeting while online to save it again. Nothing else is affected: the app's own files and images are left in place, so this costs one page load, not a full re-download.
- **A superadmin can no longer view an archived club by acting as it.** Removing a club now means no club screen serves it to anyone; the superadmin console is the way to look at one. This matches what the console already did — it hides "View as this club" for an archived club — so the two no longer disagree.

## [1.13.0.1] - 2026-08-13

### Changed

- **Nothing user-facing.** Corrects a claim in the contributor docs that shipped with v1.13.0.0. The note about the print checks needing a browser said they had only ever run on the build server, which is wrong — it described a Mac, and this project is normally developed on Linux, where they run locally like any other test. Scoped to macOS now, along with the reason the obvious workaround makes things worse rather than better.

## [1.13.0.0] - 2026-08-13

### Changed

- **The printed agenda no longer repeats a presenter's name down the page.** When the same person runs several beats back to back, they now print as one block: the name once, a line per beat, every clock time still there. On a real MCF agenda that is the General Evaluator's four-beat stretch and the President's three-beat close — six repeated name lines gone, and nothing about the meeting itself changed. A hand-off still splits the block in two, because being introduced is a real moment in the room and should not read as one uninterrupted turn.
- **The Editorial agenda prints noticeably larger.** Body text goes from roughly 5.6pt to 6.9pt — about 23% bigger. Most of that is the space the repeated names were using: the Editorial layout shrinks itself to fit one sheet, so anything that makes the page taller makes the type smaller, and the reverse. The remainder is a deliberate size increase on top, sized by measuring the sheet rather than guessing.
- **The Spacious layout gets the same treatment.** Its run-of-show page had been shrunk to about 70% to fit; with the repeated names gone it now fits with room to spare and prints at full size. The Grid and Timing layouts are untouched — they already put the name and the description on one line, so there was nothing to reclaim.

### Fixed

- **Print layout checks now run on a Mac.** The tests that catch print problems drive a real browser, and they were quietly skipping on macOS because the browser installs somewhere they did not look. They ran only on the build server. Setting `CHROME_PATH` now points them at any working browser.

### Changed

- **Every phone number in GavelUp now opens WhatsApp.** Tapping a member's number used to open the phone dialer, which is not how this club actually talks to each other — and if you do want to call, the number is right there to copy. Numbers are now one tap to a WhatsApp conversation on the sign-up sheet, the member profile, the VP Membership guest cards, and the roster. The chat opens empty: these screens have no idea which role you are calling about, and the pre-written drafts already live on the meeting page where that context exists.
- **The roster has a phone column.** It shows on wide screens only. A fifth column at tablet width squeezes the member-name column down to nothing, which defeats the point of a roster — so below 1280px the number stays one tap away on the member's profile, where it has always been.
- **Guest phone numbers on the VP Membership board are clickable.** They used to be plain text glued to the email with a middot.
- **A number typed without a country code still works.** The club's country code (set on Club settings, `+1` by default) is applied when the page loads, so numbers imported years ago link correctly without anyone editing them. A number nobody can dial — someone typed "call the office" into the phone field — still shows as readable text instead of a broken link.

### Fixed

- **Contact links now meet the accessibility contrast standard.** A site-wide styling rule was quietly overriding the colour these links asked for, painting them at a contrast ratio below the WCAG AA minimum at the size they render. The phone and email in a contact pair also render as the same colour again, instead of one of each.
- **An email address can no longer smuggle extra headers into a message you send.** Addresses reach GavelUp from a few places, and one of them accepts any text at all. A crafted address could add a hidden recipient to the message your mail client opened — and on the meeting page, where the app writes the draft for you, it could also silently replace the subject and body. All four places that open an email now escape the address, and a new check fails the build if a fifth appears.
- **Editing a member no longer shows a rewritten phone number.** Opening Edit on someone whose number was stored with an extension showed the reformatted version instead of what is actually on file.

## [1.11.1.0] - 2026-08-10

### Fixed

- **Archiving a club now actually takes it down.** Archiving is how a club is removed from GavelUp, and how a club's own logo and name come down if it ever needs to happen (ADR-0016 / ADR-0024). It did not work. The club page 404'd, which made it *look* like it worked — but the endpoints behind that page answer directly, with no sign-in and no browser, so anyone holding the club's link could still read back the roster, the meeting schedule, the past-meeting archive, the sign-up sheet, the role list, the club's own mission text, a full agenda with every assignee's name and speech title, and the live ballot. Fourteen of those endpoints now treat an archived club exactly like one that never existed.
- **The takedown can't be walked around through a side door.** Several of the endpoints were reachable by a different key than the one the club page uses — a meeting's own id, a member's own id — so closing the front door left those open. The worst of them returned more than any of the others: the full agenda, the officer names and the club's mission, to anyone with an old `/meetings/…` bookmark. Those are closed too, and looking up a club by name no longer confirms that an archived club ever existed or hands back its Toastmasters club number.

### Changed

- **Nothing changes for a club that is not archived.** Every one of these endpoints returns exactly what it always did; the only difference is what an archived club answers.

## [1.11.0.0] - 2026-08-10

### Changed

- **The meeting page now leads with the one thing you came to do.** It used to open with a row of eight equally-shouty buttons plus a full-width "I can't make this one" bar, and you had to read all of them every visit. Now there is a single emphasized action that follows the meeting through its life — **Present** on the day, **Minutes** once it is over (officers) — next to a share button and one **Print & export** menu. Nothing was taken away: the agenda print-out, present mode, this meeting's role sheets, the club's role sheets, the Word of the Day poster and the PowerPoint export all live in that menu, one tap in.
- **Everything about you is one line.** Who you are, whether you can make it, and — after the meeting — whether you were there, all read left to right in a single row instead of being scattered through the page.
- **Guests are not shown controls they cannot use.** The availability button used to appear before the page knew who you were, so a first-time visitor was invited to decline a meeting they had never signed up for. It now appears once you have identified yourself, which the sign-up flow does for you.

### Fixed

- **Two buttons no longer compete to be "the" button.** On meeting day an officer saw "Present" and "Complete meeting" in identical filled styling, and anyone who had marked themselves unavailable got a third. The emphasized action is now the one that matches the phase; the rest step back.
- **Jumping to the minutes lands on the minutes.** The Minutes shortcut scrolled to a point 9px too high, tucking the top of the card under the sticky header — visible when a superadmin is acting on a club's behalf, where the header is taller.
- **A failed minutes load says so instead of disappearing.** If the minutes could not be fetched, the whole card — attendance, awards, Table Topics — silently vanished, most consequentially for an officer on meeting night. It now shows a short "couldn't load, refresh to try again" line, and the Minutes shortcut still has somewhere to land.
- **The export menu reads as one menu.** Half its entries rendered in link-teal and half in the normal text colour, so two neighbouring items that do the same kind of thing looked like different kinds of thing.
- **Building a PowerPoint twice at once is no longer possible.** The menu closes when you pick an export, so clicking again started a second build over the top of the first.
- Officers keep every control they had — add a role, complete, reopen, and preview-as-member — and the in-progress state of the lifecycle buttons is now announced to screen readers rather than shown only as a spinner.

### Removed

- The eight-button action row and the floating availability bar on the meeting page, replaced by the toolbar and personal strip above.

## [1.10.3.1] - 2026-08-10

### Changed

- **Nothing user-facing.** The check that counts how many sheets each printed page produces was timing out intermittently on CI and passing on re-run, because the first page measured absorbed the browser's startup cost. The browser is now started once up front. This gate is the only thing in the project that can see a printing regression, so a red light nobody trusts is worse than no light at all.

## [1.10.3.0] - 2026-08-10

### Fixed

- **The guest book can no longer be used to stuff your minutes.** Signing the guest book during a meeting records the visitor as present, which reaches the official minutes and the email that goes out afterwards — and the form takes no account, by design. It now caps how many new guests one club can register in an hour, so the record cannot be filled with names nobody recognises. A returning visitor is never counted against the cap, and an officer can still add anyone by hand.
- **The roster's "I'm new — add me" cap now works when several people tap at once.** It counted before inserting rather than as one step, so a burst of simultaneous sign-ups could all slip past the limit together. Both public forms now hold under real concurrency.

## [1.10.2.0] - 2026-08-10

### Fixed

- **A mistyped meeting date no longer opens a different meeting.** A date that doesn't exist — September 31st, say — used to roll forward and quietly show you October 1st's meeting instead, with no sign anything was wrong. On the ballot that meant a vote could land in a meeting nobody chose. Impossible dates and times are now rejected outright, so the link says "not found" rather than showing the wrong week. Affects the agenda, the projected deck, the Word of the Day poster and the ballot alike.

## [1.10.1.0] - 2026-08-10

### Fixed

- **A mistyped or stale ballot link now says "not found" instead of erroring.** Scanning a QR for a meeting that no longer resolves showed the app's error screen; it shows the normal not-found page, the way the projected deck and the Word of the Day poster already did. This is the link printed on a QR and handed to a room, so a wrong key is the ordinary case rather than the exotic one.

## [1.10.0.0] - 2026-08-09

### Added

- **The room can now vote from their phones.** A QR code on the projector and in the printed agenda opens a ballot for Best Speaker, Best Evaluator and Best Table Topics. Members pick their name; visitors add themselves. No account, no app, no slips of paper to count by hand.
- **The Vote Counter runs it, and the app only does the arithmetic.** They open and close each vote when the segment ends, watch the count come in, and tap the winner. Nothing is decided automatically — a tie, a winner who left early, or a late paper ballot is still a judgement call, and the winner reaches the minutes only when a person confirms it.
- **The count stays with the Vote Counter.** The projector shows how many ballots are in, never who is ahead. A leaderboard on the wall changes how the last few people vote.
- **Table Topics speakers get captured as they speak.** The Vote Counter taps each name as they're called, which is what puts them on the ballot — and it fills in the minutes and the minutes PDF at the same time, instead of someone reconstructing the list afterwards.
- **Voting closes when the meeting does.** Completing a meeting shuts any open ballot, so nobody votes from the car park an hour later.

### Changed

- **Vote Counter is now a role that carries a capability**, alongside Toastmaster of the Day and Grammarian. A club that renamed it keeps the capability — the role's identity is its key, not its label.
- **The printed agenda and the projected deck both carry a scan-to-vote code**, on every layout including the default one.

### Fixed

- **Merging two duplicate members no longer fails when both have voted.** Their ballots collapse to one, which is what merging two records of one person means.

### Added

- **A guest on your club's page can now read your club's actual meeting roles.** The "Meeting roles" link in the "New to Toastmasters?" strip used to open a generic article about roles in the abstract — while a page listing your club's own roles, with the descriptions your officers wrote, sat one link away with nothing pointing at it. It now opens your club's roles, in a readable page with the club header and a way back. The printable one-pager is still there, one click on from it.
- **Your club page tells a guest when you meet.** The meeting schedule, district and mission your officers already filled in — the ones that print on the agenda — never appeared anywhere a guest could see. They now sit at the top of the public club page. Nothing shows if you haven't filled them in.
- **Guests can tell you they're coming.** The guest book was reachable only by scanning the QR code an officer prints and puts on the table, so the only way to be recorded was to already be in the room. The club page now invites a visitor to sign it before they arrive. Members don't see the invitation.

### Fixed

- **A guest who signs the guest book early is no longer marked present at a meeting they haven't attended.** Signing in recorded attendance against the club's next meeting whatever the date, so someone signing a week ahead was written into that meeting's minutes as present and emailed them. Attendance is now recorded only while the meeting is actually happening; signing early still tells the VP Membership someone is interested.
- **A guest who signs in at a real meeting is recorded, wherever your club is.** The same check used the club's stored timezone, which every club silently inherits as US Central because nothing in the app ever sets it. For a club outside that zone, a meeting and a signature minutes apart could land on different dates, and the visit vanished — the member's card read "No recorded visits" for someone who was in the room. It no longer consults a timezone at all.
- **Meeting roles are grouped the same way on screen and on paper.** The readable page and the printed sheet now derive their grouping from one place, so they cannot drift apart.

### Changed

- **The public club page loads a little lighter.** Opening the roles page — or just hovering the link to it — used to run a query that counted every meeting slot in the database to produce a number the page never showed. It doesn't anymore. A club's own page also no longer fails outright if the "about this club" details can't be loaded; the rest of the page still works.

## [1.8.5.0] - 2026-08-07

### Changed

- **The public club page now leads with the club's name.** Guests arrive here from shared links, and the page used to greet them with "Hi there 👋" while the club's identity sat in tiny truncated capitals in the corner. The club name is the headline now; the greeting moved underneath it.
- **Members land on their own dashboard after signing in.** The old landing was the club roster — a management surface with export and merge buttons — while the personal dashboard (your upcoming roles, your speeches, your Pathways) sat unused in the menu. Officers still land on Officer home. The same rule now applies everywhere: any members-only bounce off an officer page lands on the dashboard too, so the answer to "where do I go when this page isn't mine" is the same on all fourteen doors.
- **The meeting-page buttons say what they open.** "Role sheet" and "Role sheets" were one letter apart and opened different things; they are now "All role sheets" (the club's printable) and "This meeting's role sheets" (PDFs pre-filled for that meeting). The share button says "Copy share link" for everyone — officers used to see a different name for the same link.
- **The sign-up sheet reads better on a phone.** When more meeting columns hide past the right edge, the edge now fades to say so — and the fade retracts once you've scrolled to the end. The member view's short codes (TD, SP1, NA…) get a legend under the grid, and an open cell shows a plus when you point at or tab to it, so free slots read as claimable.
- **The printable role-sheet page has a way back in.** It used to be a dead end for guests opening a shared link — no header, no navigation. A small "← club name" pill now returns to the club page; it stays off the printed sheet.

### Removed

- **The "Remind unfilled (soon)" button is gone.** It promised a feature that isn't built yet (#7) and had been flagged in two audits. The open-roles count it sat beside remains; the button returns when reminders actually send.

## [1.8.4.0] - 2026-08-07

### Changed

- **Nothing a club prints looks any different, and that is the point of this release.** Every printed page was rendered before and after these changes and compared pixel by pixel: the agendas, the Word of the Day poster and the role sheets are identical. What changed is underneath. The stylesheet that keeps each of those pages to the right number of sheets used to exist as three separate copies that had quietly drifted apart, so fixing a printing problem meant finding all three and knowing which differences were deliberate. There is one copy now.

### Notes for this club

- The reason this was worth doing: printing is the part of GavelUp that has broken most quietly. A missing line of CSS once added a blank second page to every Word of the Day poster, and it got past six test files, the type checker, the linter and two reviews, because nothing in the project ever printed a page and counted the sheets. Something does now — on every change, automatically. It caught that exact bug on demand while being built.

## [1.8.3.0] - 2026-08-07

### Changed

- **The Speaker and Evaluator roles can no longer be turned off.** Their Disable button is now inert, with a note explaining why, and the server refuses the change even if something else asks for it. Disabling Speaker used to delete every open speaker slot across upcoming meetings while leaving the evaluators behind with nothing to evaluate — the same silent breakage that "− Remove speaker" was just fixed for, reached another way. Every meeting needs speakers and their evaluators; a meeting that genuinely has none is expressed by setting the count to 0 on that meeting, not by switching the role off for the whole club. Re-enabling still works, so any club that had already turned one off can put it back. #512

## [1.8.2.0] - 2026-08-07

### Fixed

- **"− Remove speaker" now removes that speaker's own evaluator.** It used to remove the last speaker and the last evaluator as two separate decisions, which look the same until a claimed speaker and a claimed evaluator sit at different positions — then it deleted an evaluator whose speaker was still on the agenda, and left the removed speaker's evaluator behind with nothing to evaluate. Nothing errored; the agenda just quietly went wrong. #512
- If the evaluator paired to that speaker has already been claimed, removal is now refused with a message naming which speaker to free up first, rather than pulling the speech out from under whoever volunteered to evaluate it. That matches how the rest of the app behaves — it never deletes a role someone has taken.

## [1.8.1.0] - 2026-08-07

### Changed

- An evaluator whose speaker isn't assigned yet now reads **"Evaluates Speaker 2"** instead of the generic "Evaluates a speaker". On an agenda printed before the roster is filled, that tells the evaluator which speaking slot they're on — and it makes "linked, speaker still open" visibly different from "not linked at all", which previously looked identical on the page. A club running a single speaker gets "Evaluates Speaker", unnumbered, matching how the speaker's own row is labelled. #512

### Added

- `scripts/backfill-evaluator-pairing.ts` links evaluators to their speaker on meetings that already existed before that link started being recorded. Dry-run by default; `--apply` writes. It pairs only where the evidence is unambiguous — equal speaker and evaluator counts, contiguous slot numbering, nothing already linked — and reports everything it skips with the reason instead of guessing. A wrong link is worse than none: a blank row reads as "not filled in yet", while the wrong name next to an evaluator is a confident error on a printed agenda. #512

## [1.8.0.0] - 2026-08-06

### Added

- **The VP Education dashboard now shows who has stopped coming.** The app has recorded attendance at every meeting since minutes shipped, and nothing has ever read it across meetings — so a member could quietly drift away and the first anyone knew was when they failed to renew. A new "Stopped attending" section lists active members not recorded present at the last 3 or more held meetings, longest absence first, with their attendance rate and the date they were last seen. It reads the attendance already being captured; there is no schema change and nothing new to fill in. #530

  It sits above "Overdue for a role" deliberately, because the two look alike and mean different things. A member who comes every week and never volunteers needs a nudge; a member who has stopped coming is a resignation in progress. Both show as having no claimed role, so the older section cannot tell them apart — only attendance can.

  Excused meetings do not count against anyone, and holding a role counts as being there even when nobody ticked the register.

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
