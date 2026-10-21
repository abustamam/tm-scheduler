# Easy-Speak fixtures

Pages for the Easy-Speak export's parser and walk tests (#1047). **This repo is public.**

They were saved from a real club's Easy-Speak pages while signed in as a member, cut down to the
markup the parsers read, and rewritten: every person name, Easy-Speak username and person id, every
phone number and email, the club's name, number, venue, address, district and web address, and the
online-meeting link are replaced with fakes. `fake-names.json` is the only list of names that may
appear; `easy-speak-fixtures.test.ts` fails if any other name, a person id outside `900001-900999`,
or a phone outside `(555) 010-xxxx` shows up in a fixture. A name in plain text (an introduction, a theme, an unlinked chart cell) is caught the same way: every run of two or more capitalised words must be a fake name or a phrase in `non-person-phrases.json` (headings, roles, Pathways projects, the fixture club's fake places, speech titles). Never add a person's name there. Do not copy a saved page in as it is.

| File | Source |
| --- | --- |
| `meeting-list.html`, `meeting-upcoming.html`, `meeting-completed.html`, `speech-list.html`, `member-list.html`, `club-data.html`, `chart-1-role-history.html`, `chart-4-roles-by-member.html`, `chart-8-mentors.html` | Saved pages, cut down and anonymised |
| `meeting-table-topics.html` | **Hand-built.** No saved meeting records Table Topics speakers; this is the empty block's markup with two rows added. The row shape is a guess |
| `speech-request-intro.html` | A saved request-form popup, cut down and anonymised, then **hand-edited**: the saved page was a blank new-request form, so the speech id, title and introduction were filled in. The popup has no site header and names no viewer; only the hidden `cached_user` and `cached_club` inputs identify the session |
| `chart-7-visitors-introduced.html` | **Hand-built.** A member sees this chart with a header and no rows; the row shape is a guess |
| `my-evaluations.html`, `my-evaluations.json`, `evaluation-501.json`, `evaluation-502.json` | **Hand-built** from the page's own script (`/api/v1/evaluations.php/...`); the saved page's list was empty |
| `non-person-phrases.json` | The allow-list for the plain-text name guard: non-person phrases only |
| `bundle.expected.json` | Produced by `easy-speak-walk.test.ts` from the files above; parsed with the zod schema in `src/lib/easy-speak-bundle.test.ts` |

Hand edits inside the saved pages: one guest per category has a reply, one role is vacant, the viewer
is the 1st speaker of the upcoming meeting (so the speech list's own request links to it), one member
"Wants Mentee?", and the member and club pages carry `(555) 010-xxxx` in their contact columns.

`UPDATE_FIXTURES=1 bunx vitest run lib/easy-speak-walk.test.ts` rewrites `bundle.expected.json`. Read
the diff: it is the contract's only worked example.

## A live Easy-Speak failure ships its page

A fix prompted by a live Easy-Speak failure commits the offending page in the same PR, with a test
that fails without the fix (#1252). The page is **anonymised by the generator below, then read by a human**: every name,
id, username, phone, email and club detail is replaced, and a person reads every line before committing. The export's
`easy-speak-<club>-<date>-pages.json` archive is raw, so **never commit it or a page from it**.

`fixtureViolations` (`easy-speak-test-kit.ts`) is a net, not a gate: it catches the shapes of real
data it knows, not every shape, and a pass is not clearance. Never add an allow-list entry to make a
page pass. Add a row to the table above, then write the test with `replay`:

```ts
const r = replay({ "/request_speech.php?s=123": "speech-request-regression.html" });
await expect(r.run()).resolves.toBeDefined(); // fails without the fix
```

`replay` serves the named fixtures in place of the usual pages, for a path or a path plus the query
parameters given, and runs the whole walk. Run `UPDATE_FIXTURES=1 bunx vitest run
lib/easy-speak-walk.test.ts` only if the fixture changes `bundle.expected.json` on purpose.

## The fixture generator

`extension/scripts/easy-speak-fixture-from-archive.ts` (#1272) turns a saved page into a fixture. It is
**deny by default**: the page is parsed, and EVERY text node and attribute value is replaced with a
fake unless it is on the allow-list (`ALLOW_LIST` in the script: menu labels, column headers, role
names, button text, date shapes, the URL shapes the walker reads, with every person id, club id and
username inside a URL replaced; host, page name, query parameter and fragment are each checked against a
literal list). **Names are data too**: a tag that is not a standard HTML tag becomes a `span`, an
attribute name that is not on the allow-list becomes `data-xN`, and comments, the doctype and
`srcdoc` are scrubbed like any text. The allow-list is literal: nothing is kept for resembling a fake
(a name that looks like one of `fake-names.json` is replaced like any other). **No digit survives**
(decision B of the risk review; round 3 of #1275 reworked how). NFKC runs first, so a fullwidth or
superscript digit is the digit it stands for, and a digit of any other script is dropped. A 1-3 digit
run outside an id context becomes ONE constant per width (`0`, `00`, `000`): no sampling and no "never
itself", so a repeated value or the values left out say nothing about the page. An id in its own
context (`t=`, `s=`, a club id) gets one fake per id from a keyed per-context derangement: lined up
inside the context, unrelated across contexts. A run of 4+ digits takes a keyed deterministic
one-to-one walk (an explicit error if the space is full); a zero-prefixed run keeps its full width and
is keyed by its exact text. **Dates (round 4, option A):** only a date in a link to a meeting page or in a
meeting page's title cell is a MEETING date (in a title cell only a date written the way the walker reads it, `<day> <month> <year> at <time>` with the month spelled out; `Joined Date: ...` in that cell is a member's). Meeting dates get a synthetic calendar built from their
RANK among the meeting dates of the pages, never from the real gaps: slots a week apart, the ones
before today completed and the ones after it upcoming, on a weekday a key chooses, **never one that carries a real date of the pages** (the first weekday of a keyed order whose slots are all free of every real date, in any shape and place; when every weekday holds some real date, the first whose slots are free of the real MEETING dates, since any other date is the placeholder and one landing on a slot is not attributable; an explicit error only if the meetings themselves fill every weekday). Every other date
(joined, paid until, last online, requested) is the one placeholder 2000-01-01 in whatever shape it
was written, so one known real-to-fake pair, or the club's public weekly schedule, recovers nothing
about a member date. Pages rewritten with ONE state share one calendar, so give the state all of them
first (`primeRewriteState`); a meeting date that falls between those of an earlier page is refused.
(`newRewriteState({ now })` fixes today for a test.) A date-shaped text that is not a date is scrubbed
whole. Numeric and non-ordinal dates (`10/13/2026`, `13.10.2026`, `2026/10/13`, `27 October 2026`, `13 Oct 2026`) are read BEFORE a phone is, by the same scan for priming and rewriting, and are the placeholder in their own shape; both readings of an ambiguous numeric date count as real dates. A time INSIDE a meeting date is drawn from the whole 1-12 (or 0-23) hour and 0-59 minute range, keyed, with no "never itself" rule; any other time is one constant per format (`12:00 am`, `00:00`). A phone becomes
`(555) 010-xxxx` with a keyed suffix that is never the input's last four digits (for a phone cut across tags, the ORIGINAL digits); the username is
`fixtureuser`, or `fixtureuser-alt` when the input is that very word. Fake names are an invented first
name with an invented last name, drawn from a keyed stream, each built from three syllables (`inventedFirst`, `inventedLast` in the test kit: 2,304 x 2,304, words no real person has, so no candidate is ever skipped for a word of the page and the pool does not run out on a page of thousands of names). Person ids are drawn from a keyed permutation of 900001-900999 with no avoidance of the page's own numbers, except that an id is never its own fake (an id already in that range would otherwise survive 1 time in 999). A phone the markup cuts across INLINE tags is joined after the digits are already fake, never across a block element or a `<br>`, and
no in-string marker character exists anywhere. What still keeps a digit is literal: tag names `h1`-`h6`, the classes `row1`-`row3`,
a few id words (`date1`...), the rank phrases (`1st Speaker`, `PM1`, `EH1`, `PI1`), the doctype,
charset and viewport strings, and three contexts: a radio's value 1, 2, 5, 6 only on an
`available[<digits>]` field (the walker reads the attendance plan from it), a pager's page numbers
`1`-`9` only inside `.nav` and never past the page count, and a month NAME only in the options of a
select named `month`, `start_month` or `end_month`. The old layout-number list is gone: `colspan`,
`width` and the like are mapped like any digit. Text is scanned by code point after NFKC, and any
non-space, non-punctuation code point counts as content. Pages primed together (`primeRewriteState`) reserve every page's digit runs, words and dates before any fake is made. The second net's `SHARED_WORDS` exempts only words of the allowed phrases. Every random choice is HMAC-SHA256 under a
256-bit key that is **random for each run and never stored or printed**; `newRewriteState({ seed, now })`
passes an explicit key for a test. A name word spelled with a JS escape, an entity or a percent escape
is a page word too (the words are gathered from every decoded form the rewrite reads). `Page` and `of`
are kept only in the pager. Event-handler attribute names are
a literal list (`handlerNames`), not a pattern. The document structure is kept. The same real value becomes the same fake within one run, so a person's id in a link and in a
table still line up. Then `fixtureViolations` runs over the output as a second net: if it reports
anything, **nothing is written**, the violations are printed and the exit code is non-zero.

Run it from `extension/`, on a page saved from a browser or taken out of the export's archive:

```sh
bun scripts/easy-speak-fixture-from-archive.ts saved.html lib/__fixtures__/easy-speak/<name>.html
bun scripts/easy-speak-fixture-from-archive.ts --archive easy-speak-<club>-<date>-pages.json --page "meeting.php?t=123" <name>.html
```

`--contact-page` for the member list or the club page (the only pages that may carry a phone);
`--real-name`, `--real-term`, `--real-club` and `--real-person-id` (repeatable) name real values for the
second net to look for. **A human still reads the output before it is committed**: the generator is a
net, not clearance. Look for text that is still real and not on the allow-list's intent; things it
cannot know (a club number shorter than four digits written outside the "Club Number" row, a speech
title that happens to be a public Pathways name) are for the reader. Free text (a theme, a title, an
introduction) comes out as `redacted-<letters>` or a fake name: the walker's structure is kept, not its
wording. The evaluations JSON (`evaluation-*.json`, `my-evaluations.json`) is **hand-written**: the
generator refuses JSON input (exit 2) rather than guess at it. A short number can come out as the same constant it was (`0` stays `0`): a placeholder, not a kept value. Add to the allow-list only what every club's page says, never a name, and never to make a page
pass. Then add a row to the table above and write the test with `replay`.
