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
username inside a URL replaced). Tags, tag names, attribute names and the document structure are never
rewritten. The same real value becomes the same fake within one run, so a person's id in a link and in a
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
introduction) comes out as `redacted-N` or a fake name: the walker's structure is kept, not its
wording. Add to the allow-list only what every club's page says, never a name, and never to make a page
pass. Then add a row to the table above and write the test with `replay`.
